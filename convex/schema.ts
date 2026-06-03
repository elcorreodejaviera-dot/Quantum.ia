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
    poolAddress: v.optional(v.string()),
    apyUpdatedAt: v.optional(v.number()),
    volume1d: v.optional(v.number()),
    volume7d: v.optional(v.number()),
    feeTier: v.optional(v.number()),
    subgraphVolumeUsd1d: v.optional(v.number()),
    subgraphFeesUsd1d: v.optional(v.number()),
    subgraphTvlUsd: v.optional(v.number()),
    subgraphUpdatedAt: v.optional(v.number()),
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
    orderType: v.optional(v.string()),
    entryTrigger: v.optional(v.string()),
    triggerPrice: v.optional(v.number()),
    autoLeverage: v.optional(v.boolean()),
    collateral: v.optional(v.string()),
  }),

  wallets: defineTable({
    label: v.string(),
    type: v.string(),
    address: v.string(),
    network: v.string(),
    ownerId: v.optional(v.string()),
  })
    .index("by_type", ["type"])
    .index("by_owner", ["ownerId"]),

  hl_api_credentials: defineTable({
    userId: v.id("users"),
    agentAddress: v.string(),
    encryptedPrivateKey: v.string(),
    iv: v.string(),
    authTag: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

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
    exchangeStatus: v.optional(v.string()),
    orderId: v.optional(v.string()),
    exchangeResponse: v.optional(v.any()),
    source: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_timestamp", ["timestamp"])
    .index("by_user_timestamp", ["userId", "timestamp"]),

  alerts: defineTable({
    userId: v.id("users"),
    alertType: v.union(v.literal("out_of_range"), v.literal("apy_below"), v.literal("price_cross")),
    pair: v.string(),
    network: v.optional(v.string()),
    threshold: v.optional(v.number()),
    active: v.boolean(),
    lastTriggeredAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"]),

  alert_history: defineTable({
    userId: v.id("users"),
    alertType: v.string(),
    pair: v.string(),
    message: v.string(),
    timestamp: v.number(),
  })
    .index("by_user_timestamp", ["userId", "timestamp"]),

  purchase_history: defineTable({
    userId: v.string(),
    asset: v.string(),
    qty: v.number(),
    price: v.number(),
    dcaBefore: v.number(),
    dcaAfter: v.number(),
    amountBefore: v.number(),
    amountAfter: v.number(),
    timestamp: v.number(),
  })
    .index("by_user_asset", ["userId", "asset"])
    .index("by_user_asset_time", ["userId", "asset", "timestamp"]),

  admin_logs: defineTable({
    userId: v.string(),
    action: v.string(),
    timestamp: v.number(),
    meta: v.optional(v.any()),
  }).index("by_timestamp", ["timestamp"]),

  system_config: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),
});
