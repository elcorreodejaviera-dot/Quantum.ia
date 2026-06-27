# Auditoria Codex - JAV-120 Fase 0 schema `pool_fee_snapshots`

Fecha: 2026-06-26
Commit auditado: `649bdc6` (`elcorreodejaviera/jav-120-fees-24h-real`)
Alcance: codigo de Fase 0 para schema Convex. Se reviso `convex/schema.ts` y se contrasto con `docs/plan-fees24h-real.md` v3. No se audito implementacion de writer, cron, lectura backend ni UI porque no existen en esta fase.

## Resumen

Veredicto: **GO**.

La Fase 0 es aditiva e inerte: agrega solo la tabla `pool_fee_snapshots` con indice `by_pool_at` y no introduce funciones, cron, mutations ni money-path. Los tipos y campos son coherentes con `pool_fee_events`, `readPositionSnapshotKey` y el plan v3.

## Hallazgos bloqueantes

Ninguno.

## Hallazgos altos

Ninguno.

## Hallazgos medios

Ninguno.

## Hallazgos bajos

Ninguno.

## Evidencia revisada

- Cambio de codigo: el diff de `649bdc6^..649bdc6` modifica codigo solo en `convex/schema.ts`, agregando `pool_fee_snapshots` en `convex/schema.ts:119-143`.
- La tabla existente `pool_fee_events` queda intacta y mantiene raw amounts como `string` y bloques como `number` en `convex/schema.ts:106-117`.
- Los campos nuevos son suficientes para el neteo al leer:
  - `tokensOwed0Raw` / `tokensOwed1Raw`
  - `collected0Raw` / `collected1Raw`
  - `principalDebt0Raw` / `principalDebt1Raw`
  - formula del plan: `feesCollectedRaw + max(tokensOwedRaw - principalDebtRaw, 0)` en `docs/plan-fees24h-real.md:73-79`.
- `snapshotKey: v.string()` esta alineado con el helper real `readPositionSnapshotKey`, que compone `liquidity|feeGrowthInside0|feeGrowthInside1|tokensOwed0|tokensOwed1` en `convex/actions/poolScanner.ts:464-480`.
- `safeHeadBlock: v.number()` resuelve la condicion previa de F4: rango exacto de `getLogs` sin timestamp->block, segun `docs/plan-fees24h-real.md:121-123` y `docs/plan-fees24h-real.md:219-222`.
- `aggregatesComplete: v.boolean()` participa del gate de `status=ok` junto con `snapshotKey`, segun `docs/plan-fees24h-real.md:81-95` y `docs/plan-fees24h-real.md:150-152`. **Nota (post-F4 r2):** por si solo NO basta; el contrato se refino con `aggregatesSafeThroughBlock` (anadido en `bda6470`) y F4 certifica `ok` solo si `aggregatesSafeThroughBlock >= safeHeadBlock` (la deuda base esta probada a ese bloque exacto, recomputada desde `pool_fee_events`).
- Busqueda fuera de docs: `pool_fee_snapshots` aparece solo en `convex/schema.ts:131`. No hay query, mutation, internalAction, cron ni UI que lea o escriba esta tabla todavia.
- `convex/crons.ts:70-81` conserva solo los crons existentes de lifetime y poda de engine events; no hay cron nuevo para snapshots en Fase 0.
- El indice `by_pool_at ["poolId", "at"]` sirve para:
  - buscar el ref mas nuevo con `poolId == X` y `at <= now - 24h` usando rango sobre `at`;
  - podar por antiguedad por pool durante el writer.
  No falta indice para F1/F3. Si en una fase futura se elige poda global sin iterar por pool, podria agregarse un indice `by_at`, pero no es requisito de esta Fase 0 ni del camino recomendado inline.

## Pruebas y comandos revisados

- `git status --short --branch`
- `git show --stat --oneline --decorate --no-renames 649bdc6`
- `git diff --no-ext-diff --unified=80 649bdc6^ 649bdc6 -- convex/schema.ts`
- `git diff --name-status 649bdc6^ 649bdc6`
- `rg -n "pool_fee_snapshots" . --glob '!docs/**' --glob '!node_modules/**' --glob '!.git/**'`
- `nl -ba convex/schema.ts | sed -n '90,155p'`
- `nl -ba convex/actions/poolScanner.ts | sed -n '460,485p'`
- `nl -ba convex/crons.ts | sed -n '1,90p'`
- `nl -ba docs/plan-fees24h-real.md | sed -n '60,170p'`
- `nl -ba docs/plan-fees24h-real.md | sed -n '200,230p'`
- `npm run typecheck` -> OK (`tsc -p convex/tsconfig.json --noEmit`).

Limitacion de entorno: intente reproducir `npx convex codegen`, pero en este sandbox sin red falla antes de validar el schema:

- `npx convex codegen` -> `TypeError: fetch failed`, con DNS a `o1192621.ingest.sentry.io`.
- `CI=1 npx convex codegen --dry-run --typecheck disable` -> `TypeError: fetch failed`.

Esto no apunta a un error del cambio de schema; es una limitacion de ejecucion de la CLI de Convex en el entorno restringido. El prompt indica `npx convex codegen` verificado OK fuera de este sandbox.

## Veredicto final

**GO**.

Puede avanzar a F1. Condiciones a preservar en las siguientes fases: mantener la tabla inerte hasta que exista writer auditado, usar `by_pool_at` para lectura/poda por pool, no marcar `ok` sin `aggregatesComplete` y sin certificacion por `snapshotKey`/eventos cuando aplique, y usar `safeHeadBlock` para el rango exacto de `getLogs` en F4.
