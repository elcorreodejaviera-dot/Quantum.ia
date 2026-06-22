import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getUserOrNull, requireUser } from "./helpers";
import { hasNonTerminalArmForAccount } from "./triggerArms";

// Legacy de cuenta única eliminado (status/revoke/getForUserInternal/save): usaban `.first()`
// ambiguo en un modelo multi-cuenta. Reemplazado por list/revokeById/connectAccount.

// --- Multi-cuenta (Fase 1) ---

// Todas las cuentas HL del usuario (sin exponer la clave privada).
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUserOrNull(ctx);
    if (!user) return []; // (JAV-82) race de primer login: aún sin doc Convex
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
    // No revocar mientras existan ejecuciones abiertas (snapshot de la cuenta): dejaría una
    // posición sin posibilidad de colocar/reconciliar su SL (perderíamos la clave privada).
    const open = await ctx.db
      .query("execution_requests")
      .withIndex("by_account", (q) => q.eq("hlAccountId", id))
      .collect();
    // Solo closed (SL ejecutado) y failed (sin entrada) son seguros: el resto puede tener
    // posición abierta — incluido `protected` (SL resting, la posición sigue viva).
    const hasOpen = open.some((r) => !["closed", "failed"].includes(r.status));
    if (hasOpen) {
      throw new Error("La cuenta tiene ejecuciones abiertas; espera a que se cierren antes de revocar.");
    }
    // JAV-44 (R4): tampoco revocar si hay un trigger_arm NO terminal (incluido filled = posición
    // abierta): perderíamos la clave privada para cancelar/cerrar el trigger en HL.
    if (await hasNonTerminalArmForAccount(ctx, id)) {
      throw new Error("La cuenta tiene cobertura automática activa; pausa/cierra el trigger antes de revocar.");
    }
    // JAV-102 (ALTO money-path): tampoco revocar con un Spot Grid vivo (no-`stopped`) en la cuenta —
    // perderíamos la clave privada para cancelar/reconciliar sus órdenes resting (fondos atascados en HL).
    const liveGrid = (await ctx.db
      .query("spot_grid_bots")
      .withIndex("by_account", (q) => q.eq("hlAccountId", id))
      .collect())
      .find((g) => g.status !== "stopped");
    if (liveGrid) {
      throw new Error("La cuenta tiene un Spot Grid activo; deténlo antes de revocar.");
    }
    // (JAV-107) Tampoco revocar con un arm de defensa spot NO terminal: perderíamos la clave para
    // cancelar/cerrar el short y su SL en HL (posición/orden resting viva → fondos atascados).
    const liveDefenseArm = (await ctx.db
      .query("spot_defense_arms")
      .withIndex("by_account", (q) => q.eq("hlAccountId", id))
      .collect())
      .find((a) => !["disarmed", "closed", "failed"].includes(a.status));
    if (liveDefenseArm) {
      throw new Error("La cuenta tiene un bot de defensa spot activo; pausa/cierra el trigger antes de revocar.");
    }
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

// (JAV-63) Todas las credenciales (para el re-cifrado en la rotación de clave). Solo internal.
export const listAllInternal = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("hl_api_credentials").collect(),
});

// (JAV-63) Reemplaza el ciphertext + keyId de una credencial (re-cifrado con la clave activa).
export const updateCipherInternal = internalMutation({
  args: {
    id: v.id("hl_api_credentials"),
    encryptedPrivateKey: v.string(),
    iv: v.string(),
    authTag: v.string(),
    keyId: v.optional(v.string()),
  },
  handler: async (ctx, { id, encryptedPrivateKey, iv, authTag, keyId }) => {
    await ctx.db.patch(id, { encryptedPrivateKey, iv, authTag, keyId, updatedAt: Date.now() });
  },
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
    keyId: v.optional(v.string()),   // (JAV-63) versión de clave; ausente = legacy
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

// upsertInternal (legacy) eliminado: insertaba sin `tradingAccountAddress` (ahora obligatorio) y
// sin verificación userRole/unicidad global. Reemplazado por insertAccountInternal + connectAccount.
