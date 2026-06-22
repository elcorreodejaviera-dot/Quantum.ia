import { describe, it, expect } from "vitest";
import { calculateGridLevels, deriveAutoGrid, floorQuoteForBudget, pickInitialPlacementPrice,
  calculateSellLadder, deriveSeededGrid, allocateSeededSells } from "../convex/spotGridEngine";

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

// (JAV-101, Codex MEDIO) pickInitialPlacementPrice: SOLO auto-grids con ancla válida usan el precio de
// creación; manual/legacy/corrupto refrescan en vivo (null). Garantiza prometido==colocado sin reabrir #103.
describe("pickInitialPlacementPrice (JAV-101)", () => {
  const NOW = 1_700_000_000_000;
  const fresh = NOW - 30_000;            // creado hace 30 s → dentro de la ventana de frescura
  it("auto-grid fresco con currentPrice > minPrice → ancla a currentPrice", () => {
    expect(pickInitialPlacementPrice({ autoDerived: true, currentPrice: 64000, minPrice: 45000, _creationTime: fresh }, NOW)).toBe(64000);
  });
  it("auto-grid con ancla corrupta (currentPrice ≤ minPrice, p.ej. ~0) → null (refresca en vivo)", () => {
    expect(pickInitialPlacementPrice({ autoDerived: true, currentPrice: 0.000069, minPrice: 45000, _creationTime: fresh }, NOW)).toBeNull();
    expect(pickInitialPlacementPrice({ autoDerived: true, currentPrice: 45000, minPrice: 45000, _creationTime: fresh }, NOW)).toBeNull();
  });
  it("manual (autoDerived false) o legacy (undefined) → null (refresca en vivo, preserva #103)", () => {
    expect(pickInitialPlacementPrice({ autoDerived: false, currentPrice: 64000, minPrice: 45000, _creationTime: fresh }, NOW)).toBeNull();
    expect(pickInitialPlacementPrice({ currentPrice: 64000, minPrice: 45000, _creationTime: fresh }, NOW)).toBeNull();
  });
  it("auto sin currentPrice → null", () => {
    expect(pickInitialPlacementPrice({ autoDerived: true, minPrice: 45000, _creationTime: fresh }, NOW)).toBeNull();
  });
  it("(CodeRabbit) ancla VENCIDA (creación hace >5 min) o sin timestamp → null (refresca en vivo)", () => {
    const stale = NOW - 6 * 60 * 1000;   // creado hace 6 min → fuera de la ventana
    expect(pickInitialPlacementPrice({ autoDerived: true, currentPrice: 64000, minPrice: 45000, _creationTime: stale }, NOW)).toBeNull();
    expect(pickInitialPlacementPrice({ autoDerived: true, currentPrice: 64000, minPrice: 45000 }, NOW)).toBeNull();
  });

  it("CONTRATO ancla: auto-grid derivado a precio A coloca gridCount en A; a un precio B drifteado puede diferir", () => {
    const p = { currentPrice: 64000, gridProfitPercent: 1, szDecimals: 5, feeRate: 0.0004, minPrice: 45000, investmentAmount: 1200 };
    const d = deriveAutoGrid(p);
    // En el ANCLA (A=64000) el motor coloca EXACTAMENTE gridCount (lo que pickInitialPlacementPrice devuelve).
    const anchor = pickInitialPlacementPrice({ autoDerived: true, currentPrice: 64000, minPrice: 45000, _creationTime: fresh }, NOW)!;
    expect(anchor).toBe(64000);
    const atA = calculateGridLevels({ currentPrice: anchor, minPrice: p.minPrice, gridProfitPercent: p.gridProfitPercent, orderSize: d.orderSize, gridCount: d.gridCount, szDecimals: p.szDecimals, feeRate: p.feeRate });
    expect(atA.levels.length).toBe(d.gridCount);
    // A un precio B muy por debajo (drift), el mismo gridCount puede recortarse contra el suelo → justifica anclar.
    const atB = calculateGridLevels({ currentPrice: 47000, minPrice: p.minPrice, gridProfitPercent: p.gridProfitPercent, orderSize: d.orderSize, gridCount: d.gridCount, szDecimals: p.szDecimals, feeRate: p.feeRate });
    expect(atB.levels.length).toBeLessThan(d.gridCount);
  });
});

