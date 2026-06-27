# Auditoria Codex - JAV-120 Fase 1 writer `snapshotPoolFees`

## Alcance auditado

- Rama: `elcorreodejaviera/jav-120-fees-24h-real`
- Commit auditado: `3f2eb6a0019f4cac7196101bfe470bbe4a0a0020`
- Prompt: `docs/audit-prompt-jav120-f1-codigo.md`
- Plan: `docs/plan-fees24h-real.md`
- Archivos del commit:
  - `convex/actions/poolScanner.ts`
  - `convex/pools.ts`

Fase auditada: F1 writer + mutation. Aun sin cron ni UI.

## Bloqueante

No hay hallazgos bloqueantes de money-path. No se detecta ejecucion de ordenes, margen, firmas ni cambios de cobertura.

## Alto

### 1. `safeHeadBlock` no corresponde al bloque usado para leer `tokensOwed` y `snapshotKey`

Evidencia:

- `rpcCall` usa siempre `eth_call` con block tag `"latest"` (`convex/actions/poolScanner.ts:80-90`).
- `snapshotOnePoolFees` primero lee `fetchUncollectedFeesRaw` y `readPositionSnapshotKey`, ambos via `rpcCallWithFallback`/`rpcCall` en `"latest"` (`convex/actions/poolScanner.ts:1333-1336`).
- Despues calcula `safeHead = latest - CONFIRMATIONS` y lo guarda como `safeHeadBlock` (`convex/actions/poolScanner.ts:1337-1354`).
- El schema documenta `safeHeadBlock` como "bloque finalizado al insertar -> rango exacto de getLogs" (`convex/schema.ts:127-142`).
- El plan v3 exige que `safeHeadBlock` habilite un rango exacto para F4 sin timestamp->block (`docs/plan-fees24h-real.md:121-123`, `:219-222`).

Impacto:

El snapshot queda temporalmente inconsistente: los raw/key pueden incluir cambios de bloques posteriores a `safeHeadBlock`, pero F4 usaria `safeHeadBlock` como frontera de eventos. Si hubo un collect/increase/decrease en la franja `(safeHeadBlock, latest]` durante el snapshot, esos cambios ya estan reflejados en `tokensOwed`/`snapshotKey`, pero el rango futuro de `getLogs` podria volver a incluirlos o no cubrirlos de forma coherente. Eso rompe la garantia de "rango exacto" que arreglo el GO condicionado del plan.

Correccion requerida:

- Opcion preferida: permitir `eth_call` con block tag y leer `fetchUncollectedFeesRaw` + `readPositionSnapshotKey` en el mismo `safeHeadBlock` que se guarda.
- Alternativa: guardar explicitamente el bloque real de lectura (`readBlock`) y definir F3/F4 alrededor de ese bloque, con una politica clara de finalizacion/reorg. No basta con guardar `safeHeadBlock` si los valores fueron leidos en `"latest"`.
- En ambos casos, el campo usado por F4 debe representar el bloque exacto de los valores raw/key del snapshot.

## Medio

No hay hallazgos medios adicionales. La decision de incluir pools cerrados es aceptable para esta fase: si el NFT esta quemado/no accesible no se inserta, y si la posicion existe con liquidez cero puede seguir teniendo estado de fees pendiente para historia.

## Bajo

### 1. La verificacion runtime diferida es aceptable, pero debe quedar como condicion de F2/F3

Evidencia:

- El prompt indica que probar `snapshotPoolFees` en vivo requiere deploy al unico deployment, por lo que se difiere.
- `npm run typecheck` pasa localmente.

Impacto:

Bajo. Para F1 inerte es razonable no desplegar solo para probar runtime, siempre que F2/F3 incluyan ejecucion real controlada y lectura de filas antes de activar cron/UI.

## Checks realizados

- `git status --short --branch`
- `git show --stat --oneline --decorate 3f2eb6a`
- `git show --name-only --format=fuller 3f2eb6a`
- `git diff 3f2eb6a^ 3f2eb6a -- convex/pools.ts convex/actions/poolScanner.ts convex/schema.ts docs/plan-fees24h-real.md`
- `rg -n "pool_fee_snapshots|insertPoolFeeSnapshot|snapshotPoolFees|snapshotOnePoolFees|FEE_SNAPSHOT_RETENTION|safeHeadBlock|aggregatesComplete" convex docs tests -g '!convex/_generated/**'`
- Revision directa de:
  - `rpcCall`
  - `fetchUncollectedFeesRaw`
  - `readPositionSnapshotKey`
  - `snapshotOnePoolFees`
  - `insertPoolFeeSnapshot`
  - schema `pool_fee_snapshots`
- `npm run typecheck`
  - OK: `tsc -p convex/tsconfig.json --noEmit`.

## Veredicto final

NO GO.

La F1 es inerte y no toca money-path, pero el writer no cumple la condicion tecnica que justificaba `safeHeadBlock`: los valores del snapshot se leen en `"latest"` y el bloque guardado es `latest - confirmations`. Corregir esa consistencia de bloque antes de pushear/mergear F1.
