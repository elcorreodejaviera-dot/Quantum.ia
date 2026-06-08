import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUser } from "./helpers";

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

// El pool vinculado debe existir y pertenecer al mismo usuario (o ser admin).
async function validatePoolOwnership(
  ctx: MutationCtx,
  user: { _id: Id<"users">; role: string },
  poolId: Id<"pools">,
) {
  const pool = await ctx.db.get(poolId);
  if (!pool) throw new Error("El pool vinculado no existe.");
  if (pool.userId !== user._id && user.role !== "admin") {
    throw new Error("El pool vinculado no te pertenece.");
  }
}

export const listBots = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    // Multi-tenancy: cada usuario ve solo sus propios bots.
    return await ctx.db.query("bots").withIndex("by_user", q => q.eq("userId", user._id)).collect();
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
    poolId: v.optional(v.id("pools")),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    validateBotNumbers(args);
    if (args.poolId !== undefined) await validatePoolOwnership(ctx, user, args.poolId);
    return await ctx.db.insert("bots", { ...args, userId: user._id });
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
    poolId: v.optional(v.id("pools")),
  },
  handler: async (ctx, { id, ...fields }) => {
    const user = await requireUser(ctx);
    const bot = await ctx.db.get(id);
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id && user.role !== "admin") {
      throw new Error("Sin permiso para modificar este bot.");
    }
    validateBotNumbers(fields);
    if (fields.poolId !== undefined) await validatePoolOwnership(ctx, user, fields.poolId);
    const filtered = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(id, filtered);
  },
});

export const toggleBot = mutation({
  args: { id: v.id("bots"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    const user = await requireUser(ctx);
    const bot = await ctx.db.get(id);
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id && user.role !== "admin") {
      throw new Error("Sin permiso para modificar este bot.");
    }
    await ctx.db.patch(id, { active });
  },
});
