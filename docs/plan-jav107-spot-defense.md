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
    disarming/disarmed/closed/failed/unknown — **sin** `armed_lower_only`), `side:"Short"`, `triggerPx`,
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
    (>0, finito) y `triggerPrice < markPx` (un short de bajada no puede armar ya disparado — el cálculo
    de markPx se hace en la action de Fase 3; aquí valida coherencia con el snapshot).
  - `listMySpotDefenseBots`, `getSpotDefenseDetail` (ownership, tope órdenes/cap como en grid),
    `pauseSpotDefenseBot`, lease/record/mark de órdenes y arms (espejo de `spotGridBots.ts` +
    `triggerArms.ts`), `closeArmAndScheduleRearm` / `setRearm*`.
- `convex/coverageUsage.ts`: extender `assertWithinPlanCoverage` para **incluir** el nocional de los
  spot-defense arms vivos en el consumo total del usuario (clave sintética p. ej. `spot:<baseAsset>`,
  deduplicada como un "pool" más). Mantener fail-closed para filas legacy.

### Fase 3 — Motor live (MONEY-PATH, el corazón)
- `convex/spotDefenseEngine.ts` (nuevo, `"use node"`): espejo recortado de `triggerEngine.ts`:
  - `armSpotDefenseBot` (auth) + `armSpotDefenseInternal` (sin auth, lo llaman el arm y el auto-rearm):
    `makeClients` + `getAssetMeta`; **triggerPx = `roundHlPrice(triggerPrice, szDecimals, "floor")`**
    (manual o DCA, NO desde rango); gate `markPx > triggerPx`; sizing `notionalUsd / triggerPx` →
    `size` redondeado; reserva margen `notional/leverage`; inserta arm (DB-intent) + coloca **UNA**
    orden trigger SELL (`role:"entry"`, `tpsl:"sl"`, dispara al bajar) con cloid determinista.
  - `reconcileSpotDefenseArm` / `reconcileAllSpotDefense`: al llenarse la entrada → colocar SL
    (`placeStopLoss`), mover a BE cuando ganancia ≥ `breakevenPct` (latch `beMoved`, mismo guard
    anti-auto-disparo `beTrigger > markPx + tick` que `triggerEngine.ts`), colocar TPs parciales si
    `tps` no vacío (reduceOnly), cerrar ciclo y, si `autoRearm`, reprogramar. Idempotencia por
    cloid + lookup + lease/fencing (igual que grid/trigger). `stopSpotDefenseBot`: cancela por cloid lo
    propio y, si hay posición viva, cierre a mercado reduceOnly. Revalida gate + `hlNetwork()===network`.
- `convex/crons.ts`: nuevo cron **"reconcile spot defense" cada 1 min** (mismo patrón que "reconcile
  pool arms" y "reconcile spot grid"); arranque del arm tras crear el bot.
- Gate de seguridad: reusar `tradingEnabled` y, si se decide, un flag análogo a
  `mainnetSpotGridApproval` (a confirmar en implementación; por defecto reusar el gate de trading real).

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
