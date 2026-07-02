import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedCredential, seedPool } from "./fixtures";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-180 / P5) getMyCoverageUsage: la MISMA verdad server-side del enforcement que consume la
// SubscriptionBar (en vez de estimar en cliente deduplicando por poolId). Cierra el hueco "cap vs
// barra" de JAV-176-P8: IL + Trading del MISMO pool SUMAN (no deduplican), y una fila viva no
// cuantificable ⇒ quantifiable:false (barra muestra "revisión requerida", nunca un 0 engañoso).

let prevNetwork: string | undefined;
beforeAll(() => { prevNetwork = process.env.HL_NETWORK; process.env.HL_NETWORK = "testnet"; });
afterAll(() => { if (prevNetwork === undefined) delete process.env.HL_NETWORK; else process.env.HL_NETWORK = prevNetwork; });

// convex-test corre las queries sin identidad; getUserOrNull devuelve null ⇒ para ejercitar el
// núcleo, sembramos el usuario y llamamos a la query con identidad falsa vía withIdentity.
async function seedUserWithPlan(ctx: MutationCtx, plan: string | undefined, role: "viewer" | "admin" = "viewer") {
  return await ctx.db.insert("users", {
    clerkId: "clerk_cov", role, ...(plan ? { subscriptionPlan: plan as any } : {}),
  });
}

