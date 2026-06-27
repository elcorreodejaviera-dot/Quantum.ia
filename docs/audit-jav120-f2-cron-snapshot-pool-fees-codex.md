# Auditoria Codex - JAV-120 Fase 2 cron `snapshot pool fees`

Fecha: 2026-06-26
Rama: `elcorreodejaviera/jav-120-fees-24h-real`
Commit auditado: `ac122fa966cce1caad63fca37c81a7bd30976f6b`
Base declarada: F1 writer `snapshotPoolFees`, commit `302d581`, GO en `docs/audit-jav120-f1-snapshot-writer-r2-codex.md`
Plan: `docs/plan-fees24h-real.md`

## Alcance auditado

Auditoria de codigo de F2 solamente:

- `convex/cronHealth.ts`: nuevo wrapper `snapshotPoolFeesWithHealth`.
- `convex/crons.ts`: nuevo cron horario `"snapshot pool fees"`.
- Revision de soporte para validar destino y efectos: `convex/actions/poolScanner.ts`, `convex/pools.ts`, `convex/schema.ts`, `src/components/AdminView.jsx`.

No se audito F3/F4/F5 ni se ejecuto el cron contra Convex/Railway. El runtime de acumulacion real queda diferido hasta deploy o corrida controlada.

## Resumen

Veredicto: **GO**.

El cableado de F2 es correcto: el nombre `"snapshot pool fees"` es unico en `crons.ts`, coincide con el nombre usado por `withCronHealth`, y apunta a `internal.cronHealth.snapshotPoolFeesWithHealth`, que invoca `internal.actions.poolScanner.snapshotPoolFees`.

El cron esta separado del de lifetime, lo que evita depender del camino Alchemy/no_key. El writer invocado es read-only on-chain por `eth_call` y solo escribe la serie append-only `pool_fee_snapshots`; no toca ejecucion, margen, ordenes ni bots.

## Hallazgos bloqueantes

Ninguno.

## Hallazgos altos

Ninguno.

## Hallazgos medios

Ninguno.

## Hallazgos bajos

### 1. Validacion runtime diferida

Evidencia:

- El cron nuevo empieza a correr solo tras deploy del codigo (`convex/crons.ts:80-84`).
- `snapshotPoolFees` depende de RPC publicos por pool y puede devolver `unavailable` si no logra leer latest/safeHead/owed/snapshotKey (`convex/actions/poolScanner.ts:1337-1347`).
- F1 ya habia dejado como condicion operativa ejecutar una corrida controlada y confirmar filas reales (`docs/audit-jav120-f1-snapshot-writer-r2-codex.md:148-154`).

Impacto:

Bajo. No afecta money-path y la salud del cron dara visibilidad. Es aceptable diferir runtime para esta F2, pero antes de que F3/F5 dependan de los datos conviene hacer una corrida controlada post-deploy, leer `pool_fee_snapshots`, y confirmar que se acumulan al menos 24 snapshots/historia suficiente.

## Verificaciones solicitadas

### 1. Cableado correcto

Correcto.

- `crons.ts` registra exactamente un cron llamado `"snapshot pool fees"` y lo agenda cada 1h (`convex/crons.ts:80-84`).
- `cronHealth.ts` usa el mismo nombre en `withCronHealth(ctx, "snapshot pool fees", ...)` (`convex/cronHealth.ts:156-160`).
- El wrapper llama a `internal.actions.poolScanner.snapshotPoolFees` (`convex/cronHealth.ts:158-159`).
- La action destino existe como `internalAction` (`convex/actions/poolScanner.ts:1365-1381`).
- `npm run typecheck` paso con `tsc -p convex/tsconfig.json --noEmit`.

### 2. Best-effort y aislamiento

Correcto con una precision: `withCronHealth` no traga errores del cuerpo del cron; registra health best-effort y relanza el error real (`convex/cronHealth.ts:71-81`). Eso es el patron existente del modulo. El aislamiento frente a otros crons viene de que `"snapshot pool fees"` es un cron separado (`convex/crons.ts:72-84`) y de que el writer usa `Promise.allSettled` por lote, contando fallos por pool sin abortar todo el lote (`convex/actions/poolScanner.ts:1371-1379`).

Separarlo del cron `"refresh pool lifetimes"` es correcto: si el camino lifetime esta `no_key` o inerte por Alchemy, eso no bloquea snapshots; y si snapshots falla, no contamina el health ni la ejecucion del lifetime.

### 3. Cadencia y solapamiento

Correcto para la ventana de 24h.

- La cadencia `{ hours: 1 }` produce aproximadamente 24 puntos para una ventana de 24h (`convex/crons.ts:80-84`).
- Si una corrida tarda mas de 1h y se solapa con la siguiente, el efecto funcional esperado es insertar filas adicionales en una tabla append-only, no sobrescribir estado critico (`convex/pools.ts:370-399`).
- La tabla tiene retencion por pool y `by_pool_at`, sin constraint de unicidad por hora/bloque (`convex/schema.ts:119-143`).

