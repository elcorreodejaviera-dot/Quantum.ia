import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedUser, seedCredential, seedPool } from "./fixtures";
import {
  consumedCoverageByKey, poolCoverageKey, spotDefenseCoverageKey, tradingCoverageKey,
  assertWithinPlanCoverageForKey,
} from "../convex/coverageUsage";
import { committedMarginForAccount, liveManualExecutionForAccountAsset, liveArmForAccountAssetExcept } from "../convex/executions";
import { hasNonTerminalArmForBot, requestDisarmAndDeactivateImpl } from "../convex/triggerArms";
import { armErrorKind } from "../convex/triggerRearm";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-178 / Bot Trading PR2) Reserva atómica + guard simétrico + cuota [blocked_cap] + rearm del 4º
// motor. Tests money-path obligatorios (plan JAV-176, cierres P2/P5/P6/V2-P2/V2-P3).

let prevNetwork: string | undefined;
beforeAll(() => { prevNetwork = process.env.HL_NETWORK; process.env.HL_NETWORK = "testnet"; });
afterAll(() => { if (prevNetwork === undefined) delete process.env.HL_NETWORK; else process.env.HL_NETWORK = prevNetwork; });

async function seedLiveConfig(ctx: MutationCtx) {
  await ctx.db.insert("system_config", { key: "tradingEnabled", value: true });
  await ctx.db.insert("system_config", { key: "simulationMode", value: false });
}

// Bot de TRADING (fila en `bots`, config JAV-41) + entorno live. Admin = bypass canTradeLive + sin cap.
async function seedTradingBot(ctx: MutationCtx, over: any = {}, userOver: any = {}) {
  await seedLiveConfig(ctx);
  const userId = userOver.userId ?? await seedUser(ctx, { role: userOver.role ?? "admin" });
  const hlAccountId = await seedCredential(ctx, userId);
  const poolId = await seedPool(ctx);
  const botId = await ctx.db.insert("bots", {
    name: "Trading ETH testnet", userId, poolId, hlAccountId, kind: "trading",
    baseAsset: "ETH", direction: "long_short", leverage: 10, autoLeverage: false,
    capitalPct: 100, stopLossPct: 1, autoRearm: true,
    active: true, simulationMode: false, ...over,
  });
  return { userId, hlAccountId, poolId, botId };
}

// Args de reserva por el camino de PAR DE TRIGGERS (rango 2000–3000, mark en el centro).
// rangeWidthPct = (2980−2020)/2500·100 ≈ 38.4% ≥ 2×(1+2)=6 ✓.
const reserveArgs = (botId: any, over: any = {}) => ({
  botId, lpNotionalUsd: 5000, markPx: 2500, lowerEdge: 2000, upperEdge: 3000, tickSize: 0.5,
  lowerTriggerPx: 2020, upperTriggerPx: 2980, entryUpperLimitPx: 3039.6, entryLowerLimitPx: 1979.6,
  availableCollateral: 10000, assetMaxLeverage: 20, szDecimals: 3, ...over,
});

describe("reserveTradingArm — dirección/legsFactor y filas de entrada (mapeo on-chain)", () => {
  it("long_short: legsFactor=1, dos filas trigger (upper BUY / lower SELL), coverage = efectivo×1", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    expect(r.ok).toBe(true);
    expect(r.legsFactor).toBe(1);
    expect(r.size).toBeCloseTo(2, 9);                       // 5000/2500
    expect(r.effectiveNotionalUsd).toBeCloseTo(5000, 6);
    expect(r.coverageNotionalUsd).toBeCloseTo(5000, 6);
    const { arm, orders } = await t.run(async (ctx) => {
      const arm = await ctx.db.get(r.armId);
      const orders = await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", r.armId)).collect();
      return { arm, orders };
    });
    expect(arm!.status).toBe("arming");
    expect(arm!.ocoConfirmed).toBeUndefined();
    const upper = orders.find((o: any) => o.role === "entry_upper");
    const lower = orders.find((o: any) => o.role === "entry_lower");
    expect(upper!.isBuy).toBe(true);
    expect(lower!.isBuy).toBe(false);
    expect(upper!.triggerPx).toBe(2980);
    expect(lower!.triggerPx).toBe(2020);
    expect(upper!.reduceOnly).toBe(false);
  });

  it("solo long: legsFactor=2 (worst case hasta OCO), AMBAS filas BUY, coverage = efectivo×2", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx, { direction: "long" }));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    expect(r.legsFactor).toBe(2);
    expect(r.coverageNotionalUsd).toBeCloseTo(10000, 6);
    const orders = await t.run((ctx) =>
      ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", r.armId)).collect());
    expect(orders.every((o: any) => o.isBuy === true)).toBe(true);
  });

  it("solo short: AMBAS filas SELL (ruptura abajo + reversión arriba)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx, { direction: "short" }));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    const orders = await t.run((ctx) =>
      ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", r.armId)).collect());
    expect(orders.every((o: any) => o.isBuy === false)).toBe(true);
  });

  it("unicidad: una segunda reserva con arm vivo lanza [transient]", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId)))
      .rejects.toThrow(/\[transient\] Ya existe un armado activo/);
  });
});

