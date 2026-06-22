# Plan — JAV-107: Bot de defensa de posiciones SPOT

## Context

El usuario quiere que el botón **"Bot"** dentro de las tarjetas de **posiciones spot** (`spot_positions`)
abra un menú **igual al del bot de protección de pool** y cumpla **la misma función real de cobertura
en Hyperliquid**, pero adaptado a un holding spot suelto en vez de a una posición LP. Hoy ese botón ya
existe en la UI (`SpotProtectorBot`, `src/components/BotPortal.jsx:3176`) pero es **solo simulación
local** (config en localStorage, solo graba una señal vía `tradesHistory.recordSignal`, pide la wallet HL
como texto). No coloca nada en HL.

Diferencias pedidas vs el bot de pool:
1. **Un solo trigger** (el de pool usa dos: `entry_lower`/`entry_upper`). El trigger es un **precio
   explícito**, elegible en dos modos: **manual** o **anclado al precio DCA** (`spot_positions.dca`).
2. **TPs opcionales** (en el bot de pool ya lo son: se reutiliza tal cual).
3. Cuando esté activo, debe pintar una **tarjeta en vivo idéntica** a la `CoberturaViva`
   (`BotPortal.jsx:174`, captura `tarjeta_de_bot.jpg` en la raíz), con la **misma paleta** (CSS vars del
   portal), pero con **un solo recuadro de trigger**.

**Decisiones del usuario (2026-06-22):**
- **Motor SEPARADO** (no extender el motor de pool): se construye un engine de defensa spot aparte —como
  se hizo con el Spot Grid— reutilizando solo las primitivas de bajo nivel de HL. Aísla por completo el
  bot IL vivo (cero riesgo de regresión sobre el money-path en producción).
- **Defensa = SHORT** que se arma y dispara **al CAER** el precio hasta el trigger (manual o DCA). Un
  solo trigger "abajo". `side` fijo = `"Short"` (igual semántica que el bot IL).
- **Mismas reglas que cobertura:** exclusividad de cuenta HL por `baseAsset` (JAV-102) y el nocional del
  bot **cuenta para el tope del plan** (JAV-77).

Por qué motor separado y no extender: el motor actual (`trigger_arms.poolId` **obligatorio**;
`armBotInternal` exige `bot.poolId`, deriva el trigger de `pool.minRange` y el nocional de la liquidez LP
on-chain; dos entradas + OCO + reentrada) está fuertemente acoplado a pools. Tocarlo arriesga el bot IL en
producción. Un engine spot dedicado, single-trigger, es más código pero aislado y auditable.

## Arquitectura (resumen)

Espejo del patrón Spot Grid (engine separado + cron lease/reconcile + idempotencia por cloid) tomando del
motor de triggers el **ciclo de vida de cobertura** (trigger SELL → fill → SL → BE → TPs → auto-rearm),
pero con **una sola entrada**.

### Primitivas de bajo nivel a REUTILIZAR (no duplicar)
- `makeClients(decryptPrivateKey(cred), isTestnet)` → `{ info, exchange }` — `convex/hyperliquid.ts` (export ~:9).
- `getAssetMeta(info, asset)` → `{ assetId, szDecimals, markPx, maxLeverage }` — `convex/hyperliquid.ts`.
- `roundHlPrice` / `ceilHlPrice` / `aggressiveHlPriceStr` — `convex/hyperliquid.ts:85+` (redondeo al tick).
- `placeStopLoss(...)` — `convex/hyperliquid.ts:189` (colocación de SL reutilizable).
- `hlNetwork()` / `hlIsTestnet()` — `convex/hlNetwork.ts:6`.
- `decryptPrivateKey` — `convex/hlCredentialActions.ts`.
- `toHlCloid` + **nuevo namespace de cloid** `"spot_defense"` — `convex/cloids.ts` (patrón `spotGridCloidInput`).
- `deriveBaseAsset` + lógica de exclusividad de cuenta — `convex/bots.ts:265` (`getOrCreatePoolBot`).

