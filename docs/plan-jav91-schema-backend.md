# Plan JAV-91 — QSG PR2: Schema + funciones backend Spot Grid

Sub-2 de la épica JAV-89 (Quantum Spot Grid Live). Persistencia y comandos backend. **Live-only** (sin
`simulationMode`). **NO envía órdenes** (el motor y `stop` van en PR3/JAV-92). Reusa el connector de
JAV-90 (`convex/hyperliquidSpot.ts`, ya mergeado) y el helper CLOID (`convex/cloids.ts`).

## 1. `convex/schema.ts` — tablas nuevas
- **`spot_grid_bots`**: `userId`, `hlAccountId`, `symbol`, `assetId`, `baseAsset`, `quoteAsset`,
  `minPrice`, `gridProfitPercent`, `investmentAmount`, `orderSize`, `gridCount`, `feeRate`,
  `currentPrice`, `status` (`running|paused|stopped|error`), `network`, `generation` (entero, 1×/arranque),
  `fillCursor` (Codex #2), `createdAt`/`updatedAt`/`lastReconciledAt`, `errorMessage`.
  Índices: `by_user`, `by_status_updated`, `by_account`.
- **`spot_grid_orders`**: `botId`, `userId`, `cloid`, `oid`, `assetId`, `side` (`buy|sell`), `price`,
  `quantity`, `quoteSize`, `gridLevel`, `generation`+`cycleId` (Codex #1), `status`
  (`open|partially_filled|filled|cancelled|failed`), `filledQty`/`remainingQty`/`avgFillPx` +
  `pendingSellQty` (Codex #7/#3-r2), `pairedOrderId`, `attempt`, `createdAt`/`filledAt`/`cancelledAt`,
  `errorMessage`. Índices: `by_bot_status`, `by_cloid`. **(Codex #7-r2)** Convex no impone unicidad →
  dedupe con **lookup-before-insert** `by_cloid` en la misma mutation.
- **`spot_grid_cycles`**: `botId`, `userId`, `cycleId` (monótono por bot), `buyOrderId`, `sellOrderId`,
  `buyPrice`, `sellPrice`, `quantity`, `grossProfit`, `fees`, `netProfit`, `closedAt`.
  Índices: `by_bot`, `by_bot_cycle`.
- **(Codex #2-r3 + #1-r4) Gate mainnet sobre el esquema real de `system_config`** (`{ key, value:any }`,
  índice `by_key` — NO se cambia su forma): fila `key="mainnetSpotGridApproved"`,
  `value={ enabled: boolean, approvedAt: number, approvedBy: string }`.

## 2. Formato CLOID (canónico, reusa PR1)
CLOID enviado a HL = `0x` + 32 hex (16 bytes) vía `toHlCloid` (`convex/cloids.ts`). Input =
`botId|generation|cycleId|level|side` (`spotGridCloidInput`). NO SHA-256 completo.

## 3. Backend — flujo de creación DIVIDIDO en 2 archivos (CodeRabbit #95)
La creación NO vive en un solo archivo: la **action** (RPC HL) está aislada en `convex/spotGridActions.ts`
("use node") y los **guards/persistencia** en `convex/spotGridBots.ts` (NON-node, convex-testable).
- **`createSpotGridBot`** (action, `spotGridActions.ts`) — `requireAuth` + `assertExpectedNetwork` +
  confirm LIVE → corre el **preflight** ANTES de cualquier RPC → lecturas PÚBLICAS de HL (resolver activo
  por red, precio, balance; SIN clave) → delega en `persistSpotGridBot`.
- **`preflightCreateSpotGridBot`** (internalQuery) y **`persistSpotGridBot`** (internalMutation) en
  `spotGridBots.ts` comparten `assertCreateGuards`: **`requireBotManager` (canManageBots) +
  `requireTradeLive` (canTradeLive)** — crear/activar infraestructura de bots es permiso de GESTIÓN;
  `canTradeLive` autoriza operar real pero NO crear bots por sí solo, así que se exigen AMBOS (Codex
  ALTO). + `tradingEnabled` ON + `!simulationMode` global + red (`assertExpectedNetwork` en la action).
  **Gate mainnet:** `by_key` `"mainnetSpotGridApproved"`, rechaza `mainnet` si `value?.enabled !== true`.
  Inputs (`validateGridInputs`: >0, gridCount entero≥1, `orderSize≥$10`, `orderSize×gridCount≤investment`);
  balance≥investment en persist. Scoping por `userId`.
  - **🔑 INVARIANTE CUENTA HL EXCLUSIVA (decisión usuario 2026-06-20, JAV-89/JAV-91):** rechazar una
    `hlAccountId` cuya `tradingAccountAddress` ya use **cualquier bot IL/Trading (`bots`)** o **otro
    `spot_grid_bots`**. En HL spot y perp viven en la MISMA wallet → compartir cuenta mezclaría órdenes/
    balance spot con margen/posiciones perp. Exclusividad TOTAL de cuenta (no solo "1 por par").
- **`setMainnetSpotGridApproval`** — `requireAdmin` + `writeAdminLog`; sella `enabled`/`approvedAt`/
  `approvedBy`.
- **`pauseSpotGridBot`** (NO toca HL), **`listSpotGridBots`**, **`getSpotGridBot`**. Internal queries
  para el motor (PR3).
- **(Codex #8) `stopSpotGridBot` → PR3** (money-path, fuera de alcance aquí).

## 4. Lo que NO se hace aquí
NO envía/cancela órdenes en HL (PR3). NO motor ni cron (PR3). NO UI (PR4). NO toca el motor perp ni
`leverage.ts`.

## Tests (convex-test + pure)
- El harness convex-test congela **`preflightCreateSpotGridBot` / `persistSpotGridBot`** (NON-node); la
  action Node (`spotGridActions.ts`) queda FUERA del harness (su lógica es delgada: preflight→RPC→persist).
- preflight/persist: rechazan si SIN `canManageBots` o SIN `canTradeLive` (ambos requeridos) /
  trading off / simulationMode / red incorrecta / sin confirm.
- Gate mainnet: rechaza mainnet sin `mainnetSpotGridApproved.enabled=true`; acepta tras aprobación.
- **Exclusividad de cuenta:** rechaza `hlAccountId` ya usada por un `bots` o por otro `spot_grid_bots`.
- Validación de inputs (>0), allowlist por red (reusa resolver PR1), balance insuficiente.
- `setMainnetSpotGridApproval`: solo admin; escribe admin_log.
- Dedupe `by_cloid` lookup-before-insert (si aplica en alguna mutation de PR2).
- Ownership por `userId` en list/get/pause.

## DoD
`npm run typecheck` OK · guard `canManageBots` + `canTradeLive` + gate mainnet + exclusividad de cuenta · ownership por userId · **sin
enviar órdenes** · tests verdes · `convex deploy` (tablas nuevas) + verificar `HL_NETWORK=mainnet`.
Flujo: plan → GO Codex → implementar → GO Codex código → PR → CodeRabbit → merge → deploy.