describe("reserveTradingArm — market-entry (decisión 6) y out_of_range tipado", () => {
  it("variante marketEntry: 1 fila entry_market SIN triggerPx (V2-P2), legsFactor=1, ocoConfirmed de origen", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx, { direction: "long" }));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, {
      markPx: 1900,                       // fuera del rango: la variante lo OMITE (no valida rango)
      marketEntry: { side: "Long" }, marketLimitPx: 1938,
      lowerTriggerPx: undefined, upperTriggerPx: undefined,
      entryUpperLimitPx: undefined, entryLowerLimitPx: undefined,
    }));
    expect(r.ok).toBe(true);
    expect(r.legsFactor).toBe(1);         // SIEMPRE 1 en market-entry, aun en modo solo
    const { arm, orders } = await t.run(async (ctx) => ({
      arm: await ctx.db.get(r.armId),
      orders: await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", r.armId)).collect(),
    }));
    expect(arm!.ocoConfirmed).toBe(true);
    expect(arm!.lowerTriggerPx).toBeUndefined();
    expect(arm!.upperTriggerPx).toBeUndefined();
    expect(orders).toHaveLength(1);
    expect(orders[0].role).toBe("entry_market");
    expect(orders[0].triggerPx).toBeUndefined();   // V2-P2: una IOC no tiene trigger
    expect(orders[0].limitPx).toBe(1938);
    expect(orders[0].isBuy).toBe(true);
  });

  it("camino triggers con mark FUERA ⇒ resultado tipado out_of_range (sin insertar arm, sin throw)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, { markPx: 1900 }));
    expect(r).toEqual({ ok: false, reason: "out_of_range", side: "Short" });   // borde inferior superado
    const arms = await t.run((ctx) =>
      ctx.db.query("trading_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect());
    expect(arms).toHaveLength(0);
  });

  it("separación < 1 tick y rango angosto ⇒ [blocked_config]", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, {
      lowerTriggerPx: 2500.0, upperTriggerPx: 2500.3,   // < 1 tick (0.5)
    }))).rejects.toThrow(/\[blocked_config\] Separación/);
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, {
      lowerTriggerPx: 2480, upperTriggerPx: 2520,       // 1.6% < 6% mínimo
    }))).rejects.toThrow(/\[blocked_config\] Rango demasiado angosto/);
  });

  it("reserva sin lpNotionalUsd válido ⇒ [blocked_config] sin insertar arm ni tocar nada (P3)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    for (const bad of [0, -5, NaN]) {
      await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, { lpNotionalUsd: bad })))
        .rejects.toThrow(/\[blocked_config\] Nocional del LP/);
    }
    const arms = await t.run((ctx) =>
      ctx.db.query("trading_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect());
    expect(arms).toHaveLength(0);
  });
});

describe("cuota — [blocked_cap] (P6) y claves sin dedupe cruzado (P5)", () => {
  it("cap de plan excedido ⇒ tag [blocked_cap] (no [blocked_margin]) y armErrorKind lo clasifica", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      // Usuario NO admin con plan Betatester ($5k) + canTradeLive: legsFactor 2 ⇒ coverage 10k > 5k.
      const userId = await ctx.db.insert("users", { clerkId: "clerk_cap", role: "viewer", subscriptionPlan: "betatester" });
      await ctx.db.insert("user_permissions", { userId, permission: "canTradeLive", granted: true, grantedAt: Date.now() });
      return await seedTradingBot(ctx, { direction: "long" }, { userId });
    });
    let thrown = "";
    try {
      await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    } catch (e) {
      thrown = String((e as Error).message);
    }
    // El mensaje REAL capturado clasifica blocked_cap (armErrorKind exige el tag como PREFIJO anclado,
    // tolerando solo el wrapper "Uncaught Error:" — si el tag quedara embebido, en prod caería a
    // transient y el cap se reintentaría en silencio: exactamente la regresión que P6 evita).
    expect(thrown).toMatch(/^(?:Uncaught Error:\s*)*\[blocked_cap\] Supera el tope de cobertura del plan/);
    expect(thrown).not.toMatch(/blocked_margin/);
    expect(armErrorKind(thrown)).toBe("blocked_cap");
  });

  it("trading:<botId> convive SIN dedupe con pool:<poolId> del mismo pool (suman, no colapsan)", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const { botId, userId, hlAccountId, poolId } = await seedTradingBot(ctx);
      const now = Date.now();
      // Arm IL vivo del MISMO pool (clave pool:<poolId>, hedge 3000).
      await ctx.db.insert("trigger_arms", {
        botId, userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", side: "Short", triggerPx: 2000, size: 1,
        appliedLeverage: 5, reservedNotional: 3000, marginReserved: 600, hedgeNotionalUsd: 3000,
        stopLossPct: 1, lowerEdge: 2000, armMode: "oco", createdAt: now, updatedAt: now,
      } as any);
      // Arm TRADING vivo (clave trading:<botId>, coverage 5000).
      await ctx.db.insert("trading_arms", {
        botId, userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", direction: "long_short",
        lowerEdge: 2000, upperEdge: 3000, size: 2, appliedLeverage: 10, legsFactor: 1,
        reservedNotional: 5000, marginReserved: 500, effectiveNotionalUsd: 5000, coverageNotionalUsd: 5000,
        stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      // Arm de DEFENSA SPOT vivo (clave spot-defense:<botId>, coverage 2000) — las TRES claves suman.
      const sdBotId = await ctx.db.insert("spot_defense_bots", {
        userId, spotPositionId: await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 60000, userId: "clerk_x" }),
        hlAccountId, asset: "BTC", baseAsset: "BTC", side: "Short", leverage: 5, stopLossPct: 1,
        triggerMode: "manual", triggerPrice: 60000, requestedNotionalUsd: 2000, active: true,
        status: "running", network: "testnet", generation: 1, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("spot_defense_arms", {
        botId: sdBotId, userId, hlAccountId, asset: "BTC", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", side: "Short", triggerPx: 60000, size: 0.03,
        appliedLeverage: 5, reservedNotional: 2000, marginReserved: 400, effectiveNotionalUsd: 2000,
        stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      const map = await consumedCoverageByKey(ctx, userId);
      expect(map.get(poolCoverageKey(poolId))).toBe(3000);
      expect(map.get(tradingCoverageKey(botId))).toBe(5000);
      expect(map.get(spotDefenseCoverageKey(sdBotId))).toBe(2000);
      let total = 0; for (const v of map.values()) total += v;
      expect(total).toBe(10000);   // SUMAN — sin dedupe cruzado entre pool:/trading:/spot-defense:
    });
  });

  it("arm de trading vivo sin coverageNotionalUsd ⇒ fail-closed [blocked_config]", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const { botId, userId, hlAccountId, poolId } = await seedTradingBot(ctx);
      const now = Date.now();
      await ctx.db.insert("trading_arms", {
        botId, userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", direction: "long_short",
        lowerEdge: 2000, upperEdge: 3000, size: 2, appliedLeverage: 10, legsFactor: 1,
        reservedNotional: 5000, marginReserved: 500, effectiveNotionalUsd: 5000,   // SIN coverageNotionalUsd
        stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      await expect(consumedCoverageByKey(ctx, userId)).rejects.toThrow(/\[blocked_config\].*coverageNotionalUsd/);
    });
  });
});

