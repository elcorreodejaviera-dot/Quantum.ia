# Auditoria Codex - JAV-120 Fase 3 `getPoolFees24h`

## Alcance auditado

- Rama: `elcorreodejaviera/jav-120-fees-24h-real`
- Commit auditado: `15b9bcb3742ee42d1987d4320b3a6b2a9e336e0c`
- Prompt: `docs/audit-prompt-jav120-f3-codigo.md`
- Plan: `docs/plan-fees24h-real.md`
- Archivos de codigo del commit:
  - `convex/actions/poolScanner.ts`
  - `convex/pools.ts`

Fase auditada: F3, action backend `getPoolFees24h` + internalQuery `getFees24hWindowInternal`.

## Bloqueante

No hay hallazgos bloqueantes de money-path. La action es read-only y no toca ordenes, margen, bots ni cobertura.

## Alto

### 1. La seleccion de snapshots puede devolver `ok` para una ventana menor a 24h, incluso 0h

Evidencia:

- `getFees24hWindowInternal` selecciona `nowSnap` como el snapshot mas reciente (`convex/pools.ts:415-418`).
- `refSnap` se selecciona con `at <= serverNow - 24h`, no con `at <= nowSnap.at - 24h` (`convex/pools.ts:419-422`).
- La action calcula `refAgeMs = nowSnap.at - refSnap.at` (`convex/actions/poolScanner.ts:1118`).
- Solo valida `refAgeMs > 26h` como `stale`; no valida `refAgeMs < 24h` (`convex/actions/poolScanner.ts:1118-1120`).

Impacto:

La metrica puede marcar `status: "ok"` aunque no mida 24h reales:

- Si existe un solo snapshot viejo, ese mismo documento puede ser `nowSnap` y `refSnap`; `refAgeMs = 0`, delta `0`, y la action puede devolver `ok`.
- Si el cron salteo la corrida mas reciente, `nowSnap` puede ser de hace ~1-2h y `refSnap` de `serverNow - 24h`, dando una ventana de 22-23h que tambien puede devolver `ok`.
- Si el cron se detuvo, puede devolver una ventana historica vieja como si fuera "Fees 24h" actual.

Esto rompe la promesa del plan: referencia aceptable solo si `refAge` esta en `[24h, 26h]` y el valor representa una ventana actual.

Correccion requerida:

- Seleccionar `refSnap` relativo a `nowSnap.at`, no a `serverNow`: `at <= nowSnap.at - FEE24H_WINDOW_MS`.
- Rechazar `refAgeMs < FEE24H_WINDOW_MS` como `warming_up` o `partial`, nunca `ok`.
- Asegurar que `nowSnap` este fresco respecto a `serverNow` (por ejemplo, max 2h o similar); si no, devolver `stale`.
- Asegurar que `nowSnap` y `refSnap` no sean el mismo snapshot.

## Medio

No hay hallazgos medios adicionales.

La autorizacion owner/admin esta correctamente centralizada en `getFees24hWindowInternal`: usa `requireUser`, carga el pool, y valida `pool.userId === user._id || user.role === "admin"` antes de leer snapshots (`convex/pools.ts:410-413`).

## Bajo

### 1. Runtime real queda diferido hasta tener 24h de snapshots

Evidencia:

- El prompt indica que la validacion runtime requiere el cron F2 desplegado y al menos 24h de historia.
- `npm run typecheck` pasa, pero no hay fixture local de snapshots para ejercitar los estados.

Impacto: bajo. Es aceptable para auditoria estatica, pero despues del fix del hallazgo alto conviene agregar al menos pruebas con snapshots sintenticos para: un solo snapshot, ventana <24h, ventana 24-26h, ventana >26h, key cambiada y delta negativo.

## Evidencia positiva

- `snapshotKey` no depende de `feeShareStatus`, consistente con el plan.
- Si `snapshotKey` cambia, la action devuelve `partial`, dejando el cierre a F4.
- Si el delta raw es negativo, devuelve `partial`.
- La valuacion usa `tokenInfo` + `valueFeesUsd`, el mismo helper usado por `fetchPositionLiquidity`.
- La action no escribe en DB ni ejecuta transacciones on-chain.

## Checks realizados

- `git status --short --branch`
- `git show --stat --oneline --decorate 15b9bcb`
- `git show --name-only --format=fuller 15b9bcb`
- `git diff 15b9bcb^ 15b9bcb -- convex/actions/poolScanner.ts convex/pools.ts`
- `rg -n "getPoolFees24h|getFees24hWindowInternal|FEE24H|hoursUntilReady|windowHours|refAgeMs|fees24hUsd|valueFeesUsd|feeShareStatus" convex src tests docs -g '!convex/_generated/**'`
- Revision directa de:
  - `getFees24hWindowInternal`
  - `getPoolFees24h`
  - `readPositionSnapshotKey`
  - `valueFeesUsd`
  - authz existente en `pools.ts`
- `git diff --check 15b9bcb^ 15b9bcb`
  - OK.
- `npm run typecheck`
  - OK: `tsc -p convex/tsconfig.json --noEmit`.

## Veredicto final

NO GO.

La logica financiera principal esta bien encaminada, pero la seleccion de ventana puede producir `ok` para menos de 24h o para snapshots viejos. Corregir la seleccion/validacion de `refSnap` y frescura de `nowSnap` antes de avanzar a F4/F5.
