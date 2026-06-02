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

  // Permisos dinámicos por usuario — cada fila es un permiso individual.
  // Permite añadir, revocar o expirar permisos sin tocar el registro de usuario.
  // Keys válidas: canViewPools, canViewBots, canViewWallets, canViewPositions,
  //               canManageBots, subscriptionBasic, subscriptionPro
  user_permissions: defineTable({
    userId: v.id("users"),
    permission: v.string(),
    granted: v.boolean(),
    grantedAt: v.number(),
    expiresAt: v.optional(v.number()),
    grantedBy: v.optional(v.id("users")),
  })
    .index("by_user", ["userId"])
    .index("by_user_permission", ["userId", "permission"]),

  pools: defineTable({
    pair: v.string(),
    network: v.string(),
    minRange: v.number(),
    maxRange: v.number(),
    status: v.string(),
    apy: v.optional(v.number()),
    tvl: v.optional(v.number()),
    fees1d: v.optional(v.number()),
    defillamaId: v.optional(v.string()),
    apyUpdatedAt: v.optional(v.number()),
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
  }).index("by_type", ["type"]),

  spot_positions: defineTable({
    asset: v.string(),
    amount: v.number(),
    dca: v.number(),
    userId: v.string(),
  }).index("by_user_id", ["userId"]),

  trades_history: defineTable({
    userId: v.id("users"),
    action: v.string(),
    asset: v.string(),
    amount: v.number(),
    price: v.number(),
    simulated: v.boolean(),
    network: v.string(),
    timestamp: v.number(),
    botId: v.optional(v.id("bots")),
    botName: v.optional(v.string()),
    triggerType: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_timestamp", ["timestamp"]),

  alerts: defineTable({
    userId: v.id("users"),
    condition: v.string(),
    threshold: v.number(),
    active: v.boolean(),
  })
    .index("by_userId", ["userId"]),

  system_config: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),
});
