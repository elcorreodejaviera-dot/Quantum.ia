# Auditoria Codex - plan "Fees 24h real" v2

## Alcance auditado

- Plan: `docs/plan-fees24h-real.md`
- Prompt: `docs/audit-prompt-fees24h-real-plan.md`
- Auditoria previa contrastada: `docs/audit-fees24h-real-plan-codex.md`
- Codigo revisado:
  - `convex/actions/poolScanner.ts`
  - `convex/pools.ts`
  - `convex/schema.ts`
  - `src/components/BotPortal.jsx`

## Bloqueante

No hay hallazgos bloqueantes.

## Alto

No hay hallazgos altos. Los dos altos de la auditoria previa quedaron cerrados en el plan v2:

- El acumulador ahora es neto: `feesCollectedRaw + max(tokensOwedRaw - principalDebtRaw, 0)`.
- Un cambio de `snapshotKey` ya no puede marcar `ok` sin eventos completos; `getLogs` estrecho pasa a ser obligatorio para certificar `ok` cuando hubo cambios.

## Medio

### 1. Falta guardar el bloque de referencia del snapshot para poder hacer `getLogs` exacto

Evidencia:

- La tabla propuesta en `docs/plan-fees24h-real.md:94-104` guarda `at`, raw amounts, `snapshotKey` y `aggregatesComplete`, pero no guarda `blockNumber` / `safeHeadBlock`.
- La F4 exige `getLogs` estrecho para certificar `ok` cuando `snapshotKey` cambio (`docs/plan-fees24h-real.md:202-203`).
- El codigo existente de `getLogs` trabaja con rangos de bloques (`convex/actions/poolScanner.ts:141-162`, `:1258-1299`).

Impacto:

Con solo `at` no hay un rango exacto `[refBlock, safeHead]` para leer eventos de la ventana. Reintroducir timestamp->block seria un supuesto nuevo, y ya hubo auditorias previas donde esa ruta fue fragil. Sin bloque guardado, la F4 queda incompleta.

Correccion requerida:

- Agregar al snapshot `blockNumber` o `safeHeadBlock` leido al momento de insertar la fila.
- Para F4 usar `[ref.safeHeadBlock + 1 - confirmationsMargin, currentSafeHead]` o una regla equivalente anti-reorg.
- Exponer si el rango cubierto no coincide con la ventana real.

### 2. `feeShareStatus out_of_range/inconsistent` no debe invalidar el valor real por snapshots

Evidencia:

- El plan define `unavailable` como `feeShareStatus out_of_range/inconsistent u otro` en `docs/plan-fees24h-real.md:142-143`.
- El valor real por snapshots se deriva de `tokensOwed`/eventos; no depende de que la posicion este actualmente in-range.
- El `feeShareStatus` actual se usa para APR concentrado/fallback (`src/components/BotPortal.jsx:441-452`), no para el stock real de fees.

Impacto:

Una posicion que hoy esta fuera de rango puede haber generado fees dentro de las ultimas 24h antes de salir. Si el plan marca `unavailable` por `out_of_range`, oculta un dato real que el delta de snapshots si puede medir.

Correccion requerida:

- Usar `feeShareStatus` solo para el fallback estimado concentrado.
- Para `fees24hUsd` real, depender de snapshots/eventos/refAge/agregados, no de in-range actual.

## Bajo

### 1. La descripcion de `snapshotKey` debe alinearse con el helper real

Evidencia:

- El plan sugiere `snapshotKey = lifetimeSnapshotKey/posicion (liquidity+cursor+collectedHash)` en `docs/plan-fees24h-real.md:102-110`.
- El helper real `readPositionSnapshotKey` usa `liquidity | feeGrowthInside0/1Last | tokensOwed0/1` de `positions()` (`convex/actions/poolScanner.ts:464-480`).

Correccion sugerida:

- Especificar que se debe reutilizar exactamente `readPositionSnapshotKey` o factorizarlo, y definir que si devuelve `null` el snapshot queda `unavailable` y no se inserta como certificable.

### 2. El prompt de auditoria quedo desactualizado frente al plan v2

Evidencia:

- `docs/audit-prompt-fees24h-real-plan.md` todavia pregunta por el clamp negativo, `getLogs` opcional y `+1 eth_call/pool/hora`.
- El plan v2 ya corrigio esos puntos.

Correccion sugerida:

- Actualizar el prompt para que audite la version v2 y no vuelva a pedir revisar supuestos ya corregidos.

## Checks realizados

- `git status --short --branch`
- Lectura completa de `docs/plan-fees24h-real.md`
- Lectura de `docs/audit-prompt-fees24h-real-plan.md`
- Comparacion contra `docs/audit-fees24h-real-plan-codex.md`
- Revision de:
  - `readPositionSnapshotKey`
  - `fetchUncollectedFeesRaw`
  - `fetchPositionLiquidity`
  - `refreshOnePoolLifetime`
  - `computeLifetimeAggregates`
  - permisos owner/admin existentes en `pools.ts`
  - calculo actual de `feeShareStatus` y APR concentrado en `BotPortal.jsx`

No ejecute build/tests porque sigue siendo auditoria de plan, sin implementacion de codigo.

## Veredicto final

GO condicionado.

Puede avanzar a implementacion si antes se corrigen dos condiciones en el plan: guardar el bloque del snapshot para F4 y no usar `feeShareStatus` para invalidar la metrica real por snapshots. Sin esas correcciones, la implementacion podria quedar incompleta o esconder valores reales en posiciones fuera de rango.
