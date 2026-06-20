import { describe, it, expect } from "vitest";
import { toHlCloid, spotGridCloidInput } from "../convex/cloids";
import {
  resolveSpotAssetFromMeta,
  roundSpotPrice,
  formatSpotPrice,
  floorSpotSize,
  assertMinNotional,
  roundAndValidateSpotOrder,
  buildSpotLimitOrder,
  withSpotTimeout,
  getSpotPrice,
  placeSpotLimit,
  SPOT_ASSET_ID_OFFSET,
} from "../convex/hyperliquidSpot";

// spotMeta sintético: mainnet expone UBTC/UETH; testnet expone BTC. USDC es el token quote (idx 0).
const META_MAINNET = {
  tokens: [
    { name: "USDC", szDecimals: 8, index: 0 },
    { name: "UBTC", szDecimals: 5, index: 1 },
    { name: "UETH", szDecimals: 4, index: 2 },
    { name: "PURR", szDecimals: 0, index: 3 },
  ],
  universe: [
    { tokens: [3, 0], name: "PURR/USDC", index: 0, isCanonical: true },
    { tokens: [1, 0], name: "UBTC/USDC", index: 107, isCanonical: true },
    { tokens: [2, 0], name: "UETH/USDC", index: 120, isCanonical: true },
  ],
};

const META_TESTNET = {
  tokens: [
    { name: "USDC", szDecimals: 8, index: 0 },
    { name: "BTC", szDecimals: 5, index: 1 },
  ],
  universe: [{ tokens: [1, 0], name: "BTC/USDC", index: 3, isCanonical: true }],
};