describe("guard SIMÉTRICO (P2 + V2-P3) — las dos carreras + drift legacy", () => {
  it("manual viva PRIMERO ⇒ reserveTradingArm rechaza [transient]", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const now = Date.now();
      await ctx.db.insert("execution_requests", {
        userId: seeded.userId, botId: seeded.botId, idempotencyKey: "k1",
        hlAccountId: seeded.hlAccountId, poolId: seeded.poolId, hedgeNotionalUsd: 100,
        asset: "ETH", stopLossPct: 1, requestedAmount: 100, notional: 100, marginReserved: 10,
        side: "Long", status: "pending", network: "testnet", entryCloid: "0xa", slCloid: "0xb",
        slAttempt: 0, createdAt: now, updatedAt: now,
      } as any);
      return seeded;
    });
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId)))
      .rejects.toThrow(/\[transient\] Ejecución manual viva/);
  });

  it("arm de trading vivo PRIMERO ⇒ reserveExecution rechaza la manual (misma cuenta/coin)", async () => {
    const t = makeConvexTest();
    const { userId, botId, hlAccountId, poolId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      return seeded;
    });
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    expect(r.ok).toBe(true);
    await expect(t.mutation(internal.executions.reserveExecution, {
      userId, botId, idempotencyKey: "k-manual", hlAccountId, poolId, hedgeNotionalUsd: 100,
      asset: "ETH", stopLossPct: 1, requestedAmount: 100, notional: 100, availableCollateral: 10000,
      autoLeverage: false, manualLeverage: 5, assetMaxLeverage: 20, side: "Long", network: "testnet",
      entryCloid: "0xc", slCloid: "0xd",
    })).rejects.toThrow(/armado automático vivo \(trading_arms/);
  });

  it("drift legacy: arm de OTRO motor vivo en (cuenta, coin) ⇒ reserveTradingArm falla cerrado", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const now = Date.now();
      // spot_defense_arm vivo con el MISMO asset en la MISMA cuenta (JAV-102 debería impedirlo; el
      // guard no se fía — V2-P3).
      const sdBotId = await ctx.db.insert("spot_defense_bots", {
        userId: seeded.userId, spotPositionId: await ctx.db.insert("spot_positions", { asset: "ETH", amount: 1, dca: 2000, userId: "clerk_x" }),
        hlAccountId: seeded.hlAccountId, asset: "ETH", baseAsset: "ETH", side: "Short",
        leverage: 5, stopLossPct: 1, triggerMode: "manual", triggerPrice: 2000,
        requestedNotionalUsd: 100, active: true, status: "running", network: "testnet",
        generation: 1, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("spot_defense_arms", {
        botId: sdBotId, userId: seeded.userId, hlAccountId: seeded.hlAccountId, asset: "ETH",
        network: "testnet", generation: 1, status: "armed", desiredState: "armed", side: "Short",
        triggerPx: 2000, size: 0.05, appliedLeverage: 5, reservedNotional: 100, marginReserved: 20,
        effectiveNotionalUsd: 100, stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      return seeded;
    });
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId)))
      .rejects.toThrow(/\[transient\] Arm vivo de otro motor \(spot_defense_arms/);
  });

  it("los helpers normalizan asset a MAYÚSCULAS", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const now = Date.now();
      await ctx.db.insert("execution_requests", {
        userId: seeded.userId, botId: seeded.botId, idempotencyKey: "k2",
        hlAccountId: seeded.hlAccountId, poolId: seeded.poolId, hedgeNotionalUsd: 100,
        asset: "eth", stopLossPct: 1, requestedAmount: 100, notional: 100, marginReserved: 10,
        side: "Long", status: "pending", network: "testnet", entryCloid: "0xe", slCloid: "0xf",
        slAttempt: 0, createdAt: now, updatedAt: now,
      } as any);
      const hit = await liveManualExecutionForAccountAsset(ctx, seeded.hlAccountId, "ETH");
      expect(hit).toEqual({ table: "execution_requests", status: "pending" });
      const none = await liveArmForAccountAssetExcept(ctx, seeded.hlAccountId, "BTC", {});
      expect(none).toBeNull();
    });
  });
});

