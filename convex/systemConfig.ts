import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireAdmin } from "./helpers";

export const logAdminAction = mutation({
  args: { action: v.string(), meta: v.optional(v.any()) },
  handler: async (ctx, { action, meta }) => {
    const identity = await requireAdmin(ctx);
    await ctx.db.insert("admin_logs", {
      userId: identity.subject,
      action,
      timestamp: Date.now(),
      meta,
    });
  },
});

export const getConfig = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
  },
});

export const getConfigInternal = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    return await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
  },
});

export const setSimulationMode = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "simulationMode"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { value: enabled });
    } else {
      await ctx.db.insert("system_config", { key: "simulationMode", value: enabled });
    }
  },
});

export const setTradingEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    await requireAdmin(ctx);
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
