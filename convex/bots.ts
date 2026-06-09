import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUser, requireBotManager } from "./helpers";

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

// Un bot solo puede quedar activo si protege un pool vinculado y abierto.
// Cubre createBot(active+poolId), updateBot(poolId en bot activo) y toggleBot.
async function assertActivatable(
  ctx: MutationCtx,
  poolId: Id<"pools"> | undefined,
) {
  if (!poolId) throw new Error("No se puede activar un bot sin pool vinculado.");
  const pool = await ctx.db.get(poolId);
  if (!pool) throw new Error("El pool vinculado no existe.");
  if (pool.closed) throw new Error("No se puede activar: el pool protegido está cerrado.");
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
    const user = await requireBotManager(ctx);
    validateBotNumbers(args);
    if (args.poolId !== undefined) await validatePoolOwnership(ctx, user, args.poolId);
    // Un bot nuevo no puede nacer activo sin un pool abierto que proteger.
    if (args.active) await assertActivatable(ctx, args.poolId);
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
    // null = desvincular el pool; un Id = vincular; ausente = no tocar.
    poolId: v.optional(v.union(v.id("pools"), v.null())),
  },
  handler: async (ctx, { id, poolId, ...fields }) => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(id);
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id && user.role !== "admin") {
      throw new Error("Sin permiso para modificar este bot.");
    }
    validateBotNumbers(fields);

    // Resolver el poolId resultante. updateBot NO cambia `active` (eso es toggleBot).
    let resultingPoolId = bot.poolId;
    if (poolId === null) resultingPoolId = undefined;        // desvincular
    else if (poolId !== undefined) {
      await validatePoolOwnership(ctx, user, poolId);
      resultingPoolId = poolId;                              // vincular
    }
    // Un bot activo no puede quedar sin pool válido y abierto: pausar primero.
    if (bot.active && resultingPoolId !== bot.poolId) {
      await assertActivatable(ctx, resultingPoolId);
    }

    const patch: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    // En Convex, patch con `undefined` elimina el campo (desvincular).
    if (poolId !== undefined) patch.poolId = resultingPoolId;
    await ctx.db.patch(id, patch);
  },
});

export const toggleBot = mutation({
  args: { id: v.id("bots"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(id);
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id && user.role !== "admin") {
      throw new Error("Sin permiso para modificar este bot.");
    }
    // Solo se puede activar si protege un pool vinculado y abierto.
    if (active) await assertActivatable(ctx, bot.poolId);
    await ctx.db.patch(id, { active });
  },
});
