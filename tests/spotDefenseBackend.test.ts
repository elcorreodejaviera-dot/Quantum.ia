import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { internal, api } from "../convex/_generated/api";
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

async function seedLiveConfig(ctx: MutationCtx) {
  // Gates globales que assertSpotDefenseLiveAdmissible exige (Codex Fase 2 #1).
  await ctx.db.insert("system_config", { key: "tradingEnabled", value: true });
  await ctx.db.insert("system_config", { key: "simulationMode", value: false });
}

async function seedDefenseBot(ctx: MutationCtx, over: any = {}) {
  await seedLiveConfig(ctx);
  const userId = await seedUser(ctx, { role: "admin" });   // admin = sin tope de plan + bypass canTradeLive
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

describe("reserveSpotDefenseArm — gates live + leverage (Codex Fase 2 #1/#4/#5)", () => {
  const args = (botId: any) => ({ botId, triggerPx: 2000, availableCollateral: 1000, assetMaxLeverage: 20, szDecimals: 3 });

  it("#1 bloquea si el kill-switch global está apagado", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      const r = await seedDefenseBot(ctx);
      // apagar tradingEnabled
      const cfg = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "tradingEnabled")).first();
      await ctx.db.patch(cfg!._id, { value: false });
      return r;
    });
    await expect(t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, args(botId))).rejects.toThrow(/No admisible/);
  });

  it("#4 bloquea si el bot está pausándose (disarmPending)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx, { disarmPending: true }));
    await expect(t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, args(botId))).rejects.toThrow(/No admisible/);
  });

  it("#4 bloquea si el bot no está running", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx, { status: "paused" }));
    await expect(t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, args(botId))).rejects.toThrow(/No admisible/);
  });

  it("#5 resolveLeverage RECHAZA leverage manual > máx del activo (no capa en silencio)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx, { leverage: 22 }));   // 22 ∈ [1,25] pero > maxLev 10
    await expect(t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, {
      botId, triggerPx: 2000, availableCollateral: 1000, assetMaxLeverage: 10, szDecimals: 3,
    })).rejects.toThrow(/supera el máximo del activo|leverage/i);
  });

  it("#5 autoLeverage resuelve un leverage válido vía el helper", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx, { autoLeverage: true }));
    const r = await t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, args(botId));
    expect(r.appliedLeverage).toBeGreaterThanOrEqual(1);
    expect(r.appliedLeverage).toBeLessThanOrEqual(20);
    expect(r.effectiveNotionalUsd).toBeGreaterThan(0);
  });
});

describe("CAS revalidan el live guard entre reserva y envío (Codex Fase 2 r2 #1)", () => {
  const reserve = (t: any, botId: any) =>
    t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, { botId, triggerPx: 2000, availableCollateral: 1000, assetMaxLeverage: 20, szDecimals: 3 });
  async function killTrading(t: any) {
    await t.run(async (ctx: MutationCtx) => {
      const cfg = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "tradingEnabled")).first();
      await ctx.db.patch(cfg!._id, { value: false });
    });
  }

  it("markArmSubmitting bloquea si se apaga el kill-switch tras reservar", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx));
    const r = await reserve(t, botId);
    await killTrading(t);
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId: r.armId });
    expect(cas.ok).toBe(false);
    expect(cas.reason).toBe("blocked");
  });

  it("gateArmBeforeOrder bloquea si se apaga el kill-switch tras pasar a submitting", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx));
    const r = await reserve(t, botId);
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId: r.armId });
    expect(cas.ok).toBe(true);
    await killTrading(t);
    const gate = await t.mutation(internal.spotDefenseBots.gateArmBeforeOrder, { armId: r.armId, token: cas.token });
    expect(gate.ok).toBe(false);
  });

  it("markArmSubmitting bloquea si se activa simulationMode tras reservar", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedDefenseBot(ctx));
    const r = await reserve(t, botId);
    await t.run(async (ctx: MutationCtx) => {
      const cfg = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "simulationMode")).first();
      await ctx.db.patch(cfg!._id, { value: true });
    });
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId: r.armId });
    expect(cas.ok).toBe(false);
  });
});

