import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireAdmin, requireAuth, requireUser, requireTradeLive, hasPermission } from "./helpers";

export const getCurrentAdminInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireAdmin(ctx);
  },
});

export const getCurrentUserInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireUser(ctx);
  },
});

export const getOrCreateUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (existing) return existing._id;

    return await ctx.db.insert("users", {
      clerkId: identity.subject,
      name: identity.name ?? undefined,
      email: identity.email ?? undefined,
      role: "viewer",
    });
  },
});

export const getUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    return await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
  },
});

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export const setWalletAddress = mutation({
  args: { walletAddress: v.string() },
  handler: async (ctx, { walletAddress }) => {
    const normalized = walletAddress.trim().toLowerCase();
    if (!EVM_ADDRESS_RE.test(normalized)) {
      throw new Error("Dirección EVM inválida — debe ser 0x seguido de 40 caracteres hex");
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, { walletAddress: normalized });
  },
});

export const clearWalletAddress = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, { walletAddress: undefined });
  },
});

export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const filtered = Object.fromEntries(
      Object.entries(args).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(user._id, filtered);
  },
});

// Bootstrap: promueve un usuario a admin por su Clerk ID.
// Solo accesible via CLI: npx convex run users:promoteToAdmin '{"clerkId":"user_xxx"}'
export const promoteToAdmin = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
      .first();
    if (!user) throw new Error(`Usuario con clerkId ${clerkId} no encontrado`);
    await ctx.db.patch(user._id, { role: "admin" });
    return { promoted: user.email ?? user.clerkId };
  },
});

export const getUserPermissions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    if (!user) return [];

    const now = Date.now();
    const perms = await ctx.db
      .query("user_permissions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    return perms.filter(
      (p) => p.granted && (p.expiresAt === undefined || p.expiresAt > now)
    );
  },
});

// --- Trading real (canTradeLive) — Fase 3a.1 ---

// Fail-fast para actions: valida canTradeLive del usuario autenticado (auth propagada al runQuery).
export const assertTradeLiveInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireTradeLive(ctx);
  },
});

// JAV-44: ¿un usuario CONCRETO (por id) tiene canTradeLive vigente? Para el kill-switch del cron
// (reconcileArm), que corre sin identidad de usuario y debe detectar la revocación del permiso.
export const hasTradeLiveForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return false;
    return await hasPermission(ctx, user, "canTradeLive");
  },
});

// Concede canTradeLive consolidando en UNA fila canónica granted:true (resto a false).
export const grantTradeLive = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const admin = await requireAdmin(ctx);
    const rows = await ctx.db
      .query("user_permissions")
      .withIndex("by_user_permission", (q) =>
        q.eq("userId", userId).eq("permission", "canTradeLive"))
      .collect();
    const now = Date.now();
    if (rows.length === 0) {
      await ctx.db.insert("user_permissions", {
        userId, permission: "canTradeLive", granted: true, grantedAt: now, grantedBy: admin._id,
      });
    } else {
      await ctx.db.patch(rows[0]._id, { granted: true, grantedAt: now, grantedBy: admin._id, expiresAt: undefined });
      for (const r of rows.slice(1)) if (r.granted) await ctx.db.patch(r._id, { granted: false });
    }
  },
});

// Revoca canTradeLive en TODAS las filas del usuario (el esquema permite duplicados).
export const revokeTradeLive = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("user_permissions")
      .withIndex("by_user_permission", (q) =>
        q.eq("userId", userId).eq("permission", "canTradeLive"))
      .collect();
    for (const r of rows) if (r.granted) await ctx.db.patch(r._id, { granted: false });
  },
});

// Lista usuarios + estado canTradeLive para el panel admin (paginado).
export const listUsersWithTradeLive = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db.query("users").paginate(paginationOpts);
    const now = Date.now();
    const page = [];
    for (const u of result.page) {
      const rows = await ctx.db
        .query("user_permissions")
        .withIndex("by_user_permission", (q) =>
          q.eq("userId", u._id).eq("permission", "canTradeLive"))
        .collect();
      const canTradeLive = u.role === "admin"
        || rows.some((r) => r.granted && (r.expiresAt === undefined || r.expiresAt > now));
      page.push({ userId: u._id, email: u.email ?? null, name: u.name ?? null, role: u.role, canTradeLive });
    }
    return { ...result, page };
  },
});