## Cambios tras Codex r1 (NO-GO) — incorporados abajo

Ronda 1 de Codex dio NO-GO con 6 hallazgos, todos cerrados en este diseño:
1. **Sizing seguro (ALTO):** NO dimensionar el SHORT solo con `spot_positions.amount` (editable, no
   verifica holdings reales). El nocional efectivo = `min(` nocional pedido por amount, **cota por
   margen real HL** (`withdrawable × leverage × (1 − MARGIN_SAFETY_BUFFER)`), `maxLeverage` del activo,
   **cap del plan** `)`. Ver Fase 3 §sizing.
2. **Precondición cuenta flat (ALTO):** la posición perp en HL es **neta por activo** → el bot podría
   mezclar/cerrar exposición manual del mismo coin. Añadir precondición: cuenta **flat** (szi==0) y
   **sin órdenes abiertas** de ese coin al crear y revalidado al armar. Ver Fase 2 §precondición.
3. **Trigger nacido disparado (ALTO):** si `triggerPrice >= markPx` (caso DCA por encima del precio,
   p. ej. BTC DCA $82.350 vs ~$64k) → **rechazar con lectura HL real** al crear, y **repetir el gate
   antes de enviar la orden**. Ver Fase 2 §trigger y Fase 3.
4. **Cap del plan por claves explícitas (ALTO):** `coverageUsage.ts` es por `poolId`; `spot:<baseAsset>`
   deduplica mal. Rediseñar el consumo con **claves namespaced** `pool:<poolId>` y
   `spot-defense:<botId>` (o `spot-position:<spotPositionId>`). Ver Fase 2 §coverageUsage.
5. **`desiredState` + CAS pre-envío (MEDIO):** añadir `desiredState:"armed"|"disarmed"` a
   `spot_defense_arms` y gates CAS equivalentes a `markArmSubmitting`/`gateArmBeforeOrder`. Ver Fase 1/3.
6. **Gate mainnet dedicado (MEDIO):** insuficiente reusar solo `tradingEnabled`. Añadir
   `mainnetSpotDefenseApproval` obligatorio en **create, arm, reconcile y pre-order**. Ver Fase 3 §gate.

## Cambios por fase (money-path → cada fase: Codex GO plan+código, CodeRabbit, deploy + HL_NETWORK)

