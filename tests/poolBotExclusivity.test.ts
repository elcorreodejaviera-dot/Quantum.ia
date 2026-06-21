import { describe, it, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedCredential } from "./fixtures";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-102) Exclusividad de cuenta HL en la cobertura (getOrCreatePoolBot) y en la revocación
// (revokeById). Regla: la cobertura comparte cuenta SOLO entre pares distintos (un bot por
// baseAsset), nunca el mismo par dos veces ni junto a un Spot Grid; el grid exige cuenta dedicada
// total. Revocar con un grid vivo se bloquea (perderíamos la clave para cancelar sus órdenes).

const CLERK = "u-cov";

async function seedUser(ctx: MutationCtx, perms: string[] = ["canManageBots"], clerkId = CLERK) {
  const userId = await ctx.db.insert("users", { clerkId, role: "viewer" });
  for (const p of perms) await ctx.db.insert("user_permissions", { userId, permission: p, granted: true, grantedAt: Date.now() });
  return userId;
}

async function seedPool(ctx: MutationCtx, userId: Id<"users">, pair: string) {
  return await ctx.db.insert("pools", { userId, pair, network: "testnet", minRange: 1, maxRange: 2, status: "open" });
}

async function seedGrid(ctx: MutationCtx, userId: Id<"users">, hlAccountId: Id<"hl_api_credentials">, status: string) {
  const now = Date.now();
  return await ctx.db.insert("spot_grid_bots", {
    userId, hlAccountId, symbol: "BTC", assetId: 10107, baseAsset: "UBTC", quoteAsset: "USDC",
    minPrice: 50000, gridProfitPercent: 1, investmentAmount: 100, orderSize: 20, gridCount: 5,
    feeRate: 0.0004, status, network: "testnet", generation: 1, createdAt: now, updatedAt: now,
  });
}

const asUser = (t: any) => t.withIdentity({ subject: CLERK });
// Config mínima válida para un bot IL (cobertura short). simulationMode default → no exige canTradeLive.
const ilArgs = (poolId: Id<"pools">, hlAccountId: Id<"hl_api_credentials">) =>
  ({ poolId, kind: "il" as const, hlAccountId, direction: "short" as const });

describe("getOrCreatePoolBot — exclusividad por par (JAV-102)", () => {
  it("mismo par en la misma cuenta → rechaza", async () => {
    const t = makeConvexTest();
    const { acc, poolBtc1, poolBtc2 } = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx);
      const acc = await seedCredential(ctx, userId);
      return { acc, poolBtc1: await seedPool(ctx, userId, "BTC/USDC"), poolBtc2: await seedPool(ctx, userId, "BTC/USDC") };
    });
    await asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolBtc1, acc));
    await expect(asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolBtc2, acc)))
      .rejects.toThrow(/ya tiene una cobertura para BTC\/USDC/i);
  });

  it("otro par en la misma cuenta → permitido", async () => {
    const t = makeConvexTest();
    const { acc, poolBtc, poolEth } = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx);
      const acc = await seedCredential(ctx, userId);
      return { acc, poolBtc: await seedPool(ctx, userId, "BTC/USDC"), poolEth: await seedPool(ctx, userId, "ETH/USDC") };
    });
    await asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolBtc, acc));
    const id = await asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolEth, acc));
    expect(id).toBeTruthy();
    const bot = await t.run((ctx: MutationCtx) => ctx.db.get(id));
    expect(bot?.baseAsset).toBe("ETH");
  });

  it("cuenta con un Spot Grid VIVO → rechaza la cobertura", async () => {
    const t = makeConvexTest();
    const { acc, poolBtc } = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx);
      const acc = await seedCredential(ctx, userId);
      await seedGrid(ctx, userId, acc, "running");
      return { acc, poolBtc: await seedPool(ctx, userId, "BTC/USDC") };
    });
    await expect(asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolBtc, acc)))
      .rejects.toThrow(/vinculada a un Spot Grid/i);
  });

  it("cuenta con un Spot Grid STOPPED → permite la cobertura", async () => {
    const t = makeConvexTest();
    const { acc, poolBtc } = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx);
      const acc = await seedCredential(ctx, userId);
      await seedGrid(ctx, userId, acc, "stopped");
      return { acc, poolBtc: await seedPool(ctx, userId, "BTC/USDC") };
    });
    const id = await asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolBtc, acc));
    expect(id).toBeTruthy();
  });

  it("upsert del MISMO bot (mismo pool/kind/cuenta) → NO se rechaza a sí mismo", async () => {
    const t = makeConvexTest();
    const { acc, poolBtc } = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx);
      const acc = await seedCredential(ctx, userId);
      return { acc, poolBtc: await seedPool(ctx, userId, "BTC/USDC") };
    });
    const id1 = await asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolBtc, acc));
    const id2 = await asUser(t).mutation(api.bots.getOrCreatePoolBot, ilArgs(poolBtc, acc));
    expect(id2).toBe(id1);   // mismo (user,pool,kind) → patch, no segundo bot
  });
});

describe("revokeById — guard de Spot Grid vivo (JAV-102)", () => {
  it("revocar con un grid VIVO → rechaza", async () => {
    const t = makeConvexTest();
    const acc = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx);
      const acc = await seedCredential(ctx, userId);
      await seedGrid(ctx, userId, acc, "running");
      return acc;
    });
    await expect(asUser(t).mutation(api.hlCredentials.revokeById, { id: acc }))
      .rejects.toThrow(/Spot Grid activo/i);
    // Sigue existiendo (no se borró la credencial).
    expect(await t.run((ctx: MutationCtx) => ctx.db.get(acc))).not.toBeNull();
  });

  it("revocar con un grid STOPPED → borra la credencial", async () => {
    const t = makeConvexTest();
    const acc = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx);
      const acc = await seedCredential(ctx, userId);
      await seedGrid(ctx, userId, acc, "stopped");
      return acc;
    });
    await asUser(t).mutation(api.hlCredentials.revokeById, { id: acc });
    expect(await t.run((ctx: MutationCtx) => ctx.db.get(acc))).toBeNull();
  });
});
