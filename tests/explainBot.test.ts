import { describe, it, expect } from "vitest";
// @ts-expect-error — módulo JS sin tipos
import { explainBot, capitalPerPosition, leverageText, slOrderOpen, beState } from "../src/lib/armView";

// (Fase 6-D) Congela las frases de explainBot y los helpers compartidos. Frontend-puro: deriva 1:1 del
// estado del backend, no inventa SL ni motivo de fallo.

const bot = (over: any = {}) => ({ baseAsset: "ETH", active: true, autoLeverage: false, leverage: 5, ...over });
const armWaiting = (over: any = {}) => ({
  status: "armed", side: "Short", lowerEdge: 1600, upperEdge: 1700,
  appliedLeverage: 5, reservedNotional: 1000, allowReentryFromAbove: false, orders: [], ...over,
});

describe("helpers compartidos", () => {
  it("capitalPerPosition: 2 entradas sin reducir → /2; reducido → tal cual", () => {
    expect(capitalPerPosition({ reservedNotional: 1000, allowReentryFromAbove: true, reservationReduced: false })).toBe(500);
    expect(capitalPerPosition({ reservedNotional: 1000, allowReentryFromAbove: true, reservationReduced: true })).toBe(1000);
    expect(capitalPerPosition({ reservedNotional: 1000, allowReentryFromAbove: false })).toBe(1000);
    expect(capitalPerPosition(null)).toBeNull();
  });

  it("leverageText: auto/manual", () => {
    expect(leverageText({ autoLeverage: true }, { appliedLeverage: 12 })).toBe("Auto · 12x");
    expect(leverageText({ autoLeverage: true, leverage: 10 }, {})).toBe("Auto");  // lev del bot, sin arm aún
    expect(leverageText({ autoLeverage: false, leverage: 5 }, null)).toBe("5x");
    expect(leverageText({ autoLeverage: true }, {})).toBe("");                     // sin lev en ningún lado
  });

  it("slOrderOpen / beState: usa la orden SL abierta real, nunca infiere", () => {
    const arm = { entryPrice: 2000, beMoved: true, orders: [{ role: "sl_upper", observedStatus: "open", triggerPx: 2001 }] };
    const sl = slOrderOpen(arm);
    expect(sl?.triggerPx).toBe(2001);
    expect(beState(arm, sl)).toBe("be");                       // 2001 ≤ 2000·1.001
    expect(beState({ ...arm, beMoved: false }, sl)).toBeNull();
    expect(beState({ entryPrice: 2000, beMoved: true, orders: [{ role: "sl_upper", observedStatus: "open", triggerPx: 2100 }] },
      { triggerPx: 2100 })).toBe("be_pending");
  });
});

describe("explainBot", () => {
  it("esperando trigger: frase de espera + short", () => {
    const lines = explainBot(bot(), armWaiting(), null, null);
    expect(lines[0]).toBe("Esperando a que ETH toque $1,600 o $1,700.");
    expect(lines[1]).toContain("Si perfora abajo, cubro un short de ≈$1,000");
    expect(lines.some((l: string) => l.startsWith("Capital por posición:"))).toBe(true);
  });

  it("unknown: rama top-level 'Verificando la cobertura…' (antes inalcanzable)", () => {
    const lines = explainBot(bot(), { status: "unknown", reservedNotional: 1000, orders: [] }, null, null);
    expect(lines).toContain("Verificando la cobertura…");
  });

  it("posición abierta con SL real: muestra el SL de la orden, no inferido", () => {
    const arm = { status: "protected", side: "Short", entryPrice: 2000, reservedNotional: 1000,
      beMoved: false, orders: [{ role: "sl_upper", observedStatus: "open", triggerPx: 2100 }] };
    const lines = explainBot(bot(), arm, null, null);
    expect(lines[0]).toBe("Short de ETH abierto en ≈$2,000.");
    expect(lines[1]).toBe("Protección en ≈$2,100.");
  });

  it("protecting sin SL abierto: 'Colocando la protección…' (no inventa SL)", () => {
    const lines = explainBot(bot(), { status: "protecting", entryPrice: 2000, reservedNotional: 1000, orders: [] }, null, null);
    expect(lines).toContain("Colocando la protección…");
    expect(lines.some((l: string) => l.includes("Protección en"))).toBe(false);
  });

  it("failed: solo 'El último armado falló' (sin motivo inventado)", () => {
    const lines = explainBot(bot(), { status: "failed", reservedNotional: 1000, orders: [] }, null, null);
    expect(lines).toContain("El último armado falló.");
  });

  it("auto-rearm: añade la nota solo si bot.autoRearm y no failed", () => {
    expect(explainBot(bot({ autoRearm: true }), armWaiting(), null, null))
      .toContain("Si cierra por SL, reintento la cobertura en ~5 min.");
    expect(explainBot(bot({ autoRearm: true }), { status: "failed", reservedNotional: 1000, orders: [] }, null, null))
      .not.toContain("Si cierra por SL, reintento la cobertura en ~5 min.");
  });

  it("sin arm: blocked / pausado / esperando (no maquilla)", () => {
    expect(explainBot(bot({ rearmStatus: "blocked", lastRearmErrorKind: "blocked_margin" }), null, null, null))
      .toContain("Bloqueado: blocked_margin. Revisa margen o plan.");
    expect(explainBot(bot({ active: false }), null, null, null)).toContain("Pausado.");
    expect(explainBot(bot(), null, null, null)).toContain("Esperando para armar la cobertura.");
  });

  it("margen incluye 'disponible' si hay saldo HL", () => {
    const lines = explainBot(bot(), armWaiting(), null, { spotUsdcFree: 5000 });
    expect(lines.some((l: string) => l.includes("Capital por posición: $1,000 · disponible $5,000"))).toBe(true);
  });
});
