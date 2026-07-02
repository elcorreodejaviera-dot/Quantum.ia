import { describe, it, expect } from "vitest";
import {
  ENTRY_TRIGGER_SLIPPAGE, RANGE_MIN_K, BE_OFFSET_FRACTION,
  computeEntryTriggers, triggerSeparationOk, rangeWidthOk,
  entryOrderSpecs, splitFilledSide, resolveEntryTopology,
  nextTrailAnchor, computeDesiredSlTrigger, tpLevels, floorToDecimals, classifyLpRead,
} from "../convex/tradingMath";

// (JAV-177) Matemática pura del motor de trading. Cada bloque cubre lo exigido por el plan
// (docs/plan-bot-trading-fase.md, PR1) y los cierres de auditoría P4/P7/V2-P1.

describe("computeEntryTriggers (pre-trigger % del ANCHO del rango)", () => {
  it("0% = bordes exactos", () => {
    const t = computeEntryTriggers(2000, 3000, 0);
    expect(t.lowerTriggerPx).toBe(2000);
    expect(t.upperTriggerPx).toBe(3000);
  });

  it("desplaza AMBOS triggers hacia dentro en % del ancho", () => {
    const t = computeEntryTriggers(2000, 3000, 2);   // ancho 1000 → inset 20
    expect(t.lowerTriggerPx).toBe(2020);
    expect(t.upperTriggerPx).toBe(2980);
  });

  it("rechaza rango invertido/degenerado y pct negativo", () => {
    expect(() => computeEntryTriggers(3000, 2000, 0)).toThrow(/rango inválido/);
    expect(() => computeEntryTriggers(2000, 2000, 0)).toThrow(/rango inválido/);
    expect(() => computeEntryTriggers(2000, 3000, -1)).toThrow(/preTriggerPct/);
    expect(() => computeEntryTriggers(NaN, 3000, 0)).toThrow(/finito/);
  });

  it("rechaza preTriggerPct ≥ 50 (colapsaría/invertiría el par de triggers)", () => {
    expect(() => computeEntryTriggers(2000, 3000, 50)).toThrow(/preTriggerPct debe ser < 50/);
    expect(() => computeEntryTriggers(2000, 3000, 60)).toThrow(/preTriggerPct debe ser < 50/);
    // 49.9 sigue siendo válido (par no invertido, aunque angostísimo — lo frena rangeWidthOk).
    const t = computeEntryTriggers(2000, 3000, 49.9);
    expect(t.lowerTriggerPx).toBeLessThan(t.upperTriggerPx);
  });
});

describe("triggerSeparationOk (redondeo que deja <1 tick)", () => {
  it("separación ≥ 1 tick pasa; menor falla; invertido falla", () => {
    expect(triggerSeparationOk(2000, 2000.5, 0.5)).toBe(true);
    expect(triggerSeparationOk(2000, 2000.4, 0.5)).toBe(false);
    expect(triggerSeparationOk(2001, 2000, 0.5)).toBe(false);
  });
});

