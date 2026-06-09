import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireAdmin } from "./helpers";
import { LIMIT_DEFAULTS, getLimit } from "./executionLimits";

// Límites efectivos (config o default) para el panel admin — no campos vacíos que diverjan.
export const getExecutionLimits = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return {
      maxNotionalPerOrder: await getLimit(ctx, "maxNotionalPerOrder"),
      maxNotionalPerUserDaily: await getLimit(ctx, "maxNotionalPerUserDaily"),
      slBufferPct: await getLimit(ctx, "slBufferPct"),
    };
  },
});

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

// --- Límites de ejecución HL (JAV-37) ---

async function upsertConfig(ctx: any, key: string, value: number) {
  const existing = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();
  if (existing) await ctx.db.patch(existing._id, { value });
  else await ctx.db.insert("system_config", { key, value });
}

// Ops: setear límites desde el CLI/backend (NO accesible desde el cliente — internalMutation).
// Replica las mismas validaciones que las mutations públicas. Uso operativo de admin con acceso
// al deployment; el gate de admin de la UI no se evade desde el frontend.
export const setExecutionLimitInternal = internalMutation({
  args: {
    key: v.union(
      v.literal("maxNotionalPerOrder"),
      v.literal("maxNotionalPerUserDaily"),
      v.literal("slBufferPct"),
    ),
    value: v.number(),
  },
  handler: async (ctx, { key, value }) => {
    if (!Number.isFinite(value)) throw new Error("value debe ser finito");
    if (key === "slBufferPct") {
      if (value < 0 || value > 10) throw new Error("slBufferPct debe estar entre 0 y 10");
    } else {
      if (value <= 0) throw new Error(`${key} debe ser > 0`);
      const perOrder = key === "maxNotionalPerOrder"
        ? value : await readNum(ctx, "maxNotionalPerOrder", LIMIT_DEFAULTS.maxNotionalPerOrder);
      const daily = key === "maxNotionalPerUserDaily"
        ? value : await readNum(ctx, "maxNotionalPerUserDaily", LIMIT_DEFAULTS.maxNotionalPerUserDaily);
      if (perOrder > daily) throw new Error("maxNotionalPerOrder no puede superar maxNotionalPerUserDaily");
    }
    await upsertConfig(ctx, key, value);
    return { key, value };
  },
});

async function readNum(ctx: any, key: string, def: number): Promise<number> {
  const row = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();
  return typeof row?.value === "number" ? row.value : def;
}

export const setMaxNotionalPerOrder = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await requireAdmin(ctx);
    if (!Number.isFinite(value) || value <= 0) throw new Error("maxNotionalPerOrder debe ser > 0");
    const daily = await readNum(ctx, "maxNotionalPerUserDaily", LIMIT_DEFAULTS.maxNotionalPerUserDaily);
    if (value > daily) throw new Error("maxNotionalPerOrder no puede superar maxNotionalPerUserDaily");
    await upsertConfig(ctx, "maxNotionalPerOrder", value);
  },
});

export const setMaxNotionalPerUserDaily = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await requireAdmin(ctx);
    if (!Number.isFinite(value) || value <= 0) throw new Error("maxNotionalPerUserDaily debe ser > 0");
    const perOrder = await readNum(ctx, "maxNotionalPerOrder", LIMIT_DEFAULTS.maxNotionalPerOrder);
    if (value < perOrder) throw new Error("maxNotionalPerUserDaily no puede ser menor que maxNotionalPerOrder");
    await upsertConfig(ctx, "maxNotionalPerUserDaily", value);
  },
});

export const setSlBufferPct = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await requireAdmin(ctx);
    if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error("slBufferPct debe estar entre 0 y 10");
    await upsertConfig(ctx, "slBufferPct", value);
  },
});
