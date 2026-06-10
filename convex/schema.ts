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
    userId: v.optional(v.id("users")),
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
    tokenId: v.optional(v.number()),
    apyUpdatedAt: v.optional(v.number()),
    volume1d: v.optional(v.number()),
    volume7d: v.optional(v.number()),
    feeTier: v.optional(v.number()),
    subgraphVolumeUsd1d: v.optional(v.number()),
    subgraphFeesUsd1d: v.optional(v.number()),
    subgraphTvlUsd: v.optional(v.number()),
    subgraphUpdatedAt: v.optional(v.number()),
    initialLiquidityUsd: v.optional(v.number()),
    initialLiquidityAt: v.optional(v.number()),
    // Ciclo de vida de la posición LP (detección de cierre on-chain).
    // closed = la posición se vació/cerró en Uniswap/Revert. Reversible:
    // si la posición vuelve a recibir liquidez, el cron limpia el flag.
    closed: v.optional(v.boolean()),
    closedAt: v.optional(v.number()),           // primer cierre detectado (no se sobrescribe)
    closureReason: v.optional(v.string()),       // "empty" | "not_found"
    closureCheckedAt: v.optional(v.number()),    // último chequeo del cron (incluye RPC unavailable)
  }).index("by_user", ["userId"]),

  bots: defineTable({
    name: v.string(),
    // --- Campos legacy (bots demo). Opcionales: los bots por pool usan los canónicos de abajo. ---
    action: v.optional(v.string()),
    active: v.boolean(),
    mode: v.optional(v.string()),
    trigger: v.optional(v.string()),
    walletId: v.optional(v.string()),
    capitalPerTrade: v.optional(v.number()),
    stop: v.optional(v.number()),
    simulationMode: v.boolean(),
    orderType: v.optional(v.string()),
    entryTrigger: v.optional(v.string()),
    triggerPrice: v.optional(v.number()),
    collateral: v.optional(v.string()),
    // Multi-tenancy + vínculo explícito al pool protegido.
    userId: v.optional(v.id("users")),
    poolId: v.optional(v.id("pools")),
    // --- Bots por pool (Fase 1): dos tipos con config canónica ---
    // kind: "il" = cobertura de impermanent loss (solo short); "trading" = breakout long/short.
    kind: v.optional(v.union(v.literal("il"), v.literal("trading"))),
    // Cuenta HL vinculada por ID real (ownership verificado en backend).
    hlAccountId: v.optional(v.id("hl_api_credentials")),
    // Asset base normalizado en backend (WETH→ETH, WBTC→BTC) — clave de colisión.
    baseAsset: v.optional(v.string()),
    // Dirección canónica (sustituye a `mode` para estos bots). IL siempre "short".
    direction: v.optional(v.union(
      v.literal("long_short"), v.literal("long"), v.literal("short"))),
    leverage: v.optional(v.number()),              // multiplicador (1–20), fuente única
    autoLeverage: v.optional(v.boolean()),         // único campo de auto-ajuste de leverage
    capitalPct: v.optional(v.number()),            // capital relativo al pool (50–200), fuente única
    bufferPct: v.optional(v.number()),             // buffer de capital extra (0–100)
    stopLossPct: v.optional(v.number()),           // SL canónico (no reutiliza `stop`)
    breakevenPct: v.optional(v.number()),          // % ganancia para mover SL a entrada
    trailingStop: v.optional(v.boolean()),         // trailing (bot de trading)
    trailingPct: v.optional(v.number()),
    preTriggerPct: v.optional(v.number()),         // pre-trigger (bot de trading)
    allowReentryFromAbove: v.optional(v.boolean()),// IL: proteger también al reentrar por arriba
    autoRearm: v.optional(v.boolean()),            // reabrir tras SL automáticamente
    tps: v.optional(v.array(v.object({ gainPct: v.number(), closePct: v.number() }))),
    // JAV-44: nocional de cobertura explícito (USDC), fuente de verdad backend para el motor
    // automático (no se deriva del frontend ni de un campo LP inexistente). Validado finito > 0.
    hedgeNotionalUsd: v.optional(v.number()),
    // JAV-44: pausa segura — bloquea nuevos arms mientras se cancela un trigger vivo, manteniendo
    // active=true hasta confirmar la cancelación en HL (requestDisarmAndDeactivate).
    disarmPending: v.optional(v.boolean()),
    // Órdenes trigger/límit colocadas en HL (Fase 3). oids para modificar/cancelar.
    // Opcional/vacío hasta que la colocación real exista (bloqueado por JAV-37).
    liveOrders: v.optional(v.object({
      entryOid: v.optional(v.string()),
      slOid: v.optional(v.string()),
      tpOids: v.optional(v.array(v.string())),
      placedAt: v.optional(v.number()),
    })),
  })
    .index("by_user", ["userId"])
    .index("by_pool", ["poolId"])
    // Unicidad/atomicidad: máx 1 bot por (usuario, pool, tipo) — getOrCreatePoolBot.
    .index("by_user_pool_kind", ["userId", "poolId", "kind"])
    // Exclusividad: una cuenta HL solo puede estar asignada a un bot (1 cuenta = 1 bot).
    .index("by_user_account", ["userId", "hlAccountId"]),

  wallets: defineTable({
    label: v.string(),
    type: v.string(),
    address: v.string(),
    network: v.string(),
    ownerId: v.optional(v.string()),
  })
    .index("by_type", ["type"])
    .index("by_owner", ["ownerId"]),

  // Varias cuentas HL por usuario (una por bot — "cada bot su cuenta").
  // Modelo: cada cuenta es una wallet EVM independiente (MetaMask/Rabby) vinculada a HL
  // como cuenta principal → posiciones aisladas entre cuentas. La API wallet (agentAddress)
  // solo FIRMA; el aislamiento lo da la cuenta principal (tradingAccountAddress).
  // Exclusividad "1 cuenta = 1 bot" sobre tradingAccountAddress.
  hl_api_credentials: defineTable({
    userId: v.id("users"),
    label: v.optional(v.string()),               // nombre legible (ej. "Avaro")
    agentAddress: v.string(),                    // API wallet que firma, lowercase
    tradingAccountAddress: v.string(),           // cuenta principal EVM (MetaMask/Rabby) en HL, lowercase — clave de aislamiento
    encryptedPrivateKey: v.string(),
    iv: v.string(),
    authTag: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    // Unicidad GLOBAL (no solo por usuario): ninguna cuenta/agente puede registrarse dos veces
    // en el portal, ni siquiera entre usuarios distintos. Validado en save.
    .index("by_agent", ["agentAddress"])
    .index("by_trading_account", ["tradingAccountAddress"]),

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

  // Ciclo de vida de una ejecución real en HL (JAV-37). Modela idempotency, reserva de
  // nocional y recuperación por cloid. trades_history queda como log final.
  execution_requests: defineTable({
    userId: v.id("users"),
    botId: v.id("bots"),
    idempotencyKey: v.string(),
    // Snapshot inmutable de los parámetros efectivos: la reconciliación NO relee el bot
    // (que puede reconfigurarse). Protege la posición original aunque el bot/cuenta cambien.
    hlAccountId: v.id("hl_api_credentials"),
    asset: v.string(),
    stopLossPct: v.number(),
    requestedAmount: v.number(),          // tradeAmount solicitado (base del dedupe)
    notional: v.number(),                 // nocional efectivo (size × markPx) de la 1ª ejecución
    marginReserved: v.optional(v.number()), // margen reservado por cuenta (notional/leverage) — anti-carrera
    side: v.union(v.literal("Long"), v.literal("Short")),
    status: v.union(
      v.literal("pending"), v.literal("submitting"), v.literal("entry_filled"),
      v.literal("protected"), v.literal("sl_failed"), v.literal("closed"),
      v.literal("unknown"), v.literal("failed")),
    network: v.string(),                  // "mainnet" | "testnet" capturada al reservar
    entryCloid: v.string(),
    slCloid: v.string(),                   // cloid del SL del intento actual
    slAttempt: v.optional(v.number()),     // nº de recolocación → nuevo cloid determinista
    submittedAt: v.optional(v.number()),           // cuándo se envió la entrada (grace de unknownOid)
    slSubmittedAt: v.optional(v.number()),         // cuándo se aceptó el SL (resting/waitingForTrigger): grace anti-doble-SL en lag de unknownOid
    reconcileLeaseUntil: v.optional(v.number()),   // claim exclusivo de reconciliación (anti-carrera)
    reconcileLeaseToken: v.optional(v.string()),   // fencing token: propietario del claim actual
    entryOrderId: v.optional(v.string()),
    slOrderId: v.optional(v.string()),
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    error: v.optional(v.string()),
    historyRecorded: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_idempotency", ["userId", "idempotencyKey"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_status_created", ["status", "createdAt"])
    .index("by_account", ["hlAccountId"])    // bloquear revocación con ejecuciones abiertas
    .index("by_created", ["createdAt"]),     // observabilidad admin (listRecentExecutions)

  // --- JAV-44 Etapa 1: motor de cobertura automática (triggers nativos en HL) ---
  // Un "armado" de un bot (versión = generation). Snapshot inmutable de la intención + lease/fencing.
  trigger_arms: defineTable({
    botId: v.id("bots"),
    userId: v.id("users"),
    hlAccountId: v.id("hl_api_credentials"),
    poolId: v.id("pools"),
    asset: v.string(),
    network: v.string(),                 // INMUTABLE "testnet" — el cliente de cancelación se construye de aquí
    generation: v.number(),              // sube en cada re-arm; generation = max+1 (backend)
    status: v.union(
      v.literal("arming"), v.literal("submitting"), v.literal("armed"), v.literal("disarming"),
      v.literal("disarmed"), v.literal("filled"), v.literal("closed"), v.literal("failed"),
      v.literal("unknown")),
    desiredState: v.union(v.literal("armed"), v.literal("disarmed")),
    // snapshot de config (inmutable durante la vida del arm)
    side: v.literal("Short"),
    triggerPx: v.number(),               // triggerPxNormalized (ya redondeado al tick)
    size: v.number(),
    appliedLeverage: v.number(),
    reservedNotional: v.number(),
    marginReserved: v.number(),
    lowerEdge: v.number(),               // minRange del pool al armar
    // fill
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    filledAt: v.optional(v.number()),    // cuándo se confirmó el fill (grace anti-closed-prematuro por lag)
    // ciclo de vida / fencing
    submittedAt: v.optional(v.number()), // se fija SOLO en el CAS markArmSubmitting (cuarentena N5/N6)
    error: v.optional(v.string()),
    reconcileLeaseUntil: v.optional(v.number()),
    reconcileLeaseToken: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_bot_generation", ["botId", "generation"])  // unicidad + generation = max+1
    .index("by_bot_status", ["botId", "status"])
    .index("by_status_updated", ["status", "updatedAt"])  // cron reconcilePoolArms
    .index("by_updated", ["updatedAt"])                   // cron sin starvation (más antiguo primero)
    .index("by_user_created", ["userId", "createdAt"])    // límite diario compartido con JAV-43
    .index("by_account", ["hlAccountId"]),                // bloquear revocación con arm no terminal

  // Cada orden trigger nativa de un arm. CLOID = identidad primaria determinista.
  trigger_orders: defineTable({
    armId: v.id("trigger_arms"),
    role: v.literal("entry_lower"),       // Etapa 1: solo el trigger inferior de entrada
    cloid: v.string(),                    // determinista botId|generation|role
    oid: v.optional(v.string()),          // de HL; OPCIONAL (waitingForTrigger/timeout sin oid)
    triggerPx: v.number(),
    size: v.number(),
    reduceOnly: v.boolean(),              // false (abre posición)
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    submittedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_arm_role", ["armId", "role"])  // unicidad: un entry_lower por arm
    .index("by_cloid", ["cloid"]),
});