describe("rangeWidthOk (rango mínimo, constantes cerradas P7)", () => {
  // Umbral: widthPct ≥ RANGE_MIN_K × (stopLossPct + ENTRY_TRIGGER_SLIPPAGE×100).
  // Con SL 1% y slippage 2%: 2×(1+2) = 6% del mark.
  const mark = 1000;
  const slPct = 1;
  const thresholdPct = RANGE_MIN_K * (slPct + ENTRY_TRIGGER_SLIPPAGE * 100);

  it("las constantes cerradas del plan no cambian silenciosamente", () => {
    expect(ENTRY_TRIGGER_SLIPPAGE).toBe(0.02);
    expect(RANGE_MIN_K).toBe(2);
    expect(thresholdPct).toBe(6);
  });

  it("frontera: justo menor falla, igual pasa, mayor pasa", () => {
    const width = (thresholdPct / 100) * mark;   // 60
    expect(rangeWidthOk(1000 - width / 2 + 0.01, 1000 + width / 2, mark, slPct)).toBe(false);
    expect(rangeWidthOk(1000 - width / 2, 1000 + width / 2, mark, slPct)).toBe(true);
    expect(rangeWidthOk(1000 - width / 2 - 1, 1000 + width / 2 + 1, mark, slPct)).toBe(true);
  });

  it("pre-trigger invertido (width ≤ 0) NUNCA pasa", () => {
    expect(rangeWidthOk(1030, 970, mark, slPct)).toBe(false);   // triggers cruzados
    expect(rangeWidthOk(1000, 1000, mark, slPct)).toBe(false);
  });

  it("mark/slPct inválidos fallan cerrado", () => {
    expect(rangeWidthOk(900, 1100, 0, slPct)).toBe(false);
    expect(rangeWidthOk(900, 1100, mark, 0)).toBe(false);
  });
});

describe("entryOrderSpecs (mapeo verificado on-chain)", () => {
  it("long_short: buy-stop arriba + sell-stop abajo, ambas tpsl:sl", () => {
    expect(entryOrderSpecs("long_short")).toEqual([
      { role: "entry_upper", isBuy: true, tpsl: "sl" },
      { role: "entry_lower", isBuy: false, tpsl: "sl" },
    ]);
  });

  it("solo long: ruptura BUY arriba (sl) + reversión BUY abajo (tp)", () => {
    expect(entryOrderSpecs("long")).toEqual([
      { role: "entry_upper", isBuy: true, tpsl: "sl" },
      { role: "entry_lower", isBuy: true, tpsl: "tp" },
    ]);
  });

  it("solo short: ruptura SELL abajo (sl) + reversión SELL arriba (tp)", () => {
    expect(entryOrderSpecs("short")).toEqual([
      { role: "entry_lower", isBuy: false, tpsl: "sl" },
      { role: "entry_upper", isBuy: false, tpsl: "tp" },
    ]);
  });
});

describe("splitFilledSide", () => {
  it("modos solo: siempre su dirección", () => {
    expect(splitFilledSide("long", "entry_upper")).toBe("Long");
    expect(splitFilledSide("long", "entry_lower")).toBe("Long");
    expect(splitFilledSide("long", "entry_market")).toBe("Long");
    expect(splitFilledSide("short", "entry_upper")).toBe("Short");
    expect(splitFilledSide("short", "entry_market")).toBe("Short");
  });

  it("long_short: el borde define el lado; entry_market exige el lado de la topología", () => {
    expect(splitFilledSide("long_short", "entry_upper")).toBe("Long");
    expect(splitFilledSide("long_short", "entry_lower")).toBe("Short");
    expect(() => splitFilledSide("long_short", "entry_market")).toThrow(/filledSide/);
  });
});

