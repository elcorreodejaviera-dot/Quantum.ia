import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listMyPositions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return await ctx.db
      .query("spot_positions")
      .withIndex("by_user_id", (q) => q.eq("userId", identity.subject))
      .collect();
  },
});

export const addPosition = mutation({
  args: {
    asset: v.string(),
    amount: v.number(),
    dca: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    if (args.amount <= 0) throw new Error("amount must be > 0");
    if (args.dca <= 0) throw new Error("dca must be > 0");

    return await ctx.db.insert("spot_positions", {
      ...args,
      userId: identity.subject,
    });
  },
});

export const updatePosition = mutation({
  args: {
    id: v.id("spot_positions"),
    amount: v.optional(v.number()),
    dca: v.optional(v.number()),
  },
  handler: async (ctx, { id, amount, dca }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const pos = await ctx.db.get(id);
    if (!pos) throw new Error("Position not found");
    if (pos.userId !== identity.subject) throw new Error("Forbidden");
    const patch: { amount?: number; dca?: number } = {};
    if (amount !== undefined && amount > 0) patch.amount = amount;
    if (dca !== undefined && dca > 0) patch.dca = dca;
    if (Object.keys(patch).length > 0) await ctx.db.patch(id, patch);
  },
});

export const removePosition = mutation({
  args: { id: v.id("spot_positions") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const pos = await ctx.db.get(id);
    if (!pos) throw new Error("Position not found");
    if (pos.userId !== identity.subject) throw new Error("Forbidden");

    await ctx.db.delete(id);
  },
});
