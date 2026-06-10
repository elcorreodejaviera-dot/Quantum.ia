import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireUser } from "./helpers";
import { hasNonTerminalArmForBot, requestDisarmAndDeactivateImpl } from "./triggerArms";

export const listPools = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", q => q.eq("clerkId", identity.subject))
      .first();
    if (!user) return [];
    return await ctx.db.query("pools").withIndex("by_user", q => q.eq("userId", user._id)).collect();
  },
});

export const listPoolsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("pools").collect();
  },
});

export const getPoolByIdInternal = internalQuery({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

export const patchPoolApy = internalMutation({
  args: {
    id: v.id("pools"),
    apy: v.number(),
    tvl: v.optional(v.number()),
    fees1d: v.optional(v.number()),
    volume1d: v.optional(v.number()),
    volume7d: v.optional(v.number()),
    feeTier: v.optional(v.number()),
    defillamaId: v.optional(v.string()),
    poolAddress: v.optional(v.string()),
  },
  handler: async (ctx, { id, apy, tvl, fees1d, volume1d, volume7d, feeTier, defillamaId, poolAddress }) => {
    const patch: Record<string, unknown> = { apy, apyUpdatedAt: Date.now() };
    if (tvl !== undefined) patch.tvl = tvl;
    if (fees1d !== undefined) patch.fees1d = fees1d;
    if (volume1d !== undefined) patch.volume1d = volume1d;
    if (volume7d !== undefined) patch.volume7d = volume7d;
    if (feeTier !== undefined) patch.feeTier = feeTier;
    if (defillamaId !== undefined) patch.defillamaId = defillamaId;
    if (poolAddress !== undefined) patch.poolAddress = poolAddress;
    await ctx.db.patch(id, patch);
  },
});

export const patchPoolAddress = internalMutation({
  args: { id: v.id("pools"), poolAddress: v.string() },
  handler: async (ctx, { id, poolAddress }) => {
    await ctx.db.patch(id, { poolAddress });
  },
});

export const patchPoolSubgraph = internalMutation({
  args: {
    id: v.id("pools"),
    volumeUsd1d: v.optional(v.number()),
    feesUsd1d: v.optional(v.number()),
    tvlUsd: v.optional(v.number()),
  },
  handler: async (ctx, { id, volumeUsd1d, feesUsd1d, tvlUsd }) => {
    const patch: Record<string, unknown> = { subgraphUpdatedAt: Date.now() };
    if (volumeUsd1d !== undefined) patch.subgraphVolumeUsd1d = volumeUsd1d;
    if (feesUsd1d !== undefined) patch.subgraphFeesUsd1d = feesUsd1d;
    if (tvlUsd !== undefined) patch.subgraphTvlUsd = tvlUsd;
    await ctx.db.patch(id, patch);
  },
});

export const createPool = mutation({
  args: {
    pair: v.string(),
    network: v.string(),
    minRange: v.number(),
    maxRange: v.number(),
    status: v.string(),
    feeTier: v.optional(v.number()),
    poolAddress: v.optional(v.string()),
    tokenId: v.optional(v.number()),
    initialLiquidityUsd: v.optional(v.number()),
    initialLiquidityAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.minRange < 0 || args.maxRange < 0) throw new Error("Los rangos deben ser no negativos.");
    if (args.minRange > args.maxRange) throw new Error("minRange no puede ser mayor que maxRange.");
    if (args.tokenId != null) {
      const existing = await ctx.db.query("pools")
        .withIndex("by_user", q => q.eq("userId", user._id))
        .filter(q => q.eq(q.field("tokenId"), args.tokenId))
        .first();
      if (existing) throw new Error("Este Token ID ya está siendo monitoreado. Si cerraste la posición, elimina primero el pool anterior para volver a registrarlo.");
    }
    return await ctx.db.insert("pools", {
      userId: user._id as any,
      pair: args.pair,
      network: args.network,
      minRange: args.minRange,
      maxRange: args.maxRange,
      status: args.status,
      feeTier: args.feeTier,
      poolAddress: args.poolAddress,
      tokenId: args.tokenId,
      initialLiquidityUsd: args.initialLiquidityUsd,
      initialLiquidityAt: args.initialLiquidityAt,
    });
  },
});

export const patchPoolInitialLiquidity = internalMutation({
  args: { id: v.id("pools"), initialLiquidityUsd: v.number(), initialLiquidityAt: v.number() },
  handler: async (ctx, { id, initialLiquidityUsd, initialLiquidityAt }) => {
    const pool = await ctx.db.get(id);
    if (!pool || pool.initialLiquidityUsd != null) return; // nunca sobreescribir el histórico
    await ctx.db.patch(id, { initialLiquidityUsd, initialLiquidityAt });
  },
});

export const deletePool = mutation({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const pool = await ctx.db.get(id);
    if (!pool) throw new Error("Pool no encontrado.");
    if (pool.userId !== user._id && user.role !== "admin") throw new Error("Sin permiso para eliminar este pool.");
    // Desvincular y pausar atómicamente los bots que protegían este pool, para
    // no dejar poolId colgante (Convex no aplica claves foráneas).
    const linkedBots = await ctx.db.query("bots").withIndex("by_pool", q => q.eq("poolId", id)).collect();
    // JAV-44 (R4): no borrar el pool si algún bot tiene un trigger_arm NO terminal — se perdería el
    // snapshot necesario para cancelar/cerrar el trigger vivo en HL.
    for (const bot of linkedBots) {
      if (await hasNonTerminalArmForBot(ctx, bot._id)) {
        throw new Error("El pool tiene un bot con cobertura automática activa; pausa/cierra el trigger antes de eliminar.");
      }
    }
    for (const bot of linkedBots) {
      await ctx.db.patch(bot._id, { active: false, poolId: undefined });
    }
    await ctx.db.delete(id);
  },
});

