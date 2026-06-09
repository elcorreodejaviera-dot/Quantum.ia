import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./helpers";

export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const credential = await ctx.db
      .query("hl_api_credentials")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
    if (!credential) return { connected: false };
    return {
      connected: true,
      id: credential._id,                 // la UI lo usa para vincular bots a la cuenta
      agentAddress: credential.agentAddress,
      updatedAt: credential.updatedAt,
    };
  },
});

export const revoke = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db
      .query("hl_api_credentials")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
    if (!existing) return;
    // Evitar hlAccountId colgante: pausar y desvincular los bots que usaban esta cuenta.
    const linked = await ctx.db
      .query("bots")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .filter((q) => q.eq(q.field("hlAccountId"), existing._id))
      .collect();
    for (const bot of linked) {
      await ctx.db.patch(bot._id, { active: false, hlAccountId: undefined });
    }
    await ctx.db.delete(existing._id);
  },
});

// --- Multi-cuenta (Fase 1) ---

// Todas las cuentas HL del usuario (sin exponer la clave privada).
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const creds = await ctx.db
      .query("hl_api_credentials")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return creds.map((c) => ({
      id: c._id,
      label: c.label ?? null,
      agentAddress: c.agentAddress,
      tradingAccountAddress: c.tradingAccountAddress,
      updatedAt: c.updatedAt,
    }));
  },
});

// Revoca una cuenta concreta y pausa/desvincula los bots que la usaban.
export const revokeById = mutation({
  args: { id: v.id("hl_api_credentials") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const cred = await ctx.db.get(id);
    if (!cred) return;
    if (cred.userId !== user._id) throw new Error("Sin permiso para revocar esta cuenta.");
    const linked = await ctx.db
      .query("bots")
      .withIndex("by_user_account", (q) => q.eq("userId", user._id).eq("hlAccountId", id))
      .collect();
    for (const bot of linked) {
      await ctx.db.patch(bot._id, { active: false, hlAccountId: undefined });
    }
    await ctx.db.delete(id);
  },
});

export const getAccountByIdInternal = internalQuery({
  args: { id: v.id("hl_api_credentials") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

// Inserta una cuenta nueva con unicidad GLOBAL (agente y cuenta operativa).
export const insertAccountInternal = internalMutation({
  args: {
    userId: v.id("users"),
    label: v.optional(v.string()),
    agentAddress: v.string(),
    tradingAccountAddress: v.string(),
    encryptedPrivateKey: v.string(),
    iv: v.string(),
    authTag: v.string(),
  },
  handler: async (ctx, args) => {
    const dupAgent = await ctx.db
      .query("hl_api_credentials")
      .withIndex("by_agent", (q) => q.eq("agentAddress", args.agentAddress))
      .first();
    if (dupAgent) throw new Error("Esta API wallet ya está registrada en el portal.");
    const dupAcct = await ctx.db
      .query("hl_api_credentials")
      .withIndex("by_trading_account", (q) => q.eq("tradingAccountAddress", args.tradingAccountAddress))
      .first();
    if (dupAcct) throw new Error("Esta cuenta de Hyperliquid ya está registrada en el portal.");
    const now = Date.now();
    return await ctx.db.insert("hl_api_credentials", { ...args, createdAt: now, updatedAt: now });
  },
});

export const getForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("hl_api_credentials")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
  },
});

// upsertInternal (legacy) eliminado: insertaba sin `tradingAccountAddress` (ahora obligatorio) y
// sin verificación userRole/unicidad global. Reemplazado por insertAccountInternal + connectAccount.