El solapamiento podria aumentar costo RPC y densidad de snapshots, pero no introduce riesgo de dinero ni perdida de datos.

### 4. Money-path

Correcto: no toca money-path.

- La lectura on-chain usa `eth_call`; `rpcCall` construye `eth_call` y no envia transacciones (`convex/actions/poolScanner.ts:80-92`).
- `fetchUncollectedFeesRaw` simula `collect()` con `from=owner` y block tag; no firma ni transmite una tx (`convex/actions/poolScanner.ts:691-705`).
- La unica escritura persistente nueva de F1 es `insertPoolFeeSnapshot`, que inserta en `pool_fee_snapshots` y poda filas viejas de esa misma tabla (`convex/pools.ts:376-399`).
- F2 solo agenda esa action: no modifica ejecuciones, margen, ordenes, credenciales, bots ni arms.

### 5. Costo agregado

Aceptable.

- `snapshotPoolFees` filtra pools con `tokenId`, RPC y NFT manager, y procesa en lotes de `POOL_SCAN_CONCURRENCY = 5` (`convex/actions/poolScanner.ts:1092`, `convex/actions/poolScanner.ts:1368-1373`).
- Por pool exitoso hace latest/safeHead, `ownerOf`, `collect()` simulado y `positions()`/snapshotKey, con fallback solo ante fallo de proveedor (`convex/actions/poolScanner.ts:1337-1347`, `convex/actions/poolScanner.ts:114-125`).
- El cron lifetime retorna `no_key` antes de hacer RPC si falta Alchemy (`convex/actions/poolScanner.ts:1213-1219`), asi que el costo nuevo real es el del cron de snapshots.

No veo condicion NO-GO por costo en F2. Monitorear duracion y `consecutiveFailures` en las primeras corridas es suficiente.

### 6. Registro de health

Correcto.

- `recordCronStart`, `recordCronSuccess` y `recordCronError` hacen upsert por `name`, asi que no requiere registro previo (`convex/cronHealth.ts:28-57`).
- `listCronHealth` devuelve todas las filas de `cron_health` para admin (`convex/cronHealth.ts:171-176`).
- El panel ordena y renderiza dinamicamente `rows`; no mantiene una lista estatica de crons esperados (`src/components/AdminView.jsx:71-99`, `src/components/AdminView.jsx:424`, `src/components/AdminView.jsx:566-579`).
- La busqueda no encontro otro listado cerrado de nombres de cron que haya que actualizar. `tests/convexHarness.ts` tiene una allowlist de modulos mutation-safe, no una lista de crons, y excluye explicitamente crons/actions (`tests/convexHarness.ts:4-10`).

## Pruebas y comandos revisados

- `git status --short --branch`
- `git rev-parse --show-toplevel && git rev-parse HEAD && git branch --show-current`
- `git show --stat --oneline --decorate --no-renames ac122fa`
- `git show --no-renames --format=fuller --find-renames=0 ac122fa -- convex/cronHealth.ts convex/crons.ts`
- `git diff --name-status ac122fa^ ac122fa`
- `git diff --no-ext-diff --unified=80 ac122fa^ ac122fa -- convex/cronHealth.ts convex/crons.ts`
- `git diff --check ac122fa^ ac122fa` -> OK
- `rg -n "snapshot pool fees|refresh pool lifetimes|refreshPoolLifetimes|snapshotPoolFees|listCronHealth|cron health|cronHealth" convex docs -S`
- `rg -n "expected|EXPECTED|cron.*name|cronNames|CronHealthPanel|SALUD DE LOS CRONS|cronHealth" src convex tests -S -g '!node_modules/**' -g '!convex/_generated/**'`
- `rg -n "snapshotPoolFeesWithHealth|snapshotPoolFees =|insertPoolFeeSnapshot|pool_fee_snapshots|POOL_SCAN_CONCURRENCY =" convex -S -g '!convex/_generated/**'`
- `npm run typecheck` -> OK (`tsc -p convex/tsconfig.json --noEmit`)

## Limitaciones

No ejecute el cron ni `snapshotPoolFees` contra Convex prod/Railway. Dado que esta fase no toca money-path y solo activa un writer read-only on-chain + append-only en Convex, el runtime diferido es aceptable. La primera validacion operativa debe confirmar filas reales y acumulacion durante al menos 24h antes de usar el dato en UI/decision.

## Veredicto final

**GO**.

F2 puede avanzar. Recomendacion operativa post-merge: forzar o esperar una primera corrida, verificar `cron_health.name = "snapshot pool fees"` y leer filas recientes de `pool_fee_snapshots`; tras 24h, confirmar que existe referencia valida para F3.
