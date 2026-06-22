import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("viewer")),
    walletAddress: v.optional(v.string()),
    // JAV-73 (planes de cobertura). Plan de suscripción del usuario: define el tope de cobertura
    // total (catálogo único en convex/subscriptions.ts). Ausente/undefined = sin plan (cap 0: no puede
    // armar bots reales). Los literales DEBEN coincidir con PLAN_IDS de convex/subscriptions.ts.
    subscriptionPlan: v.optional(v.union(
      v.literal("betatester"), v.literal("starter"), v.literal("growth"),
      v.literal("pro"), v.literal("prime"), v.literal("vault"), v.literal("institutional"))),
    // El admin puede suspender a un usuario (lo detiene aunque tenga plan). El enforcement (JAV-77)
    // bloquea el armado si suspended === true.
    suspended: v.optional(v.boolean()),
  }).index("by_clerk_id", ["clerkId"]),

  // Permisos dinámicos por usuario — cada fila es un permiso individual.
  // Permite añadir, revocar o expirar permisos sin tocar el registro de usuario.
  // Keys válidas: canViewPools, canViewBots, canViewWallets, canViewPositions,
  //               canManageBots, canTradeLive, subscriptionBasic, subscriptionPro
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
    // C (JAV-UI): precio al que el portal vio por primera vez la posición LP (aprox. de entrada).
    // Se captura una sola vez y NUNCA se sobreescribe. Uniswap V3 no almacena el precio de entrada.
    entryPrice: v.optional(v.number()),
    entryPriceAt: v.optional(v.number()),
    // Ciclo de vida de la posición LP (detección de cierre on-chain).
    // closed = la posición se vació/cerró en Uniswap/Revert. Reversible:
    // si la posición vuelve a recibir liquidez, el cron limpia el flag.
    closed: v.optional(v.boolean()),
    // (JAV-40) ESTADO ACTUAL: instante del cierre vigente; se limpia al reabrir. El historial
    // verdadero (cierres/reaperturas sucesivos) vive en `pool_events`, no aquí.
    closedAt: v.optional(v.number()),
    closureReason: v.optional(v.string()),       // "empty" | "not_found"
    closureCheckedAt: v.optional(v.number()),    // último chequeo del cron (incluye RPC unavailable)
  }).index("by_user", ["userId"]),

  // (JAV-40 #15) Historial de cierres/reaperturas de pools. El doc de pools refleja el ESTADO
  // actual (closed/closedAt); esta tabla preserva la secuencia de eventos aunque closedAt se limpie.
  pool_events: defineTable({
    poolId: v.id("pools"),
    type: v.union(v.literal("closed"), v.literal("reopened")),
    reason: v.optional(v.string()),   // solo en "closed": "empty" | "not_found"
    at: v.number(),
  }).index("by_pool", ["poolId", "at"]),

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
    // Instante (ms) en que se SOLICITÓ la pausa (se setea al pasar disarmPending→true y NO se reinicia
    // en llamadas repetidas). La UI lo usa para un contador estimado (~60s = intervalo del cron
    // "reconcile pool arms") junto a "Deteniendo…". Se limpia en cada sitio que limpia disarmPending.
    disarmRequestedAt: v.optional(v.number()),
    // JAV-44 auto-rearm durable (Codex GO): estado persistente del re-armado tras un cierre por SL.
    // El cron lo reclama con lease, revalida gates y reabre la cobertura. "Nunca desprotegido" =
    // ningún fallo TÉCNICO abandona el rearm (reintento indefinido cada 5 min); pausa/kill/pool cerrado
    // sí lo cancelan; margen/config/incompatible → blocked/pending reevaluable con alerta.
    rearmStatus: v.optional(v.union(v.literal("pending"), v.literal("running"), v.literal("blocked"))),
    nextRearmAt: v.optional(v.number()),          // no rearmar antes de este instante (cooldown 5 min / backoff)
    rearmAttempts: v.optional(v.number()),
    lastRearmError: v.optional(v.string()),
    lastRearmErrorKind: v.optional(v.union(
      v.literal("transient"), v.literal("blocked_margin"),
      v.literal("blocked_config"), v.literal("retry_incompatible"))),
    rearmLeaseToken: v.optional(v.string()),
    rearmLeaseUntil: v.optional(v.number()),
    consecutiveStops: v.optional(v.number()),     // SL consecutivos → alerta de whipsaw a los 5
    stopAlertSentAt: v.optional(v.number()),      // último envío de alerta de stops
    lastStopAlertLevel: v.optional(v.number()),   // nivel de stops ya alertado (solo se sube tras Resend OK)
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
    // Exclusividad de cuenta (JAV-102): una cuenta HL de cobertura admite varios bots SOLO si cubren
    // pares distintos (un bot por baseAsset); nunca el mismo par dos veces, nunca junto a un Spot Grid
    // (el grid exige cuenta dedicada total). Usado por getOrCreatePoolBot y revokeById.
    .index("by_user_account", ["userId", "hlAccountId"])
    // JAV-44 auto-rearm: el cron busca bots con re-armado pendiente/blocked listos (nextRearmAt).
    .index("by_rearm_status", ["rearmStatus", "nextRearmAt"]),

  wallets: defineTable({
    label: v.string(),
    type: v.string(),
    address: v.string(),
    network: v.string(),
    ownerId: v.optional(v.string()),
  })
    .index("by_type", ["type"])
    .index("by_owner", ["ownerId"]),

  // Varias cuentas HL por usuario.
  // Modelo: cada cuenta es una wallet EVM independiente (MetaMask/Rabby) vinculada a HL
  // como cuenta principal → posiciones aisladas entre cuentas. La API wallet (agentAddress)
  // solo FIRMA; el aislamiento lo da la cuenta principal (tradingAccountAddress).
  // Exclusividad de cuenta (JAV-102) sobre tradingAccountAddress: una cuenta de cobertura admite
  // varios bots SOLO si cubren pares distintos (un bot por baseAsset); una cuenta de Spot Grid es
  // dedicada total (1 cuenta = 1 grid, nunca junto a cobertura/trading).
  hl_api_credentials: defineTable({
    userId: v.id("users"),
    label: v.optional(v.string()),               // nombre legible (ej. "Avaro")
    agentAddress: v.string(),                    // API wallet que firma, lowercase
    tradingAccountAddress: v.string(),           // cuenta principal EVM (MetaMask/Rabby) en HL, lowercase — clave de aislamiento
    encryptedPrivateKey: v.string(),
    iv: v.string(),
    authTag: v.string(),
    // (JAV-63) Id de la clave de cifrado con la que se cifró esta credencial. AUSENTE = clave legacy
    // (HL_CREDENTIALS_ENCRYPTION_KEY) → registros previos siguen descifrando sin cambios. Permite rotar
    // la clave sin dejar credenciales ilegibles (keyring + re-cifrado gradual).
    keyId: v.optional(v.string()),
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

  // (OBS-2) Salud/heartbeat de los crons. Una fila por cron (by_name). Se actualiza best-effort
  // desde los wrappers de cronHealth.ts: NUNCA bloquea ni marca como fallido un cron money-path.
  cron_health: defineTable({
    name: v.string(),
    lastStartedAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastErrorAt: v.optional(v.number()),
    lastError: v.optional(v.string()),       // mensaje truncado, SIN payload ni datos sensibles
    lastDurationMs: v.optional(v.number()),
    consecutiveFailures: v.optional(v.number()),
  }).index("by_name", ["name"]),

  // (OBS-3b) Hitos persistidos del motor money-path (subconjunto de los elog de OBS-3): transiciones
  // de arm/ejecución, outcome de auto-rearm, cierre de emergencia. Solo ESCALARES no sensibles (mismo
  // contrato que elog): ids/estados/enums/categoría. PROHIBIDO claves/direcciones/payloads/errores
  // crudos del SDK. Inserción best-effort desde recordEngineEvent (engineEvents.ts): un fallo escribiendo
  // aquí NUNCA aborta una mutation de trading. Todo v.optional → un campo de más nunca rompe el insert.
  engine_events: defineTable({
    scope: v.string(),     // "exec" | "arm" | "rearm" | "hl"
    event: v.string(),     // "transition" | "rearm_outcome" | "emergency_close"
    at: v.number(),
    botId: v.optional(v.id("bots")),
    armId: v.optional(v.id("trigger_arms")),
    requestId: v.optional(v.id("execution_requests")),
    userId: v.optional(v.id("users")),
    fromStatus: v.optional(v.string()),
    toStatus: v.optional(v.string()),
    reason: v.optional(v.string()),   // closeReason/kind/outcome — categoría, NUNCA string crudo
  })
    .index("by_at", ["at"])                // poda + feed admin global
    .index("by_bot_at", ["botId", "at"])   // panel por bot
    .index("by_arm_at", ["armId", "at"]),  // panel por arm

  // (JAV-81) Reportes de bug enviados por usuarios desde su Portal. El admin los gestiona en JAV-80.
  bug_reports: defineTable({
    userId: v.id("users"),
    message: v.string(),
    status: v.union(v.literal("new"), v.literal("in_review"), v.literal("resolved")),
    context: v.optional(v.object({ url: v.optional(v.string()), userAgent: v.optional(v.string()) })),
    attachments: v.array(v.id("_storage")),   // capturas validadas (ownership probado vía bug_uploads)
    adminNote: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_status_created", ["status", "createdAt"])   // filtro por estado + orden por fecha
    .index("by_user_created", ["userId", "createdAt"])     // rate-limit + reportes del usuario
    .index("by_created", ["createdAt"]),

  // (JAV-81, Codex #1) Registro de subidas para PROBAR ownership del adjunto antes de aceptarlo en
  // reportBug: el archivo debe estar registrado por ESE usuario, no consumido y dentro de TTL.
  bug_uploads: defineTable({
    userId: v.id("users"),
    storageId: v.id("_storage"),
    contentType: v.string(),       // validado contra la metadata de sistema en registerBugUpload
    size: v.number(),
    createdAt: v.number(),
    consumedAt: v.optional(v.number()),   // se fija al adjuntarse a un bug_report (un solo uso)
  })
    .index("by_user", ["userId"])
    .index("by_storage", ["storageId"]),

  // Ciclo de vida de una ejecución real en HL (JAV-37). Modela idempotency, reserva de
  // nocional y recuperación por cloid. trades_history queda como log final.
  execution_requests: defineTable({
    userId: v.id("users"),
    botId: v.id("bots"),
    idempotencyKey: v.string(),
    // Snapshot inmutable de los parámetros efectivos: la reconciliación NO relee el bot
    // (que puede reconfigurarse). Protege la posición original aunque el bot/cuenta cambien.
    hlAccountId: v.id("hl_api_credentials"),
    // (JAV-77) Snapshot del pool + liquidez LP (sin buffer) para el hard-cap por plan (Modelo B).
    // optional/legacy-safe: filas antiguas sin estos campos bloquean fail-closed en coverageUsage.ts.
    poolId: v.optional(v.id("pools")),
    hedgeNotionalUsd: v.optional(v.number()), // liquidez LP cruda (unidad de cobertura del plan)
    asset: v.string(),
    stopLossPct: v.number(),
    requestedAmount: v.number(),          // tradeAmount solicitado (base del dedupe)
    notional: v.number(),                 // nocional efectivo (size × markPx) de la 1ª ejecución
    marginReserved: v.optional(v.number()), // margen reservado por cuenta (notional/leverage) — anti-carrera
    appliedLeverage: v.optional(v.number()), // leverage entero aplicado (auto o manual); optional para filas legacy
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
    // (G5) cuándo se OBSERVÓ por primera vez la posición flat (szi==0) con el SL ya no resting.
    // Se confirma el cierre solo si sigue flat tras un grace (lecturas separadas en el tiempo entre
    // ciclos del cron) → defensa contra un lag consistente de clearinghouseState. Se limpia si la
    // posición vuelve a verse viva.
    flatSince: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_idempotency", ["userId", "idempotencyKey"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_status_created", ["status", "createdAt"])
    .index("by_account", ["hlAccountId"])    // bloquear revocación con ejecuciones abiertas
    .index("by_bot", ["botId"])              // bloquear borrado del bot con ejecuciones abiertas (D)
    .index("by_created", ["createdAt"])      // observabilidad admin (listRecentExecutions)
    .index("by_user_status", ["userId", "status"]), // (JAV-79) cobertura: leer solo filas vivas del user

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
      v.literal("disarmed"), v.literal("filled"), v.literal("protecting"), v.literal("protected"),
      // (JAV-61) armed_lower_only: el short de arriba (reentry) cerró por TP-final pero entry_lower
      // sigue armada esperando PERFORACIÓN del borde inferior. Flat, sin short, cobertura viva.
      v.literal("armed_lower_only"),
      v.literal("closed"), v.literal("failed"), v.literal("unknown")),
    desiredState: v.union(v.literal("armed"), v.literal("disarmed")),
    // snapshot de config (inmutable durante la vida del arm)
    side: v.literal("Short"),
    triggerPx: v.number(),               // triggerPxNormalized (ya redondeado al tick)
    size: v.number(),
    appliedLeverage: v.number(),
    reservedNotional: v.number(),
    marginReserved: v.number(),
    // (JAV-77) liquidez LP cruda (sin buffer) del pool al armar = unidad de cobertura del plan
    // (Modelo B). optional/legacy-safe: arms vivos sin este campo bloquean fail-closed en coverageUsage.ts.
    hedgeNotionalUsd: v.optional(v.number()),
    lowerEdge: v.number(),               // minRange del pool al armar
    upperEdge: v.optional(v.number()),   // maxRange normalizado (entry_upper, si allowReentryFromAbove)
    allowReentryFromAbove: v.optional(v.boolean()),  // 2ª entrada (borde superior) + OCO
    reservationReduced: v.optional(v.boolean()),     // la reserva 2×→1× ya se aplicó (tras OCO confirmado)
    // (JAV-61) Modo de coexistencia de las dos patas. undefined/"oco" = flujo in-range clásico
    // (al llenarse una entrada se cancela la hermana y se reduce 2×→1×). "reentry_coexist" = ambas
    // patas conviven: NO se cancela entry_lower al llenarse entry_upper, NO se reduce la reserva, y
    // tras el TP-final del short de arriba el arm pasa a `armed_lower_only` (entry_lower sigue viva).
    armMode: v.optional(v.union(v.literal("oco"), v.literal("reentry_coexist"))),
    // (JAV-61) Semántica de entry_upper: "breakout_up" = SELL trigger ARRIBA del borde, dispara al
    // SUBIR (tpsl:"tp"), precio dentro del rango. "reentry_down" = SELL trigger EN el borde superior,
    // dispara al BAJAR/reentrar (tpsl:"sl"), precio por encima del rango.
    entryUpperMode: v.optional(v.union(v.literal("breakout_up"), v.literal("reentry_down"))),
    // (JAV-61) Qué entrada llenó la posición. El TP-final solo se coloca si llenó "entry_upper".
    filledEntryRole: v.optional(v.union(v.literal("entry_lower"), v.literal("entry_upper"))),
    // (Codex #1 auto-rearm) Este arm nació de un auto-rearm: si termina `failed` SIN entrada viva/fill
    // (prueba negativa confirmada), settleArm/recoverAbandonedArming REPROGRAMA otro rearm atómicamente
    // (el consumo transfirió la responsabilidad al arm; al fallar sin cobertura, devuelve el trabajo).
    fromRearm: v.optional(v.boolean()),
    stopLossPct: v.number(),             // snapshot del SL del bot (para armar el SL post-fill)
    bufferPct: v.optional(v.number()),   // snapshot del búfer (% del pool) — TPs solo sobre el búfer
    tps: v.optional(v.array(v.object({ gainPct: v.number(), closePct: v.number() }))),  // snapshot config TPs
    // (JAV-66) Break-even: snapshot del bot.breakevenPct (% de GANANCIA que activa el movimiento del SL
    // a entrada). undefined → BE desactivado (comportamiento legacy intacto). beMoved = latch one-way:
    // el BE ya se activó → el trigger deseado del SL pasa de entry+stopLossPct% a entry (break-even).
    breakevenPct: v.optional(v.number()),
    beMoved: v.optional(v.boolean()),
    // SL post-fill
    slAttempts: v.optional(v.number()),  // nº de intentos de colocar el SL (cloid …|sl|attempt)
    slSubmittedAt: v.optional(v.number()),  // SL enviado (resting/pending): grace+prueba negativa antes de rotar cloid (anti-doble-SL)
    protectDeadline: v.optional(v.number()),  // filledAt + SL_PROTECT_DEADLINE_MS → escala a cierre de emergencia
    // fill
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    filledAt: v.optional(v.number()),    // cuándo se confirmó el fill (grace anti-closed-prematuro por lag)
    closeConfirmSince: v.optional(v.number()),  // 1ª lectura szi==0 (doble lectura anti single transient read)
    // ciclo de vida / fencing
    submittedAt: v.optional(v.number()), // se fija SOLO en el CAS markArmSubmitting (cuarentena N5/N6)
    error: v.optional(v.string()),
    // auto-rearm (JAV-44): MOTIVO del cierre (Codex #1). El re-arm SOLO dispara con closeReason="sl".
    // emergencyClosing se fija ANTES del market close para distinguir emergency/disarm de un SL/cierre externo.
    closeReason: v.optional(v.union(v.literal("sl"), v.literal("manual"), v.literal("emergency"), v.literal("disarm"))),
    emergencyClosing: v.optional(v.union(v.literal("emergency"), v.literal("disarm"))),
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
    .index("by_account", ["hlAccountId"])                 // bloquear revocación con arm no terminal
    .index("by_filledAt", ["filledAt"])                   // (JAV-85 #5) volumen 24h por momento del fill
    .index("by_user_status", ["userId", "status"]),       // (JAV-79) cobertura: leer solo filas vivas del user

  // Cada orden trigger nativa de un arm. CLOID = identidad primaria determinista.
  trigger_orders: defineTable({
    armId: v.id("trigger_arms"),
    // entradas (2) + SL + TPs parciales + (JAV-61) tp_final: cierre del remanente del short de arriba
    // al llegar al borde inferior (reduceOnly, size residual dinámico = 100 − Σ closePct parciales).
    role: v.union(v.literal("entry_lower"), v.literal("entry_upper"), v.literal("sl_upper"), v.literal("tp"), v.literal("tp_final")),
    tpIndex: v.optional(v.number()),      // solo role:"tp" (0..N-1) — unicidad por (armId, "tp", tpIndex)
    cloid: v.string(),                    // determinista botId|generation|role[:tpIndex]:attempt
    oid: v.optional(v.string()),          // de HL; OPCIONAL (waitingForTrigger/timeout sin oid)
    triggerPx: v.number(),
    size: v.number(),
    reduceOnly: v.boolean(),
    attempt: v.optional(v.number()),      // nº de intento (rota el cloid …:attempt) — TPs
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    submittedAt: v.optional(v.number()),  // por orden: confirmar-antes-de-rotar (anti-doble) por TP/SL
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_arm_role", ["armId", "role"])
    .index("by_arm_role_index", ["armId", "role", "tpIndex"])  // lookup/unicidad por TP individual
    .index("by_cloid", ["cloid"]),

  // (QSG / JAV-91) Quantum Spot Grid Live — bots de grid spot en Hyperliquid. AISLADO del motor perp.
  // Live-only (sin simulationMode). PR2: persistencia + comandos; el motor real va en PR3.
  spot_grid_bots: defineTable({
    userId: v.id("users"),
    hlAccountId: v.id("hl_api_credentials"),   // cuenta HL DEDICADA (exclusiva: ningún otro bot la usa)
    symbol: v.string(),                        // activo lógico del MVP: "BTC" | "ETH"
    assetId: v.number(),                       // 10000 + universeIndex (resuelto por red en creación)
    baseAsset: v.string(),                     // símbolo real en spotMeta (p.ej. "UBTC")
    quoteAsset: v.string(),                    // "USDC"
    minPrice: v.number(),                      // suelo del grid (no compra por debajo)
    gridProfitPercent: v.number(),             // espaciado geométrico (% por cuadrícula)
    investmentAmount: v.number(),              // capital total asignado (quote, USDC)
    orderSize: v.number(),                     // quote por orden de compra
    gridCount: v.number(),                     // nº de niveles
    feeRate: v.number(),                       // tarifa efectiva usada en el cálculo de profit neto
    currentPrice: v.optional(v.number()),      // precio de CREACIÓN (ancla del grid si autoDerived) / informativo
    // (JAV-101) true = gridCount/orderSize derivados por deriveAutoGrid desde el rango → la colocación
    // inicial ANCLA a currentPrice (prometido==colocado). Ausente/false = manual o legacy → la colocación
    // inicial refresca el precio spot en vivo (no depende del snapshot persistido). legacy-safe.
    autoDerived: v.optional(v.boolean()),
    status: v.union(v.literal("running"), v.literal("paused"), v.literal("stopped"), v.literal("error")),
    network: v.union(v.literal("mainnet"), v.literal("testnet")),
    generation: v.number(),                    // entero, +1 por arranque (idempotencia de cloids)
    // (JAV-92) Secuencia monótona de ciclos por bot: cada cierre de ciclo (SELL llenada) la incrementa y
    // la BUY de reposición usa el nuevo valor en su cloid → cloid siempre único. Ausente = 0 (legacy-safe).
    cycleSeq: v.optional(v.number()),
    // (JAV-103) Siembra de inventario inicial (tipo BingX Infinity). Todo opcional → legacy-safe (los grids
    // sin estos campos son "compra-primero" como hasta ahora).
    seedPercent: v.optional(v.number()),          // % derivado del capital sembrado (informativo)
    seedQty: v.optional(v.number()),              // base realmente comprada en la semilla (seedQtyReal)
    seedAvgPx: v.optional(v.number()),            // VWAP real de la compra semilla (costBasis de las SELL sembradas)
    seedNotionalReal: v.optional(v.number()),     // quote gastado en la semilla (= seedQty·seedAvgPx)
    seedStatus: v.optional(v.union(v.literal("pending"), v.literal("done"), v.literal("failed"))),
    // (JAV-103) Fase del bootstrap seeded: "seed" compra inventario, "sells" coloca SELLs sembradas,
    // "buys" coloca BUYs grid, "done" → reconcile normal. Ausente = grid legacy/no-seeded (camino actual).
    bootstrapPhase: v.optional(v.union(v.literal("seed"), v.literal("sells"), v.literal("buys"), v.literal("done"))),
    // (JAV-103) Contador de intentos de liquidación: cada envío usa un cloid con este nonce → un IOC que
    // llenó PARCIAL se puede reintentar (cloid nuevo) sin que gatedPlaceIoc lo bloquee por "ya tiene fills",
    // vendiendo el `free` restante. Pre-incrementado antes de enviar (crash-safe). Ausente = 0.
    liquidationSeq: v.optional(v.number()),
    fillCursor: v.optional(v.number()),        // cursor de fills procesados (reconcile PR3)
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastReconciledAt: v.optional(v.number()),
    // (JAV-104) Último precio spot VIVO observado en el reconcile → mark-to-market del flotante (NO el
    // ancla de creación `currentPrice`). `lastPriceAt` es la base real de `priceStale`. Opcionales →
    // legacy-safe (bots viejos caen a `currentPrice` hasta su primer reconcile nuevo).
    lastPrice: v.optional(v.number()),
    lastPriceAt: v.optional(v.number()),
    // (JAV-92) lease/fencing del reconcile (igual que trigger_arms): un solo worker por bot a la vez.
    reconcileLeaseToken: v.optional(v.string()),
    reconcileLeaseUntil: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_account", ["hlAccountId"]),     // exclusividad de cuenta + lookup del motor

  // Órdenes del grid. Convex no impone unicidad → dedupe por lookup-before-insert en by_cloid.
  spot_grid_orders: defineTable({
    botId: v.id("spot_grid_bots"),
    userId: v.id("users"),
    cloid: v.string(),                         // 0x+32hex determinista (toHlCloid de PR1)
    oid: v.optional(v.string()),
    assetId: v.number(),
    side: v.union(v.literal("buy"), v.literal("sell")),
    price: v.number(),
    quantity: v.number(),
    quoteSize: v.number(),
    gridLevel: v.number(),
    generation: v.number(),
    cycleId: v.number(),
    // (JAV-92 ALTO#1) `submitting` = intent en DB ANTES de enviar a HL; nunca `open` sin confirmación HL.
    status: v.union(
      v.literal("submitting"), v.literal("open"), v.literal("partially_filled"), v.literal("filled"),
      v.literal("cancelled"), v.literal("failed")),
    filledQty: v.optional(v.number()),
    remainingQty: v.optional(v.number()),
    avgFillPx: v.optional(v.number()),
    pendingSellQty: v.optional(v.number()),
    pairedOrderId: v.optional(v.id("spot_grid_orders")),
    attempt: v.optional(v.number()),
    submittedAt: v.optional(v.number()),       // (JAV-92) instante del intent submitting → grace de retry
    cycleSettled: v.optional(v.boolean()),     // (JAV-92 ALTO#3) SELL ya consumida por un cierre de ciclo
    sellTranche: v.optional(v.number()),       // (JAV-92) nº de SELL ya emitidas para ESTE BUY (cloid por tranche)
    // (JAV-103) Rol de la orden (namespace de cloid): "grid" (default/ausente) | "seed" | "liquidation".
    kind: v.optional(v.union(v.literal("grid"), v.literal("seed"), v.literal("liquidation"))),
    // (JAV-103) Precio de compra del nivel para la reposición tras cerrar (independiente de que haya BUY
    // previa). Para SELL grid = price del BUY pareado; para SELL sembrada = sellPrice/step.
    repostBuyPrice: v.optional(v.number()),
    // (JAV-92 r4) Costo real de la base AÚN no vendida de un BUY (Σ sz·px de los fills sin SELL), para que
    // cada tranche se valore con su VWAP correcto, no el de todo el BUY. `costBasis` = VWAP de compra de
    // ESTA SELL concreta (lo usa el netProfit del ciclo, sin contaminar con otros tranches).
    pendingSellCost: v.optional(v.number()),
    costBasis: v.optional(v.number()),
    filledFeeUsd: v.optional(v.number()),      // (JAV-92 r5) fee REAL acumulada de TODOS los fills de la orden
                                               // (multi-ronda) → netProfit del ciclo no se infla con fees parciales
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    filledAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
  })
    .index("by_bot_status", ["botId", "status"])
    .index("by_cloid", ["cloid"]),

  // Ciclos cerrados (compra→venta pareada) con profit neto.
  spot_grid_cycles: defineTable({
    botId: v.id("spot_grid_bots"),
    userId: v.id("users"),
    cycleId: v.number(),                       // monótono por bot
    buyOrderId: v.id("spot_grid_orders"),
    sellOrderId: v.optional(v.id("spot_grid_orders")),
    buyPrice: v.number(),
    sellPrice: v.optional(v.number()),
    quantity: v.number(),
    grossProfit: v.optional(v.number()),
    fees: v.optional(v.number()),
    netProfit: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_bot", ["botId"])
    .index("by_bot_cycle", ["botId", "cycleId"]),
});
