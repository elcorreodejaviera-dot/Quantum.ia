"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { decryptPrivateKey } from "./hlCredentialActions";

const ASSET_IDS: Record<string, number> = {
  BTC: 0,
  ETH: 1,
};
const IOC_SLIPPAGE = 0.01;

function orderIdFromResponse(response: unknown): string | undefined {
  const statuses = (response as any)?.response?.data?.statuses;
  const first = Array.isArray(statuses) ? statuses[0] : undefined;
  const oid = first?.resting?.oid ?? first?.filled?.oid;
  return oid == null ? undefined : String(oid);
}

export const executePerpMarketOrder = action({
  args: {
    // Bot que ejecuta. La cuenta firmante y el asset se derivan del bot (vínculo bot↔cuenta),
    // no del cliente: evita firmar con una cuenta arbitraria o ajena.
    botId: v.id("bots"),
    side: v.union(v.literal("Long"), v.literal("Short")),
    tradeAmount: v.number(),
    price: v.number(),
    leverage: v.number(),
    stopLoss: v.optional(v.number()),
    triggerType: v.optional(v.string()),
    confirmLive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.users.getCurrentUserInternal, {});
    const [tradingConfig, simConfig] = await Promise.all([
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
    ]);

    if (user.role !== 'admin') throw new Error("Admin role required for live execution");
    if (!args.confirmLive) throw new Error("Live execution requires explicit confirmation");
    if (tradingConfig?.value !== true) throw new Error("Live trading is disabled");
    if (simConfig?.value !== false) throw new Error("Simulation mode is active — live execution blocked");
    // Number.isFinite: Convex v.number() admite NaN/Infinity y `NaN <= 0` es false → evadiría.
    if (!Number.isFinite(args.tradeAmount) || args.tradeAmount <= 0) throw new Error("tradeAmount must be a finite number > 0");
    if (!Number.isFinite(args.price) || args.price <= 0) throw new Error("price must be a finite number > 0");

    // Cargar el bot y validar el vínculo bot↔cuenta. asset y cuenta firmante se derivan del bot.
    const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: args.botId });
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id) throw new Error("Bot does not belong to this user");
    if (!bot.hlAccountId) throw new Error("Bot has no Hyperliquid account linked");
    if (!bot.baseAsset) throw new Error("Bot has no base asset");

    // Estado operativo del bot: solo ejecuta un bot activo, real y con pool abierto.
    if (!bot.active) throw new Error("Bot is not active");
    if (bot.simulationMode) throw new Error("Bot is in simulation mode — live execution blocked");
    if (!bot.poolId) throw new Error("Bot has no pool linked");
    const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: bot.poolId });
    if (!pool) throw new Error("Linked pool not found");
    if (pool.closed) throw new Error("Linked pool is closed");

    // El lado de la orden debe ser compatible con la dirección del bot (IL siempre short).
    if (!bot.direction) throw new Error("Bot has no direction");
    const dirOk = bot.direction === "long_short"
      || (bot.direction === "long" && args.side === "Long")
      || (bot.direction === "short" && args.side === "Short");
    if (!dirOk) throw new Error(`side ${args.side} incompatible con la dirección del bot (${bot.direction})`);

    // Apalancamiento: fuente única en el bot (salvo autoLeverage). No se confía en el cliente.
    const effectiveLeverage = (!bot.autoLeverage && bot.leverage !== undefined) ? bot.leverage : args.leverage;
    if (!Number.isFinite(effectiveLeverage) || effectiveLeverage < 1 || effectiveLeverage > 25) {
      throw new Error("leverage must be a finite number between 1 and 25");
    }

    const asset = bot.baseAsset.toUpperCase();
    const assetId = ASSET_IDS[asset];
    if (assetId == null) throw new Error(`Unsupported HL asset: ${bot.baseAsset}`);

    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, {
      id: bot.hlAccountId,
    });
    if (!credential) throw new Error("Hyperliquid account not found");
    if (credential.userId !== user._id) throw new Error("Account does not belong to this user");

    const wallet = privateKeyToAccount(decryptPrivateKey(credential));
    const transport = new HttpTransport();
    const exchange = new ExchangeClient({ transport, wallet });

    await exchange.updateLeverage({
      asset: assetId,
      isCross: false,
      leverage: Math.round(effectiveLeverage),
    });

    const size = args.tradeAmount / args.price;
    const roundedSize = size.toFixed(asset === "BTC" ? 5 : 4);
    if (Number(roundedSize) <= 0) throw new Error("Order size is too small");

    const limitPrice = args.side === "Long"
      ? args.price * (1 + IOC_SLIPPAGE)
      : args.price * (1 - IOC_SLIPPAGE);

    const response = await exchange.order({
      orders: [{
        a: assetId,
        b: args.side === "Long",
        p: limitPrice.toFixed(asset === "BTC" ? 0 : 2),
        s: roundedSize,
        r: false,
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    });

    const orderId = orderIdFromResponse(response);
    await ctx.runMutation(internal.tradesHistory.recordExecution, {
      userId: user._id,
      action: `HL ${args.side} ${asset}`,
      asset,
      amount: args.tradeAmount,
      price: args.price,
      network: "Hyperliquid",
      botName: bot.name,
      triggerType: args.triggerType ?? "manual",
      exchangeStatus: (response as any)?.status ?? "unknown",
      orderId,
      exchangeResponse: response,
    });

    return { ok: true, orderId, response };
  },
});
