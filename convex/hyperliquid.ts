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
    asset: v.string(),
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
    const tradingConfig = await ctx.runQuery(internal.systemConfig.getConfigInternal, {
      key: "tradingEnabled",
    });

    if (!args.confirmLive) throw new Error("Live execution requires explicit confirmation");
    if (tradingConfig?.value !== true) throw new Error("Live trading is disabled");
    if (args.tradeAmount <= 0) throw new Error("tradeAmount must be > 0");
    if (args.price <= 0) throw new Error("price must be > 0");
    if (args.leverage < 1 || args.leverage > 25) throw new Error("leverage must be between 1 and 25");

    const asset = args.asset.toUpperCase();
    const assetId = ASSET_IDS[asset];
    if (assetId == null) throw new Error(`Unsupported HL asset: ${args.asset}`);

    const credential = await ctx.runQuery(internal.hlCredentials.getForUserInternal, {
      userId: user._id,
    });
    if (!credential) throw new Error("Hyperliquid API wallet is not connected");

    const wallet = privateKeyToAccount(decryptPrivateKey(credential));
    const transport = new HttpTransport();
    const exchange = new ExchangeClient({ transport, wallet });

    await exchange.updateLeverage({
      asset: assetId,
      isCross: false,
      leverage: Math.round(args.leverage),
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
      botName: `Bot protector ${asset}`,
      triggerType: args.triggerType ?? "manual",
      exchangeStatus: (response as any)?.status ?? "unknown",
      orderId,
      exchangeResponse: response,
    });

    return { ok: true, orderId, response };
  },
});
