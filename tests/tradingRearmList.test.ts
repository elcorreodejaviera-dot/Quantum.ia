import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedUser, seedPool } from "./fixtures";
import type { MutationCtx } from "../convex/_generated/server";

// (JAV-178) Separación ESTRICTA de los listados de rearm por kind: el cron IL (listRearmReadyBots)
// jamás reclama bots de trading, y processTradingRearms (listDueTradingRearmsInternal) jamás ve bots
// IL. Legacy `kind: undefined` = IL (bots anteriores a JAV-41).

async function seedRearmReadyBot(ctx: MutationCtx, kind: "il" | "trading" | undefined) {
  const userId = await seedUser(ctx);
  const poolId = await seedPool(ctx);
  return await ctx.db.insert("bots", {
    name: `bot-${kind ?? "legacy"}`, userId, poolId, baseAsset: "ETH",
    ...(kind !== undefined ? { kind } : {}),
    active: true, simulationMode: false, autoRearm: true,
    rearmStatus: "pending", nextRearmAt: Date.now() - 1000, rearmAttempts: 0,
  });
}

describe("separación de listados de rearm por kind", () => {
  it("listRearmReadyBots devuelve IL y legacy (undefined) pero EXCLUYE trading", async () => {
    const t = makeConvexTest();
    const { ilId, legacyId, tradingId } = await t.run(async (ctx) => ({
      ilId: await seedRearmReadyBot(ctx, "il"),
      legacyId: await seedRearmReadyBot(ctx, undefined),
      tradingId: await seedRearmReadyBot(ctx, "trading"),
    }));
    const ready = await t.query(internal.triggerRearm.listRearmReadyBots, {});
    expect(ready).toContain(ilId);
    expect(ready).toContain(legacyId);
    expect(ready).not.toContain(tradingId);
  });

  it("listDueTradingRearmsInternal devuelve SOLO trading", async () => {
    const t = makeConvexTest();
    const { ilId, legacyId, tradingId } = await t.run(async (ctx) => ({
      ilId: await seedRearmReadyBot(ctx, "il"),
      legacyId: await seedRearmReadyBot(ctx, undefined),
      tradingId: await seedRearmReadyBot(ctx, "trading"),
    }));
    const due = await t.query(internal.tradingBots.listDueTradingRearmsInternal, {});
    expect(due).toContain(tradingId);
    expect(due).not.toContain(ilId);
    expect(due).not.toContain(legacyId);
  });

  it("un trading con lease de rearm vivo NO se lista (anti doble-claim); running con lease vencido SÍ", async () => {
    const t = makeConvexTest();
    const { leased, expired } = await t.run(async (ctx) => {
      const leased = await seedRearmReadyBot(ctx, "trading");
      await ctx.db.patch(leased, { rearmStatus: "running", rearmLeaseToken: "x", rearmLeaseUntil: Date.now() + 60_000 });
      const expired = await seedRearmReadyBot(ctx, "trading");
      await ctx.db.patch(expired, { rearmStatus: "running", rearmLeaseToken: "y", rearmLeaseUntil: Date.now() - 1000, nextRearmAt: Date.now() - 1000 });
      return { leased, expired };
    });
    const due = await t.query(internal.tradingBots.listDueTradingRearmsInternal, {});
    expect(due).not.toContain(leased);
    expect(due).toContain(expired);
  });
});
