import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedBase } from "./fixtures";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-92) Idempotencia y fencing de las mutations del motor (NON-node). El contrato money-path crítico:
// recordSpotGridOrder no duplica; closeCycleAndRepost no cierra dos veces la misma SELL; lease fencing.

async function seedGridBot(ctx: MutationCtx, over: any = {}) {
  const base = await seedBase(ctx);
  const now = Date.now();
  const botId = await ctx.db.insert("spot_grid_bots", {
    userId: base.userId, hlAccountId: base.hlAccountId, symbol: "ETH", assetId: 10120,
    baseAsset: "UETH", quoteAsset: "USDC", minPrice: 2000, gridProfitPercent: 1, investmentAmount: 100,
    orderSize: 100, gridCount: 5, feeRate: 0.0004, status: "running", network: "testnet",
    generation: 1, createdAt: now, updatedAt: now, ...over,
  });
  return { ...base, botId };
}
async function seedOrder(ctx: MutationCtx, botId: Id<"spot_grid_bots">, userId: Id<"users">, cloid: string, over: any = {}) {
  const now = Date.now();
  return await ctx.db.insert("spot_grid_orders", {
    botId, userId, cloid, assetId: 10120, side: "buy", price: 2900, quantity: 0.03, quoteSize: 87,
    gridLevel: 0, generation: 1, cycleId: 0, status: "open", createdAt: now, ...over,
  });
}

describe("recordSpotGridOrder — idempotencia + fencing (JAV-92)", () => {
  it("lookup-before-insert: dos llamadas iguales NO duplican", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx));
    const claim = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    const args = { botId, token: claim.token!, side: "buy" as const, gridLevel: 0, generation: 1, cycleId: 0,
      assetId: 10120, price: 2900, quantity: 0.03, quoteSize: 87 };
    const r1 = await t.mutation(internal.spotGridBots.recordSpotGridOrder, args);
    const r2 = await t.mutation(internal.spotGridBots.recordSpotGridOrder, args);
    expect(r2.existed).toBe(true);
    expect(r2.orderId).toEqual(r1.orderId);
    const count = await t.run((ctx) => ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", r1.cloid!)).collect()).then((a) => a.length);
    expect(count).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(r1.orderId!)))?.status).toBe("submitting");   // DB-intent
  });

  it("fencing: token ajeno → no-op", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx));
    await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    const r = await t.mutation(internal.spotGridBots.recordSpotGridOrder, { botId, token: "intruso", side: "buy", gridLevel: 0, generation: 1, cycleId: 0, assetId: 10120, price: 2900, quantity: 0.03, quoteSize: 87 });
    expect(r.ok).toBe(false);
    // (CodeRabbit #99) el no-op por fencing NO debe escribir en DB.
    const count = (await t.run((ctx) => ctx.db.query("spot_grid_orders").collect())).length;
    expect(count).toBe(0);
  });
});

describe("closeCycleAndRepost — idempotente por SELL consumida (JAV-92 ALTO#3)", () => {
  it("doble fill de la MISMA SELL → un solo ciclo + una sola BUY de reposición", async () => {
    const t = makeConvexTest();
    const { botId, sellCloid } = await t.run(async (ctx) => {
      const s = await seedGridBot(ctx);
      const buyId = await seedOrder(ctx, s.botId, s.userId, "0xbuy", { side: "buy", price: 2900, quantity: 0.03, status: "filled", filledQty: 0.03, avgFillPx: 2900 });
      await seedOrder(ctx, s.botId, s.userId, "0xsell", { side: "sell", price: 2930, quantity: 0.03, status: "filled", filledQty: 0.03, avgFillPx: 2930, pairedOrderId: buyId, cycleId: 0 });
      return { ...s, sellCloid: "0xsell" };
    });
    const claim = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    const token = claim.token!;
    const r1 = await t.mutation(internal.spotGridBots.closeCycleAndRepost, { botId, token, sellCloid, feesUsd: 0.02 });
    const r2 = await t.mutation(internal.spotGridBots.closeCycleAndRepost, { botId, token, sellCloid, feesUsd: 0.02 });
    expect(r1.alreadySettled).toBeUndefined();
    expect(r2.alreadySettled).toBe(true);   // segundo procesado = no-op
    const cycles = await t.run((ctx) => ctx.db.query("spot_grid_cycles").withIndex("by_bot", (q) => q.eq("botId", botId)).collect());
    expect(cycles.length).toBe(1);                       // un solo ciclo
    expect(cycles[0].netProfit).toBeCloseTo((2930 - 2900) * 0.03 - 0.02, 6);
    const reposts = await t.run((ctx) => ctx.db.query("spot_grid_orders").withIndex("by_bot_status", (q) => q.eq("botId", botId).eq("status", "submitting")).collect());
    expect(reposts.length).toBe(1);                      // una sola BUY de reposición
    expect(reposts[0].cycleId).toBe(1);                  // nuevo cycleId
  });
});

