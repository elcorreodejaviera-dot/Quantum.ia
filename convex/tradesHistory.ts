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
    return await ctx.db.insert("trades_history", {
      userId: user._id,
      action: args.action,
      asset: args.asset,
      amount: args.amount,
      price: args.price,
      simulated: true,
      network: args.network,
      timestamp: Date.now(),
      botId: args.botId,
      botName: args.botName,
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
