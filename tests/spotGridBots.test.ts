import { describe, it, expect } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedCredential } from "./fixtures";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-91) Guards de createSpotGridBot (vía persistSpotGridBot) + setMainnetSpotGridApproval. Congela:
// canManageBots + canTradeLive (AMBOS), switches live-only, gate mainnet, exclusividad TOTAL de cuenta,
// inputs y balance. NO se prueba la action (RPC node) — eso queda fuera del harness mutation-safe.

const CLERK = "u-grid";

async function seedUser(ctx: MutationCtx, perms: string[], role: "admin" | "viewer" = "viewer", clerkId = CLERK) {
  const userId = await ctx.db.insert("users", { clerkId, role });
  for (const p of perms) await ctx.db.insert("user_permissions", { userId, permission: p, granted: true, grantedAt: Date.now() });
  return userId;
}
const setCfg = (ctx: MutationCtx, key: string, value: any) => ctx.db.insert("system_config", { key, value });

const args = (hlAccountId: Id<"hl_api_credentials">, over: any = {}) => ({
  hlAccountId, symbol: "BTC", assetId: 10107, baseAsset: "UBTC", quoteAsset: "USDC",
  minPrice: 50000, gridProfitPercent: 1, investmentAmount: 100, orderSize: 20, gridCount: 5,
  feeRate: 0.0004, currentPrice: 65000, freeQuoteBalance: 500, network: "testnet" as const, ...over,
});

async function seedLiveEnv(t: any, perms = ["canManageBots", "canTradeLive"]) {
  return await t.run(async (ctx: MutationCtx) => {
    const userId = await seedUser(ctx, perms);
    await setCfg(ctx, "tradingEnabled", true);
    await setCfg(ctx, "simulationMode", false);
    return await seedCredential(ctx, userId);
  });
}
const asUser = (t: any) => t.withIdentity({ subject: CLERK });

describe("persistSpotGridBot — guards (JAV-91)", () => {
  it("happy path: ambos permisos + trading on + sim off + testnet → crea bot running", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    const r = await asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId));
    expect(r.ok).toBe(true);
    const bot = await t.run((ctx: MutationCtx) => ctx.db.get(r.botId));
    expect(bot?.status).toBe("running");
    expect(bot?.assetId).toBe(10107);
    expect(bot?.generation).toBe(1);
  });

  it("rechaza si falta canTradeLive (canManageBots no basta para operar)", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t, ["canManageBots"]);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId)))
      .rejects.toThrow(/canTradeLive/);
  });

  it("rechaza si falta canManageBots (canTradeLive no basta para crear bots)", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t, ["canTradeLive"]);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId)))
      .rejects.toThrow(/canManageBots/);
  });

  it("kill switch: tradingEnabled false → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx, ["canManageBots", "canTradeLive"]);
      await setCfg(ctx, "tradingEnabled", false);
      await setCfg(ctx, "simulationMode", false);
      return await seedCredential(ctx, userId);
    });
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId)))
      .rejects.toThrow(/deshabilitado|kill/i);
  });

  it("simulationMode global → rechaza (live-only)", async () => {
    const t = makeConvexTest();
    const hlAccountId = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx, ["canManageBots", "canTradeLive"]);
      await setCfg(ctx, "tradingEnabled", true);
      await setCfg(ctx, "simulationMode", true);
      return await seedCredential(ctx, userId);
    });
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId)))
      .rejects.toThrow(/simulaci/i);
  });

  it("gate mainnet: network mainnet sin aprobación → rechaza; tras setMainnetSpotGridApproval(true) → acepta", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { network: "mainnet" })))
      .rejects.toThrow(/mainnet/i);
    // Un admin aprueba el gate.
    await t.run(async (ctx: MutationCtx) => { await seedUser(ctx, [], "admin", "admin-clerk"); });
    await t.withIdentity({ subject: "admin-clerk" }).mutation(api.spotGridBots.setMainnetSpotGridApproval, { enabled: true });
    const r = await asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { network: "mainnet" }));
    expect(r.ok).toBe(true);
  });

  it("exclusividad: cuenta ya usada por un bot perp/IL → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx, ["canManageBots", "canTradeLive"]);
      await setCfg(ctx, "tradingEnabled", true);
      await setCfg(ctx, "simulationMode", false);
      const acc = await seedCredential(ctx, userId);
      await ctx.db.insert("bots", { name: "IL", active: true, simulationMode: false, userId, hlAccountId: acc });
      return acc;
    });
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId)))
      .rejects.toThrow(/cuenta dedicada|cobertura|trading/i);
  });

  it("exclusividad: cuenta ya usada por otro spot grid vivo → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    await asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId));   // primer grid
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId)))  // segundo en misma cuenta
      .rejects.toThrow(/cuenta dedicada|Spot Grid activo/i);
  });

  it("balance insuficiente → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { freeQuoteBalance: 50 })))
      .rejects.toThrow(/insuficiente/i);
  });

  it("inputs inválidos: gridCount no entero / orderSize > investment → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { gridCount: 2.5 })))
      .rejects.toThrow(/gridCount/);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { orderSize: 200 })))
      .rejects.toThrow(/orderSize/);
  });
});

describe("setMainnetSpotGridApproval (JAV-91)", () => {
  it("solo admin; no admin → Forbidden", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx: MutationCtx) => { await seedUser(ctx, ["canManageBots", "canTradeLive"]); });
    await expect(asUser(t).mutation(api.spotGridBots.setMainnetSpotGridApproval, { enabled: true }))
      .rejects.toThrow(/Forbidden/);
  });

  it("admin sella enabled + escribe admin_log", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx: MutationCtx) => { await seedUser(ctx, [], "admin", "admin-clerk"); });
    await t.withIdentity({ subject: "admin-clerk" }).mutation(api.spotGridBots.setMainnetSpotGridApproval, { enabled: true });
    const { row, log } = await t.run(async (ctx: MutationCtx) => ({
      row: await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "mainnetSpotGridApproved")).first(),
      log: await ctx.db.query("admin_logs").collect(),
    }));
    expect(row?.value?.enabled).toBe(true);
    expect(log.some((l: any) => l.action === "set_mainnet_spot_grid_approval")).toBe(true);
  });
});
