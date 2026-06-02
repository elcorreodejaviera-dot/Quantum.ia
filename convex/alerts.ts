import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./helpers";

export const listAlerts = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return ctx.db
      .query("alerts")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
  },
});

export const createAlert = mutation({
  args: {
    alertType: v.union(v.literal("out_of_range"), v.literal("apy_below"), v.literal("price_cross")),
    pair: v.string(),
    network: v.optional(v.string()),
    threshold: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return ctx.db.insert("alerts", { ...args, userId: user._id, active: true });
  },
});

export const deleteAlert = mutation({
  args: { id: v.id("alerts") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const alert = await ctx.db.get(id);
    if (!alert || alert.userId !== user._id) throw new Error("Not found");
    await ctx.db.delete(id);
  },
});

export const recordAlertTrigger = mutation({
  args: {
    alertId: v.id("alerts"),
    message: v.string(),
  },
  handler: async (ctx, { alertId, message }) => {
    const user = await requireUser(ctx);
    const alert = await ctx.db.get(alertId);
    if (!alert || alert.userId !== user._id) throw new Error("Not found");
    await ctx.db.patch(alertId, { lastTriggeredAt: Date.now() });
    await ctx.db.insert("alert_history", {
      userId: user._id,
      alertType: alert.alertType,
      pair: alert.pair,
      message,
      timestamp: Date.now(),
    });
  },
});

export const listAlertHistory = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return ctx.db
      .query("alert_history")
      .withIndex("by_user_timestamp", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(20);
  },
});