describe("revokeById detiene bots spot-defense sin arm vivo (Codex Fase 2 r2 #2)", () => {
  const CLERK = "u-rev";
  it("al revocar la credencial, el bot de defensa sin arm queda stopped+inactivo", async () => {
    const t = makeConvexTest();
    const { acc, botId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: CLERK, role: "viewer" });
      const acc = await seedCredential(ctx, userId);
      const spotPositionId = await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 1, userId: CLERK });
      const now = Date.now();
      const botId = await ctx.db.insert("spot_defense_bots", {
        userId, spotPositionId, hlAccountId: acc, asset: "BTC", baseAsset: "BTC", side: "Short",
        leverage: 10, stopLossPct: 1, triggerMode: "manual", triggerPrice: 1, requestedNotionalUsd: 100,
        active: true, status: "running", network: "testnet", generation: 0, createdAt: now, updatedAt: now,
      });
      return { acc, botId };
    });
    await t.withIdentity({ subject: CLERK }).mutation(api.hlCredentials.revokeById, { id: acc });
    const bot = await t.run((ctx) => ctx.db.get(botId));
    expect(bot?.active).toBe(false);
    expect(bot?.status).toBe("stopped");
  });
});

describe("exclusividad en rutas existentes (Codex Fase 2 #2)", () => {
  const CLERK = "u-sd";
  it("getOrCreatePoolBot rechaza cuenta con defensa spot viva del mismo par", async () => {
    const t = makeConvexTest();
    const { acc, poolBtc } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: CLERK, role: "viewer" });
      await ctx.db.insert("user_permissions", { userId, permission: "canManageBots", granted: true, grantedAt: Date.now() });
      const acc = await seedCredential(ctx, userId);
      const poolBtc = await ctx.db.insert("pools", { userId, pair: "BTC/USDC", network: "testnet", minRange: 1, maxRange: 2, status: "open" });
      const spotPositionId = await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 1, userId: CLERK });
      const now = Date.now();
      await ctx.db.insert("spot_defense_bots", {
        userId, spotPositionId, hlAccountId: acc, asset: "BTC", baseAsset: "BTC", side: "Short",
        leverage: 10, stopLossPct: 1, triggerMode: "manual", triggerPrice: 1, requestedNotionalUsd: 100,
        active: true, status: "running", network: "testnet", generation: 0, createdAt: now, updatedAt: now,
      });
      return { acc, poolBtc };
    });
    await expect(t.withIdentity({ subject: CLERK }).mutation(api.bots.getOrCreatePoolBot, {
      poolId: poolBtc, kind: "il" as const, hlAccountId: acc, direction: "short" as const,
    })).rejects.toThrow(/bot de defensa para BTC\/USDC/i);
  });
});

describe("persistSpotDefenseBot — no reconfigura con arm vivo (Codex Fase 2 #3)", () => {
  const CLERK = "u-sd2";
  it("rechaza reconfigurar (active=false) si hay un arm no terminal", async () => {
    const t = makeConvexTest();
    const { spotPositionId, acc, userId } = await t.run(async (ctx) => {
      await seedLiveConfig(ctx);
      const userId = await ctx.db.insert("users", { clerkId: CLERK, role: "admin" });
      const acc = await seedCredential(ctx, userId);
      const spotPositionId = await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 60000, userId: CLERK });
      return { spotPositionId, acc, userId };
    });
    const as = t.withIdentity({ subject: CLERK });
    const base = { spotPositionId, hlAccountId: acc, leverage: 10, stopLossPct: 1, triggerMode: "manual" as const, triggerPrice: 60000, requestedNotionalUsd: 1000, active: false };
    const { botId } = await as.mutation(api.spotDefenseBots.persistSpotDefenseBot, base);
    // insertar un arm vivo para ese bot
    await t.run((ctx) => ctx.db.insert("spot_defense_arms", {
      botId, userId, hlAccountId: acc, asset: "BTC", network: "testnet",
      generation: 1, status: "armed", desiredState: "armed", side: "Short", triggerPx: 60000, size: 0.01,
      appliedLeverage: 10, reservedNotional: 600, marginReserved: 60, stopLossPct: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await expect(as.mutation(api.spotDefenseBots.persistSpotDefenseBot, { ...base, triggerPrice: 55000 }))
      .rejects.toThrow(/pausa el trigger/i);
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
