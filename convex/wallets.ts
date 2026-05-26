import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireAdmin } from "./helpers";

export const listWallets = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db.query("wallets").collect();
  },
});

export const addWallet = mutation({
  args: {
    label: v.string(),
    type: v.string(),
    address: v.string(),
    network: v.string(),
    ownerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db.insert("wallets", args);
  },
});

export const removeWallet = mutation({
  args: { id: v.id("wallets") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(id);
  },
});
