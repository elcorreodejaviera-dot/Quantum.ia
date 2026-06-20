import { describe, it, expect } from "vitest";
import { calculateGridLevels, deriveAutoGrid, floorQuoteForBudget } from "../convex/spotGridEngine";

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

  it("el NETO tras fees buy+sell cubre el objetivo (p% del costo real del nivel)", () => {
    const { levels } = calculateGridLevels(base);
    for (const l of levels) {
      const target = l.quantity * l.buyPrice * (base.gridProfitPercent / 100);   // costo real, no orderSize bruto
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

// (JAV-101) floorQuoteForBudget: cents enteros → orderCents*n ≤ invCents SIEMPRE (sin ULP de float).
describe("floorQuoteForBudget (JAV-101)", () => {
  it("nunca supera el presupuesto en cents, incluso con investments 'feos'", () => {
    for (const [inv, n] of [[110.55, 3], [100.01, 5], [399, 37], [30, 3], [100, 5]] as const) {
      const { orderSize, orderCents, invCents } = floorQuoteForBudget(inv, n);
      expect(orderCents * n).toBeLessThanOrEqual(invCents);
      expect(orderSize).toBe(orderCents / 100);
    }
  });
  it("110.55/3 = 36.85 y 36.85*3 ≤ 110.55 en cents (el float daría 110.55000000000001)", () => {
    const { orderSize, orderCents, invCents } = floorQuoteForBudget(110.55, 3);
    expect(orderSize).toBe(36.85);
    expect(orderCents * 3).toBeLessThanOrEqual(invCents);   // 3685*3=11055 ≤ 11055
  });
});

// (JAV-101) deriveAutoGrid: nº de niveles auto desde el rango, oráculo == calculateGridLevels.
describe("deriveAutoGrid (JAV-101)", () => {
  // BTC-like: szDecimals 5, feeRate maker 0.0004.
  const btc = { currentPrice: 64000, gridProfitPercent: 1, szDecimals: 5, feeRate: 0.0004 };

  it("rango amplio con capital suficiente: cubre, no capped, prometido == colocado", () => {
    const d = deriveAutoGrid({ ...btc, minPrice: 45000, investmentAmount: 1200 });
    expect(d.gridCount).toBeGreaterThanOrEqual(2);
    expect(d.gridCount).toBeLessThanOrEqual(50);
    expect(d.capped).toBe(false);
    // el motor coloca EXACTAMENTE gridCount con el orderSize derivado
    const { levels } = calculateGridLevels({ currentPrice: btc.currentPrice, minPrice: 45000, gridProfitPercent: btc.gridProfitPercent, orderSize: d.orderSize, gridCount: d.gridCount, szDecimals: btc.szDecimals, feeRate: btc.feeRate });
    expect(levels.length).toBe(d.gridCount);
    expect(d.coveredFloor).toBe(levels[levels.length - 1].buyPrice);
    expect(d.orderSize).toBeGreaterThanOrEqual(10);
    expect(Math.ceil(d.orderSize * 100 - 1e-6) * d.gridCount).toBeLessThanOrEqual(Math.floor(1200 * 100 + 1e-6));
  });

  it("capital corto a 0.5%: capped, no llega al suelo, sigue colocando lo prometido", () => {
    const d = deriveAutoGrid({ ...btc, gridProfitPercent: 0.5, minPrice: 45000, investmentAmount: 399 });
    expect(d.capped).toBe(true);
    expect(d.coveredFloor).toBeGreaterThan(45000);   // no alcanza el suelo
    const { levels } = calculateGridLevels({ currentPrice: btc.currentPrice, minPrice: 45000, gridProfitPercent: 0.5, orderSize: d.orderSize, gridCount: d.gridCount, szDecimals: btc.szDecimals, feeRate: btc.feeRate });
    expect(levels.length).toBe(d.gridCount);
    expect(d.orderSize).toBeGreaterThanOrEqual(10);
  });

  it("tope ABS_MAX = 50 niveles", () => {
    const d = deriveAutoGrid({ ...btc, gridProfitPercent: 0.5, minPrice: 30000, investmentAmount: 5000 });
    expect(d.gridCount).toBeLessThanOrEqual(50);
  });

  it("minPrice ≥ currentPrice → lanza", () => {
    expect(() => deriveAutoGrid({ ...btc, minPrice: 64000, investmentAmount: 1000 })).toThrow(/suelo/);
    expect(() => deriveAutoGrid({ ...btc, minPrice: 70000, investmentAmount: 1000 })).toThrow(/suelo/);
  });

  it("rango demasiado estrecho (nFull<2) → lanza", () => {
    expect(() => deriveAutoGrid({ ...btc, gridProfitPercent: 0.5, minPrice: 63900, investmentAmount: 1000 })).toThrow(/estrecho/);
  });

  it("capital insuficiente (nCapital<2) → lanza", () => {
    expect(() => deriveAutoGrid({ ...btc, minPrice: 45000, investmentAmount: 15 })).toThrow(/[Cc]apital/);
  });

  it("gridProfitPercent fuera de [0.5,10] y valores no finitos → lanzan", () => {
    expect(() => deriveAutoGrid({ ...btc, gridProfitPercent: 0.3, minPrice: 45000, investmentAmount: 1000 })).toThrow();
    expect(() => deriveAutoGrid({ ...btc, gridProfitPercent: 11, minPrice: 45000, investmentAmount: 1000 })).toThrow();
    expect(() => deriveAutoGrid({ ...btc, minPrice: 45000, investmentAmount: Number.NaN })).toThrow();
    expect(() => deriveAutoGrid({ ...btc, feeRate: -1, minPrice: 45000, investmentAmount: 1000 })).toThrow();
  });

  it("feeRate alto reduce niveles pero mantiene prometido == colocado", () => {
    const d = deriveAutoGrid({ ...btc, feeRate: 0.005, minPrice: 45000, investmentAmount: 1200 });
    const { levels } = calculateGridLevels({ currentPrice: btc.currentPrice, minPrice: 45000, gridProfitPercent: btc.gridProfitPercent, orderSize: d.orderSize, gridCount: d.gridCount, szDecimals: btc.szDecimals, feeRate: 0.005 });
    expect(levels.length).toBe(d.gridCount);
  });
});
