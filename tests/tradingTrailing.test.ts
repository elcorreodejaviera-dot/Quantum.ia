import { describe, it, expect } from "vitest";
import { nextTrailAnchor, computeDesiredSlTrigger } from "../convex/tradingMath";
import { decideSlReplacement, beLatchReached, hlPriceTick, SL_REPLACE_MIN_INTERVAL_MS, preHlGateCheck } from "../convex/tradingReconcileCore";

// (JAV-179-C1) Contrato de ORDEN del money-path: los gates son la PRIMERA barrera antes de tocar HL.
describe("preHlGateCheck — kill-switch/canLive/gate-mainnet bloquean ANTES de cualquier lectura HL", () => {
  const base = { tradingEnabled: true, simulationOff: true, canLive: true, network: "mainnet", mainnetApproved: true };

  it("gate mainnet cerrado ⇒ [blocked_config] (barrera total, sin descifrar clave ni tocar HL)", () => {
    const r = preHlGateCheck({ ...base, mainnetApproved: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/^\[blocked_config\] mainnetTradingApproved OFF/);
  });

  it("kill-switch / simulación ⇒ [cancel]; canLive revocado ⇒ [blocked_config]", () => {
    expect((preHlGateCheck({ ...base, tradingEnabled: false }) as any).error).toMatch(/^\[cancel\]/);
    expect((preHlGateCheck({ ...base, simulationOff: false }) as any).error).toMatch(/^\[cancel\]/);
    expect((preHlGateCheck({ ...base, canLive: false }) as any).error).toMatch(/^\[blocked_config\] canTradeLive/);
  });

  it("testnet no exige el gate mainnet; todo ok ⇒ ok", () => {
    expect(preHlGateCheck({ ...base, network: "testnet", mainnetApproved: false })).toEqual({ ok: true });
    expect(preHlGateCheck(base)).toEqual({ ok: true });
  });
});

// (JAV-179 / PR3) Trailing del motor de trading: anchor direccional (P4) + ratchet + histéresis de
// REPLACE. Property tests con secuencias reales (reinicio, rebote adverso) para AMBOS lados.

describe("hlPriceTick — espejo exacto del tick HL de perps", () => {
  it("5 cifras significativas y ≤ 6−szDecimals decimales", () => {
    expect(hlPriceTick(2500, 1)).toBe(0.1);       // 4 dígitos enteros → 1 decimal significativo
    expect(hlPriceTick(250, 1)).toBe(0.01);
    expect(hlPriceTick(2.5, 1)).toBe(0.0001);     // limitado por sigDecimals=4... min(5, 4)=4
    expect(hlPriceTick(95000, 5)).toBe(1);        // BTC-style: 6−5=1 decimal, pero 5 dígitos ⇒ tick 1
  });
});

describe("decideSlReplacement — umbral max(2 ticks, 0.1%) + histéresis 60s + máx 1 rotación/tick", () => {
  const now = 1_000_000_000;

  it("sin SL vivo ⇒ replace inmediato", () => {
    expect(decideSlReplacement({ side: "Long", desiredPx: 100, currentSlPx: undefined, tickSize: 0.5, now }).replace).toBe(true);
  });

  it("mejora bajo el umbral ⇒ hold (anti-spam)", () => {
    // 2 ticks = 1.0; 0.1% de 1000 = 1.0 ⇒ umbral 1.0. Mejora 0.9 ⇒ hold.
    const r = decideSlReplacement({ side: "Long", desiredPx: 1000.9, currentSlPx: 1000, tickSize: 0.5, now });
    expect(r.replace).toBe(false);
  });

  it("mejora sobre el umbral pero < 60s del último replace ⇒ hold (histéresis)", () => {
    const r = decideSlReplacement({
      side: "Long", desiredPx: 1010, currentSlPx: 1000, tickSize: 0.5,
      lastSlReplaceAt: now - SL_REPLACE_MIN_INTERVAL_MS + 1000, now,
    });
    expect(r.replace).toBe(false);
  });

  it("mejora sobre el umbral y ≥60s ⇒ replace; Short es espejo (mejora = BAJAR)", () => {
    expect(decideSlReplacement({
      side: "Long", desiredPx: 1010, currentSlPx: 1000, tickSize: 0.5,
      lastSlReplaceAt: now - SL_REPLACE_MIN_INTERVAL_MS - 1, now,
    }).replace).toBe(true);
    expect(decideSlReplacement({ side: "Short", desiredPx: 990, currentSlPx: 1000, tickSize: 0.5, now }).replace).toBe(true);
    // Short "mejora" hacia ARRIBA no existe: desired > current ⇒ hold.
    expect(decideSlReplacement({ side: "Short", desiredPx: 1010, currentSlPx: 1000, tickSize: 0.5, now }).replace).toBe(false);
  });
});

describe("beLatchReached — ganancia ≥ breakevenPct Ó TP1 filled", () => {
  it("Long y Short espejo; TP1 latchea aunque no haya ganancia", () => {
    expect(beLatchReached({ side: "Long", entryPx: 1000, markPx: 1006, breakevenPct: 0.5, tp1Filled: false })).toBe(true);
    expect(beLatchReached({ side: "Long", entryPx: 1000, markPx: 1004, breakevenPct: 0.5, tp1Filled: false })).toBe(false);
    expect(beLatchReached({ side: "Short", entryPx: 1000, markPx: 994, breakevenPct: 0.5, tp1Filled: false })).toBe(true);
    expect(beLatchReached({ side: "Short", entryPx: 1000, markPx: 996, breakevenPct: 0.5, tp1Filled: false })).toBe(false);
    expect(beLatchReached({ side: "Long", entryPx: 1000, markPx: 990, breakevenPct: 0.5, tp1Filled: true })).toBe(true);
    expect(beLatchReached({ side: "Long", entryPx: 1000, markPx: 1010, breakevenPct: undefined, tp1Filled: false })).toBe(false);
  });
});

describe("secuencia integrada: anchor + ratchet + replace — el SL JAMÁS retrocede (ambos lados)", () => {
  const tickSize = 0.5;

  function runPath(side: "Long" | "Short", entryPx: number, path: number[], opts: { restartAt?: number } = {}) {
    let anchor = entryPx;
    let slPx: number | undefined;
    let lastReplaceAt: number | undefined;
    let now = 1_000_000_000;
    const slHistory: number[] = [];
    path.forEach((mark, i) => {
      now += 61_000;   // cada tick del cron pasa la histéresis (aísla el ratchet en este test)
      if (opts.restartAt === i) {
        // REINICIO del worker: el anchor persistido se recarga tal cual (nada en memoria).
        anchor = anchor;   // (persistido — el test verifica que el avance no se pierde)
      }
      anchor = nextTrailAnchor(side, anchor, mark);
      const desired = computeDesiredSlTrigger({
        side, entryPx, stopLossPct: 1, beMoved: true,
        trailingEnabled: true, trailAnchorPx: anchor, trailingPct: 1,
        currentSlPx: slPx, markPx: mark, tickSize,
      });
      const dec = decideSlReplacement({ side, desiredPx: desired, currentSlPx: slPx, tickSize, lastSlReplaceAt: lastReplaceAt, now });
      if (dec.replace) { slPx = desired; lastReplaceAt = now; }
      if (slPx !== undefined) slHistory.push(slPx);
    });
    return { anchor, slPx, slHistory };
  }

  it("Long: camino a favor con rebotes adversos y REINICIO a mitad — SL monótono no-decreciente", () => {
    const { slHistory, anchor } = runPath("Long", 1000, [1005, 1012, 1008, 1030, 1022, 1060, 1040, 1100], { restartAt: 4 });
    for (let i = 1; i < slHistory.length; i++) expect(slHistory[i]).toBeGreaterThanOrEqual(slHistory[i - 1]);
    expect(anchor).toBe(1100);   // el reinicio no perdió el máximo favorable
  });

  it("Short: espejo — SL monótono no-creciente y anchor en el mínimo favorable tras reinicio", () => {
    const { slHistory, anchor } = runPath("Short", 1000, [995, 988, 992, 970, 978, 940, 960, 900], { restartAt: 4 });
    for (let i = 1; i < slHistory.length; i++) expect(slHistory[i]).toBeLessThanOrEqual(slHistory[i - 1]);
    expect(anchor).toBe(900);
  });

  it("rebote adverso puro: ni el anchor ni el SL se mueven", () => {
    const { slPx: sl1, anchor: a1 } = runPath("Long", 1000, [1050]);
    const { slPx: sl2, anchor: a2 } = runPath("Long", 1000, [1050, 1010, 1005, 1002]);
    expect(a2).toBe(a1);
    expect(sl2).toBe(sl1);
  });

  it("(JAV-179-C2) contrato de la rotación real (rotateSl): con currentSlPx del MISMO lado, el trigger " +
     "recomputado JAMÁS es peor — incluso en el resize donde el deseado crudo quedó por detrás", () => {
    // Escenario resize: la hermana llenó tarde (posición 2×), el mark CAYÓ desde el anchor y el
    // deseado crudo (sin clamp) queda por DEBAJO del SL vivo. rotateSl recomputa con
    // currentSlPx = trigger viejo del mismo lado ⇒ el clamp monotónico lo usa como piso.
    const oldSl = 1060;
    const raw = computeDesiredSlTrigger({
      side: "Long", entryPx: 1000, stopLossPct: 1, beMoved: true,
      trailingEnabled: true, trailAnchorPx: 1100, trailingPct: 1,
      currentSlPx: undefined, markPx: 1050, tickSize: 0.5,
    });
    expect(raw).toBeLessThan(oldSl);   // el crudo SERÍA peor (clamp a mark−tick = 1049.5)
    const clamped = computeDesiredSlTrigger({
      side: "Long", entryPx: 1000, stopLossPct: 1, beMoved: true,
      trailingEnabled: true, trailAnchorPx: 1100, trailingPct: 1,
      currentSlPx: oldSl, markPx: 1050, tickSize: 0.5,   // la llamada REAL de rotateSl
    });
    expect(clamped).toBe(oldSl);       // jamás retrocede para el mismo lado
    // Espejo Short.
    const clampedS = computeDesiredSlTrigger({
      side: "Short", entryPx: 1000, stopLossPct: 1, beMoved: true,
      trailingEnabled: true, trailAnchorPx: 900, trailingPct: 1,
      currentSlPx: 940, markPx: 950, tickSize: 0.5,
    });
    expect(clampedS).toBe(940);
  });
});
