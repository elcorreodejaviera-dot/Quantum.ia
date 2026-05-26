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