describe("SELL por tranche — varias del mismo BUY NO colisionan (JAV-92 r2#1/r3#2)", () => {
  it("recordSpotGridOrder con tranche distinto → cloid distinto, dos órdenes", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx));
    const token = (await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId })).token!;
    const common = { botId, token, side: "sell" as const, gridLevel: 0, generation: 1, cycleId: 0, assetId: 10120, price: 2950, quantity: 0.03, quoteSize: 88.5 };
    const r0 = await t.mutation(internal.spotGridBots.recordSpotGridOrder, { ...common, tranche: 0 });
    const r1 = await t.mutation(internal.spotGridBots.recordSpotGridOrder, { ...common, tranche: 1 });
    expect(r1.existed).toBe(false);
    expect(r0.cloid).not.toEqual(r1.cloid);   // tranche distinto → cloid distinto (sin colisión)
    const subs = await t.run((ctx) => ctx.db.query("spot_grid_orders").withIndex("by_bot_status", (q) => q.eq("botId", botId).eq("status", "submitting")).collect());
    expect(subs.length).toBe(2);
  });
});

describe("netProfit por tranche usa costBasis, no el VWAP del BUY (JAV-92 r4)", () => {
  it("una SELL con costBasis propio liquida el ciclo con ESE costo, no el avgFillPx del BUY", async () => {
    const t = makeConvexTest();
    const { botId, sellCloid } = await t.run(async (ctx) => {
      const s = await seedGridBot(ctx);
      // BUY con VWAP total 2900 (mezcla barato+caro), pero ESTE tranche se compró a 2950.
      const buyId = await seedOrder(ctx, s.botId, s.userId, "0xbuyT", { side: "buy", price: 2900, quantity: 0.06, status: "partially_filled", filledQty: 0.06, avgFillPx: 2900 });
      await seedOrder(ctx, s.botId, s.userId, "0xsellT", { side: "sell", price: 3000, quantity: 0.03, status: "filled", filledQty: 0.03, avgFillPx: 3000, pairedOrderId: buyId, cycleId: 0, costBasis: 2950 });
      return { ...s, sellCloid: "0xsellT" };
    });
    const token = (await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId })).token!;
    await t.mutation(internal.spotGridBots.closeCycleAndRepost, { botId, token, sellCloid, feesUsd: 0.01 });
    const cyc = await t.run((ctx) => ctx.db.query("spot_grid_cycles").withIndex("by_bot", (q) => q.eq("botId", botId)).first());
    // netProfit con costBasis 2950 (NO 2900): (3000-2950)*0.03 - 0.01 = 1.49 (no 2.99).
    expect(cyc?.buyPrice).toBe(2950);
    expect(cyc?.netProfit).toBeCloseTo((3000 - 2950) * 0.03 - 0.01, 6);
  });
});

describe("gate live — red HL efectiva ≠ bot.network (JAV-92 ALTO#4/r3#1)", () => {
  it("HL_NETWORK del backend distinta a la del bot → paused/network_mismatch", async () => {
    const prev = process.env.HL_NETWORK;
    process.env.HL_NETWORK = "testnet";
    try {
      const t = makeConvexTest();
      const botId = await t.run(async (ctx: MutationCtx) => {
        const base = await seedBase(ctx);
        await ctx.db.insert("user_permissions", { userId: base.userId, permission: "canTradeLive", granted: true, grantedAt: Date.now() });
        await ctx.db.insert("system_config", { key: "tradingEnabled", value: true });
        await ctx.db.insert("system_config", { key: "simulationMode", value: false });
        const now = Date.now();
        return await ctx.db.insert("spot_grid_bots", {
          userId: base.userId, hlAccountId: base.hlAccountId, symbol: "BTC", assetId: 10107, baseAsset: "UBTC",
          quoteAsset: "USDC", minPrice: 50000, gridProfitPercent: 1, investmentAmount: 100, orderSize: 100,
          gridCount: 5, feeRate: 0.0004, status: "running", network: "mainnet", generation: 1, createdAt: now, updatedAt: now,
        });
      });
      const r: any = await t.query(internal.spotGridBots.assertSpotGridLiveAdmissibleInternal, { botId });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("network_mismatch");
      expect(r.policy).toBe("paused");
    } finally {
      if (prev === undefined) delete process.env.HL_NETWORK; else process.env.HL_NETWORK = prev;
    }
  });
});
