import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedUser, seedCredential } from "./fixtures";
import { consumedCoverageByKey, poolCoverageKey, spotDefenseCoverageKey } from "../convex/coverageUsage";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-107 Fase 2) Reserva atómica + cap + sizing capado del bot de defensa spot, y regresión de
// coverageUsage con claves namespaced. Tests money-path obligatorios (Codex r3).

let prevNetwork: string | undefined;
beforeAll(() => { prevNetwork = process.env.HL_NETWORK; process.env.HL_NETWORK = "testnet"; });
afterAll(() => { if (prevNetwork === undefined) delete process.env.HL_NETWORK; else process.env.HL_NETWORK = prevNetwork; });

async function seedDefenseBot(ctx: MutationCtx, over: any = {}) {
  const userId = await seedUser(ctx, { role: "admin" });   // admin = sin tope de plan (margen = cota binding)
  const hlAccountId = await seedCredential(ctx, userId);
  const spotPositionId = await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 60000, userId: "clerk_x" });
  const now = Date.now();
  const botId = await ctx.db.insert("spot_defense_bots", {
    userId, spotPositionId, hlAccountId, asset: "BTC", baseAsset: "BTC", side: "Short",
    leverage: 10, autoLeverage: false, stopLossPct: 1, triggerMode: "manual", triggerPrice: 2000,
    requestedNotionalUsd: 100000, active: true, status: "running", network: "testnet",
    generation: 0, createdAt: now, updatedAt: now, ...over,
  });
  return { userId, hlAccountId, spotPositionId, botId };
}

describe("reserveSpotDefenseArm — sizing capado (Codex r1#1/r2#1)", () => {
  it("capa el nocional por margen real cuando el pedido excede la cuenta", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx));
    // usableReal = 1000*0.9 = 900; lev 10 → marginCap = 9000; requested 100000 → efectivo 9000.
    const r = await t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, {
      botId, triggerPx: 2000, availableCollateral: 1000, assetMaxLeverage: 20, szDecimals: 3,
    });
    expect(r.effectiveNotionalUsd).toBeCloseTo(9000, 6);
    expect(r.size).toBeCloseTo(4.5, 6);
    expect(r.effectiveNotionalUsd).toBeLessThan(r.requestedNotionalUsd);   // cobertura parcial
    expect(r.marginReserved).toBeCloseTo(900, 6);
  });

  it("bloquea si la cobertura efectiva cae bajo minCoveragePct (Codex r2#4)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx, { minCoveragePct: 50 }));
    await expect(t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, {
      botId, triggerPx: 2000, availableCollateral: 1000, assetMaxLeverage: 20, szDecimals: 3,
    })).rejects.toThrow(/umbral mínimo/);
  });

  it("bloquea si el nocional efectivo < mínimo de orden", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx));
    await expect(t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, {
      botId, triggerPx: 2000, availableCollateral: 1, assetMaxLeverage: 20, szDecimals: 3,
    })).rejects.toThrow(/mínimo/);
  });

  it("rechaza una segunda reserva si ya hay un arm vivo (unicidad)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx));
    const args = { botId, triggerPx: 2000, availableCollateral: 1000, assetMaxLeverage: 20, szDecimals: 3 };
    await t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, args);
    await expect(t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, args)).rejects.toThrow(/armado activo/);
  });
});

describe("consumedCoverageByKey — claves namespaced sin colisión (Codex r2#3/#4)", () => {
  it("suma pool y spot-defense bajo claves distintas", async () => {
    const t = makeConvexTest();
    const { total, keys, poolKey, sdKey } = await t.run(async (ctx) => {
      const userId = await seedUser(ctx, { role: "viewer" });
      const hlAccountId = await seedCredential(ctx, userId);
      const poolId = await ctx.db.insert("pools", { pair: "ETH/USDC", network: "testnet", minRange: 1, maxRange: 2, status: "open" });
      const now = Date.now();
      // arm de pool vivo (hedge 500)
      await ctx.db.insert("trigger_arms", {
        botId: await ctx.db.insert("bots", { name: "b", active: true, simulationMode: false, userId }),
        userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", side: "Short", triggerPx: 1, size: 1, appliedLeverage: 10,
        reservedNotional: 100, marginReserved: 10, hedgeNotionalUsd: 500, lowerEdge: 1,
        stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      // arm de defensa spot vivo (effectiveNotionalUsd 300)
      const spotPositionId = await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 1, userId: "ck" });
      const sdBotId = await ctx.db.insert("spot_defense_bots", {
        userId, spotPositionId, hlAccountId, asset: "BTC", baseAsset: "BTC", side: "Short",
        leverage: 10, stopLossPct: 1, triggerMode: "manual", triggerPrice: 1, requestedNotionalUsd: 300,
        active: true, status: "running", network: "testnet", generation: 1, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("spot_defense_arms", {
        botId: sdBotId, userId, hlAccountId, asset: "BTC", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", side: "Short", triggerPx: 1, size: 1, appliedLeverage: 10,
        reservedNotional: 300, marginReserved: 30, effectiveNotionalUsd: 300,
        stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      const map = await consumedCoverageByKey(ctx, userId);
      let total = 0; for (const v of map.values()) total += v;
      return { total, keys: [...map.keys()], poolKey: poolCoverageKey(poolId), sdKey: spotDefenseCoverageKey(sdBotId) };
    });
    expect(total).toBe(800);
    expect(keys).toContain(poolKey);
    expect(keys).toContain(sdKey);
    expect(keys.length).toBe(2);   // claves distintas, sin dedupe cruzada
  });
});