describe("margen 4 motores + reducción 2×→1× (P1: solo tras relectura negativa post-cancel)", () => {
  it("committedMarginForAccount suma el arm de trading vivo", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const now = Date.now();
      await ctx.db.insert("trading_arms", {
        botId: seeded.botId, userId: seeded.userId, hlAccountId: seeded.hlAccountId, poolId: seeded.poolId,
        asset: "ETH", network: "testnet", generation: 1, status: "armed", desiredState: "armed",
        direction: "long", lowerEdge: 2000, upperEdge: 3000, size: 2, appliedLeverage: 10, legsFactor: 2,
        reservedNotional: 10000, marginReserved: 1000, effectiveNotionalUsd: 5000, coverageNotionalUsd: 10000,
        stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      expect(await committedMarginForAccount(ctx, seeded.hlAccountId)).toBe(1000);
    });
  });

  it("reduceTradingReservation baja coverage/margen a 1× y marca ocoConfirmed (idempotente)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx, { direction: "long" }));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    expect(r.coverageNotionalUsd).toBeCloseTo(10000, 6);
    const claim = await t.mutation(internal.tradingBots.claimTradingReconcile, { armId: r.armId });
    expect(claim.claimed).toBe(true);
    const red = await t.mutation(internal.tradingBots.reduceTradingReservation, { armId: r.armId, token: claim.token! });
    expect(red.ok).toBe(true);
    const arm = await t.run((ctx) => ctx.db.get(r.armId));
    expect(arm!.ocoConfirmed).toBe(true);
    expect(arm!.reservationReduced).toBe(true);
    expect(arm!.coverageNotionalUsd).toBeCloseTo(5000, 6);
    expect(arm!.reservedNotional).toBeCloseTo(5000, 6);
    expect(arm!.marginReserved).toBeCloseTo(r.marginReserved / 2, 6);
    const again = await t.mutation(internal.tradingBots.reduceTradingReservation, { armId: r.armId, token: claim.token! });
    expect(again).toMatchObject({ ok: true, already: true });
  });
});

describe("CAS/gates + rearmToken + gate mainnet", () => {
  it("markTradingArmSubmitting bloquea tras kill-switch (revalidación live en la OCC)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    await t.run(async (ctx) => {
      const cfg = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "tradingEnabled")).first();
      await ctx.db.patch(cfg!._id, { value: false });
    });
    const cas = await t.mutation(internal.tradingBots.markTradingArmSubmitting, { armId: r.armId });
    expect(cas).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("gate mainnet OFF bloquea la reserva en mainnet (barrera total)", async () => {
    process.env.HL_NETWORK = "mainnet";
    try {
      const t = makeConvexTest();
      const { botId } = await t.run((ctx) => seedTradingBot(ctx));
      await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId)))
        .rejects.toThrow(/\[blocked_config\] No admisible/);
    } finally {
      process.env.HL_NETWORK = "testnet";
    }
  });

  it("consume el rearmToken en la MISMA OCC (fencing) y rechaza un token inválido", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      await ctx.db.patch(seeded.botId, {
        rearmStatus: "running", rearmLeaseToken: "tok-1", rearmLeaseUntil: Date.now() + 60000, rearmAttempts: 3,
      });
      return seeded;
    });
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, { rearmToken: "tok-WRONG" })))
      .rejects.toThrow(/\[transient\] Lease de rearm inválido/);
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, { rearmToken: "tok-1" }));
    expect(r.ok).toBe(true);
    const bot = await t.run((ctx) => ctx.db.get(botId));
    expect(bot!.rearmStatus).toBeUndefined();
    expect(bot!.rearmLeaseToken).toBeUndefined();
    expect(bot!.rearmAttempts).toBe(0);
    expect(bot!.marketReentryStreak).toBe(0);   // reserva OCO ⇒ reset del streak (decisión 6b)
  });
});

// Sembrado directo de un arm en un estado dado (bypasea la cuarentena post-submit para testear settle).
async function seedArm(ctx: MutationCtx, seeded: any, over: any = {}) {
  const now = Date.now();
  const armId = await ctx.db.insert("trading_arms", {
    botId: seeded.botId, userId: seeded.userId, hlAccountId: seeded.hlAccountId, poolId: seeded.poolId,
    asset: "ETH", network: "testnet", generation: 1, status: "protected", desiredState: "armed",
    direction: "long_short", lowerEdge: 2000, upperEdge: 3000, size: 2, appliedLeverage: 10, legsFactor: 1,
    reservedNotional: 5000, marginReserved: 500, effectiveNotionalUsd: 5000, coverageNotionalUsd: 5000,
    stopLossPct: 1, filledEntryRole: "entry_lower", filledSide: "Short", filledSize: 2, entryPrice: 2020,
    filledAt: now - 10 * 60_000, submittedAt: now - 10 * 60_000,   // fuera de la cuarentena de 90s
    reconcileLeaseToken: "lease-1", reconcileLeaseUntil: now + 60_000,
    createdAt: now, updatedAt: now, ...over,
  });
  return armId;
}

