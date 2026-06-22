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

describe("Fase 3a — ciclo de vida del arm (claim/settle/fencing/cuarentena)", () => {
  async function reservedArm(t: any) {
    const { botId } = await t.run((ctx: MutationCtx) => seedDefenseBot(ctx));
    const r = await t.mutation(internal.spotDefenseBots.reserveSpotDefenseArm, {
      botId, triggerPx: 2000, availableCollateral: 1000, assetMaxLeverage: 20, szDecimals: 3,
    });
    return { botId, armId: r.armId };
  }

  it("path correcto: markArmSubmitting (arming→submitting) + settle (submitting→armed)", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId });
    expect(cas.ok).toBe(true);
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.status).toBe("submitting");
    const r = await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token: cas.token, status: "armed" });
    expect(r.ok).toBe(true);
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.status).toBe("armed");
  });

  it("(Codex #1) settle NO permite arming→armed sin pasar por el CAS", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const claim = await t.mutation(internal.spotDefenseBots.claimSpotDefenseReconcile, { armId });
    const r = await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token: claim.token, status: "armed" });
    expect(r.ok).toBe(false);   // ALLOWED_SD.arming no incluye "armed"
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.status).toBe("arming");
  });

  it("(Codex #2) settle con token ajeno → no-op (fencing obligatorio)", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId });
    const r = await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token: "intruso", status: "armed" });
    expect(r.ok).toBe(false);
    expect(cas.ok).toBe(true);
  });

  it("closed exige closeReason (tras cuarentena)", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId });
    const token = cas.token;
    await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "filled" });
    // retrodatar submittedAt para salir de la cuarentena post-submit (90s) y poder terminalizar.
    await t.run((ctx: MutationCtx) => ctx.db.patch(armId, { submittedAt: Date.now() - 200000 }));
    const noReason = await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "closed" });
    expect(noReason.ok).toBe(false);
    const ok = await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "closed", closeReason: "sl" });
    expect(ok.ok).toBe(true);
  });

  it("(Codex 3c-1 #1) submitting→disarmed ahora permitido (pre-fill disarm)", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId });
    await t.run((ctx: MutationCtx) => ctx.db.patch(armId, { submittedAt: Date.now() - 200000 }));  // fuera de cuarentena
    const r = await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token: cas.token, status: "disarmed", closeReason: "disarm" });
    expect(r.ok).toBe(true);
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.status).toBe("disarmed");
  });

  it("(Codex 3c-1 #4) setSpotDefenseCloseConfirm fija y limpia closeConfirmSince bajo lease", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const claim = await t.mutation(internal.spotDefenseBots.claimSpotDefenseReconcile, { armId });
    await t.mutation(internal.spotDefenseBots.setSpotDefenseCloseConfirm, { armId, token: claim.token, value: 12345 });
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.closeConfirmSince).toBe(12345);
    await t.mutation(internal.spotDefenseBots.setSpotDefenseCloseConfirm, { armId, token: claim.token, value: null });
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.closeConfirmSince).toBeUndefined();
    const bad = await t.mutation(internal.spotDefenseBots.setSpotDefenseCloseConfirm, { armId, token: "x", value: 1 });
    expect(bad.ok).toBe(false);
  });

  it("recordSpotDefenseSlOrder: upsert idempotente por rol sl bajo lease", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const claim = await t.mutation(internal.spotDefenseBots.claimSpotDefenseReconcile, { armId });
    const a = { armId, token: claim.token, cloid: "0xsl1", triggerPx: 2020, size: 0.01, observedStatus: "open" as const };
    const r1 = await t.mutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, a);
    const r2 = await t.mutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, { ...a, cloid: "0xsl2", observedStatus: "filled" as const });
    expect(r1.ok).toBe(true); expect(r2.ok).toBe(true);
    expect(r2.orderId).toEqual(r1.orderId);   // upsert, no duplica
    const sls = await t.run((ctx: MutationCtx) => ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "sl")).collect());
    expect(sls.length).toBe(1);
    expect(sls[0].observedStatus).toBe("filled");
    // fencing: token ajeno no escribe
    const bad = await t.mutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, { ...a, token: "x" });
    expect(bad.ok).toBe(false);
  });

  it("(Codex 3c-2 #2) el listado del cron va por antigüedad global, no por estado (sin starvation)", async () => {
    const t = makeConvexTest();
    const ids = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx, { role: "admin" });
      const hlAccountId = await seedCredential(ctx, userId);
      const spotPositionId = await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 1, userId: "ck" });
      const now = Date.now();
      const botId = await ctx.db.insert("spot_defense_bots", {
        userId, spotPositionId, hlAccountId, asset: "BTC", baseAsset: "BTC", side: "Short",
        leverage: 10, stopLossPct: 1, triggerMode: "manual", triggerPrice: 1, requestedNotionalUsd: 100,
        active: true, status: "running", network: "testnet", generation: 1, createdAt: now, updatedAt: now,
      });
      const mk = (status: any, updatedAt: number) => ctx.db.insert("spot_defense_arms", {
        botId, userId, hlAccountId, asset: "BTC", network: "testnet", generation: 1,
        status, desiredState: "armed", side: "Short", triggerPx: 1, size: 1, appliedLeverage: 10,
        reservedNotional: 100, marginReserved: 10, stopLossPct: 1, createdAt: updatedAt, updatedAt,
      });
      // Muchos arms tempranos VIEJOS no deben tapar a un filled/protected más NUEVO si el orden es por antigüedad:
      const a1 = await mk("arming", 1000);
      const a2 = await mk("submitting", 2000);
      const closed = await mk("closed", 2500);   // terminal → excluido
      const a3 = await mk("filled", 3000);
      const a4 = await mk("protected", 4000);
      return { a1, a2, closed, a3, a4 };
    });
    const list = await t.query(internal.spotDefenseBots.listLiveSpotDefenseArmIdsInternal, { limit: 10 });
    expect(list).toEqual([ids.a1, ids.a2, ids.a3, ids.a4]);   // por updatedAt ASC, sin el closed
    // con tope 2 = los 2 MÁS ANTIGUOS no terminales (turno justo por antigüedad)
    const top2 = await t.query(internal.spotDefenseBots.listLiveSpotDefenseArmIdsInternal, { limit: 2 });
    expect(top2).toEqual([ids.a1, ids.a2]);
  });

  it("(Codex 3c-1 r3) attempt persiste arm.slAttempts → el cloid rota al recolocar", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const claim = await t.mutation(internal.spotDefenseBots.claimSpotDefenseReconcile, { armId });
    await t.mutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, { armId, token: claim.token, cloid: "0xa", triggerPx: 2020, size: 0.01, observedStatus: "pending", attempt: 1 });
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.slAttempts).toBe(1);
    await t.mutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, { armId, token: claim.token, cloid: "0xb", triggerPx: 2020, size: 0.01, observedStatus: "pending", attempt: 2 });
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(armId)))?.slAttempts).toBe(2);
  });

  it("(Codex 3c-1 r2 #2) pre-record pending NO marca submittedAt; sí al enviar (markSubmitted)", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const claim = await t.mutation(internal.spotDefenseBots.claimSpotDefenseReconcile, { armId });
    const base = { armId, token: claim.token, cloid: "0xslp", triggerPx: 2020, size: 0.01 };
    // PREPARADO (pre-RPC): pending sin submittedAt → el motor NO lo trata como SL vivo (slAlive=false).
    await t.mutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, { ...base, observedStatus: "pending" });
    let sl = await t.run((ctx: MutationCtx) => ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "sl")).first());
    expect(sl?.submittedAt).toBeUndefined();
    // ENVIADO (RPC aceptado): markSubmitted fija submittedAt → ahora sí cuenta como vivo.
    await t.mutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, { ...base, observedStatus: "open", oid: "999", markSubmitted: true });
    sl = await t.run((ctx: MutationCtx) => ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "sl")).first());
    expect(typeof sl?.submittedAt).toBe("number");
    expect(sl?.observedStatus).toBe("open");
  });

  it("(Codex) cuarentena: no terminaliza un arm submittedAt reciente", async () => {
    const t = makeConvexTest();
    const { armId } = await reservedArm(t);
    const cas = await t.mutation(internal.spotDefenseBots.markArmSubmitting, { armId });   // fija submittedAt ahora
    const r = await t.mutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token: cas.token, status: "failed" });
    expect(r.ok).toBe(false);
    expect(r.quarantined).toBe(true);
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
