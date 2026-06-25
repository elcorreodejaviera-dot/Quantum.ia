import { describe, it, expect } from "vitest";
import { isFlatOrDust, DUST_NOTIONAL_USD } from "../convex/hyperliquid";

// (JAV-113) El umbral de "dust": un residuo cuyo nocional cae por debajo del mínimo de orden de HL
// (~$10) es intradeable → se trata como posición PLANA. Esto evita que un remanente de redondeo
// (p.ej. 0.0001 ETH ≈ $0.16 que HL deja al cerrar) deje el arm "abierto" para siempre.
describe("isFlatOrDust — umbral de dust de posición", () => {
  it("szi exactamente 0 → flat", () => {
    expect(isFlatOrDust(0, 1630)).toBe(true);
  });

  it("dust real de benjamin (0.0001 ETH @ 1630 ≈ $0.16) → flat", () => {
    expect(isFlatOrDust(-0.0001, 1630)).toBe(true);
  });

  it("posición de cobertura real (2.7739 ETH @ 1630 ≈ $4521) → NO flat", () => {
    expect(isFlatOrDust(-2.7739, 1630)).toBe(false);
  });

  it("justo por debajo del umbral ($9.99) → flat; en/sobre el umbral ($10) → NO flat", () => {
    expect(isFlatOrDust(9.99 / 1630, 1630)).toBe(true);
    expect(isFlatOrDust(DUST_NOTIONAL_USD / 1630, 1630)).toBe(false);
  });

  it("markPx inválido (0/NaN/negativo) → solo szi===0 cuenta como flat (estricto, no falsea reales)", () => {
    expect(isFlatOrDust(0, 0)).toBe(true);
    expect(isFlatOrDust(0.0001, 0)).toBe(false);
    expect(isFlatOrDust(0.0001, NaN)).toBe(false);
    expect(isFlatOrDust(0.0001, -5)).toBe(false);
  });

  it("signo del szi no importa (posición short = szi negativo)", () => {
    expect(isFlatOrDust(0.0001, 1630)).toBe(isFlatOrDust(-0.0001, 1630));
  });
});