describe("resolveEntryTopology (decisión 6 + revalidación pre-RPC V2-P1)", () => {
  const lo = 2000, hi = 3000;

  it("dentro del rango ⇒ oco (los 3 modos)", () => {
    for (const d of ["long_short", "long", "short"] as const) {
      expect(resolveEntryTopology(2500, lo, hi, d)).toEqual({ kind: "oco" });
    }
  });

  it("bordes EXACTOS cuentan como fuera (un trigger en el mark nacería disparado) — los 3 modos", () => {
    expect(resolveEntryTopology(lo, lo, hi, "long_short")).toEqual({ kind: "market", side: "Short" });
    expect(resolveEntryTopology(hi, lo, hi, "long_short")).toEqual({ kind: "market", side: "Long" });
    expect(resolveEntryTopology(lo, lo, hi, "long")).toEqual({ kind: "market", side: "Long" });
    expect(resolveEntryTopology(hi, lo, hi, "long")).toEqual({ kind: "market", side: "Long" });
    expect(resolveEntryTopology(lo, lo, hi, "short")).toEqual({ kind: "market", side: "Short" });
    expect(resolveEntryTopology(hi, lo, hi, "short")).toEqual({ kind: "market", side: "Short" });
  });

  it("par degenerado/invertido LANZA — jamás elige topología con config inválida", () => {
    // Sin este guard, "dentro" sería insatisfacible y TODO mark caería a market con lado arbitrario
    // (p.ej. el centro real del pool clasificado como market Short).
    expect(() => resolveEntryTopology(2500, 2600, 2400, "long_short")).toThrow(/degenerado/);
    expect(() => resolveEntryTopology(2500, 2500, 2500, "long")).toThrow(/degenerado/);
  });

  it("long_short fuera: el lado lo define el borde superado", () => {
    expect(resolveEntryTopology(1900, lo, hi, "long_short")).toEqual({ kind: "market", side: "Short" });
    expect(resolveEntryTopology(3100, lo, hi, "long_short")).toEqual({ kind: "market", side: "Long" });
  });

  it("solo long/short fuera por CUALQUIER borde: siempre su dirección", () => {
    expect(resolveEntryTopology(1900, lo, hi, "long")).toEqual({ kind: "market", side: "Long" });
    expect(resolveEntryTopology(3100, lo, hi, "long")).toEqual({ kind: "market", side: "Long" });
    expect(resolveEntryTopology(1900, lo, hi, "short")).toEqual({ kind: "market", side: "Short" });
    expect(resolveEntryTopology(3100, lo, hi, "short")).toEqual({ kind: "market", side: "Short" });
  });
});

describe("nextTrailAnchor (anchor DIRECCIONAL, P4)", () => {
  it("Long sube con el mark; un rebote adverso NO lo mueve", () => {
    let anchor = 100;                                    // seed = entry (coalescencia del caller)
    anchor = nextTrailAnchor("Long", anchor, 105);
    expect(anchor).toBe(105);
    anchor = nextTrailAnchor("Long", anchor, 95);        // rebote adverso
    expect(anchor).toBe(105);
    anchor = nextTrailAnchor("Long", anchor, 110);
    expect(anchor).toBe(110);
  });

  it("Short BAJA con el mark (min, jamás max); el rebote adverso no lo sube", () => {
    let anchor = 100;
    anchor = nextTrailAnchor("Short", anchor, 92);
    expect(anchor).toBe(92);
    anchor = nextTrailAnchor("Short", anchor, 99);       // rebote adverso hacia arriba
    expect(anchor).toBe(92);
    anchor = nextTrailAnchor("Short", anchor, 88);
    expect(anchor).toBe(88);
  });

  it("reinicio (re-seed desde persistido) preserva el avance en AMBOS lados", () => {
    // Simula reinicio: el anchor persistido se recarga y el primer mark post-reinicio es adverso.
    const persistedLong = 110;
    expect(nextTrailAnchor("Long", persistedLong, 101)).toBe(110);
    const persistedShort = 88;
    expect(nextTrailAnchor("Short", persistedShort, 97)).toBe(88);
  });

  it("property: monótono direccional sobre un camino de precios determinista", () => {
    // Camino sin aleatoriedad: sube/baja alternando. El anchor Long nunca baja; el Short nunca sube.
    const path = [100, 103, 101, 108, 104, 112, 90, 111, 120, 95];
    let aLong = 100, aShort = 100;
    for (const px of path) {
      const nl = nextTrailAnchor("Long", aLong, px);
      const ns = nextTrailAnchor("Short", aShort, px);
      expect(nl).toBeGreaterThanOrEqual(aLong);
      expect(ns).toBeLessThanOrEqual(aShort);
      aLong = nl; aShort = ns;
    }
    expect(aLong).toBe(120);
    expect(aShort).toBe(90);
  });
});

