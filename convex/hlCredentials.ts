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
    if (existing) await ctx.db.delete(existing._id);
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

export const upsertInternal = internalMutation({
  args: {
    userId: v.id("users"),
    agentAddress: v.string(),
    encryptedPrivateKey: v.string(),
    iv: v.string(),
    authTag: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("hl_api_credentials")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        agentAddress: args.agentAddress,
        encryptedPrivateKey: args.encryptedPrivateKey,
        iv: args.iv,
        authTag: args.authTag,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("hl_api_credentials", {
      userId: args.userId,
      agentAddress: args.agentAddress,
      encryptedPrivateKey: args.encryptedPrivateKey,
      iv: args.iv,
      authTag: args.authTag,
      createdAt: now,
      updatedAt: now,
    });
  },
});
