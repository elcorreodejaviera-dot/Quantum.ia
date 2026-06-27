# Auditoría de CÓDIGO (Codex) — JAV-122: Spot Grid resiliente a errores transitorios de HL (502)

Eres un auditor senior de código money-path sobre Hyperliquid. Audita el **CÓDIGO** del commit `c070b49`
(rama `spot-grid/jav122-transient-recovery`). Emite veredicto **GO / NO-GO** por hallazgo con severidad
(ALTO / MEDIO / BAJO). El diseño ya tiene tu GO (Ronda 6, plan `docs/plan-jav122-spotgrid-transient-recovery.md`
Rev.7; auditorías r1–r6 en `docs/audit-jav122-plan-codex-r*.md`). Aquí verificás que el código implementa
ese diseño FIELMENTE y sin huecos nuevos.

> **RE-AUDITORÍA (tras tu GO-cond de código, ALTO-1).** ALTO-1 corregido en commit `895c6d8` (Rev.8 del
> plan): los catches LOCALES de envío de orden (`placeOrder` y los inline de retry de `submitting`/repost)
> tragaban el `TransportError`. Ahora `reconcileOneBot` acumula y DEVUELVE una bandera `transientPlace`
> (la setean esos catches cuando `classifySpotGridError(e).kind === "transient"`), y el loop del cron, con
> la bandera activa, hace `bumpSpotGridTransient` (activo) / `bumpSpotGridErrorRecovery` (recuperación) en
> vez del path de éxito. **NO se re-lanza** a propósito: en el loop de fills `setSpotGridFillCursor` se
> aplica al final, así que re-lanzar a mitad saltearía el avance del cursor → DOBLE-CONTEO de fills.
> Verificá en r-código: (a) ¿la bandera cubre TODOS los catches locales de envío (placeOrder, retry de
> submitting `~621`, repost `~691`) y los bootstrap sells/buys? (b) ¿el IOC de la semilla sigue re-lanzando
> al catch central (sin catch local)? (c) ¿el desenlace por bandera respeta wasError (recuperación →
> bumpErrorRecovery, no recover)? (d) ¿sigue sin haber doble-conteo de fills ni doble-orden? Archivo
> tocado: `convex/spotGridEngine.ts` (commit `895c6d8`). typecheck OK, suite 286/286 verde.

## Qué cambia (commit `c070b49`)
- `convex/schema.ts`: 5 campos opcionales en `spot_grid_bots` (`errorKind`, `transientFailCount`,
  `errorRecoveryAttempts`, `nextRetryAt`, `recoverToStatus`). Aditivos, legacy-safe.
- `convex/spotGridConstants.ts` (NUEVO, hoja sin `"use node"`): `SPOT_GRID_TRANSIENT_BACKOFF_MS=60_000`,
  `SPOT_GRID_MAX_TRANSIENT_FAILS=12`, `SPOT_GRID_ERROR_RETRY_BACKOFF_MS=15min`, `SPOT_GRID_MAX_ERROR_RECOVERIES=8`,
  y mensajes limpios.
- `convex/spotGridEngine.ts` (`"use node"`): `classifySpotGridError(e)` (`instanceof TransportError` →
  transient con mensaje fijo; resto → fatal con `safeError`). `reconcileAllSpotGrids` ahora: lista
  activos + recuperables; usa `claim.wasError` (leído de DB) como origen; en éxito llama
  `recoverSpotGridFromError` (si wasError) o `markSpotGridReconcileSuccess` (si activo); el catch ramifica
  transient/fatal × activo/recuperación; el gate-loop pasa `errorKind:"fatal"` en `policy:"error"`. Catches
  de colocación de orden y `stopSpotGridBot` re-lanzan/persisten el mensaje clasificado (nunca HTML).
- `convex/spotGridBots.ts` (non-node): helper `isRecoverableError(bot)`; `claimSpotGridReconcile` espeja
  ese predicate y devuelve `wasError`; nuevas internalMutations `bumpSpotGridTransient`,
  `bumpSpotGridErrorRecovery`, `markSpotGridReconcileSuccess`, `recoverSpotGridFromError`;
  `setSpotGridStatus` extendido (errorKind explícito + normaliza recovery); query
  `listRecoverableErrorSpotGridBotsInternal`; `pauseSpotGridBot` y `setSpotGridBootstrap` limpian recovery.
- `convex/spotGridActions.ts` (`"use node"`): `createSpotGridBot` envuelta → re-lanza mensaje clasificado.
- `tests/spotGridTransientRecovery.test.ts` (NUEVO): 21 tests. Suite 286/286 verde; `npm run typecheck` OK;
  `npx convex codegen` OK.