describe("settleTradingArm — closeReason → rearm + streak escalonado (decisión 6b) + whipsaw", () => {
  it("closed(sl) de un arm OCO ⇒ rearm pending a +5 min, consecutiveStops+1, streak intacto", async () => {
    const t = makeConvexTest();
    const { seeded, armId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded);
      return { seeded, armId };
    });
    const before = Date.now();
    const r = await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-1", closeReason: "sl",
    });
    expect(r.ok).toBe(true);
    const bot = await t.run((ctx) => ctx.db.get(seeded.botId));
    expect(bot!.rearmStatus).toBe("pending");
    expect(bot!.consecutiveStops).toBe(1);
    expect(bot!.nextRearmAt!).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(bot!.nextRearmAt!).toBeLessThan(before + 6 * 60_000);
    expect(bot!.marketReentryStreak ?? 0).toBe(0);
  });

  it("escalera 6b LITERAL por streak: 1º SL de mercado ⇒ 5 min, 2º ⇒ 15 min (índice streak−1, sin código muerto)", async () => {
    const t = makeConvexTest();
    // 1º SL de un entry_market (streak 0→1) ⇒ arranca la escalera en 5 min (espíritu JAV-111).
    const a = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded, { filledEntryRole: "entry_market", ocoConfirmed: true });
      return { seeded, armId };
    });
    let before = Date.now();
    await t.mutation(internal.tradingBots.settleTradingArm, {
      armId: a.armId, status: "closed", token: "lease-1", closeReason: "sl",
    });
    let bot = await t.run((ctx) => ctx.db.get(a.seeded.botId));
    expect(bot!.marketReentryStreak).toBe(1);
    expect(bot!.nextRearmAt!).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(bot!.nextRearmAt!).toBeLessThan(before + 6 * 60_000);

    // 2º consecutivo (streak 1→2) ⇒ 15 min.
    const b = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      await ctx.db.patch(seeded.botId, { marketReentryStreak: 1 });
      const armId = await seedArm(ctx, seeded, { filledEntryRole: "entry_market", ocoConfirmed: true });
      return { seeded, armId };
    });
    before = Date.now();
    await t.mutation(internal.tradingBots.settleTradingArm, {
      armId: b.armId, status: "closed", token: "lease-1", closeReason: "sl",
    });
    bot = await t.run((ctx) => ctx.db.get(b.seeded.botId));
    expect(bot!.marketReentryStreak).toBe(2);
    expect(bot!.nextRearmAt!).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
    expect(bot!.nextRearmAt!).toBeLessThan(before + 16 * 60_000);
  });

  it("streak alto se CAPA a 60 min", async () => {
    const t = makeConvexTest();
    const { seeded, armId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      await ctx.db.patch(seeded.botId, { marketReentryStreak: 7 });
      const armId = await seedArm(ctx, seeded, { filledEntryRole: "entry_market", ocoConfirmed: true });
      return { seeded, armId };
    });
    const before = Date.now();
    await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-1", closeReason: "sl",
    });
    const bot = await t.run((ctx) => ctx.db.get(seeded.botId));
    expect(bot!.marketReentryStreak).toBe(8);
    expect(bot!.nextRearmAt!).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
    expect(bot!.nextRearmAt!).toBeLessThan(before + 61 * 60_000);
  });

  it("closed(tp) ⇒ rearm a 5 min, streak y consecutiveStops RESETEADOS", async () => {
    const t = makeConvexTest();
    const { seeded, armId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      await ctx.db.patch(seeded.botId, { marketReentryStreak: 3, consecutiveStops: 4 });
      const armId = await seedArm(ctx, seeded);
      return { seeded, armId };
    });
    await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-1", closeReason: "tp",
    });
    const bot = await t.run((ctx) => ctx.db.get(seeded.botId));
    expect(bot!.rearmStatus).toBe("pending");
    expect(bot!.marketReentryStreak).toBe(0);
    expect(bot!.consecutiveStops).toBe(0);
  });

  it("closed(oco_race) cuenta whipsaw Y rearma; closed(disarm) NO rearma", async () => {
    const t = makeConvexTest();
    const a = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded);
      return { seeded, armId };
    });
    await t.mutation(internal.tradingBots.settleTradingArm, {
      armId: a.armId, status: "closed", token: "lease-1", closeReason: "oco_race",
    });
    let bot = await t.run((ctx) => ctx.db.get(a.seeded.botId));
    expect(bot!.consecutiveStops).toBe(1);
    expect(bot!.rearmStatus).toBe("pending");

    const b = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded);
      return { seeded, armId };
    });
    await t.mutation(internal.tradingBots.settleTradingArm, {
      armId: b.armId, status: "closed", token: "lease-1", closeReason: "disarm",
    });
    bot = await t.run((ctx) => ctx.db.get(b.seeded.botId));
    expect(bot!.rearmStatus).toBeUndefined();
  });

  it("closed sin closeReason se rechaza; token inválido se rechaza (fencing); settle idempotente", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded);
      return { armId };
    });
    expect((await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-1",
    })).ok).toBe(false);
    expect((await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-WRONG", closeReason: "sl",
    })).ok).toBe(false);
    expect((await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-1", closeReason: "sl",
    })).ok).toBe(true);
    // Terminal: un segundo settle es no-op (idempotencia por estado terminal).
    expect((await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-1", closeReason: "sl",
    })).ok).toBe(false);
  });
});

