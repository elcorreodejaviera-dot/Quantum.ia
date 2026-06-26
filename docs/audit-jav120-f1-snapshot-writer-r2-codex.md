# Auditoria Codex - JAV-120 Fase 1 writer `snapshotPoolFees` r2

Fecha: 2026-06-26
Rama: `elcorreodejaviera/jav-120-fees-24h-real`
Commit auditado: `302d581e0b33ca876856a1dd666f3fcbc228af8a`
Base de fase: F0 `1260726` y auditoria F0 GO en `docs/audit-jav120-f0-schema-pool-fee-snapshots-codex.md`
Plan: `docs/plan-fees24h-real.md`
Alcance: F1 solamente. Se auditaron `convex/actions/poolScanner.ts` y `convex/pools.ts`. No se audito cron, lectura backend F3, getLogs F4 ni UI porque no forman parte de este commit.

## Resumen

Veredicto: **GO**.

El NO-GO previo queda corregido. `snapshotOnePoolFees` fija primero `safeHead = latest - CONFIRMATIONS`, arma `blockTag`, y lee `tokensOwed` bruto y `snapshotKey` en ese mismo bloque antes de guardar `safeHeadBlock`. Los callers existentes conservan el comportamiento anterior porque el nuevo parametro `block` tiene default `"latest"`.

La fase sigue inerte: no hay cron ni UI que invoquen o lean estos snapshots. La unica escritura nueva es append-only en `pool_fee_snapshots`.

## Hallazgos bloqueantes

Ninguno.

## Hallazgos altos

Ninguno.

## Hallazgos medios

Ninguno.

## Hallazgos bajos

### 1. Runtime live diferido hasta deploy/cron

Evidencia:

- El prompt indica que ejecutar `snapshotPoolFees` en vivo requiere `npx convex deploy` al unico deployment productivo.
- F1 no engancha cron ni UI; `snapshotPoolFees` es `internalAction` y queda inerte salvo invocacion manual (`convex/actions/poolScanner.ts:1365-1381`).
- `npm run typecheck` pasa localmente.

Impacto:

Bajo. Para F1 es aceptable diferir la prueba runtime si F2/F3 ejecutan una corrida controlada, leen filas reales de `pool_fee_snapshots`, y confirman que los RPC publicos soportan `eth_call` contra `safeHead` reciente en las redes objetivo. Leer `latest - 12/20` deberia estar dentro del estado reciente de proveedores full-node no archivo, pero debe validarse al operar.

### 2. Comentario historico de `fetchUncollectedFeesRaw` sigue diciendo "AHORA/live"

Evidencia:

- `fetchUncollectedFeesRaw` ahora acepta `block = "latest"` por default (`convex/actions/poolScanner.ts:691-705`), pero su comentario conserva la redaccion de cobrable "AHORA/live" (`convex/actions/poolScanner.ts:687-690`).

Impacto:

Bajo, de claridad solamente. El codigo es correcto: los callers existentes no pasan `block` y siguen leyendo `"latest"`; F1 pasa `blockTag` explicitamente.

## Verificaciones del prompt

### 1. Neteo diferido correcto

Correcto. El writer guarda componentes brutos, no un fee armado:

- `tokensOwed0Raw` y `tokensOwed1Raw` salen de `collect()` simulado y se guardan como raw strings (`convex/actions/poolScanner.ts:1344-1360`).
- `collected0Raw`, `collected1Raw`, `principalDebt0Raw`, `principalDebt1Raw` se guardan separados (`convex/actions/poolScanner.ts:1349-1360`).
- La mutation solo inserta esos campos; no netea ni valua USD (`convex/pools.ts:370-399`).
- El schema documenta que el neteo se hara al leer con `feesCollectedRaw + max(tokensOwedRaw - principalDebtRaw, 0)` (`convex/schema.ts:119-130`).

F3 tendra los datos necesarios para calcular `collected + max(owed - debt, 0)` por token y luego valuar a USD.

### 2. No insertar lo no certificable

Correcto.

- Si no hay RPC/NFT/tokenId, retorna `unavailable` (`convex/actions/poolScanner.ts:1331-1333`).
- Si `getLatestBlock` falla o `safeHead <= 0`, retorna `unavailable` sin mutar (`convex/actions/poolScanner.ts:1337-1341`).
- Si `fetchUncollectedFeesRaw` falla/decodifica mal, retorna `null` y no inserta (`convex/actions/poolScanner.ts:1344-1345`; helper en `:691-714`).
- Si `readPositionSnapshotKey` devuelve `null`, no inserta (`convex/actions/poolScanner.ts:1346-1347`; helper en `:469-482`).

Un snapshot sin `snapshotKey` no entra en la tabla.

### 3. `aggregatesComplete`

Correcto para F1 y consistente con el plan.

- Ausentes se convierten a `""` (`convex/actions/poolScanner.ts:1349-1352`).
- `aggregatesComplete` solo es true si los cuatro strings son distintos de `""` (`convex/actions/poolScanner.ts:1353-1354`).
- `"0"` no se confunde con ausente: `"0" !== ""`, por lo que un agregado completo con valor cero queda presente.

Esto alcanza como gate estructural para F3 junto con la regla de `snapshotKey`/eventos. F3 no debe tratar `aggregatesComplete=false` como `ok`.

### 4. `safeHeadBlock`

Correcto.

