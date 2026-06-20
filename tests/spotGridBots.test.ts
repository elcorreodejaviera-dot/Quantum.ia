import { describe, it, expect } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { SPOT_GRID_DETAIL_CYCLE_CAP } from "../convex/spotGridBots";
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

  it("inputs inválidos: gridCount no entero → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { gridCount: 2.5 })))
      .rejects.toThrow(/gridCount/);
  });

  it("(Codex ALTO) presupuesto total orderSize×gridCount > investmentAmount → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    // 50 × 5 = 250 > 100 (aunque una sola orden 50 ≤ 100).
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { orderSize: 50, gridCount: 5, investmentAmount: 100, freeQuoteBalance: 500 })))
      .rejects.toThrow(/[Pp]resupuesto|orderSize×gridCount/);
  });

  it("(Codex MEDIO) orderSize < mínimo notional HL (~$10) → rechaza", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    await expect(asUser(t).mutation(internal.spotGridBots.persistSpotGridBot, args(hlAccountId, { orderSize: 5, gridCount: 1 })))
      .rejects.toThrow(/m[ií]nimo notional|10 USDC/);
  });
});

describe("preflightCreateSpotGridBot — guards ANTES de la RPC (JAV-91, Codex MEDIO #2)", () => {
  const preArgs = (hlAccountId: Id<"hl_api_credentials">, over: any = {}) => ({
    hlAccountId, network: "testnet" as const,
    minPrice: 50000, gridProfitPercent: 1, investmentAmount: 100, orderSize: 20, gridCount: 5, feeRate: 0.0004, ...over,
  });

  it("happy path: devuelve la tradingAccountAddress (todo OK)", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    const r = await asUser(t).query(internal.spotGridBots.preflightCreateSpotGridBot, preArgs(hlAccountId));
    expect(typeof r.tradingAccountAddress).toBe("string");
  });

  it("rechaza ANTES de tocar HL si falta canTradeLive", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t, ["canManageBots"]);
    await expect(asUser(t).query(internal.spotGridBots.preflightCreateSpotGridBot, preArgs(hlAccountId)))
      .rejects.toThrow(/canTradeLive/);
  });

  it("rechaza inputs inválidos (presupuesto excedido) en el preflight", async () => {
    const t = makeConvexTest();
    const hlAccountId = await seedLiveEnv(t);
    await expect(asUser(t).query(internal.spotGridBots.preflightCreateSpotGridBot, preArgs(hlAccountId, { orderSize: 50, gridCount: 5, investmentAmount: 100 })))
      .rejects.toThrow(/[Pp]resupuesto|orderSize×gridCount/);
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

describe("pause/list/get — ownership (JAV-91, Codex BAJO)", () => {
  async function seedBotFor(t: any, clerkId: string) {
    return await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx, ["canManageBots", "canTradeLive"], "viewer", clerkId);
      const hlAccountId = await seedCredential(ctx, userId);
      const now = Date.now();
      const botId = await ctx.db.insert("spot_grid_bots", {
        userId, hlAccountId, symbol: "BTC", assetId: 10107, baseAsset: "UBTC", quoteAsset: "USDC",
        minPrice: 50000, gridProfitPercent: 1, investmentAmount: 100, orderSize: 20, gridCount: 5,
        feeRate: 0.0004, status: "running", network: "testnet", generation: 1, createdAt: now, updatedAt: now,
      });
      return { userId, botId };
    });
  }
  const as = (t: any, clerkId: string) => t.withIdentity({ subject: clerkId });

  it("pauseSpotGridBot: el dueño pausa (running → paused)", async () => {
    const t = makeConvexTest();
    const { botId } = await seedBotFor(t, "owner1");
    await as(t, "owner1").mutation(api.spotGridBots.pauseSpotGridBot, { botId });
    expect((await t.run((ctx: MutationCtx) => ctx.db.get(botId)))?.status).toBe("paused");
  });

  it("pauseSpotGridBot: un usuario ajeno NO puede pausar", async () => {
    const t = makeConvexTest();
    const { botId } = await seedBotFor(t, "owner1");
    await t.run(async (ctx: MutationCtx) => { await seedUser(ctx, ["canManageBots", "canTradeLive"], "viewer", "intruso"); });
    await expect(as(t, "intruso").mutation(api.spotGridBots.pauseSpotGridBot, { botId }))
      .rejects.toThrow(/ajeno|no encontrado/i);
  });

  it("listSpotGridBots / getSpotGridBot: solo devuelven los del dueño", async () => {
    const t = makeConvexTest();
    const { botId } = await seedBotFor(t, "owner1");
    await seedBotFor(t, "owner2");                       // bot de OTRO usuario
    const mine = await as(t, "owner1").query(api.spotGridBots.listSpotGridBots, {});
    expect(mine.length).toBe(1);
    expect(mine[0]._id).toBe(botId);
    // owner2 NO ve el bot de owner1 por getSpotGridBot.
    expect(await as(t, "owner2").query(api.spotGridBots.getSpotGridBot, { botId })).toBeNull();
    expect((await as(t, "owner1").query(api.spotGridBots.getSpotGridBot, { botId }))?._id).toBe(botId);
  });

  it("getSpotGridDetail: ownership + agrega stats de ciclos (cyclesCount/totalNetProfit) sin truncar", async () => {
    const t = makeConvexTest();
    const { userId, botId } = await seedBotFor(t, "owner1");
    await t.run(async (ctx: MutationCtx) => { await seedUser(ctx, ["canManageBots", "canTradeLive"], "viewer", "owner2"); });
    await t.run(async (ctx: MutationCtx) => {
      const now = Date.now();
      const mkOrder = (side: "buy" | "sell", cloid: string) => ctx.db.insert("spot_grid_orders", {
        botId, userId, cloid, assetId: 10107, side, price: 50000, quantity: 0.001, quoteSize: 50,
        gridLevel: 0, generation: 1, cycleId: 0, status: "filled", createdAt: now,
      });
      const buyId = await mkOrder("buy", "0xb");
      // Dos ciclos cerrados con netProfit conocido + una orden viva (open).
      for (const [i, np] of [1.5, 2.25].entries()) {
        await ctx.db.insert("spot_grid_cycles", {
          botId, userId, cycleId: i, buyOrderId: buyId, buyPrice: 50000, sellPrice: 50500,
          quantity: 0.001, netProfit: np, closedAt: now,
        });
      }
      await ctx.db.insert("spot_grid_orders", {
        botId, userId, cloid: "0xopen", assetId: 10107, side: "buy", price: 49000, quantity: 0.001,
        quoteSize: 49, gridLevel: 1, generation: 1, cycleId: 2, status: "open", createdAt: now,
      });
    });
    const ajeno = await as(t, "owner2").query(api.spotGridBots.getSpotGridDetail, { botId });
    expect(ajeno).toBeNull();                                   // ownership: ajeno → null
    const d = await as(t, "owner1").query(api.spotGridBots.getSpotGridDetail, { botId });
    expect(d?.stats.cyclesCount).toBe(2);
    expect(d?.stats.totalNetProfit).toBeCloseTo(3.75, 6);
    expect(d?.stats.truncated).toBe(false);
    expect(d?.recentCycles.length).toBe(2);
    expect(d?.openOrders.some((o: any) => o.status === "open")).toBe(true);
    // Nunca expone credencial/clave (ni hlAccountId): solo escalares.
    expect(JSON.stringify(d)).not.toMatch(/encryptedPrivateKey|authTag|hlAccountId/);
  });

  it("getSpotGridDetail: borde de truncado — exactamente cap (false) vs cap+1 (true, cyclesCount===cap)", async () => {
    const cap = SPOT_GRID_DETAIL_CYCLE_CAP;
    async function detailWith(nCycles: number) {
      const t = makeConvexTest();
      const { userId, botId } = await seedBotFor(t, "owner1");
      await t.run(async (ctx: MutationCtx) => {
        const now = Date.now();
        const buyId = await ctx.db.insert("spot_grid_orders", {
          botId, userId, cloid: "0xb", assetId: 10107, side: "buy", price: 50000, quantity: 0.001,
          quoteSize: 50, gridLevel: 0, generation: 1, cycleId: 0, status: "filled", createdAt: now,
        });
        for (let i = 0; i < nCycles; i++) {
          await ctx.db.insert("spot_grid_cycles", {
            botId, userId, cycleId: i, buyOrderId: buyId, buyPrice: 50000, sellPrice: 50500,
            quantity: 0.001, netProfit: 1, closedAt: now + i,
          });
        }
      });
      return await as(t, "owner1").query(api.spotGridBots.getSpotGridDetail, { botId });
    }
    const exact = await detailWith(cap);
    expect(exact?.stats.truncated).toBe(false);                 // exactamente cap → NO truncado
    expect(exact?.stats.cyclesCount).toBe(cap);
    const over = await detailWith(cap + 1);
    expect(over?.stats.truncated).toBe(true);                   // cap+1 → truncado
    expect(over?.stats.cyclesCount).toBe(cap);                  // cuenta tope al cap, no cap+1
  });
});
