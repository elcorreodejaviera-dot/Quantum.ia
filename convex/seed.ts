import { mutation } from "./_generated/server";
import { requireAdmin } from "./helpers";

const SEED_POOLS = [
  { pair: "BTC/USDC", network: "Arbitrum", minRange: 63200, maxRange: 72400, status: "En rango" },
  { pair: "ETH/USDC", network: "Arbitrum", minRange: 3420, maxRange: 4020, status: "En rango" },
  { pair: "BTC/USDC", network: "Base", minRange: 64600, maxRange: 70100, status: "Cerca del borde" },
  { pair: "ETH/USDC", network: "Base", minRange: 3600, maxRange: 3880, status: "En rango" },
  { pair: "BTC/USDC", network: "Optimism", minRange: 61500, maxRange: 74200, status: "En rango" },
  { pair: "ETH/USDC", network: "Optimism", minRange: 3860, maxRange: 4240, status: "Fuera de rango" },
];

const SEED_BOTS = [
  { name: "bot1", action: "Cobertura short", active: true, mode: "Short", trigger: "Precio sale del rango o delta > 0.65", walletId: "WLT-001", capitalPerTrade: 2500, leverage: 3, stop: 2.5, simulationMode: true },
  { name: "bot2", action: "Cobertura long", active: true, mode: "Long", trigger: "Entrada defensiva cuando el precio recupera rango", walletId: "WLT-002", capitalPerTrade: 1800, leverage: 2, stop: 1.8, simulationMode: true },
  { name: "bot3", action: "Rebalanceo APR", active: false, mode: "Long + Short", trigger: "Rebalanceo cuando APR cae bajo 18%", walletId: "WLT-003", capitalPerTrade: 1200, leverage: 1, stop: 3.2, simulationMode: true },
];

const SEED_WALLETS = [
  { label: "Wallet bot1", type: "Bot", address: "0x8a21...91F4", network: "Arbitrum", ownerId: "bot1" },
  { label: "Wallet bot2", type: "Bot", address: "0x43d9...A2c8", network: "Base", ownerId: "bot2" },
  { label: "Wallet bot3", type: "Bot", address: "0x71b4...0E19", network: "Optimism", ownerId: "bot3" },
  { label: "Wallet pool BTC", type: "Pool", address: "0x5c02...B7D1", network: "Arbitrum", ownerId: "BTC/USDC" },
  { label: "Wallet pool ETH", type: "Pool", address: "0x96ef...3C44", network: "Base", ownerId: "ETH/USDC" },
];

// Idempotente: solo inserta si las tablas están vacías.
// Llamar una vez desde Convex dashboard o desde el primer login de admin.
export const seedInitialData = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const existingPools = await ctx.db.query("pools").first();
    if (!existingPools) {
      for (const pool of SEED_POOLS) await ctx.db.insert("pools", pool);
    }

    const existingBots = await ctx.db.query("bots").first();
    if (!existingBots) {
      for (const bot of SEED_BOTS) await ctx.db.insert("bots", bot);
    }

    const existingWallets = await ctx.db.query("wallets").first();
    if (!existingWallets) {
      for (const wallet of SEED_WALLETS) await ctx.db.insert("wallets", wallet);
    }

    const existingConfig = await ctx.db.query("system_config").first();
    if (!existingConfig) {
      await ctx.db.insert("system_config", { key: "simulationMode", value: true });
      await ctx.db.insert("system_config", { key: "tradingEnabled", value: false });
    }

    return { ok: true };
  },
});