- `rpcCall` acepta `block` con default `"latest"` y lo usa como segundo parametro de `eth_call` (`convex/actions/poolScanner.ts:80-92`).
- `rpcCallWithFallback` propaga ese `block` (`convex/actions/poolScanner.ts:114-118`).
- `fetchUncollectedFeesRaw` usa el mismo block tag en `ownerOf` y `collect()` simulado (`convex/actions/poolScanner.ts:691-705`).
- `readPositionSnapshotKey` usa el mismo block tag en `positions()` (`convex/actions/poolScanner.ts:469-472`).
- `snapshotOnePoolFees` calcula `latest`, `conf`, `safeHead`, `blockTag`, lee `owed` y `snapshotKey` en ese `blockTag`, y guarda `safeHeadBlock: safeHead` (`convex/actions/poolScanner.ts:1337-1360`).

La consistencia bloque-valores que fallo en la auditoria anterior queda resuelta. El patron de `safeHead = latest - confirmations` es coherente con `refreshOnePoolLifetime` (`convex/actions/poolScanner.ts:1223-1227`) y `backfillPoolLifetime` (`convex/actions/poolScanner.ts:1401-1405`).

### 5. Mutation y poda

Correcto.

- `at = Date.now()` se sella en la mutation (`convex/pools.ts:389-391`), no en la action.
- Ya hay uso de `Date.now()` en mutation en `applyPoolFeeEventsWindow` (`convex/pools.ts:337`), asi que el patron es localmente aceptado.
- La poda usa `by_pool_at` acotado por `poolId` y `at < cutoff` (`convex/pools.ts:392-398`; indice en `convex/schema.ts:131-143`).
- No hay update/upsert de snapshots: la serie es append-only salvo poda por antiguedad. Duplicados por invocacion manual repetida no borran datos recientes ni cambian money-path.

### 6. Money-path y efectos

Correcto.

- `fetchUncollectedFeesRaw` usa `eth_call`, no envia transacciones (`convex/actions/poolScanner.ts:80-92`, `:691-705`).
- `collect()` es simulado con `from=owner` y `MAX_U128`; no hay firma ni tx on-chain (`convex/actions/poolScanner.ts:699-705`).
- `readPositionSnapshotKey` tambien es `eth_call` a `positions()` (`convex/actions/poolScanner.ts:469-472`).
- La unica escritura nueva es `ctx.db.insert("pool_fee_snapshots", ...)` y poda de filas viejas de esa misma tabla (`convex/pools.ts:391-398`).
- No se tocaron rutas de ejecucion, margen, ordenes, cobertura ni bots.

### 7. Concurrencia y costo

Correcto para F1.

- Reusa `POOL_SCAN_CONCURRENCY = 5` (`convex/actions/poolScanner.ts:1090-1092`).
- `snapshotPoolFees` procesa por lotes y usa `Promise.allSettled`; rechazos cuentan como `errored` sin abortar el lote completo (`convex/actions/poolScanner.ts:1368-1379`).
- Costo esperado por pool/run: `eth_blockNumber` (`getLatestBlock`) + `ownerOf` + `collect()` simulado + `positions()`; con fallback solo ante fallo de proveedor.

### 8. Filtro de pools

Aceptable para F1.

- `targets = pools.filter(p.tokenId && RPC && NFT_MANAGER)` replica el patron de `refreshAllPoolLifetimes` y no filtra `closed` (`convex/actions/poolScanner.ts:1308-1309`, `:1368-1369`).
- Para pools cerrados o NFTs no legibles, los helpers devuelven `null`/`unavailable` y no se inserta snapshot.
- Si una posicion existe con liquidez cero pero mantiene fees/principal pendiente, snapshotearla puede ser util para historia. No hay impacto de money-path.

## Checks realizados

- `git status --short --branch`
- `git rev-parse HEAD`
- `git show --stat --oneline --decorate --no-renames 302d581`
- `git diff --name-status 1260726 302d581`
- `git diff --no-ext-diff --unified=80 1260726 302d581 -- convex/pools.ts convex/actions/poolScanner.ts convex/schema.ts`
- `git diff --no-ext-diff --unified=60 3f2eb6a 302d581 -- convex/actions/poolScanner.ts convex/pools.ts`
- `rg -n "pool_fee_snapshots|insertPoolFeeSnapshot|snapshotPoolFees|snapshotOnePoolFees|FEE_SNAPSHOT_RETENTION|safeHeadBlock|aggregatesComplete|rpcCall\\(|rpcCallWithFallback\\(|fetchUncollectedFeesRaw\\(|readPositionSnapshotKey\\(|getLatestBlock\\(" convex docs tests -g '!convex/_generated/**' -g '!node_modules/**'`
- Revision directa de `rpcCall`, `rpcCallWithFallback`, `fetchUncollectedFeesRaw`, `readPositionSnapshotKey`, `snapshotOnePoolFees`, `snapshotPoolFees`, `insertPoolFeeSnapshot`, schema `pool_fee_snapshots`, y callers existentes que dependen del default `"latest"`.
- `git diff --check 1260726 302d581` -> OK.
- `npm run typecheck` -> OK (`tsc -p convex/tsconfig.json --noEmit`).

## Limitaciones

No ejecute `snapshotPoolFees` contra Convex prod. El prompt indica que probarlo en vivo requiere deployar codigo aun sin GO al unico deployment. Para esta F1 inerte, diferir esa prueba es aceptable; debe hacerse despues del GO/merge o en un deployment dev separado antes de exponer cron/UI.

## Veredicto final

**GO**.

F1 puede avanzar. Condicion operativa para F2/F3: ejecutar una corrida controlada, confirmar filas reales en `pool_fee_snapshots`, y validar soporte de `eth_call` con block tag `safeHead` reciente en los RPC publicos de las redes usadas.