describe("toHlCloid", () => {
  it("devuelve 0x + 32 hex chars (16 bytes), NO el SHA-256 completo (64 hex)", async () => {
    const cloid = await toHlCloid(spotGridCloidInput("bot1", 1, 0, 5, "buy"));
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it("es determinista (mismo input → mismo cloid)", async () => {
    const input = spotGridCloidInput("bot1", 1, 0, 5, "buy");
    expect(await toHlCloid(input)).toBe(await toHlCloid(input));
  });

  it("distingue por generation y cycleId (no colisiona en reposición del mismo nivel)", async () => {
    const a = await toHlCloid(spotGridCloidInput("bot1", 1, 0, 5, "buy"));
    const b = await toHlCloid(spotGridCloidInput("bot1", 1, 1, 5, "buy")); // otro cycleId
    const c = await toHlCloid(spotGridCloidInput("bot1", 2, 0, 5, "buy")); // otra generation
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("resolveSpotAssetFromMeta", () => {
  it("mainnet: BTC → UBTC/USDC con assetId = 10000 + universeIndex", () => {
    const r = resolveSpotAssetFromMeta(META_MAINNET, "BTC", "mainnet");
    expect(r.baseAsset).toBe("UBTC");
    expect(r.quoteAsset).toBe("USDC");
    expect(r.assetId).toBe(SPOT_ASSET_ID_OFFSET + 107);
    expect(r.szDecimals).toBe(5);
  });

  it("mainnet: ETH → UETH/USDC", () => {
    const r = resolveSpotAssetFromMeta(META_MAINNET, "ETH", "mainnet");
    expect(r.baseAsset).toBe("UETH");
    expect(r.assetId).toBe(SPOT_ASSET_ID_OFFSET + 120);
  });

  it("testnet: BTC → BTC/USDC (símbolo distinto a mainnet)", () => {
    const r = resolveSpotAssetFromMeta(META_TESTNET, "BTC", "testnet");
    expect(r.baseAsset).toBe("BTC");
    expect(r.assetId).toBe(SPOT_ASSET_ID_OFFSET + 3);
  });

  it("rechaza activo fuera de la allowlist", () => {
    expect(() => resolveSpotAssetFromMeta(META_MAINNET, "DOGE", "mainnet")).toThrow(/no permitido/);
  });

  it("rechaza par inexistente en la red (mainnet no tiene BTC nativo)", () => {
    const onlyUnitless = { tokens: [{ name: "USDC", szDecimals: 8, index: 0 }], universe: [] };
    expect(() => resolveSpotAssetFromMeta(onlyUnitless, "BTC", "mainnet")).toThrow(/no encontrado/);
  });

  it("(Codex #1-pr1) resuelve por token.index aunque el array de tokens NO sea contiguo", () => {
    // index con huecos y desordenados respecto a la posición del array.
    const metaGaps = {
      tokens: [
        { name: "UETH", szDecimals: 4, index: 200 },
        { name: "UBTC", szDecimals: 5, index: 50 },
        { name: "USDC", szDecimals: 8, index: 0 },
      ],
      universe: [
        { tokens: [50, 0], name: "UBTC/USDC", index: 9, isCanonical: true }, // base index=50 → UBTC
      ],
    };
    const r = resolveSpotAssetFromMeta(metaGaps, "BTC", "mainnet");
    expect(r.baseAsset).toBe("UBTC");
    expect(r.szDecimals).toBe(5);
    expect(r.assetId).toBe(SPOT_ASSET_ID_OFFSET + 9);
  });
});

describe("redondeo spot", () => {
  it("roundSpotPrice floor ≤ price y ceil ≥ price", () => {
    const f = roundSpotPrice(65432.1, 5, "floor");
    const c = roundSpotPrice(65432.1, 5, "ceil");
    expect(f).toBeLessThanOrEqual(65432.1);
    expect(c).toBeGreaterThanOrEqual(65432.1);
  });

  it("respeta 5 cifras significativas en precios grandes", () => {
    // 65432.1 → 5 sig figs → 65432 (tick = 1)
    expect(roundSpotPrice(65432.1, 5, "floor")).toBe(65432);
  });

  it("floorSpotSize trunca hacia abajo a szDecimals", () => {
    expect(floorSpotSize(0.123456, 4)).toBe(0.1234);
    expect(floorSpotSize(1.999999, 2)).toBe(1.99);
  });

  it("(Codex MEDIO-pr1-r3) INVARIANTE: floorSpotSize(size) <= size SIEMPRE (nunca redondea al alza)", () => {
    // Casos límite que el redondeo de ruido rompía: valores apenas por DEBAJO de un tick → floor, no ceil.
    expect(floorSpotSize(1.999999999, 2)).toBe(1.99);
    expect(floorSpotSize(0.000009999999999, 5)).toBe(0);
    for (const [size, dec] of [[1.999999999, 2], [0.000009999999999, 5], [0.123456, 4], [65432.1, 5], [0.07, 2]] as const) {
      expect(floorSpotSize(size, dec)).toBeLessThanOrEqual(size);
    }
  });

  it("roundSpotPrice rechaza price ≤ 0", () => {
    expect(() => roundSpotPrice(0, 5, "floor")).toThrow();
  });
});

describe("assertMinNotional", () => {
  it("acepta nocional ≥ mínimo", () => {
    expect(() => assertMinNotional(100, 0.2)).not.toThrow(); // $20
  });
  it("rechaza nocional < mínimo", () => {
    expect(() => assertMinNotional(100, 0.05)).toThrow(/mínimo/); // $5
  });
});

describe("roundAndValidateSpotOrder (Codex #2-pr1: valida post-redondeo)", () => {
  it("redondea BUY→floor / SELL→ceil y devuelve strings finales", () => {
    const buy = roundAndValidateSpotOrder({ price: 65432.1, size: 0.01, szDecimals: 5, isBuy: true });
    expect(buy.price).toBeLessThanOrEqual(65432.1);
    expect(buy.priceStr).toBe(String(buy.price));
    const sell = roundAndValidateSpotOrder({ price: 65432.1, size: 0.01, szDecimals: 5, isBuy: false });
    expect(sell.price).toBeGreaterThanOrEqual(65432.1);
  });

  it("raw PASA el min-notional pero FINAL falla tras truncar el size", () => {
    // raw: 100 * 0.1 = $10 (pasa). Pero szDecimals=0 trunca 0.1 → 0 → nocional final $0 (falla).
    expect(() => assertMinNotional(100, 0.1)).not.toThrow();
    expect(() =>
      roundAndValidateSpotOrder({ price: 100, size: 0.1, szDecimals: 0, isBuy: true }),
    ).toThrow(/mínimo/);
  });
});

describe("withSpotTimeout (Codex #3-pr1-r2: timeout local SIEMPRE)", () => {
  it("sin signal del caller: provee signal local + expiresAfter futuro", () => {
    const t = withSpotTimeout();
    expect(t.signal).toBeInstanceOf(AbortSignal);
    expect(t.signal.aborted).toBe(false);
    expect(t.expiresAfter).toBeGreaterThan(Date.now());
    t.clear();
  });

  it("con signal del caller: aborta si el CALLER aborta (signal combinado)", () => {
    const caller = new AbortController();
    const t = withSpotTimeout({ signal: caller.signal });
    expect(t.signal.aborted).toBe(false);
    caller.abort(new Error("lease perdido"));
    expect(t.signal.aborted).toBe(true); // el combinado refleja el abort del caller
    t.clear();
  });

  it("respeta expiresAfter explícito del caller", () => {
    const exp = Date.now() + 12345;
    const t = withSpotTimeout({ expiresAfter: exp });
    expect(t.expiresAfter).toBe(exp);
    t.clear();
  });
});

describe("getSpotPrice (Codex BAJO-pr1: alinea ctxs por POSICIÓN del universe, no por index)", () => {
  // universe.index con huecos/desordenados; ctxs alineados por posición del array (no por index).
  const meta = {
    tokens: [
      { name: "USDC", szDecimals: 8, index: 0 },
      { name: "UBTC", szDecimals: 5, index: 50 },
      { name: "UETH", szDecimals: 4, index: 200 },
    ],
    universe: [
      { tokens: [200, 0], name: "UETH/USDC", index: 120 }, // pos 0
      { tokens: [50, 0], name: "UBTC/USDC", index: 107 },  // pos 1
    ],
  };

  it("lee ctxs[posición], no ctxs[universeIndex]", async () => {
    const ctxs = [{ midPx: "3000" }, { midPx: "65000" }]; // pos 0→UETH, pos 1→UBTC
    const info: any = { spotMetaAndAssetCtxs: async () => [meta, ctxs] };
    const btc = resolveSpotAssetFromMeta(meta, "BTC", "mainnet"); // UBTC, universeIndex 107 (pos 1)
    // Si usara ctxs[107] sería undefined → NaN → throw. Debe tomar ctxs[1] = 65000.
    expect(await getSpotPrice(info, btc)).toBe(65000);
  });

  it("usa markPx si midPx no está disponible", async () => {
    const ctxs = [{ midPx: "3000" }, { markPx: "64000" }];
    const info: any = { spotMetaAndAssetCtxs: async () => [meta, ctxs] };
    const btc = resolveSpotAssetFromMeta(meta, "BTC", "mainnet");
    expect(await getSpotPrice(info, btc)).toBe(64000);
  });
});

describe("placeSpotLimit (Codex MEDIO-pr1: revalida min-notional)", () => {
  it("rechaza nocional < mínimo SIN llamar a exchange.order", async () => {
    let called = false;
    const exchange: any = { order: async () => { called = true; return {}; } };
    await expect(
      placeSpotLimit(exchange, {
        assetId: 10107, isBuy: true, priceStr: "100", sizeStr: "0.05", // $5 < $10
        cloid: "0x00112233445566778899aabbccddeeff",
      }),
    ).rejects.toThrow(/mínimo/);
    expect(called).toBe(false);
  });

  it("(CodeRabbit #93) rechaza price/size inválidos (negativos) aunque el notional salga positivo", async () => {
    let called = false;
    const exchange: any = { order: async () => { called = true; return {}; } };
    await expect(
      placeSpotLimit(exchange, {
        assetId: 10107, isBuy: true, priceStr: "-100", sizeStr: "-1", // (-100)*(-1)=100 ≥ mín, pero inválido
        cloid: "0x00112233445566778899aabbccddeeff",
      }),
    ).rejects.toThrow(/inválidos/);
    expect(called).toBe(false);
  });
});

describe("buildSpotLimitOrder", () => {
  it("LIMIT GTC sin reduceOnly ni trigger, con cloid", () => {
    const o = buildSpotLimitOrder({
      assetId: 10107,
      isBuy: true,
      priceStr: "65000",
      sizeStr: "0.001",
      cloid: "0x00112233445566778899aabbccddeeff",
    });
    expect(o.grouping).toBe("na");
    const ord = o.orders[0];
    expect(ord.a).toBe(10107);
    expect(ord.b).toBe(true);
    expect(ord.r).toBe(false);
    expect(ord.t).toEqual({ limit: { tif: "Gtc" } });
    expect(ord.c).toBe("0x00112233445566778899aabbccddeeff");
  });

  it("formatSpotPrice devuelve string", () => {
    expect(typeof formatSpotPrice(65432.1, 5, "floor")).toBe("string");
  });
});