// (JAV-103) Siembra de inventario: calculateSellLadder / deriveSeededGrid / allocateSeededSells.
describe("calculateSellLadder (JAV-103)", () => {
  const btc = { currentPrice: 64000, gridProfitPercent: 0.7, szDecimals: 5 };

  it("niveles geométricos POR ENCIMA del precio, K exacto, con repostBuyPrice del nivel", () => {
    const { levels } = calculateSellLadder({ ...btc, orderSize: 20, sellCount: 5 });
    expect(levels.length).toBe(5);
    // monótono creciente y todos por encima del precio
    for (let i = 0; i < levels.length; i++) {
      expect(levels[i].sellPrice).toBeGreaterThan(btc.currentPrice);
      if (i > 0) expect(levels[i].sellPrice).toBeGreaterThan(levels[i - 1].sellPrice);
      expect(levels[i].sellPrice * levels[i].quantity).toBeGreaterThanOrEqual(10);
      // repostBuyPrice = sellPrice/step, justo por debajo del nivel de venta
      expect(levels[i].repostBuyPrice).toBeLessThan(levels[i].sellPrice);
    }
  });

  it("orderSize < min-notional → ningún nivel válido", () => {
    const { levels } = calculateSellLadder({ ...btc, orderSize: 5, sellCount: 5 });
    expect(levels.length).toBe(0);
  });
});

describe("deriveSeededGrid (JAV-103)", () => {
  const btc = { currentPrice: 64000, gridProfitPercent: 0.7, szDecimals: 5, feeRate: 0.0004 };

  it("reparte M compras + K ventas, M≥2/K≥2, M+K≤50, prometido==colocado en ambos lados", () => {
    const d = deriveSeededGrid({ ...btc, minPrice: 45000, investmentAmount: 1000 });
    expect(d.M).toBeGreaterThanOrEqual(2);
    expect(d.K).toBeGreaterThanOrEqual(2);
    expect(d.M + d.K).toBeLessThanOrEqual(50);
    expect(d.orderSize).toBeGreaterThanOrEqual(10);
    const buys = calculateGridLevels({ currentPrice: btc.currentPrice, minPrice: 45000, gridProfitPercent: btc.gridProfitPercent, orderSize: d.orderSize, gridCount: d.M, szDecimals: btc.szDecimals, feeRate: btc.feeRate });
    const sells = calculateSellLadder({ currentPrice: btc.currentPrice, gridProfitPercent: btc.gridProfitPercent, orderSize: d.orderSize, sellCount: d.K, szDecimals: btc.szDecimals });
    expect(buys.levels.length).toBe(d.M);
    expect(sells.levels.length).toBe(d.K);
    // seedQtyTarget = Σ qty de las ventas (la base a comprar en la semilla)
    expect(d.seedQtyTarget).toBeCloseTo(sells.levels.reduce((s, l) => s + l.quantity, 0), 10);
    expect(d.seedPercent).toBeGreaterThan(0);
    expect(d.seedPercent).toBeLessThan(1);
  });

  // (CodeRabbit JAV-103, Major) El peor caso (M BUYs reservadas + seed que llena con slippage máx 2%) NUNCA
  // debe superar investmentAmount: la derivación reparte sobre un presupuesto recortado por ese tope.
  it("peor caso M·orderSize + seedNotional·(1+2%) ≤ investmentAmount", () => {
    for (const investmentAmount of [500, 1000, 2500]) {
      const d = deriveSeededGrid({ ...btc, minPrice: 45000, investmentAmount });
      const buysLock = d.M * d.orderSize;
      const seedWorstCase = d.seedNotional * (1 + 0.02);
      expect(buysLock + seedWorstCase).toBeLessThanOrEqual(investmentAmount + 1e-9);
    }
  });

  it("capital insuficiente para ≥2 compras y ≥2 ventas → lanza", () => {
    expect(() => deriveSeededGrid({ ...btc, minPrice: 45000, investmentAmount: 30 })).toThrow(/[Cc]apital/);
  });

  it("minPrice ≥ currentPrice → lanza", () => {
    expect(() => deriveSeededGrid({ ...btc, minPrice: 64000, investmentAmount: 1000 })).toThrow(/suelo/);
  });
});

describe("allocateSeededSells (JAV-103)", () => {
  const btc = { currentPrice: 64000, gridProfitPercent: 0.7, szDecimals: 5 };

  it("reparte la base real en KReal niveles uniformes sin sobre-vender", () => {
    const seedQtyReal = 0.003;
    const a = allocateSeededSells({ ...btc, seedQtyReal, plannedK: 10 });
    expect(a.KReal).toBeGreaterThanOrEqual(2);
    expect(a.perLevelQty * a.KReal).toBeLessThanOrEqual(seedQtyReal + 1e-12);   // nunca sobre-vende (dust queda)
    for (const lv of a.levels) expect(lv.sellPrice * lv.quantity).toBeGreaterThanOrEqual(10);
  });

  it("base demasiado pequeña para ≥K_MIN ventas → KReal 0 (fail-closed)", () => {
    const a = allocateSeededSells({ ...btc, seedQtyReal: 0.0002, plannedK: 10 });   // ~$12.8: no fondea 2× $10
    expect(a.KReal).toBe(0);
  });
});