describe("órdenes — close/entry_market sin triggerPx (V2-P2) y anchor direccional (P4)", () => {
  async function armWithLease(t: any) {
    const { seeded, armId } = await t.run(async (ctx: MutationCtx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded, { filledSide: "Long" });
      return { seeded, armId };
    });
    return { seeded, armId, token: "lease-1" };
  }

  it("recordTradingCloseOrder inserta la fila close SIN triggerPx (cloid determinista)", async () => {
    const t = makeConvexTest();
    const { armId, token } = await armWithLease(t);
    const r = await t.mutation(internal.tradingBots.recordTradingCloseOrder, {
      armId, token, cloid: "0x1234", isBuy: false, limitPx: 1980, size: 2,
      observedStatus: "pending",
    });
    expect(r.ok).toBe(true);
    const order = await t.run((ctx) => ctx.db.get(r.orderId));
    expect(order!.role).toBe("close");
    expect(order!.triggerPx).toBeUndefined();
    expect(order!.reduceOnly).toBe(true);
  });

  it("setTradingTrailAnchor: Long solo acepta avances hacia ARRIBA (favorable); adverso = no-op", async () => {
    const t = makeConvexTest();
    const { armId, token } = await armWithLease(t);
    expect((await t.mutation(internal.tradingBots.setTradingTrailAnchor, { armId, token, anchorPx: 2100 })).ok).toBe(true);
    let arm = await t.run((ctx) => ctx.db.get(armId));
    expect(arm!.trailAnchorPx).toBe(2100);
    const r = await t.mutation(internal.tradingBots.setTradingTrailAnchor, { armId, token, anchorPx: 2050 });
    expect(r).toMatchObject({ ok: true, unchanged: true });
    arm = await t.run((ctx) => ctx.db.get(armId));
    expect(arm!.trailAnchorPx).toBe(2100);   // jamás retrocede
  });

  it("setTradingTrailAnchor: Short solo acepta avances hacia ABAJO", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded, { filledSide: "Short" });
      return { armId };
    });
    await t.mutation(internal.tradingBots.setTradingTrailAnchor, { armId, token: "lease-1", anchorPx: 1950 });
    const r = await t.mutation(internal.tradingBots.setTradingTrailAnchor, { armId, token: "lease-1", anchorPx: 1990 });
    expect(r).toMatchObject({ ok: true, unchanged: true });
    const arm = await t.run((ctx) => ctx.db.get(armId));
    expect(arm!.trailAnchorPx).toBe(1950);
  });
});

describe("gates/CAS/failPreOrder — strings [blocked_cap] y guard bajo lease (V2-P4/V2-P1)", () => {
  it("CAS feliz: arming→submitting con token y submittedAt", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    const cas = await t.mutation(internal.tradingBots.markTradingArmSubmitting, { armId: r.armId });
    expect(cas.ok).toBe(true);
    expect(cas.token).toBeTruthy();
    const arm = await t.run((ctx) => ctx.db.get(r.armId));
    expect(arm!.status).toBe("submitting");
    expect(arm!.submittedAt).toBeTruthy();
  });

  it("gate con cap inadmisible ⇒ failed con string '[blocked_cap] cap/plan/suspensión' (NUNCA blocked_margin)", async () => {
    const t = makeConvexTest();
    const { botId, userId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "clerk_gate", role: "viewer", subscriptionPlan: "vault" });
      await ctx.db.insert("user_permissions", { userId, permission: "canTradeLive", granted: true, grantedAt: Date.now() });
      return await seedTradingBot(ctx, {}, { userId });
    });
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    const cas = await t.mutation(internal.tradingBots.markTradingArmSubmitting, { armId: r.armId });
    expect(cas.ok).toBe(true);
    // El plan desaparece entre el CAS y el envío (downgrade) ⇒ el gate cae con el string del clon.
    await t.run(async (ctx) => { await ctx.db.patch(userId, { subscriptionPlan: undefined }); });
    const gate = await t.mutation(internal.tradingBots.gateTradingArmBeforeOrder, { armId: r.armId, token: cas.token! });
    expect(gate.ok).toBe(false);
    const arm = await t.run((ctx) => ctx.db.get(r.armId));
    expect(arm!.status).toBe("failed");
    expect(arm!.error).toMatch(/^\[blocked_cap\] cap\/plan\/suspensión/);
    expect(arm!.error).not.toMatch(/blocked_margin/);
    const bot = await t.run((ctx) => ctx.db.get(botId));
    expect(bot!.rearmStatus).toBe("pending");   // scheduleTradingRearmAfterFailed
  });

  it("gate re-chequea el guard simétrico bajo lease: manual viva entre CAS y envío ⇒ failed [transient]", async () => {
    const t = makeConvexTest();
    const seeded = await t.run((ctx) => seedTradingBot(ctx));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(seeded.botId));
    const cas = await t.mutation(internal.tradingBots.markTradingArmSubmitting, { armId: r.armId });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("execution_requests", {
        userId: seeded.userId, botId: seeded.botId, idempotencyKey: "k-gate",
        hlAccountId: seeded.hlAccountId, poolId: seeded.poolId, hedgeNotionalUsd: 100,
        asset: "ETH", stopLossPct: 1, requestedAmount: 100, notional: 100, marginReserved: 10,
        side: "Long", status: "pending", network: "testnet", entryCloid: "0xg", slCloid: "0xh",
        slAttempt: 0, createdAt: now, updatedAt: now,
      } as any);
    });
    const gate = await t.mutation(internal.tradingBots.gateTradingArmBeforeOrder, { armId: r.armId, token: cas.token! });
    expect(gate.ok).toBe(false);
    const arm = await t.run((ctx) => ctx.db.get(r.armId));
    expect(arm!.status).toBe("failed");
    expect(arm!.error).toMatch(/^\[transient\] Intent vivo \(manual:pending\)/);
  });

  it("failTradingPreOrder: aborta SIN RPC en vuelo (V2-P1) y programa el rearm; rechaza si una entry ya se envió", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx));
    const r = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId));
    const cas = await t.mutation(internal.tradingBots.markTradingArmSubmitting, { armId: r.armId });
    const pf = await t.mutation(internal.tradingBots.failTradingPreOrder, {
      armId: r.armId, token: cas.token!, error: "[transient] topología stale pre-RPC (reintento)",
    });
    expect(pf.ok).toBe(true);
    const arm = await t.run((ctx) => ctx.db.get(r.armId));
    expect(arm!.status).toBe("failed");
    const bot = await t.run((ctx) => ctx.db.get(botId));
    expect(bot!.rearmStatus).toBe("pending");

    // Con una entry YA enviada (submittedAt), la garantía "sin RPC en vuelo" no existe ⇒ rechazo.
    const { botId: botId2 } = await t.run((ctx) => seedTradingBot(ctx));
    const r2 = await t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId2));
    const cas2 = await t.mutation(internal.tradingBots.markTradingArmSubmitting, { armId: r2.armId });
    await t.run(async (ctx) => {
      const entry = await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) =>
        q.eq("armId", r2.armId).eq("role", "entry_upper")).first();
      await ctx.db.patch(entry!._id, { submittedAt: Date.now() });
    });
    const pf2 = await t.mutation(internal.tradingBots.failTradingPreOrder, {
      armId: r2.armId, token: cas2.token!, error: "[transient] x",
    });
    expect(pf2.ok).toBe(false);
  });
});

