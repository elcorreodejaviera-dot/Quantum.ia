import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireAdmin, writeAdminLog } from "./helpers";

// (JAV-77) Los límites beta de nocional por orden/diario ($500/$2.000) se eliminaron: el tope de
// cobertura por PLAN (coverageUsage.ts) es ahora el único control de tamaño. El kill-switch global
// `tradingEnabled` y el gate de margen por colateral siguen intactos.

export const logAdminAction = mutation({
  args: { action: v.string(), meta: v.optional(v.any()) },
  handler: async (ctx, { action, meta }) => {
    const admin = await requireAdmin(ctx);
    await ctx.db.insert("admin_logs", {
      // requireAdmin devuelve el user doc (no un Clerk identity): `subject` no existe → userId quedaba
      // undefined. El identificador correcto del admin es su clerkId (string). (Bug cazado por el type-check.)
      userId: admin.clerkId,
      action,
      timestamp: Date.now(),
      meta,
    });
  },
});

// (JAV-38 #11) Solo claves PÚBLICAS explícitas: el frontend únicamente necesita el estado de los
// switches de trading. Cualquier otra clave se rechaza (no exponer config interna por key arbitraria).
const PUBLIC_CONFIG_KEYS = new Set(["simulationMode", "tradingEnabled"]);
export const getConfig = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    await requireAuth(ctx);
    if (!PUBLIC_CONFIG_KEYS.has(key)) throw new Error("Clave de configuración no pública.");
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
    const admin = await requireAdmin(ctx);
    const existing = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "simulationMode"))
      .first();
    const prev = existing?.value ?? null;
    if (existing) {
      await ctx.db.patch(existing._id, { value: enabled });
    } else {
      await ctx.db.insert("system_config", { key: "simulationMode", value: enabled });
    }
    await writeAdminLog(ctx, admin.clerkId, "set_simulation_mode", { enabled, prev });
  },
});

export const setTradingEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const admin = await requireAdmin(ctx);
    const existing = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "tradingEnabled"))
      .first();
    const prev = existing?.value ?? null;
    if (existing) {
      await ctx.db.patch(existing._id, { value: enabled });
    } else {
      await ctx.db.insert("system_config", { key: "tradingEnabled", value: enabled });
    }
    await writeAdminLog(ctx, admin.clerkId, "set_trading_enabled", { enabled, prev });
  },
});

