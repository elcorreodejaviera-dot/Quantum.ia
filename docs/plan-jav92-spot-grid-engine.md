# Plan JAV-92 — Motor Live Spot Grid (QSG PR3, MONEY-PATH)

## Context
Sub-3 de la épica **JAV-89** (Quantum Spot Grid Live). PR1 (connector, JAV-90) y PR2 (schema+backend,
JAV-91) ya están **mergeados y desplegados**. Falta el **motor**: coloca y mantiene órdenes LIMIT reales
en Hyperliquid Spot (compra al bajar, vende un poco más arriba, cierra ciclos con profit neto, repone).
**Money-path**; replica el patrón del motor perp (`triggerArms`/`triggerEngine`): lease/fencing + cloid
determinista + reconciliación por cron. Diseño base auditado por Codex (4 rondas, GO) en la issue JAV-92.

**Decisiones del usuario (2026-06-20):** un solo PR; **validación REAL en Hyperliquid, nada de simulación**
(live-only); los tests de código (math/cloid/idempotencia) se mantienen por ser money-path.

## Archivos
- **Nuevo:** `convex/spotGridEngine.ts` (action money-path, "use node" — descifra clave y firma).
- **Editar:** `convex/spotGridBots.ts` (mutations/queries internas), `convex/hyperliquidSpot.ts` (lecturas
  que faltan), `convex/schema.ts` (lease fields), `convex/crons.ts` + `convex/cronHealth.ts` (cron+wrapper),
  `tests/convexHarness.ts` (allowlist si aplica).
- **Tests:** `tests/spotGridEngine.test.ts` (math+cloid, importando el helper directo) + casos convex-test
  de idempotencia en `spotGridBots.ts` (recordOrder lookup-before-insert, closeCycleAndRepost).

## 1. Schema — añadir lease a `spot_grid_bots`
`reconcileLeaseToken: v.optional(v.string())`, `reconcileLeaseUntil: v.optional(v.number())` (legacy-safe,
igual que `trigger_arms`). Sin tablas nuevas (las 3 de PR2 existen).

