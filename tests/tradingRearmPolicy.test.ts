import { describe, it, expect } from "vitest";
import { tradingRearmDelayMs, TR_REARM_ACCEL_MS, TR_REARM_NORMAL_MS } from "../convex/tradingReconcileCore";

// (JAV-179 / PR3) Política de backoff del auto-rearm del trading (plan JAV-176, preocupación
// explícita de Javier: HL tarda en liberar margen tras un cierre con poco capital flotante).

describe("tradingRearmDelayMs — blocked_margin ACELERADO 90s×3 → 5min; el resto JAMÁS acelera", () => {
  it("blocked_margin: intentos 0/1/2 ⇒ 90s; 3+ ⇒ 5 min indefinido", () => {
    expect(tradingRearmDelayMs("blocked_margin", 0)).toBe(TR_REARM_ACCEL_MS);
    expect(tradingRearmDelayMs("blocked_margin", 1)).toBe(TR_REARM_ACCEL_MS);
    expect(tradingRearmDelayMs("blocked_margin", 2)).toBe(TR_REARM_ACCEL_MS);
    expect(tradingRearmDelayMs("blocked_margin", 3)).toBe(TR_REARM_NORMAL_MS);
    expect(tradingRearmDelayMs("blocked_margin", 50)).toBe(TR_REARM_NORMAL_MS);
  });

  it("blocked_cap NUNCA entra al backoff acelerado (JAV-176-P6: el cap de plan no es settlement de HL)", () => {
    for (const attempts of [0, 1, 2, 3, 10]) {
      expect(tradingRearmDelayMs("blocked_cap", attempts)).toBe(TR_REARM_NORMAL_MS);
    }
  });

  it("blocked_config / transient / retry_incompatible ⇒ cadencia normal 5 min", () => {
    expect(tradingRearmDelayMs("blocked_config", 0)).toBe(TR_REARM_NORMAL_MS);
    expect(tradingRearmDelayMs("transient", 0)).toBe(TR_REARM_NORMAL_MS);
    expect(tradingRearmDelayMs("retry_incompatible", 0)).toBe(TR_REARM_NORMAL_MS);
  });

  it("constantes del plan: 90s y 5 min exactos", () => {
    expect(TR_REARM_ACCEL_MS).toBe(90_000);
    expect(TR_REARM_NORMAL_MS).toBe(5 * 60_000);
  });
});