describe("computeDesiredSlTrigger (ratchet fuente-única: SL base + BE + trailing + actual)", () => {
  const base = { stopLossPct: 1, beMoved: false, trailingEnabled: false, tickSize: 0.5 };

  it("Long sin BE/trailing: SL base entry×(1−slPct)", () => {
    const d = computeDesiredSlTrigger({ ...base, side: "Long", entryPx: 1000, markPx: 1005 });
    expect(d).toBeCloseTo(990, 10);
  });

  it("Short espejo: SL base entry×(1+slPct)", () => {
    const d = computeDesiredSlTrigger({ ...base, side: "Short", entryPx: 1000, markPx: 995 });
    expect(d).toBeCloseTo(1010, 10);
  });

  it("BE latch = suelo del ratchet (entry±offset, espejo del bot de defensa)", () => {
    const dLong = computeDesiredSlTrigger({ ...base, side: "Long", entryPx: 1000, markPx: 1010, beMoved: true });
    expect(dLong).toBeCloseTo(1000 * (1 + BE_OFFSET_FRACTION), 10);
    const dShort = computeDesiredSlTrigger({ ...base, side: "Short", entryPx: 1000, markPx: 990, beMoved: true });
    expect(dShort).toBeCloseTo(1000 * (1 - BE_OFFSET_FRACTION), 10);
  });

  it("trailing gana cuando el anchor avanzó lo suficiente (Long anchor·(1−pct) / Short anchor·(1+pct))", () => {
    const dLong = computeDesiredSlTrigger({
      ...base, side: "Long", entryPx: 1000, markPx: 1100,
      beMoved: true, trailingEnabled: true, trailAnchorPx: 1100, trailingPct: 1,
    });
    expect(dLong).toBeCloseTo(1089, 10);
    const dShort = computeDesiredSlTrigger({
      ...base, side: "Short", entryPx: 1000, markPx: 900,
      beMoved: true, trailingEnabled: true, trailAnchorPx: 900, trailingPct: 1,
    });
    expect(dShort).toBeCloseTo(909, 10);
  });

  it("clamp anti-auto-disparo: jamás a menos de 1 tick del mark", () => {
    // Long con trailing agresivo y el mark encima: el deseado se clampa a mark − tick.
    const d = computeDesiredSlTrigger({
      ...base, side: "Long", entryPx: 1000, markPx: 1089.2,
      trailingEnabled: true, trailAnchorPx: 1100, trailingPct: 1,
    });
    expect(d).toBeCloseTo(1089.2 - 0.5, 10);
    const dS = computeDesiredSlTrigger({
      ...base, side: "Short", entryPx: 1000, markPx: 909.1,
      trailingEnabled: true, trailAnchorPx: 900, trailingPct: 1,
    });
    expect(dS).toBeCloseTo(909.1 + 0.5, 10);
  });

  it("monótono: nunca por debajo (Long) / encima (Short) del SL actual, aunque el clamp apriete", () => {
    const d = computeDesiredSlTrigger({
      ...base, side: "Long", entryPx: 1000, markPx: 1050,
      trailingEnabled: true, trailAnchorPx: 1100, trailingPct: 1,   // 1089 > mark−tick → clamp 1049.5
      currentSlPx: 1060,                                            // el actual ya estaba más arriba
    });
    expect(d).toBe(1060);   // no retrocede
    const dS = computeDesiredSlTrigger({
      ...base, side: "Short", entryPx: 1000, markPx: 950,
      trailingEnabled: true, trailAnchorPx: 900, trailingPct: 1,    // 909 < mark+tick → clamp 950.5
      currentSlPx: 940,
    });
    expect(dS).toBe(940);
  });

  it("property espejo: en un camino a favor el SL Long solo sube y el Short solo baja", () => {
    const pathLong = [1005, 1010, 1008, 1030, 1025, 1060, 1055, 1100];
    let anchorL = 1000, slL = -Infinity;
    for (const px of pathLong) {
      anchorL = nextTrailAnchor("Long", anchorL, px);
      const d = computeDesiredSlTrigger({
        side: "Long", entryPx: 1000, stopLossPct: 1, beMoved: true,
        trailingEnabled: true, trailAnchorPx: anchorL, trailingPct: 1,
        currentSlPx: slL === -Infinity ? undefined : slL, markPx: px, tickSize: 0.5,
      });
      expect(d).toBeGreaterThanOrEqual(slL === -Infinity ? -Infinity : slL);
      slL = d;
    }
    const pathShort = [995, 990, 992, 970, 975, 940, 945, 900];
    let anchorS = 1000, slS = Infinity;
    for (const px of pathShort) {
      anchorS = nextTrailAnchor("Short", anchorS, px);
      const d = computeDesiredSlTrigger({
        side: "Short", entryPx: 1000, stopLossPct: 1, beMoved: true,
        trailingEnabled: true, trailAnchorPx: anchorS, trailingPct: 1,
        currentSlPx: slS === Infinity ? undefined : slS, markPx: px, tickSize: 0.5,
      });
      expect(d).toBeLessThanOrEqual(slS === Infinity ? Infinity : slS);
      slS = d;
    }
  });
});

