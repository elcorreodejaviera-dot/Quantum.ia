import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireUser } from "./helpers";

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