## 2. Connector (`convex/hyperliquidSpot.ts`) — lecturas que faltan
Con `InfoClient`, por `tradingAccountAddress` (Codex #9), reusando `withSpotTimeout`:
- `getOpenSpotOrders(info, tradingAccountAddress)` → `frontendOpenOrders`.
- `getSpotFills(info, tradingAccountAddress, sinceCursor?)` → `userFills` (para `fillCursor`).
- `getSpotOrderStatusByCloid(info, tradingAccountAddress, cloid)` → fallback por CLOID (Codex #2).

## 3. Motor (`convex/spotGridEngine.ts`, "use node")
Descifra con `decryptPrivateKey(credential)` → `makeSpotClients(privKey, isTestnet)` (exchange firmado);
reusa `info` para lecturas. Replica el patrón de `triggerEngine.ts` (no copia el perp).
- **`calculateGridLevels(...)`** (pura, exportada y testeable): geométrico `buy[n]=buy[n-1]/(1+p)` mientras
  `≥ minPrice`; `qty=orderSize/buy`. **Profit neto post-rounding (Codex #6):** redondea precio (BUY floor /
  SELL ceil con `roundSpotPrice`) y size (`floorSpotSize`), descuenta fees buy+sell (`getUserFees`), y si el
  neto no cubre `gridProfitPercent` sube el SELL un tick y revalida. `roundAndValidateSpotOrder`/min-notional
  obligatorio.
- **`placeInitialBuyOrders`**: cloid = `toHlCloid(spotGridCloidInput(botId,generation,cycleId,level,"buy"))`.
  Lee `getOpenSpotOrders` ANTES de crear (idempotente); `recordSpotGridOrder` lookup-before-insert `by_cloid`
  antes de `placeSpotLimit`.
- **`reconcileSpotGridBot`** (por bot, bajo lease): `fillCursor` + fallback `getSpotOrderStatusByCloid`/
  `getOpenSpotOrders` por CLOID (Codex #2). Partial fills (Codex #7): acumula `filledQty`/`avgFillPx`. BUY
  (parcial/total) → SELL pareada por `filledQty`; SELL llenada → `closeCycleAndRepost`. **Sub-mínima
  (Codex #3-r2):** si `filledQty*sellPrice < MIN_SPOT_NOTIONAL` NO coloca SELL; acumula `pendingSellQty`
  hasta ≥ mínimo; "polvo" al detener no se vende.
- **Batching/backoff (Codex #5/#10):** una ronda de lecturas por **cuenta+red**, no por bot; backoff básico.
- **`reconcileAllSpotGrids`** (entry del cron): lista bots `running`, agrupa por `hlAccountId`, claima cada
  uno (lease), reconcilia, libera. Pausa+`error` ante fallo crítico/sin balance.
- **`stopSpotGridBot`** (Codex #8): `cancelSpotByCloid` de las órdenes propias + marca `stopped` + auditoría.

## 4. Mutations/queries internas (`convex/spotGridBots.ts`, NON-node, lease/CAS)
Patrón de `triggerArms.ts` (claim/renew/release + fencing por token):
- `claimSpotGridReconcile`/`renewSpotGridReconcile`/`releaseSpotGridReconcile`.
- `recordSpotGridOrder` (lookup-before-insert `by_cloid`), `markSpotGridOrder` (open/partial/filled/
  cancelled + filledQty/avgFillPx/pendingSellQty), `setSpotGridStatus` (paused/error/stopped + errorMessage),
  `setFillCursor`.
- **`closeCycleAndRepost` (Codex #4-r2, transaccional):** en UNA mutation incrementa `cycleId` atómico,
  inserta `spot_grid_cycles` (…+`netProfit`+closedAt) y crea la BUY de reposición con el nuevo `cycleId`
  (lookup-before-insert `by_bot_cycle`). Evita doble cierre.
- Internal queries: `listRunningSpotGridBotsInternal`, `getSpotGridOrdersInternal(botId)`,
  `getSpotGridCredentialInternal(botId)` (credencial cifrada, solo para descifrar en la action).
- `generation`: 1 en create; +1 solo en re-arranque tras stop.

## 5. Cron + health
- `cronHealth.ts`: `reconcileSpotGridWithHealth` → `withCronHealth(ctx,"reconcile spot grid",()=>runAction(
  internal.spotGridEngine.reconcileAllSpotGrids,{}))`.
- `crons.ts`: `crons.interval("reconcile spot grid",{minutes:1},internal.cronHealth.reconcileSpotGridWithHealth)`.
- `elog("spotgrid", evento, {escalares})` por transición.

## Reuso (NO duplicar)
`decryptPrivateKey`, `makeSpotClients`/`placeSpotLimit`/`cancelSpotByCloid`/`roundSpotPrice`/`floorSpotSize`/
`roundAndValidateSpotOrder`/`assertMinNotional`/`getSpotBalance`/`getUserFees`/`MIN_SPOT_NOTIONAL_USD`,
`toHlCloid`/`spotGridCloidInput`, patrón lease/CAS de `triggerArms.ts`, `withCronHealth`, `elog`/`safeError`,
guards de `helpers.ts`. NO toca `leverage.ts` ni el motor perp.

## Invariantes de seguridad
No withdrawals · solo LIMIT · API wallet trade-only · clave nunca en logs/UI · cloid único (lookup-before-
insert `by_cloid`) · idempotencia en place y reconcile · verificar balance antes de crear · respetar tick/
lot/min-notional (sin SELL sub-mínima) · al reiniciar leer openOrders antes de crear · ante error de API
pausar+registrar · el bot solo toca cloids propios · **mainnet bloqueado salvo `mainnetSpotGridApproved`**.

## Features nuevas pedidas (2026-06-20) — NO en JAV-92; JAV-92 deja los datos listos
- **Tarjeta para compartir estilo BingX** (pair · Spot Grid Infinity · Ganancias totales · Duración Xd Yh Zm
  · Órdenes emparejadas N · branding+QR) → **JAV-93 (UI)**. Datos: Σ `cycles.netProfit`, `now−createdAt`,
  nº de `cycles`. JAV-92 ya los registra.
- **Días creado + nº arbitrajes + ganancia total** (stats) → **JAV-93 (UI)**.
- **Añadir capital a un grid activo** → **nueva sub-tarea money-path (JAV-100)**: sube `investmentAmount` +
  coloca BUYs adicionales. PR aparte.
- **Retirar ganancias** → **nueva sub-tarea money-path (JAV-101)**: `withdrawnProfitUsd`, excluir de la
  reinversión (no withdrawal on-chain; contabilidad de profit retirable). PR aparte; semántica con Codex.

## Verificación
- `npm run typecheck` OK.
- Tests de código: `calculateGridLevels` (neto post-rounding ≥ objetivo; min-notional), CLOID 0x+32hex,
  partial fills + `pendingSellQty`, idempotencia (reconcile no duplica órdenes/ciclos) — mutations vía
  convex-test, math/cloid importando el helper.
- **Validación E2E REAL en Hyperliquid (sin simulación):** grid pequeño real → BUYs reales → fill real →
  SELL pareada real → ciclo con `netProfit` real → `stop` cancela solo lo propio. Mainnet gateado.
- `grep` de secretos en `elog`. Flujo: GO Codex (plan) → implementar → GO Codex (código) → PR → CodeRabbit →
  merge → deploy → validación real.
