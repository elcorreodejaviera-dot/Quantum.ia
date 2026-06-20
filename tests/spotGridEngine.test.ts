import { describe, it, expect } from "vitest";
import { calculateGridLevels } from "../convex/spotGridEngine";

// (JAV-92) Niveles del grid: geométrico, profit NETO post-rounding ≥ objetivo, min-notional, loop acotado.

describe("calculateGridLevels (JAV-92)", () => {
  const base = { currentPrice: 3000, minPrice: 2000, gridProfitPercent: 1, orderSize: 100, gridCount: 5, szDecimals: 4, feeRate: 0.0004 };

  it("genera niveles geométricos descendentes, todos ≥ minPrice y SELL > BUY", () => {
    const { levels } = calculateGridLevels(base);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.length).toBeLessThanOrEqual(base.gridCount);
    let prev = Infinity;
    for (const l of levels) {
      expect(l.buyPrice).toBeGreaterThanOrEqual(base.minPrice);
      expect(l.buyPrice).toBeLessThan(prev);   // descendente
      prev = l.buyPrice;
      expect(l.sellPrice).toBeGreaterThan(l.buyPrice);
      expect(l.buyPrice * l.quantity).toBeGreaterThanOrEqual(10);   // min-notional BUY
      expect(l.sellPrice * l.quantity).toBeGreaterThanOrEqual(10);  // min-notional SELL
    }
  });

  it("el NETO tras fees buy+sell cubre el objetivo en cada nivel", () => {
    const { levels } = calculateGridLevels(base);
    const target = base.orderSize * (base.gridProfitPercent / 100);
    for (const l of levels) {
      const net = (l.sellPrice - l.buyPrice) * l.quantity - base.feeRate * (l.buyPrice + l.sellPrice) * l.quantity;
      expect(net).toBeGreaterThanOrEqual(target - 1e-9);
    }
  });

  it("no baja de minPrice (suelo del grid)", () => {
    const { levels } = calculateGridLevels({ ...base, minPrice: 2950 });
    for (const l of levels) expect(l.buyPrice).toBeGreaterThanOrEqual(2950);
  });

  it("rechaza niveles antieconómicos (orderSize bajo el min-notional)", () => {
    const { levels, rejected } = calculateGridLevels({ ...base, orderSize: 5 });   // 5 < $10 mínimo
    expect(levels.length).toBe(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it("inputs inválidos → sin niveles (no lanza)", () => {
    expect(calculateGridLevels({ ...base, gridProfitPercent: 0 }).levels.length).toBe(0);
    expect(calculateGridLevels({ ...base, currentPrice: 0 }).levels.length).toBe(0);
  });
});