describe("reserva — compatibilidad marketEntry.side y trailing legacy (fail-closed)", () => {
  it("marketEntry.side incompatible con la dirección ⇒ [blocked_config]", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx, { direction: "long" }));
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId, {
      markPx: 3100, marketEntry: { side: "Short" }, lowerTriggerPx: undefined, upperTriggerPx: undefined,
      entryUpperLimitPx: undefined, entryLowerLimitPx: undefined,
    }))).rejects.toThrow(/\[blocked_config\] marketEntry\.side/);
  });

  it("trailingStop activo con trailingPct legacy inválido ⇒ [blocked_config] (no arma sin la protección)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedTradingBot(ctx, { trailingStop: true, trailingPct: undefined }));
    await expect(t.mutation(internal.tradingBots.reserveTradingArm, reserveArgs(botId)))
      .rejects.toThrow(/\[blocked_config\] trailingStop activo con trailingPct inválido/);
  });
});

describe("settle — resets/no-rearm restantes y candados compartidos", () => {
  it("closed(tp) resetea el streak INCONDICIONALMENTE (aun con autoRearm apagado)", async () => {
    const t = makeConvexTest();
    const { seeded, armId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx, { autoRearm: false });
      await ctx.db.patch(seeded.botId, { marketReentryStreak: 3 });
      const armId = await seedArm(ctx, seeded);
      return { seeded, armId };
    });
    await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "closed", token: "lease-1", closeReason: "tp",
    });
    const bot = await t.run((ctx) => ctx.db.get(seeded.botId));
    expect(bot!.marketReentryStreak).toBe(0);
    expect(bot!.rearmStatus).toBeUndefined();   // sin autoRearm no se programa nada
  });

  it("closed(manual) y closed(emergency) NO rearman ni tocan contadores", async () => {
    const t = makeConvexTest();
    for (const closeReason of ["manual", "emergency"] as const) {
      const { seeded, armId } = await t.run(async (ctx) => {
        const seeded = await seedTradingBot(ctx);
        const armId = await seedArm(ctx, seeded);
        return { seeded, armId };
      });
      await t.mutation(internal.tradingBots.settleTradingArm, {
        armId, status: "closed", token: "lease-1", closeReason,
      });
      const bot = await t.run((ctx) => ctx.db.get(seeded.botId));
      expect(bot!.rearmStatus).toBeUndefined();
      expect(bot!.consecutiveStops ?? 0).toBe(0);
    }
  });

  it("terminal con disarmPending completa la PAUSA (active=false, disarm limpio)", async () => {
    const t = makeConvexTest();
    const { seeded, armId } = await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      await ctx.db.patch(seeded.botId, { disarmPending: true, disarmRequestedAt: Date.now() });
      const armId = await seedArm(ctx, seeded, { status: "disarming", desiredState: "disarmed" });
      return { seeded, armId };
    });
    await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "disarmed", token: "lease-1" });
    const bot = await t.run((ctx) => ctx.db.get(seeded.botId));
    expect(bot!.active).toBe(false);
    expect(bot!.disarmPending).toBe(false);
  });

  it("candados compartidos: hasNonTerminalArmForBot ve trading_arms y el disarm marca desiredState", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const seeded = await seedTradingBot(ctx);
      const armId = await seedArm(ctx, seeded);
      expect(await hasNonTerminalArmForBot(ctx, seeded.botId)).toBe(true);
      const r = await requestDisarmAndDeactivateImpl(ctx, seeded.botId);
      expect(r.deactivated).toBe(false);                 // hay arm vivo ⇒ pausa diferida
      const arm = await ctx.db.get(armId);
      expect(arm!.desiredState).toBe("disarmed");
      const bot = await ctx.db.get(seeded.botId);
      expect(bot!.disarmPending).toBe(true);
    });
  });

  it("guard DESPUÉS del dedupe: un reintento con la MISMA idempotencyKey se reconcilia aunque haya arm vivo", async () => {
    const t = makeConvexTest();
    const seeded = await t.run(async (ctx) => {
      const s = await seedTradingBot(ctx);
      const now = Date.now();
      await ctx.db.insert("execution_requests", {
        userId: s.userId, botId: s.botId, idempotencyKey: "k-retry",
        hlAccountId: s.hlAccountId, poolId: s.poolId, hedgeNotionalUsd: 100,
        asset: "ETH", stopLossPct: 1, requestedAmount: 100, notional: 100, marginReserved: 10,
        side: "Long", status: "pending", network: "testnet", entryCloid: "0xi", slCloid: "0xj",
        slAttempt: 0, createdAt: now, updatedAt: now,
      } as any);
      await seedArm(ctx, s);   // arm de trading vivo en la misma (cuenta, coin)
      return s;
    });
    const r = await t.mutation(internal.executions.reserveExecution, {
      userId: seeded.userId, botId: seeded.botId, idempotencyKey: "k-retry",
      hlAccountId: seeded.hlAccountId, poolId: seeded.poolId, hedgeNotionalUsd: 100,
      asset: "ETH", stopLossPct: 1, requestedAmount: 100, notional: 100, availableCollateral: 10000,
      autoLeverage: false, manualLeverage: 5, assetMaxLeverage: 20, side: "Long", network: "testnet",
      entryCloid: "0xi", slCloid: "0xj",
    });
    expect(r.alreadyExists).toBe(true);   // dedupe ANTES del guard: la reconciliación no se bloquea
  });
});

