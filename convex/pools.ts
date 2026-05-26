import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireAdmin } from "./helpers";

export const listPools = query({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    return await ctx.db.query("pools").collect();
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