### Fase 1 — Schema + connector cloid (sin money-path activo)
- `convex/schema.ts`: dos tablas nuevas (legacy-safe, todas opcionales salvo claves):
  - **`spot_defense_bots`** (modelada en `bots` + `spot_grid_bots`): `userId`, `spotPositionId`
    (`v.id("spot_positions")`), `asset`/`baseAsset`, `hlAccountId`, `side:"Short"`, `leverage`,
    `autoLeverage`, `bufferPct`, `stopLossPct`, `breakevenPct`, `tps`, `autoRearm`, `triggerMode`
    (`"manual"|"dca"`), `triggerPrice` (precio explícito normalizado), `notionalUsd` (snapshot
    `amount × precio × (1+buffer)`), `active`, `status`, `disarmPending`/`disarmRequestedAt`,
    campos de rearm (igual que `bots`), `createdAt`/`updatedAt`. Índices: `by_user`,
    `by_user_position` (`userId,spotPositionId` — unicidad 1 bot por posición), `by_user_account`.
  - **`spot_defense_arms`** (modelada en `trigger_arms` pero SIN pool y con **una sola entrada**):
    `botId`(→spot_defense_bots), `userId`, `hlAccountId`, `asset`, `network`, `generation`, `status`
    (reusar el enum de `trigger_arms` recortado: arming/submitting/armed/filled/protecting/protected/
    disarming/disarmed/closed/failed/unknown — **sin** `armed_lower_only`),
    **`desiredState:"armed"|"disarmed"`** (Codex r1 #5, igual que `trigger_arms.desiredState`),
    `side:"Short"`, `triggerPx`,
    `size`, `appliedLeverage`, `reservedNotional`/`marginReserved`, `notionalUsd`, `stopLossPct`,
    `breakevenPct`/`beMoved`, `tps`, SL fields (`slAttempts`/`slSubmittedAt`/`protectDeadline`), fill
    fields, `closeReason`/`emergencyClosing`, lease/fencing, timestamps. Índices espejo de
    `trigger_arms`: `by_bot_generation`, `by_bot_status`, `by_status_updated`, `by_account`, `by_filledAt`.
  - **`spot_defense_orders`** (espejo de `trigger_orders` recortado): `armId`, `role`
    (`"entry"|"sl"|"tp"`), `tpIndex?`, `cloid`, `oid?`, `triggerPx`, `size`, `reduceOnly`, `attempt?`,
    `observedStatus`, timestamps. Índices `by_arm_role`, `by_arm_role_index`, `by_cloid`.
- `convex/cloids.ts`: añadir `SpotDefenseCloidKind`/helper de cloid determinista
  `botId|generation|role[:tpIndex]:attempt` (mismo patrón que el grid).

### Fase 2 — Backend de creación/config + exclusividad (NON-node)
- `convex/spotDefenseBots.ts` (nuevo): mutations/queries de datos (sin RPC):
  - `preflightCreateSpotDefenseBot` / `persistSpotDefenseBot` (patrón `getOrCreatePoolBot`): valida
    permisos (`canManageBots` + `canTradeLive`), deriva `baseAsset` de la posición (`deriveBaseAsset`),
    **exclusividad JAV-102** reutilizando la lógica de `bots.ts:319-352` PERO escaneando las tres tablas
    (`bots`, `spot_defense_bots`, `spot_grid_bots`) por `tradingAccountAddress`: rechaza mismo `baseAsset`
    en otra cobertura/defensa de la cuenta y rechaza grid vivo. Valida `triggerMode`/`triggerPrice`
    (>0, finito). **El gate mainnet (`mainnetSpotDefenseApproval`, Codex r1 #6) y los gates que requieren
    lectura HL real (markPx, flat, sizing) se hacen en una ACTION de preflight (`"use node"`,
    `precheckSpotDefenseCreate`), porque las mutations NON-node no pueden leer HL.**
  - **§precondición cuenta flat (Codex r1 #2):** `precheckSpotDefenseCreate` lee `clearinghouseState` del
    coin → exige **szi==0 (flat)** y **sin órdenes abiertas** de ese coin que el bot no haya colocado.
    Si hay exposición/órdenes manuales del mismo coin → rechazar ("la cuenta tiene una posición/órdenes
    de {COIN}; usá una cuenta sin exposición de ese activo"). Revalidado al armar (Fase 3).
  - **§trigger gate con lectura real (Codex r1 #3):** `precheckSpotDefenseCreate` lee `markPx` real de HL
    y exige `triggerPrice < markPx` (un SELL trigger de bajada no puede nacer disparado). En modo DCA, si
    `dca >= markPx` → **rechazar** con mensaje claro (caso BTC DCA $82.350 vs ~$64k). El gate se **repite
    antes de enviar la orden** en la action de arm (Fase 3).
  - **§sizing seguro (Codex r1 #1):** el nocional NO sale solo de `amount`. `precheckSpotDefenseCreate`
    calcula `notionalEfectivo = min(` `amount × markPx × (1+buffer)`, **cota por margen real**
    `withdrawable × leverageEfectivo × (1 − MARGIN_SAFETY_BUFFER)`, **cap del plan restante** `)` con
    `leverageEfectivo = min(leverage, maxLeverage del activo)`. Si la cota manda, avisar en UI que el
    short queda por debajo de la posición spot (cobertura parcial). Persistir el `notionalUsd` resultante.
  - `listMySpotDefenseBots`, `getSpotDefenseDetail` (ownership, tope órdenes/cap como en grid),
    `pauseSpotDefenseBot`, lease/record/mark de órdenes y arms (espejo de `spotGridBots.ts` +
    `triggerArms.ts`), `closeArmAndScheduleRearm` / `setRearm*`, **CAS `markArmSubmitting` /
    `gateArmBeforeOrder` (Codex r1 #5)** equivalentes a `triggerArms.ts` (cuarentena: `desiredState`
    debe seguir `"armed"`, status `submitting`, sin orden previa).
- `convex/coverageUsage.ts` (Codex r1 #4): **rediseñar el consumo con claves explícitas namespaced** en
  vez de keyear por `poolId` crudo. `consumedCoverageByPool` → `consumedCoverageByKey(ctx,userId)` que
  devuelve un mapa `{ "pool:<poolId>": usd, "spot-defense:<botId>": usd }`; los pool-arms usan
  `pool:<poolId>` (dedupe por pool intacto), los spot-defense usan `spot-defense:<botId>`. La suma total
  vs el tope del plan no cambia, pero ya no hay colisión ni doble-conteo. Mantener fail-closed para filas
  legacy sin `hedgeNotionalUsd`. Adaptar `assertWithinPlanCoverage` a las claves nuevas SIN romper el
  camino del bot de pool vivo.

### Fase 3 — Motor live (MONEY-PATH, el corazón)
- `convex/spotDefenseEngine.ts` (nuevo, `"use node"`): espejo recortado de `triggerEngine.ts`:
  - `armSpotDefenseBot` (auth) + `armSpotDefenseInternal` (sin auth, lo llaman el arm y el auto-rearm):
    `makeClients` + `getAssetMeta`; **revalida (Codex r1):** gate mainnet `mainnetSpotDefenseApproval`
    (#6), cuenta **flat + sin órdenes del coin** (#2), `markPx > triggerPx` con lectura fresca (#3), y
    **recalcula el sizing acotado** (#1: `min(amount×markPx×(1+buffer)`, `withdrawable×levEf×(1−MARGIN_SAFETY_BUFFER)`,
    `cap plan restante)`, `levEf=min(leverage,maxLeverage)`). **triggerPx = `roundHlPrice(triggerPrice,
    szDecimals, "floor")`** (manual o DCA, NO desde rango); `size = notionalEfectivo / triggerPx`
    redondeado; reserva margen `notional/levEf`; **CAS pre-envío `gateArmBeforeOrder` (#5):** solo
    coloca si `desiredState==="armed"` y status `submitting` sin orden previa; inserta arm (DB-intent)
    + coloca **UNA** orden trigger SELL (`role:"entry"`, `tpsl:"sl"`, dispara al bajar) con cloid
    determinista.
  - `reconcileSpotDefenseArm` / `reconcileAllSpotDefense`: al llenarse la entrada → colocar SL
    (`placeStopLoss`), mover a BE cuando ganancia ≥ `breakevenPct` (latch `beMoved`, mismo guard
    anti-auto-disparo `beTrigger > markPx + tick` que `triggerEngine.ts`), colocar TPs parciales si
    `tps` no vacío (reduceOnly), cerrar ciclo y, si `autoRearm`, reprogramar. Idempotencia por
    cloid + lookup + lease/fencing (igual que grid/trigger). `stopSpotDefenseBot`: cancela por cloid lo
    propio y, si hay posición viva, cierre a mercado reduceOnly. Revalida gate + `hlNetwork()===network`.
  - `reconcileSpotDefenseArm` revalida también el **gate mainnet** en cada ciclo (#6) y el
    `hlNetwork()===network`.
- `convex/crons.ts`: nuevo cron **"reconcile spot defense" cada 1 min** (mismo patrón que "reconcile
  pool arms" y "reconcile spot grid"); arranque del arm tras crear el bot.
- **§gate de seguridad (Codex r1 #6):** además de `tradingEnabled`, un flag dedicado
  **`mainnetSpotDefenseApproval`** en `system_config` (espejo de `setMainnetSpotGridApproval` + botón en
  AdminView), **obligatorio y revalidado en create (action de preflight), arm, reconcile y pre-order**.
  Por defecto CERRADO hasta que el admin lo abra.

### Fase 4 — UI: modal real + tarjeta en vivo
- `src/components/BotPortal.jsx`:
  - **Reemplazar** `SpotProtectorBot` (simulación) por un modal real **clonado de `ProtectionBotModal`
    (:2421)**: `HLAccountSelect`, leverage+autoLeverage, **Buffer de Capital** (`BUFFER_OPTIONS`),
    **Stop Loss**, **Breakeven**, **Take Profits** (`TakeProfitRows` :2578, ya opcionales), Auto-rearm.
    Quitar el rango/`allowReentryFromAbove`. Añadir bloque **Trigger**: toggle
    **Manual / Anclado al DCA** + input de precio (precargado con `position.dca` en modo DCA, editable
    en manual). Sizing mostrado desde `amount × precio × (1+buffer)`. Guarda vía
    `api.spotDefenseBots.*` (create/persist). Sin `canTradeLive` no crea (igual que el de pool).
  - **Tarjeta en vivo:** clonar `CoberturaViva` (:174) → `DefensaSpotViva` con la **misma paleta y clases
    `cv-*`**, pero con **un solo `cv-tile` de Trigger** (en vez de "Trigger abajo/arriba"). Alimentada por
    `getSpotDefenseDetail` (arm vivo + órdenes) + saldo HL (`useHLAccountsBalances`, ya a nivel padre).
    Se renderiza cuando el bot está activo, igual que la del pool (`BotPortal.jsx:572`).
  - Borrar el camino de simulación (`loadProtector`/`saveProtector`/`recordSpotSignal`,
    `DEFAULT_PROTECTOR`) y la wallet-por-texto.

## Archivos críticos
- Nuevos: `convex/spotDefenseBots.ts`, `convex/spotDefenseEngine.ts`.
- Modificados: `convex/schema.ts`, `convex/cloids.ts`, `convex/coverageUsage.ts`, `convex/crons.ts`,
  `src/components/BotPortal.jsx`.
- Reutilizados (sin tocar): `convex/hyperliquid.ts` (makeClients/getAssetMeta/roundHlPrice/placeStopLoss),
  `convex/hlNetwork.ts`, `convex/hlCredentialActions.ts`, `convex/bots.ts` (referencia de exclusividad),
  `src/components/HLAccountSelect.jsx`.

## Verificación (end-to-end, en REAL — sin mocks)
1. `npm run` typecheck + tests del proyecto en verde (añadir tests puros de sizing/trigger/exclusividad
   y de la derivación DCA→triggerPx, como en grid).
2. `node node_modules/convex/bin/main.js deploy` a strong-sandpiper-848 (schema OK, sin índices borrados)
   + verificar `HL_NETWORK=mainnet`.
3. En UI `/` (posiciones spot): abrir el botón "Bot" de la posición BTC (DCA $82.350) → modal real →
   elegir cuenta HL dedicada, leverage, buffer, SL, trigger anclado al DCA (o manual), TP opcional →
   crear. Verificar en Convex (`spot_defense_bots`, `spot_defense_arms`, `spot_defense_orders`) que se
   coloca **1** orden trigger SELL en HL (prometido==colocado) y que la tarjeta en vivo aparece con la
   paleta correcta y un solo recuadro de trigger.
4. Validar ciclo real: al caer el precio al trigger → fill → SL colocado → (si BE) SL movido a entrada →
   (si TP) cierres parciales. `stopSpotDefenseBot` cancela solo lo propio y cierra posición viva.
   Sin secretos en logs (redacción defensiva, como JAV-94).
5. Exclusividad: intentar crear un 2º bot de defensa BTC en la misma cuenta → rechazo claro; en cuenta
   con grid vivo → rechazo. Tope de plan: el nocional del bot cuenta en `assertWithinPlanCoverage`.

## Notas de proceso
- Money-path: **Codex GO de PLAN y de CÓDIGO antes de cualquier PR** (nunca PR antes del GO), CodeRabbit,
  deploy Convex + verificar HL_NETWORK=mainnet. `tarjeta_de_bot.jpg` NO se commitea.
- Sugerencia: 4 PRs (uno por fase) para auditar incremental, como la épica del Spot Grid.
