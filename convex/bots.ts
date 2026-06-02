import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireAdmin } from "./helpers";

function validateBotNumbers(fields: {
  capitalPerTrade?: number;
  leverage?: number;
  stop?: number;
}) {
  if (fields.capitalPerTrade !== undefined && fields.capitalPerTrade <= 0) {
    throw new Error("capitalPerTrade must be > 0");
  }
  if (fields.leverage !== undefined && fields.leverage <= 0) {
    throw new Error("leverage must be > 0");
  }
  if (fields.stop !== undefined && fields.stop <= 0) {
    throw new Error("stop must be > 0");
  }
}

export const listBots = query({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    return await ctx.db.query("bots").collect();
  },
});

export const createBot = mutation({
  args: {
    name: v.string(),
    action: v.string(),
    active: v.boolean(),
    mode: v.string(),
    trigger: v.string(),
    walletId: v.optional(v.string()),
    capitalPerTrade: v.number(),
    leverage: v.number(),
    stop: v.number(),
    simulationMode: v.boolean(),
    orderType: v.optional(v.string()),
    entryTrigger: v.optional(v.string()),
    triggerPrice: v.optional(v.number()),
    autoLeverage: v.optional(v.boolean()),
    collateral: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    validateBotNumbers(args);
    return await ctx.db.insert("bots", args);
  },
});

export const updateBot = mutation({
  args: {
    id: v.id("bots"),
    name: v.optional(v.string()),
    action: v.optional(v.string()),
    mode: v.optional(v.string()),
    trigger: v.optional(v.string()),
    walletId: v.optional(v.string()),
    capitalPerTrade: v.optional(v.number()),
    leverage: v.optional(v.number()),
    stop: v.optional(v.number()),
    simulationMode: v.optional(v.boolean()),
    orderType: v.optional(v.string()),
    entryTrigger: v.optional(v.string()),
    triggerPrice: v.optional(v.number()),
    autoLeverage: v.optional(v.boolean()),
    collateral: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    await requireAdmin(ctx);
    validateBotNumbers(fields);
    const filtered = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(id, filtered);
  },
});

export const toggleBot = mutation({
  args: { id: v.id("bots"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    await requireAdmin(ctx);
    const bot = await ctx.db.get(id);
    if (!bot) throw new Error("Bot not found");
    await ctx.db.patch(id, { active });
  },
});