describe("preservación IL (V2-P4) — blocked_cap fluye sin regresión", () => {
  it("la RESERVA COMPARTIDA lanza [blocked_cap] anclado y la cadena IL lo clasifica blocked_cap", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "clerk_il_cap", role: "viewer", subscriptionPlan: "betatester" });
      const poolId = await seedPool(ctx);
      let thrown = "";
      try {
        await assertWithinPlanCoverageForKey(ctx, userId, poolCoverageKey(poolId), 6000);   // 6k > 5k
      } catch (e) {
        thrown = String((e as Error).message);
      }
      expect(thrown).toMatch(/^\[blocked_cap\] Supera el tope/);
      // armErrorKind (la clasificación que processRearms IL usa) ⇒ blocked_cap ⇒ outcome "blocked"
      // por el branch extendido de triggerEngine — jamás "transient" silencioso.
      expect(armErrorKind(thrown)).toBe("blocked_cap");
    });
  });

  it("el sniffer de spotDefense clasifica [blocked_cap] ANTES del catch-all '[blocked'", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      const userId = await seedUser(ctx);
      const hlAccountId = await seedCredential(ctx, userId);
      const spotPositionId = await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 60000, userId: "clerk_x" });
      const now = Date.now();
      const botId = await ctx.db.insert("spot_defense_bots", {
        userId, spotPositionId, hlAccountId, asset: "BTC", baseAsset: "BTC", side: "Short",
        leverage: 5, stopLossPct: 1, triggerMode: "manual", triggerPrice: 60000,
        requestedNotionalUsd: 100, active: true, status: "running", network: "testnet",
        generation: 0, rearmStatus: "pending", nextRearmAt: now - 1000, createdAt: now, updatedAt: now,
      });
      return { botId };
    });
    const claim = await t.mutation(internal.spotDefenseBots.claimSpotDefenseRearm, { botId });
    expect(claim.claimed).toBe(true);
    await t.mutation(internal.spotDefenseBots.settleSpotDefenseRearm, {
      botId, token: claim.token!, outcome: "blocked", error: "[blocked_cap] Supera el tope de cobertura del plan",
    });
    const bot = await t.run((ctx) => ctx.db.get(botId));
    expect(bot!.lastRearmErrorKind).toBe("blocked_cap");   // NO degradado a blocked_config
  });

  it("recordRearmOutcome acepta kind blocked_cap y lo persiste (outcome blocked + recheck)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      const userId = await seedUser(ctx);
      const poolId = await seedPool(ctx);
      const botId = await ctx.db.insert("bots", {
        name: "IL ETH", userId, poolId, kind: "il", baseAsset: "ETH", active: true, simulationMode: false,
        autoRearm: true, rearmStatus: "pending", nextRearmAt: Date.now() - 1000,
      });
      return { botId };
    });
    const claim = await t.mutation(internal.triggerRearm.claimRearm, { botId });
    expect(claim.ok).toBe(true);
    const r = await t.mutation(internal.triggerRearm.recordRearmOutcome, {
      botId, token: claim.token!, outcome: "blocked", kind: "blocked_cap",
      error: "[blocked_cap] Supera el tope de cobertura del plan", nextRearmAt: Date.now() + 5 * 60_000,
    });
    expect(r.ok).toBe(true);
    const bot = await t.run((ctx) => ctx.db.get(botId));
    expect(bot!.rearmStatus).toBe("blocked");
    expect(bot!.lastRearmErrorKind).toBe("blocked_cap");
  });
});
