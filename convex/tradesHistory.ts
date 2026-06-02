import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireUser } from "./helpers";

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

export const listSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 50 }) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("trades_history")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit);
  },
});