## Verifica GO/NO-GO (responde cada punto, con evidencia file:line)
1. **Clasificación correcta.** `classifySpotGridError` (`spotGridEngine.ts`): ¿`instanceof TransportError`
   captura el 502/timeout/red y NO los deterministas (ApiRequestError/validación/firma)? ¿Alguna excepción
   relevante CRUZA un `runMutation`/`runQuery` ANTES del catch del cron y perdería el `instanceof` (se
   serializaría a Error genérico → misclasificada como fatal)? Confirmar que `getUserFees`/`getSpotPrice`/
   órdenes/bootstrap son JS plano en el mismo contexto del catch.
2. **Nunca HTML.** ¿Algún path persiste o re-lanza `safeError(e)` crudo que pueda ver un `TransportError`?
   Revisar: catch del cron, catches de orden (`markSpotGridOrder`), `stopSpotGridBot`, `createSpotGridBot`,
   `setSpotGridBootstrap`. El transitorio del bot (no escalado) NO debe tocar `errorMessage`.
3. **Predicate claim == query (Codex r6 COND-1).** ¿`isRecoverableError` es EL MISMO criterio en
   `claimSpotGridReconcile` y `listRecoverableErrorSpotGridBotsInternal`? ¿El claim aplica además el gate de
   `nextRetryAt` y NO toma error fatal / sin `recoverToStatus` / sobre tope?
4. **`wasError` autoritativo (Codex r3).** ¿`claimSpotGridReconcile` devuelve `wasError` del documento
   leído al claimar (no del snapshot de la lista)? ¿El loop usa `claim.wasError`, no `bot.status`?
5. **Anti-carrera (Codex r3/r4).** ¿`recoverSpotGridFromError` y `bumpSpotGridErrorRecovery` revalidan
   `status==="error" && errorKind==="transient"` bajo `leaseOk` y son no-op si cambió? ¿`recover` restaura
   `recoverToStatus` (running|paused, NUNCA siempre running) y TERMINALIZA a fatal si falta? ¿Todas las
   mutations nuevas operan bajo `leaseOk(token)` y patchean ANTES del `release` del `finally`?
6. **Contadores separados + escalada (Codex r1/r2).** ¿`bumpSpotGridTransient` calcula el contador DENTRO
   de la mutation, escala al tope (status:error, errorKind:transient, captura `recoverToStatus`, resetea
   contadores, alerta UNA vez) y devuelve `{escalated,count}`? ¿`bumpSpotGridErrorRecovery` usa
   `errorRecoveryAttempts` (separado) y deja `errorMessage` accionable al tope?
7. **Limpieza de estado fantasma (Codex r5/r6).** ¿`setSpotGridStatus` asigna `errorKind` de forma
   INCONDICIONAL (error → `?? "fatal"`; no-error → `undefined`) y normaliza
   `recoverToStatus`/contadores/`nextRetryAt`? ¿`pauseSpotGridBot` (que admite pausar un `error`) y
   `setSpotGridBootstrap(error)` limpian recovery? ¿`markSpotGridReconcileSuccess` queda ESTRICTAMENTE en
   contadores (no toca status/errorKind/errorMessage)?
8. **Reset en TODA ronda OK (Codex r1).** ¿El reset de `transientFailCount` corre en el punto de éxito del
   loop (con o sin fills, running o paused), no atado a `setSpotGridFillCursor`?
9. **Recuperación money-path.** Al volver `error→running`, ¿el gate live y el bootstrap idempotente
   evitan doble-orden / re-siembra? ¿Un bot que recuperó a `paused` NO coloca órdenes el siguiente tick
   (`isRunning = status==="running"`)?
10. **Legacy-safe.** Bots sin los 5 campos ¿se comportan como 0/ausente en claim, query, bumps, resets,
    recover? ¿La query filtra en memoria sobre `by_status_updated` de forma acotada?
11. **Aislamiento node/non-node.** ¿`spotGridConstants.ts` es hoja sin `"use node"` y no arrastra el SDK?
    ¿`classifySpotGridError` (usa el SDK) vive solo en tierra node y las mutations non-node no lo importan?
12. **Huecos nuevos.** Cualquier carrera, doble-alerta, doble-orden, bucle de recovery, o camino donde un
    transitorio termine en error con HTML o un fatal reintente para siempre.

## Hechos para anclar
- `e instanceof TransportError` ya es el criterio canónico del repo: `convex/hyperliquid.ts:248,597`.
- Patrón espejado: `convex/triggerRearm.ts` (backoff/tope/lease del auto-rearm JAV-44).
- Cron Spot Grid: `convex/crons.ts:49-52` (`{ minutes: 1 }`). UI muestra `errorMessage`: `src/components/SpotGridView.jsx:350`.
- `pauseSpotGridBot` admite pausar cualquier estado salvo `stopped` (incluido `error`): `convex/spotGridBots.ts`.

Checks ya verificados (no hace falta correrlos): `npx convex codegen` OK, `npm run typecheck` OK, `vitest run`
286/286. Money-path: tras tu GO sobre el código → PR → CodeRabbit → merge → deploy (prod se deploya sola al
mergear; Convex prod es deployment aparte del dev `strong-sandpiper-848`); validación runtime en prod tras deploy.
