import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getConfig = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
  },
});

export const setTradingEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "tradingEnabled"))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { value: enabled });
    } else {
      await ctx.db.insert("system_config", { key: "tradingEnabled", value: enabled });
    }
  },
});
