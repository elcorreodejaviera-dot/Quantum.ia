import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("viewer")),
    walletAddress: v.optional(v.string()),
  }).index("by_clerk_id", ["clerkId"]),

  pools: defineTable({
    pair: v.string(),
    network: v.string(),
    minRange: v.number(),
    maxRange: v.number(),
    status: v.string(),
  }),

  bots: defineTable({
    name: v.string(),
    action: v.string(),
    active: v.boolean(),
    mode: v.string(),
    trigger: v.string(),
    walletId: v.optional(v.string()),
    capitalPerTrade: v.number(),
    leverage: v.number(),
    stop: v.number(),
    simulationMode: v.boolean(),
  }),

  wallets: defineTable({
    label: v.string(),
    type: v.string(),
    address: v.string(),
    network: v.string(),
    ownerId: v.optional(v.string()),
  }),

  spot_positions: defineTable({
    asset: v.string(),
    amount: v.number(),
    dca: v.number(),
    userId: v.string(),
  }),

  system_config: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),
});
