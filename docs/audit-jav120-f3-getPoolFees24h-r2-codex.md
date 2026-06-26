# Auditoria Codex - JAV-120 Fase 3 `getPoolFees24h` r2

## Alcance auditado

- Rama: `elcorreodejaviera/jav-120-fees-24h-real`
- Commit auditado: `664d9f1`
- Prompt: `docs/audit-prompt-jav120-f3-codigo.md`
- Auditoria previa: `docs/audit-jav120-f3-getPoolFees24h-codex.md`
- Archivos de codigo revisados:
  - `convex/actions/poolScanner.ts`
  - `convex/pools.ts`

Fase auditada: F3, action backend `getPoolFees24h` + internalQuery `getFees24hWindowInternal`.

## Bloqueante

No hay hallazgos bloqueantes.

## Alto

No hay hallazgos altos.

El NO-GO previo queda corregido:

- `refSnap` ahora se selecciona relativo a `nowSnap.at - 24h`, no a `serverNow - 24h` (`convex/pools.ts:422-426`).
- La ventana `refAgeMs = nowSnap.at - refSnap.at` ya no puede ser menor a 24h cuando hay `refSnap` (`convex/actions/poolScanner.ts:1121-1124`).
- Si `nowSnap` esta viejo por cron caido, la action devuelve `stale` antes de calcular (`convex/actions/poolScanner.ts:1111-1113`).
- El countdown de `warming_up` se ancla en `nowSnap.at - oldestAt`, no en `serverNow - oldestAt` (`convex/actions/poolScanner.ts:1114-1119`).

## Medio

No hay hallazgos medios.

## Bajo

### 1. Runtime real sigue diferido hasta tener historia de snapshots

Evidencia:

- La action requiere snapshots generados por el cron F2.
- La verificacion contra tokenId 5562243 solo puede hacerse tras desplegar y acumular historia.

Impacto: bajo. Aceptable para F3, pero debe quedar como condicion operativa antes de exponer UI: confirmar filas reales y comparar contra lectura on-chain.

### 2. Conviene agregar fixtures sinteticos de ventana

Evidencia:

- Los tests existentes pasan, pero no ejercitan `getPoolFees24h` con snapshots sinteticos.

Impacto: bajo. La logica es sensible a bordes temporales.

Casos sugeridos: sin snapshots, un snapshot, ventana <24h, ventana 24-26h, ventana >26h, `nowSnap` viejo, `snapshotKey` distinto, delta negativo.

## Evidencia positiva

- Authz owner/admin: `getFees24hWindowInternal` usa `requireUser`, carga el pool y valida owner/admin antes de leer snapshots (`convex/pools.ts:410-413`).
- El valor real no depende de `feeShareStatus`, consistente con el plan.
- Si `snapshotKey` cambia, devuelve `partial`, dejando certificacion por eventos a F4.
- Si el delta raw es negativo, devuelve `partial`.
- La action es read-only: no escribe DB y solo hace lecturas RPC para metadata de token.
- La decision "ahora = ultimo snapshot almacenado" es coherente con F2 siempre que `nowSnap` este fresco; ahora esta gateada por 2h.

## Checks realizados

- `git status --short --branch`
- `git log --oneline --decorate -10`
- `git show --stat --oneline --decorate 664d9f1`
- `git diff 15b9bcb 664d9f1 -- convex/actions/poolScanner.ts convex/pools.ts`
- `git diff 664d9f1^ 664d9f1 -- convex/actions/poolScanner.ts convex/pools.ts`
- `rg -n "FEE24H_MAX_NOW_AGE|nowCutoff|nowSnap|refSnap|serverNow|hoursUntilReady|FEE24H_WINDOW_MS|FEE24H_MAX_REF_AGE_MS" convex/actions/poolScanner.ts convex/pools.ts docs/audit-prompt-jav120-f3-codigo.md`
- Revision directa de:
  - `getFees24hWindowInternal`
  - `getPoolFees24h`
  - `readPositionSnapshotKey`
  - `valueFeesUsd`
  - authz en `pools.ts`
- `git diff --check 664d9f1^ 664d9f1`
  - OK.
- `npm run typecheck`
  - OK: `tsc -p convex/tsconfig.json --noEmit`.
- `npm test`
  - OK: 17 archivos, 265 tests.

## Veredicto final

GO.

F3 puede avanzar. Siguiente fase: F4 para certificar ventanas con `snapshotKey` cambiado mediante eventos, o F5/UI si se decide exponer primero `ok/warming_up/stale/partial` sin resolver `partial`.
