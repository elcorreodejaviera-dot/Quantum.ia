"use node";

// (QSG / JAV-91) Action "use node" de creación de Spot Grid: hace las LECTURAS RPC públicas (resolver
// activo por red, precio, balance quote — sin clave, sólo InfoClient) y delega el persistido con TODOS
// los guards de DB a internal.spotGridBots.persistSpotGridBot (atómico). AISLADA: vive en su propio
// archivo node para no forzar a las mutations/queries de spotGridBots.ts a ser "use node"
// (esas deben ser convex-testables).

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { resolveSpotAsset, getSpotPrice, getSpotBalance } from "./hyperliquidSpot";
import { hlNetwork, hlIsTestnet, assertExpectedNetwork } from "./hlNetwork";
import { requireAuth } from "./helpers";

export const createSpotGridBot = action({
  args: {
    hlAccountId: v.id("hl_api_credentials"),
    symbol: v.string(),                        // "BTC" | "ETH" (allowlist la valida el resolver por red)
    minPrice: v.number(), gridProfitPercent: v.number(), investmentAmount: v.number(),
    orderSize: v.number(), gridCount: v.number(), feeRate: v.number(),
    expectedNetwork: v.string(), confirm: v.boolean(),
  },
  // Promise<any>: corta el ciclo de inferencia (TS2589) al encadenar internal.* en el mismo módulo.
  handler: async (ctx, a): Promise<any> => {
    await requireAuth(ctx);
    assertExpectedNetwork(a.expectedNetwork);                  // red del backend = fuente de verdad
    if (!a.confirm) throw new Error("Crear Spot Grid requiere confirmación LIVE explícita.");
    const network = hlNetwork();

    // (Codex MEDIO #2) PREFLIGHT ANTES de tocar HL: permisos (canManageBots + canTradeLive), switches
    // live-only, gate mainnet, ownership, exclusividad de cuenta e inputs. Si falla, NO se hace ninguna
    // RPC. Devuelve la tradingAccountAddress para las lecturas públicas. (auth propagada al runQuery.)
    const pre = await ctx.runQuery(internal.spotGridBots.preflightCreateSpotGridBot, {
      hlAccountId: a.hlAccountId, network,
      minPrice: a.minPrice, gridProfitPercent: a.gridProfitPercent, investmentAmount: a.investmentAmount,
      orderSize: a.orderSize, gridCount: a.gridCount, feeRate: a.feeRate,
    });

    // Lecturas PÚBLICAS de HL (sin descifrar clave): resolver activo por red, precio, balance quote.
    const info = new InfoClient({ transport: new HttpTransport({ isTestnet: hlIsTestnet() }) });
    const resolved = await resolveSpotAsset(info, a.symbol, network);
    const currentPrice = await getSpotPrice(info, resolved);
    const bal = await getSpotBalance(info, pre.tradingAccountAddress, resolved.quoteAsset);

    // Persistir con TODOS los guards de DB (permisos, switches, gate mainnet, exclusividad, inputs,
    // balance) atómicos con el insert.
    return await ctx.runMutation(internal.spotGridBots.persistSpotGridBot, {
      hlAccountId: a.hlAccountId, symbol: a.symbol,
      assetId: resolved.assetId, baseAsset: resolved.baseAsset, quoteAsset: resolved.quoteAsset,
      minPrice: a.minPrice, gridProfitPercent: a.gridProfitPercent, investmentAmount: a.investmentAmount,
      orderSize: a.orderSize, gridCount: a.gridCount, feeRate: a.feeRate,
      currentPrice, freeQuoteBalance: bal.free, network,
    });
  },
});
