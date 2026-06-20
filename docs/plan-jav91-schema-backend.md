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

## 3. `convex/spotGridBots.ts`
- **`createSpotGridBot`** — guard live completo (Codex #3): `requireTradeLive` +
  `systemConfig.tradingEnabled` ON + `!simulationMode` global + red esperada (`assertExpectedNetwork`) +
  flag de confirmación LIVE explícita. **Gate mainnet (Codex #2-r3/#1-r4):** lee `by_key`
  `"mainnetSpotGridApproved"` y rechaza `network==="mainnet"` si `value?.enabled !== true`. Valida
  allowlist (resolver de PR1 por red), inputs > 0, balance. Scoping por `userId`.
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
- `createSpotGridBot`: guard live rechaza si trading off / simulationMode / red incorrecta / sin confirm.
- Gate mainnet: rechaza mainnet sin `mainnetSpotGridApproved.enabled=true`; acepta tras aprobación.
- **Exclusividad de cuenta:** rechaza `hlAccountId` ya usada por un `bots` o por otro `spot_grid_bots`.
- Validación de inputs (>0), allowlist por red (reusa resolver PR1), balance insuficiente.
- `setMainnetSpotGridApproval`: solo admin; escribe admin_log.
- Dedupe `by_cloid` lookup-before-insert (si aplica en alguna mutation de PR2).
- Ownership por `userId` en list/get/pause.

## DoD
`npm run typecheck` OK · guard live + gate mainnet + exclusividad de cuenta · ownership por userId · **sin
enviar órdenes** · tests verdes · `convex deploy` (tablas nuevas) + verificar `HL_NETWORK=mainnet`.
Flujo: plan → GO Codex → implementar → GO Codex código → PR → CodeRabbit → merge → deploy.