describe("getMyCoverageUsage — verdad server-side (P5)", () => {
  it("sesión sin doc de usuario ⇒ null (mismo contrato getUserOrNull que el resto del portal)", async () => {
    const t = makeConvexTest();
    // Identidad Clerk sin fila users (race de primer login): getUserOrNull devuelve null ⇒ query null.
    expect(await t.withIdentity({ subject: "clerk_sin_doc" }).query(api.subscriptions.getMyCoverageUsage, {})).toBeNull();
  });

  it("IL + Trading + Defensa del MISMO usuario SUMAN sin dedupe (pool: + trading: + spot-defense:)", async () => {
    const t = makeConvexTest();
    const { userId, poolId } = await t.run(async (ctx) => {
      const userId = await seedUserWithPlan(ctx, "pro");   // cap 50k
      const hlAccountId = await seedCredential(ctx, userId);
      const poolId = await seedPool(ctx);
      const now = Date.now();
      // IL vivo (pool:<poolId>, hedge 3000)
      await ctx.db.insert("trigger_arms", {
        botId: await ctx.db.insert("bots", { name: "IL", userId, poolId, kind: "il", baseAsset: "ETH", active: true, simulationMode: false }),
        userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1, status: "armed",
        desiredState: "armed", side: "Short", triggerPx: 2000, size: 1, appliedLeverage: 5,
        reservedNotional: 3000, marginReserved: 600, hedgeNotionalUsd: 3000, stopLossPct: 1,
        lowerEdge: 2000, armMode: "oco", createdAt: now, updatedAt: now,
      } as any);
      // Trading vivo (trading:<botId>, coverage 5000)
      const trBotId = await ctx.db.insert("bots", { name: "TR", userId, poolId, kind: "trading", baseAsset: "ETH", direction: "long_short", capitalPct: 100, stopLossPct: 1, active: true, simulationMode: false });
      await ctx.db.insert("trading_arms", {
        botId: trBotId, userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", direction: "long_short", lowerEdge: 2000, upperEdge: 3000,
        size: 2, appliedLeverage: 10, legsFactor: 1, reservedNotional: 5000, marginReserved: 500,
        effectiveNotionalUsd: 5000, coverageNotionalUsd: 5000, stopLossPct: 1, createdAt: now, updatedAt: now,
      });
      // Defensa spot viva (spot-defense:<botId>, coverage 2000) — la TERCERA clave.
      const sdBotId = await ctx.db.insert("spot_defense_bots", {
        userId, spotPositionId: await ctx.db.insert("spot_positions", { asset: "BTC", amount: 1, dca: 60000, userId: "clerk_cov" }),
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
      return { userId, poolId };
    });
    const res = await t.withIdentity({ subject: "clerk_cov" }).query(api.subscriptions.getMyCoverageUsage, {});
    expect(res).not.toBeNull();
    expect(res!.quantifiable).toBe(true);
    expect(res!.cap).toBe(50_000);
    expect(res!.total).toBe(10_000);   // 3000 + 5000 + 2000 SUMAN (sin dedupe cruzado entre claves)
    // Valor POR CLAVE, no solo presencia del prefijo (aserción fuerte).
    const byPrefix = (p: string) => res!.byKey.filter((e) => e.key.startsWith(p)).reduce((s, e) => s + e.usd, 0);
    expect(byPrefix("pool:")).toBe(3000);
    expect(byPrefix("trading:")).toBe(5000);
    expect(byPrefix("spot-defense:")).toBe(2000);
  });

  it("fila viva sin coverageNotionalUsd ⇒ quantifiable:false (barra: revisión requerida, no un 0)", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const userId = await seedUserWithPlan(ctx, "pro");
      const hlAccountId = await seedCredential(ctx, userId);
      const poolId = await seedPool(ctx);
      const trBotId = await ctx.db.insert("bots", { name: "TR", userId, poolId, kind: "trading", baseAsset: "ETH", direction: "long_short", capitalPct: 100, stopLossPct: 1, active: true, simulationMode: false });
      const now = Date.now();
      await ctx.db.insert("trading_arms", {
        botId: trBotId, userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", direction: "long_short", lowerEdge: 2000, upperEdge: 3000,
        size: 2, appliedLeverage: 10, legsFactor: 1, reservedNotional: 5000, marginReserved: 500,
        effectiveNotionalUsd: 5000, stopLossPct: 1, createdAt: now, updatedAt: now,   // SIN coverageNotionalUsd
      });
    });
    const res = await t.withIdentity({ subject: "clerk_cov" }).query(api.subscriptions.getMyCoverageUsage, {});
    expect(res!.quantifiable).toBe(false);
    expect(res!.total).toBe(0);
    expect(res!.cap).toBe(50_000);   // el cap se conserva; la barra muestra "revisión requerida"
  });

  it("(JAV-180-C1) fila viva no cuantificable ⇒ quantifiable:false; NINGÚN otro error se traga", async () => {
    // El único degrade permitido es el [blocked_config] de consumedCoverageByKey (fila viva sin dato
    // fiable). Ese caso ⇒ quantifiable:false (ya cubierto arriba). Aquí se afirma el contrario: un
    // total normal NO es quantifiable:false, garantizando que el catch no lo dispara de más.
    const t = makeConvexTest();
    await t.run(async (ctx) => {
      const userId = await seedUserWithPlan(ctx, "pro");
      const hlAccountId = await seedCredential(ctx, userId);
      const poolId = await seedPool(ctx);
      const now = Date.now();
      const trBotId = await ctx.db.insert("bots", { name: "TR", userId, poolId, kind: "trading", baseAsset: "ETH", direction: "long_short", capitalPct: 100, stopLossPct: 1, active: true, simulationMode: false });
      await ctx.db.insert("trading_arms", {
        botId: trBotId, userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
        status: "armed", desiredState: "armed", direction: "long_short", lowerEdge: 2000, upperEdge: 3000,
        size: 2, appliedLeverage: 10, legsFactor: 1, reservedNotional: 5000, marginReserved: 500,
        effectiveNotionalUsd: 5000, coverageNotionalUsd: 5000, stopLossPct: 1, createdAt: now, updatedAt: now,
      });
    });
    const res = await t.withIdentity({ subject: "clerk_cov" }).query(api.subscriptions.getMyCoverageUsage, {});
    expect(res!.quantifiable).toBe(true);   // dato cuantificable ⇒ el catch NO lo degrada
    expect(res!.total).toBe(5000);
  });

  it("sin plan ⇒ cap 0 (fail-closed); admin ⇒ cap Infinity (acceso total)", async () => {
    const t = makeConvexTest();
    await t.run((ctx) => seedUserWithPlan(ctx, undefined));
    const noPlan = await t.withIdentity({ subject: "clerk_cov" }).query(api.subscriptions.getMyCoverageUsage, {});
    expect(noPlan!.hasPlan).toBe(false);
    expect(noPlan!.cap).toBe(0);

    const t2 = makeConvexTest();
    await t2.run((ctx) => seedUserWithPlan(ctx, undefined, "admin"));
    const admin = await t2.withIdentity({ subject: "clerk_cov" }).query(api.subscriptions.getMyCoverageUsage, {});
    expect(admin!.isAdmin).toBe(true);
    expect(admin!.cap).toBe(Infinity);
  });
});
