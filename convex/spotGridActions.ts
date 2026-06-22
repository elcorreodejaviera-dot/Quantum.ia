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
import { deriveAutoGrid, deriveSeededGrid } from "./spotGridEngine";   // (JAV-101/103) helpers puros de reparto
import { hlNetwork, hlIsTestnet, assertExpectedNetwork } from "./hlNetwork";
import { requireAuth } from "./helpers";

export const createSpotGridBot = action({
  args: {
    hlAccountId: v.id("hl_api_credentials"),
    symbol: v.string(),                        // "BTC" | "ETH" (allowlist la valida el resolver por red)
    minPrice: v.number(), gridProfitPercent: v.number(), investmentAmount: v.number(),
    feeRate: v.number(),
    // (JAV-101) Modo AUTO (default del form): el backend deriva gridCount/orderSize del rango tras leer el
    // precio spot real. Modo manual (avanzado): se envían explícitos.
    auto: v.optional(v.boolean()),
    orderSize: v.optional(v.number()), gridCount: v.optional(v.number()),
    expectedNetwork: v.string(), confirm: v.boolean(),
  },
  // Promise<any>: corta el ciclo de inferencia (TS2589) al encadenar internal.* en el mismo módulo.
  handler: async (ctx, a): Promise<any> => {
    await requireAuth(ctx);
    assertExpectedNetwork(a.expectedNetwork);                  // red del backend = fuente de verdad
    if (!a.confirm) throw new Error("Crear Spot Grid requiere confirmación LIVE explícita.");
    const network = hlNetwork();
    // (CodeRabbit Major) No dejar que gridCount/orderSize silenciosamente conviertan en MANUAL un payload que
    // pidió `auto: true`: esa combinación es ambigua → se rechaza. AUTO es el default; sólo es MANUAL si se
    // envía `auto: false` o se aportan niveles/tamaño explícitos (sin `auto: true`).
    if (a.auto === true && (a.gridCount !== undefined || a.orderSize !== undefined)) {
      throw new Error("Modo AUTO no admite gridCount ni orderSize explícitos; usa auto:false para el modo manual.");
    }
    const auto = a.auto !== false && a.gridCount === undefined && a.orderSize === undefined;

    // (Codex MEDIO #2) PREFLIGHT ANTES de tocar HL: permisos (canManageBots + canTradeLive), switches
    // live-only, gate mainnet, ownership, exclusividad de cuenta e inputs base. Si falla, NO se hace ninguna
    // RPC. Devuelve la tradingAccountAddress para las lecturas públicas. (auth propagada al runQuery.)
    const pre = await ctx.runQuery(internal.spotGridBots.preflightCreateSpotGridBot, {
      hlAccountId: a.hlAccountId, network,
      minPrice: a.minPrice, gridProfitPercent: a.gridProfitPercent, investmentAmount: a.investmentAmount,
      feeRate: a.feeRate, auto, orderSize: a.orderSize, gridCount: a.gridCount,
    });

    // Lecturas PÚBLICAS de HL (sin descifrar clave): resolver activo por red, precio, balance quote.
    const info = new InfoClient({ transport: new HttpTransport({ isTestnet: hlIsTestnet() }) });
    const resolved = await resolveSpotAsset(info, a.symbol, network);
    const currentPrice = await getSpotPrice(info, resolved);
    const bal = await getSpotBalance(info, pre.tradingAccountAddress, resolved.quoteAsset);

    // (JAV-103) En AUTO la SIEMBRA está SIEMPRE activa → `deriveSeededGrid` reparte el capital en M compras
    // abajo + K ventas sembradas arriba (gridCount persistido = M; las K SELLs las deriva el bootstrap con
    // los MISMOS parámetros → prometido==colocado). En MANUAL (avanzado) se mantiene el grid clásico
    // NO-seeded (compra-primero) con gridCount/orderSize explícitos.
    let gridCount: number, orderSize: number, capped = false, coveredFloor: number | null = null;
    let seeded = false, seedPercent: number | undefined;
    if (auto) {
      const d = deriveSeededGrid({
        currentPrice, minPrice: a.minPrice, gridProfitPercent: a.gridProfitPercent,
        investmentAmount: a.investmentAmount, szDecimals: resolved.szDecimals, feeRate: a.feeRate,
      });
      gridCount = d.M; orderSize = d.orderSize; capped = d.capped; coveredFloor = d.coveredFloor;
      seeded = true; seedPercent = d.seedPercent;
    } else {
      gridCount = a.gridCount as number; orderSize = a.orderSize as number;
    }

    // Persistir con TODOS los guards de DB (permisos, switches, gate mainnet, exclusividad, inputs,
    // balance) atómicos con el insert. persistSpotGridBot revalida validateGridInputs sobre los valores finales.
    const res = await ctx.runMutation(internal.spotGridBots.persistSpotGridBot, {
      hlAccountId: a.hlAccountId, symbol: a.symbol,
      assetId: resolved.assetId, baseAsset: resolved.baseAsset, quoteAsset: resolved.quoteAsset,
      minPrice: a.minPrice, gridProfitPercent: a.gridProfitPercent, investmentAmount: a.investmentAmount,
      orderSize, gridCount, feeRate: a.feeRate,
      currentPrice, freeQuoteBalance: bal.free, autoDerived: auto, network,
      seeded, seedPercent,
    });
    return { ...res, gridCount, orderSize, capped, coveredFloor, seeded, seedPercent };
  },
});