describe("tpLevels (el último TP absorbe el residuo de redondeo)", () => {
  const tps = [
    { gainPct: 0.5, closePct: 30 },
    { gainPct: 2, closePct: 50 },
    { gainPct: 5, closePct: 20 },
  ];

  // Suma en TICKS enteros: la comparación de floats sumados ocultaría el bug que el reparto entero arregla.
  const sumTicks = (levels: Array<{ size: number }>, f: number) =>
    levels.reduce((s, l) => s + Math.round(l.size * f), 0);

  it("Σ sizes == filledSize exacto con Σ closePct = 100 (default del amigo 30/50/20)", () => {
    const levels = tpLevels({ side: "Long", entryPx: 1000, filledSize: 0.7003, tps, szDecimals: 4 });
    expect(levels).toHaveLength(3);
    expect(sumTicks(levels, 1e4)).toBe(7003);
  });

  it("regresión float (revisión adversarial): tamaños realistas que rompían el reparto en floats", () => {
    // (a) UNDERSHOOT con el reparto float viejo: quedaba 1 tick de posición sin TP.
    const a = tpLevels({ side: "Long", entryPx: 1000, filledSize: 85.30268, tps, szDecimals: 5 });
    expect(sumTicks(a, 1e5)).toBe(8530268);
    // (b) OVERSHOOT con el reparto float viejo: el último TP reduce-only quedaba MÁS GRANDE que la posición.
    const b = tpLevels({ side: "Long", entryPx: 1000, filledSize: 7126.9749, tps, szDecimals: 4 });
    expect(sumTicks(b, 1e4)).toBe(71269749);
  });

  it("property: Σ ticks == filledTicks exacto en un barrido determinista de tamaños y szDecimals", () => {
    for (const szDecimals of [0, 2, 4, 5]) {
      const f = 10 ** szDecimals;
      for (let k = 1; k <= 400; k++) {
        const ticks = ((k * 7919 + 13) % 100_000_000) + 1;   // 1..1e8, determinista
        const filledSize = ticks / f;
        const levels = tpLevels({ side: "Long", entryPx: 1000, filledSize, tps, szDecimals });
        expect(sumTicks(levels, f)).toBe(ticks);              // ni un tick de más ni de menos
        for (const l of levels) expect(l.size).toBeGreaterThan(0);
      }
    }
  });

  it("precios por lado: Long entry×(1+gain), Short entry×(1−gain)", () => {
    const long = tpLevels({ side: "Long", entryPx: 1000, filledSize: 1, tps, szDecimals: 4 });
    const expectClose = (got: number[], want: number[]) => {
      expect(got).toHaveLength(want.length);
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
    };
    expectClose(long.map((l) => l.triggerPx), [1005, 1020, 1050]);
    const short = tpLevels({ side: "Short", entryPx: 1000, filledSize: 1, tps, szDecimals: 4 });
    expectClose(short.map((l) => l.triggerPx), [995, 980, 950]);
  });

  it("con Σ closePct < 100, Σ ticks = floor(filledTicks×Σ/100)", () => {
    const partial = [{ gainPct: 1, closePct: 25 }, { gainPct: 2, closePct: 25 }];
    const levels = tpLevels({ side: "Long", entryPx: 1000, filledSize: 1.0001, tps: partial, szDecimals: 4 });
    expect(sumTicks(levels, 1e4)).toBe(Math.floor(10001 * 0.5 + 1e-9));   // 5000 ticks = 0.5
  });

  it("un TP cuyo size redondea a 0 se OMITE y el ÚLTIMO absorbe todo (aserción no vacua)", () => {
    // 1 solo tick de posición: el TP0 (30%) florea a 0 y se omite; el último se lleva el tick entero.
    const levels = tpLevels({
      side: "Long", entryPx: 1000, filledSize: 0.0001,
      tps: [{ gainPct: 1, closePct: 30 }, { gainPct: 2, closePct: 70 }], szDecimals: 4,
    });
    expect(levels).toHaveLength(1);            // si devolviera [] se perdería TODO el camino de salida
    expect(levels[0].tpIndex).toBe(1);
    expect(levels[0].size).toBeCloseTo(0.0001, 10);
    expect(sumTicks(levels, 1e4)).toBe(1);
  });

  it("valida Σ closePct ≤ 100, valores > 0, y gainPct < 100 en Short (trigger ≤ 0)", () => {
    expect(() => tpLevels({
      side: "Long", entryPx: 1000, filledSize: 1,
      tps: [{ gainPct: 1, closePct: 60 }, { gainPct: 2, closePct: 60 }], szDecimals: 4,
    })).toThrow(/closePct/);
    expect(() => tpLevels({
      side: "Long", entryPx: 1000, filledSize: 1,
      tps: [{ gainPct: 0, closePct: 50 }], szDecimals: 4,
    })).toThrow(/gainPct\/closePct/);
    expect(() => tpLevels({
      side: "Short", entryPx: 1000, filledSize: 1,
      tps: [{ gainPct: 100, closePct: 50 }], szDecimals: 4,
    })).toThrow(/gainPct debe ser < 100 en Short/);
    // En Long gainPct ≥ 100 es válido (trigger muy arriba, jamás ≤ 0).
    const long = tpLevels({
      side: "Long", entryPx: 1000, filledSize: 1,
      tps: [{ gainPct: 150, closePct: 100 }], szDecimals: 4,
    });
    expect(long[0].triggerPx).toBeCloseTo(2500, 9);
  });

  it("floorToDecimals es espejo EXACTO del canónico de hyperliquid.ts (sin epsilon, trunca)", () => {
    expect(floorToDecimals(0.29999999999, 4)).toBe(0.2999);
    expect(floorToDecimals(1.00019999, 4)).toBe(1.0001);
  });
});

describe("classifyLpRead (mapeo fail-closed de la lectura estricta del LP, P3)", () => {
  it("ok ⇒ continuar", () => {
    expect(classifyLpRead("ok")).toEqual({ ok: true });
  });

  it("transient ⇒ [transient] (reintento)", () => {
    const r = classifyLpRead("transient");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^\[transient\]/);
  });

  it("empty/unsupported ⇒ [blocked_config]", () => {
    for (const reason of ["empty", "unsupported"]) {
      const r = classifyLpRead(reason);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^\[blocked_config\]/);
    }
  });

  it("reason desconocido ⇒ [blocked_config] (fail-closed, jamás continuar)", () => {
    const r = classifyLpRead("garbage");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^\[blocked_config\]/);
  });
});
