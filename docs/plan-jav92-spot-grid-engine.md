# Plan JAV-92 — Motor Live Spot Grid (QSG PR3, MONEY-PATH)

## Context
Sub-3 de la épica **JAV-89** (Quantum Spot Grid Live). PR1 (connector, JAV-90) y PR2 (schema+backend,
JAV-91) ya están **mergeados y desplegados**. Falta el **motor**: coloca y mantiene órdenes LIMIT reales
en Hyperliquid Spot (compra al bajar, vende un poco más arriba, cierra ciclos con profit neto, repone).
**Money-path**; replica el patrón del motor perp (`triggerArms`/`triggerEngine`): lease/fencing + cloid
determinista + reconciliación por cron. Diseño base auditado por Codex (4 rondas, GO) en la issue JAV-92.

**Decisiones del usuario (2026-06-20):** un solo PR; **validación REAL en Hyperliquid, nada de simulación**
(live-only); los tests de código (math/cloid/idempotencia) se mantienen por ser money-path.

> **Rev.2 (tras Codex NO-GO r1):** (ALTO#1) contrato DB-intent con estado `submitting` (nunca `open` sin
> confirmación de HL); (ALTO#2) gate live revalidado en CADA reconcile y antes de cada envío, no solo en
> create; (ALTO#3) `closeCycleAndRepost` idempotente por SELL consumida (`cycleSettled`), no solo
> `by_bot_cycle`; (MEDIO#4) loop de profit ACOTADO + nivel `grid_level_uneconomic`; (MEDIO#5) semántica
> pausa/stop con órdenes vivas/fills (sección 6 + tests).

## Archivos
- **Nuevo:** `convex/spotGridEngine.ts` (action money-path, "use node" — descifra clave y firma).
- **Editar:** `convex/spotGridBots.ts` (mutations/queries internas), `convex/hyperliquidSpot.ts` (lecturas
  que faltan), `convex/schema.ts` (lease fields), `convex/crons.ts` + `convex/cronHealth.ts` (cron+wrapper),
  `tests/convexHarness.ts` (allowlist si aplica).
- **Tests:** `tests/spotGridEngine.test.ts` (math+cloid, importando el helper directo) + casos convex-test
  de idempotencia en `spotGridBots.ts` (recordOrder lookup-before-insert, closeCycleAndRepost).

## 1. Schema
- `spot_grid_bots`: lease `reconcileLeaseToken: v.optional(v.string())`,
  `reconcileLeaseUntil: v.optional(v.number())` (legacy-safe, igual que `trigger_arms`).
- **(Codex ALTO#1) `spot_grid_orders.status`: añadir `"submitting"`.** Contrato DB-intent-antes-de-HL:
  la orden se inserta como `submitting`+`submittedAt`, se envía a HL, y SOLO pasa a `open` cuando HL confirma
  resting/aceptación. Nunca `open` sin confirmación → si la action muere tras el insert, el reconcile la
  resuelve (no queda orden fantasma "open").
- **(Codex ALTO#3) `spot_grid_orders`: añadir `cycleSettled: v.optional(v.boolean())`** — marca una SELL ya
  consumida por un cierre de ciclo → idempotencia por orden (no solo por `by_bot_cycle`).
Sin tablas nuevas (las 3 de PR2 existen).

## 2. Connector (`convex/hyperliquidSpot.ts`) — lecturas que faltan
Con `InfoClient`, por `tradingAccountAddress` (Codex #9), reusando `withSpotTimeout`:
- `getOpenSpotOrders(info, tradingAccountAddress)` → `frontendOpenOrders`.
- `getSpotFills(info, tradingAccountAddress, sinceCursor?)` → `userFills` (para `fillCursor`).
- `getSpotOrderStatusByCloid(info, tradingAccountAddress, cloid)` → fallback por CLOID (Codex #2).

## 3. Motor (`convex/spotGridEngine.ts`, "use node")
Descifra con `decryptPrivateKey(credential)` → `makeSpotClients(privKey, isTestnet)` (exchange firmado);
reusa `info` para lecturas. Replica el patrón de `triggerEngine.ts` (no copia el perp).
- **(Codex ALTO#2) `assertSpotGridLiveAdmissible(ctx, bot)`** — gate live revalidado **en CADA reconcile y
  ANTES de cada envío/cancelación real** (no solo en create, igual que el gate del motor perp): `tradingEnabled`
  ON + `!simulationMode` global + el dueño SIGUE con `canTradeLive` + ownership de la cuenta + (si
  `network==="mainnet"`) `mainnetSpotGridApproved.enabled`. Si falla → NO coloca nuevas órdenes y pasa el bot a
  `paused` (gate global off / sin permiso) o `error` (config inconsistente), registrando el motivo.
- **`calculateGridLevels(...)`** (pura, exportada y testeable): geométrico `buy[n]=buy[n-1]/(1+p)` mientras
  `≥ minPrice`; `qty=orderSize/buy`. **Profit neto post-rounding (Codex #6):** redondea precio (BUY floor /
  SELL ceil con `roundSpotPrice`) y size (`floorSpotSize`), descuenta fees buy+sell (`getUserFees`), y si el
  neto no cubre `gridProfitPercent` sube el SELL un tick y revalida. **(Codex MEDIO#4) Loop ACOTADO** (máx N
  iteraciones, p.ej. 20); si tras el tope el neto sigue sin cubrir el objetivo (fees/tick/min-notional lo
  impiden) → ese nivel se RECHAZA con error categorizado (`grid_level_uneconomic`), NO se itera sin fin ni se
  emite un precio absurdo. `roundAndValidateSpotOrder`/min-notional obligatorio.
- **`placeInitialBuyOrders`**: para cada nivel, **(ALTO#1)** `recordSpotGridOrder` inserta `submitting`
  (lookup-before-insert `by_cloid`) → `placeSpotLimit` → `markSpotGridOrder("open", oid)` SOLO si HL confirma.
  cloid = `toHlCloid(spotGridCloidInput(botId,generation,cycleId,level,"buy"))`. Lee `getOpenSpotOrders` ANTES
  (idempotente: si el cloid ya está vivo en HL, no reenvía).
- **`reconcileSpotGridBot`** (por bot, bajo lease; revalida gate al entrar):
  - **(ALTO#1) Resuelve `submitting`:** por cada orden en `submitting`, confirma por CLOID
    (`getSpotOrderStatusByCloid`/`getOpenSpotOrders`): viva en HL → `open`; muerta sin fill tras grace →
    reintenta el envío (cloid determinista, idempotente) o `failed`; con fill → procesa el fill. Nunca queda
    fantasma.
  - Fills vía `fillCursor` + fallback por CLOID (Codex #2). Partial fills (Codex #7): acumula
    `filledQty`/`avgFillPx`. BUY (parcial/total) → SELL pareada por `filledQty`; SELL llenada →
    `closeCycleAndRepost`. **Sub-mínima (Codex #3-r2):** si `filledQty*sellPrice < MIN_SPOT_NOTIONAL` NO
    coloca SELL; acumula `pendingSellQty` hasta ≥ mínimo; "polvo" al detener no se vende.
- **Batching/backoff (Codex #5/#10):** una ronda de lecturas por **cuenta+red**, no por bot; backoff básico.
- **`reconcileAllSpotGrids`** (entry del cron): lista bots `running`, agrupa por `hlAccountId`, claima cada
  uno (lease), **revalida `assertSpotGridLiveAdmissible`**, reconcilia, libera. Pausa+`error` ante fallo
  crítico/sin balance/gate caído.
- **`stopSpotGridBot`** (Codex #8): `cancelSpotByCloid` de las órdenes propias (`open`/`submitting`/
  `partially_filled`) + marca `stopped` + auditoría. **(Codex MEDIO#5) Semántica pausa/stop con órdenes
  vivas/fills** (ver sección dedicada abajo).

## 4. Mutations/queries internas (`convex/spotGridBots.ts`, NON-node, lease/CAS)
Patrón de `triggerArms.ts` (claim/renew/release + fencing por token):
- `claimSpotGridReconcile`/`renewSpotGridReconcile`/`releaseSpotGridReconcile`.
- `recordSpotGridOrder` (lookup-before-insert `by_cloid`), `markSpotGridOrder` (open/partial/filled/
  cancelled + filledQty/avgFillPx/pendingSellQty), `setSpotGridStatus` (paused/error/stopped + errorMessage),
  `setFillCursor`.
- **`closeCycleAndRepost` (Codex #4-r2 + ALTO#3, transaccional e idempotente por orden):** en UNA mutation:
  (a) **guard de idempotencia**: lee la SELL; si `cycleSettled === true` (o su status ya terminal-consumido)
  → **no-op** (un segundo procesado del mismo fill no cierra dos ciclos ni crea dos BUYs); (b) marca la SELL
  `cycleSettled=true`; (c) incrementa `cycleId` atómico; (d) inserta `spot_grid_cycles` (…+`netProfit`+
  closedAt); (e) crea la BUY de reposición con el nuevo `cycleId` (lookup-before-insert `by_cloid` y
  `by_bot_cycle`). El marcado de la SELL como consumida es la defensa primaria; `by_bot_cycle` es secundaria.
- Internal queries: `listRunningSpotGridBotsInternal`, `getSpotGridOrdersInternal(botId)`,
  `getSpotGridCredentialInternal(botId)` (credencial cifrada, solo para descifrar en la action).
- `generation`: 1 en create; +1 solo en re-arranque tras stop.

## 5. Cron + health
- `cronHealth.ts`: `reconcileSpotGridWithHealth` → `withCronHealth(ctx,"reconcile spot grid",()=>runAction(
  internal.spotGridEngine.reconcileAllSpotGrids,{}))`.
- `crons.ts`: `crons.interval("reconcile spot grid",{minutes:1},internal.cronHealth.reconcileSpotGridWithHealth)`.
- `elog("spotgrid", evento, {escalares})` por transición.

## 6. Semántica de pausa/stop con órdenes vivas o fills (Codex MEDIO#5)
Contrato explícito (y cubierto por tests):
- **`paused`:** el motor DEJA de colocar órdenes NUEVAS (no repone, no coloca SELL nuevas), pero **no toca
  HL**: las BUY/SELL `open` siguen vivas. Un **fill detectado mientras `paused`** SÍ se registra
  (`filledQty`/cierre de ciclo si era una SELL), porque ya ocurrió en HL — pero NO se repone la BUY (la
  reposición es "colocar nuevo" → bloqueada por la pausa). Un `submitting` colgado se resuelve igual
  (confirmar/failed), sin reenviar si la pausa lo impide.
- **`stopped`:** cancela TODAS las órdenes propias vivas (`open`/`submitting`/`partially_filled`) por
  `cancelSpotByCloid`, marca `stopped`. Un fill ya ocurrido antes del cancel se registra; el remanente base
  ("polvo" o posición comprada sin SELL) NO se liquida a mercado (solo LIMIT) → queda como balance del
  usuario y se reporta. Solo toca cloids propios.
- **BUY parcial / SELL pendiente al pausar/detener:** la cantidad ya llenada se conserva en `filledQty`/
  `pendingSellQty`; al detener no se fuerza ninguna orden inválida ni de mercado.

## Reuso (NO duplicar)
`decryptPrivateKey`, `makeSpotClients`/`placeSpotLimit`/`cancelSpotByCloid`/`roundSpotPrice`/`floorSpotSize`/
`roundAndValidateSpotOrder`/`assertMinNotional`/`getSpotBalance`/`getUserFees`/`MIN_SPOT_NOTIONAL_USD`,
`toHlCloid`/`spotGridCloidInput`, patrón lease/CAS de `triggerArms.ts`, `withCronHealth`, `elog`/`safeError`,
guards de `helpers.ts`. NO toca `leverage.ts` ni el motor perp.

## Invariantes de seguridad
No withdrawals · solo LIMIT · API wallet trade-only · clave nunca en logs/UI · cloid único (lookup-before-
insert `by_cloid`) · idempotencia en place y reconcile · verificar balance antes de crear · respetar tick/
lot/min-notional (sin SELL sub-mínima) · al reiniciar leer openOrders antes de crear · ante error de API
pausar+registrar · el bot solo toca cloids propios · **mainnet bloqueado salvo `mainnetSpotGridApproved`** ·
**gate live (tradingEnabled/!simulationMode/canTradeLive/mainnet) revalidado en CADA reconcile y antes de
cada envío** · **nunca `open` sin confirmación de HL** (estado `submitting`) · **cierre de ciclo idempotente
por SELL consumida**.

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
- Tests de código: `calculateGridLevels` (neto post-rounding ≥ objetivo; **loop acotado**; nivel
  `grid_level_uneconomic` cuando fees/tick/min-notional impiden cubrir), CLOID 0x+32hex, partial fills +
  `pendingSellQty`. **convex-test (mutations) money-path:** idempotencia de `recordSpotGridOrder`
  (lookup-before-insert no duplica), **resolución de `submitting`** (no queda fantasma; submitting→open/
  failed/retry), **`closeCycleAndRepost` doble-fill de la MISMA SELL → un solo ciclo + una sola BUY**
  (cycleSettled), y **pausa/stop con BUY parcial / SELL pendiente / fill recién detectado** (no repone en
  paused; stop cancela solo lo propio; sin órdenes a mercado).
- **Validación E2E REAL en Hyperliquid (sin simulación):** grid pequeño real → BUYs reales → fill real →
  SELL pareada real → ciclo con `netProfit` real → `stop` cancela solo lo propio. Mainnet gateado.
- `grep` de secretos en `elog`. Flujo: GO Codex (plan) → implementar → GO Codex (código) → PR → CodeRabbit →
  merge → deploy → validación real.
