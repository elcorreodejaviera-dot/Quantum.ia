import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireUser } from "./helpers";

export const recordSignal = mutation({
  args: {
    action: v.string(),
    asset: v.string(),
    amount: v.number(),
    price: v.number(),
    network: v.string(),
    botId: v.optional(v.id("bots")),
    botName: v.optional(v.string()),
    triggerType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    // Si la señal proviene de un bot, asset/botName se DERIVAN del bot (no del cliente):
    // evita atribuir una señal a un bot ajeno o falsear el asset/nombre.
    let asset = args.asset;
    let botName = args.botName;
    if (args.botId) {
      const bot = await ctx.db.get(args.botId);
      if (!bot) throw new Error("Bot not found");
      if (bot.userId !== user._id) throw new Error("Bot does not belong to this user");
      // Derivación estricta: no caer al asset del cliente.
      if (!bot.baseAsset) throw new Error("Bot has no base asset");
      asset = bot.baseAsset;
      botName = bot.name;
    }
    return await ctx.db.insert("trades_history", {
      userId: user._id,
      action: args.action,
      asset,
      amount: args.amount,
      price: args.price,
      simulated: true,
      network: args.network,
      timestamp: Date.now(),
      botId: args.botId,
      botName,
      triggerType: args.triggerType ?? "auto",
    });
  },
});

export const recordExecution = internalMutation({
  args: {
    userId: v.id("users"),
    action: v.string(),
    asset: v.string(),
    amount: v.number(),
    price: v.number(),
    network: v.string(),
    botName: v.optional(v.string()),
    triggerType: v.optional(v.string()),
    exchangeStatus: v.string(),
    orderId: v.optional(v.string()),
    exchangeResponse: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("trades_history", {
      userId: args.userId,
      action: args.action,
      asset: args.asset,
      amount: args.amount,
      price: args.price,
      simulated: false,
      network: args.network,
      timestamp: Date.now(),
      botName: args.botName,
      triggerType: args.triggerType ?? "manual",
      exchangeStatus: args.exchangeStatus,
      orderId: args.orderId,
      exchangeResponse: args.exchangeResponse,
    });
  },
});

export const recordTestnetExecution = mutation({
  args: {
    action: v.string(),
    asset: v.string(),
    amount: v.number(),
    price: v.number(),
    botName: v.optional(v.string()),
    triggerType: v.optional(v.string()),
    exchangeStatus: v.string(),
    orderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    return await ctx.db.insert("trades_history", {
      userId: user._id,
      action: args.action,
      asset: args.asset,
      amount: args.amount,
      price: args.price,
      simulated: false,
      network: "testnet",
      timestamp: Date.now(),
      botName: args.botName,
      triggerType: args.triggerType ?? "manual",
      exchangeStatus: args.exchangeStatus,
      orderId: args.orderId,
      source: "client_reported_testnet",
    });
  },
});

export const listSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 50 }) => {
    const user = await requireUser(ctx);
    const clamped = Math.min(Math.max(limit, 1), 100);
    return await ctx.db
      .query("trades_history")
      .withIndex("by_user_timestamp", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(clamped);
  },
});

export const listAllSignals = query({
  args: {
    asset: v.optional(v.string()),
    network: v.optional(v.string()),
    simulated: v.optional(v.boolean()),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const clamped = Math.min(Math.max(args.limit ?? 500, 1), 500);
    // Fetch a large buffer, apply filters in memory, then limit — avoids
    // dropping valid matches that fall outside a pre-truncated window.
    const buffer = await ctx.db
      .query("trades_history")
      .withIndex("by_timestamp")
      .order("desc")
      .take(2000);

    let rows = buffer;
    if (args.asset) rows = rows.filter(r => r.asset === args.asset);
    if (args.network) rows = rows.filter(r => r.network === args.network);
    if (args.simulated !== undefined) rows = rows.filter(r => r.simulated === args.simulated);
    if (args.fromDate) rows = rows.filter(r => r.timestamp >= args.fromDate!);
    if (args.toDate) rows = rows.filter(r => r.timestamp <= args.toDate!);

    return rows.slice(0, clamped);
  },
});