// Detección de cierre — mutaciones internas usadas por el cron checkAllPoolClosures.

// Marca el pool como cerrado y pausa atómicamente los bots vinculados.
// Idempotente: preserva el primer closedAt; closureCheckedAt siempre se refresca.
export const markPoolClosedAndPauseBots = internalMutation({
  args: { id: v.id("pools"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const pool = await ctx.db.get(id);
    if (!pool) return;
    const now = Date.now();
    await ctx.db.patch(id, {
      closed: true,
      closureReason: reason,
      closureCheckedAt: now,
      ...(pool.closedAt == null ? { closedAt: now } : {}),
    });
    const linkedBots = await ctx.db.query("bots").withIndex("by_pool", q => q.eq("poolId", id)).collect();
    for (const bot of linkedBots) {
      // (Fix #3) Pausa SEGURA (H1/N2): si el bot tiene un trigger vivo, no desactivar de golpe —
      // disarmPending + el cron lo cancela en HL y luego completa active=false (la reconciliación
      // ve pool.closed → killed → cancela). Nunca dejar un trigger huérfano por el cierre de pool.
      if (bot.active) await requestDisarmAndDeactivateImpl(ctx, bot._id);
    }
  },
});

// La posición volvió a estar activa: limpia el estado de cierre si lo tenía.
export const reopenPoolIfClosed = internalMutation({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => {
    const pool = await ctx.db.get(id);
    if (!pool) return;
    const now = Date.now();
    if (pool.closed) {
      // No reactivamos bots automáticamente — el usuario decide reanudar la protección.
      await ctx.db.patch(id, {
        closed: false,
        closureReason: undefined,
        closedAt: undefined,
        closureCheckedAt: now,
      });
    } else {
      await ctx.db.patch(id, { closureCheckedAt: now });
    }
  },
});

// RPC no disponible: solo registra que se intentó el chequeo, sin concluir cierre.
export const touchPoolChecked = internalMutation({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => {
    const pool = await ctx.db.get(id);
    if (!pool) return;
    await ctx.db.patch(id, { closureCheckedAt: Date.now() });
  },
});

export const updatePool = mutation({
  args: {
    id: v.id("pools"),
    minRange: v.optional(v.number()),
    maxRange: v.optional(v.number()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    await requireAdmin(ctx);
    const current = await ctx.db.get(id);
    if (!current) throw new Error("Pool not found");

    const nextMin = fields.minRange ?? current.minRange;
    const nextMax = fields.maxRange ?? current.maxRange;
    if (nextMin < 0 || nextMax < 0) throw new Error("Ranges must be non-negative");
    if (nextMin > nextMax) throw new Error("minRange cannot be greater than maxRange");

    const filtered = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(id, filtered);
  },
});
