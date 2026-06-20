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
