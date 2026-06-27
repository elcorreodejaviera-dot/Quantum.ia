# Auditoria Codex - JAV-122 plan Spot Grid transient recovery - r2

## Alcance

Reauditoria de la Rev.2 del plan `docs/plan-jav122-spotgrid-transient-recovery.md`, contra el prompt r2
`docs/audit-prompt-jav122-plan.md` y el codigo actual del motor Spot Grid.

Archivos revisados:

- `docs/plan-jav122-spotgrid-transient-recovery.md`
- `docs/audit-prompt-jav122-plan.md`
- `docs/audit-jav122-plan-codex.md`
- `convex/spotGridEngine.ts`
- `convex/spotGridBots.ts`
- `convex/spotGridActions.ts`
- `convex/schema.ts`
- `convex/crons.ts`
- `convex/log.ts`
- `convex/hyperliquidSpot.ts`
- `src/components/SpotGridView.jsx`
- `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts`
- `node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/_base/errors.ts`

## Veredicto

**NO GO todavia.**

La Rev.2 corrige el bloqueo conceptual de r1 al separar `transientFailCount` de `errorRecoveryAttempts`, y mueve el reset a un punto de exito garantizado. Pero el plan todavia no integra la rama de recuperacion en el `catch` principal: el pseudocodigo sigue usando `bumpSpotGridTransient` para cualquier `TransportError`. Si el bot viene de `status:"error"`, eso no incrementa `errorRecoveryAttempts`, por lo que el tope de recuperacion puede quedar inerte.

## Bloqueante

### 1. NO-GO - El catch principal no distingue intento activo vs intento de recuperacion

Evidencia:

- El plan r2 agrega el contador separado `errorRecoveryAttempts` y declara que es el unico que debe filtrar la recuperacion.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:53-57`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:172-178`
- Pero el pseudocodigo del `catch (e)` sigue aplicando una sola rama para todo `kind === "transient"`:
  - calcula `n = (bot.transientFailCount ?? 0) + 1`;
  - si no escala, llama `bumpSpotGridTransient`;
  - no mira `bot.status`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:89-119`
- La seccion de recuperacion dice que una falla transitoria desde `error` debe llamar `bumpSpotGridErrorRecovery`, incrementando `errorRecoveryAttempts`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:190-202`
- Esas dos instrucciones quedan contradictorias si el mismo `catch` gobierna activos y recuperables, como propone el plan al concatenar activos + recuperables en el mismo loop.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:180-182`

Impacto:

- Un bot en `error` recuperable que vuelve a fallar con `TransportError` puede terminar con `status:"error"`, `transientFailCount` subiendo y `errorRecoveryAttempts` permaneciendo en 0.
- La query de recuperacion filtra por `(errorRecoveryAttempts ?? 0) < SPOT_GRID_MAX_ERROR_RECOVERIES`; si ese contador no sube, el bot se reintentaria indefinidamente y el estado terminal accionable no converge.

Ajuste requerido:

- Reescribir el `catch` del loop con una rama explicita:
  - si `bot.status === "error"` y `kind === "transient"`: llamar `bumpSpotGridErrorRecovery({ botId, token, nextRetryAt })`;
  - si `bot.status !== "error"` y `kind === "transient"`: usar la politica de prevencion (`bumpSpotGridTransient` / escalada);
  - si `kind === "fatal"`: marcar `errorKind:"fatal"` y salir del set recuperable.
- La mutation de recuperacion debe leer el bot actual bajo `leaseOk`, incrementar `errorRecoveryAttempts` dentro de la transaccion y devolver el nuevo contador para decidir si quedo terminal.

## Alto

### 1. GO condicionado - El reset r2 ahora esta en el punto correcto, pero debe ejecutarse antes del release y bajo lease

Evidencia:

- R1 fallaba porque el reset dependia de `setSpotGridFillCursor`, que solo corre si avanza `maxTime`.
  - `convex/spotGridEngine.ts:680-682`
- R2 propone `markSpotGridReconcileSuccess`, bajo `leaseOk(token)`, llamada tras `reconcileOneBot` retornar sin throw.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:129-136`
- En el loop actual, el punto de exito es antes del `finally` que libera el lease.
  - `convex/spotGridEngine.ts:715-723`

Impacto:

- La correccion cierra el riesgo de acumulacion de fallos no consecutivos, siempre que la implementacion respete el orden exacto: success/recover antes de `releaseSpotGridReconcile`.

Condicion:

- Tests r2 deben cubrir ronda OK sin fills y alternancia fallo/OK, como ya propone el plan.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:224-228`

### 2. GO condicionado - HTML persistido en ordenes queda cubierto para los dos catches conocidos, pero no para errores directos de actions en portal

Evidencia:

- R2 identifica los dos persistidos `markSpotGridOrder({ errorMessage: safeError(e) })`:
  - retry de `submitting`: `convex/spotGridEngine.ts:599-600`
  - repost tras SELL: `convex/spotGridEngine.ts:674-675`
- R2 propone pasarlos por `classifySpotGridError(e)` y agrega test de orden.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:143-156`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:217-221`
- Pero el portal tambien expone errores directos de actions con `e.message`:
  - crear grid: `src/components/SpotGridView.jsx:157-184`
  - stop: `src/components/SpotGridView.jsx:320-334`
  - render del error de action: `src/components/SpotGridView.jsx:367`
- Esas actions hacen RPC HL que pueden lanzar `TransportError`:
  - creacion lee `resolveSpotAsset`, `getSpotPrice`, `getSpotBalance`: `convex/spotGridActions.ts:53-57`
  - stop lee/cancela/liquida con HL: `convex/spotGridEngine.ts:753-823`
- `safeError` no sanitiza HTML; solo trunca.
  - `convex/log.ts:26-28`

Impacto:

- Para el requisito fuerte "nunca exponer HTML en ningun path", cubrir solo `errorMessage` persistido no basta. Un 502 durante crear o detener puede llegar al usuario como `e.message`.

Ajuste requerido:

- Definir un helper de mensaje publico para Spot Grid actions, o sanitizar errores de action antes de lanzarlos/mostrarlos.
- Si se decide acotar JAV-122 solo al cron/reconcile, documentar explicitamente que create/stop quedan fuera; si no, incluirlos en el DoD y tests/manual QA.

## Medio

### 1. GO condicionado - `instanceof TransportError` sigue siendo correcto para el catch node, pero el plan conserva una afirmacion demasiado amplia

Evidencia:

- En el SDK local, `HttpRequestError extends TransportError`.
  - `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts:61-88`
- `ApiRequestError` no extiende `TransportError`.
  - `node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/_base/errors.ts:37-50`
- Las llamadas SDK que no son capturadas antes llegan vivas al `catch` node del loop:
  - `getUserFees`: `convex/spotGridEngine.ts:715`
  - `reconcileOneBot`: `convex/spotGridEngine.ts:716`
- Pero el plan aun afirma que "todas las llamadas a HL del reconcile y bootstrap ... ordenes" llegan al mismo catch.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:33-35`
- No todas llegan: `placeOrder` captura y traga errores de orden, dejando solo log.
  - `convex/spotGridEngine.ts:392-401`

Impacto:

- No rompe por si solo si el comportamiento local de orden se mantiene como retry/idempotencia por CLOID, pero el plan debe dejar claro que el contador del bot no cubre esos catches locales salvo que se instrumenten.

Ajuste requerido:

- Cambiar la frase absoluta por una clasificacion por rutas: catch externo, catches locales persistidos, catches locales solo-log.

### 2. GO condicionado - El calculo de contadores no debe venir del snapshot de la action

Evidencia:

- El snippet r2 todavia calcula `n` en la action con el `bot` obtenido antes del claim.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:92-108`
- `bumpSpotGridTransient` se describe como mutation que recibe `transientFailCount` ya calculado.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:126-128`
- El loop lista bots antes de claimar cada bot.
  - `convex/spotGridEngine.ts:689-700`

Impacto:

- Con crons solapados o una lista vieja que llegue a claimar despues de vencido `nextRetryAt`, un contador calculado fuera de la mutation puede pisar un valor mas nuevo o perder incrementos.

Ajuste requerido:

- `bumpSpotGridTransient` y `bumpSpotGridErrorRecovery` deben leer el bot actual bajo `leaseOk`, incrementar dentro de la mutation y devolver el nuevo valor.
- El plan ya exige lease/fencing; falta mover el calculo del contador al mismo punto transaccional.

## Bajo

### 1. GO con correccion documental - El plan sigue diciendo cron cada 5 min, pero el codigo actual corre cada 1 min

Evidencia:

- El plan dice que el cron corre cada 5 min.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:61-63`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:138-141`
- El codigo actual programa `reconcile spot grid` cada 1 minuto.
  - `convex/crons.ts:49-52`

Impacto:

- Con el cron actual, `SPOT_GRID_TRANSIENT_BACKOFF_MS = 60_000` si tiene efecto practico: salta hasta el siguiente tick. La frase "casi nunca bloquea" es incorrecta para el codigo actual.

Ajuste requerido:

- Sincronizar el texto del plan y recalcular las expectativas de tiempo: 12 fallos son aproximadamente 12 minutos con cron de 1 min, no aproximadamente 1 hora.

### 2. GO condicionado - Legacy-safe ahora son cuatro campos, no tres

Evidencia:

- R2 agrega `errorRecoveryAttempts`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:53-57`
- El DoD todavia enumera solo `errorKind/transientFailCount/nextRetryAt`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:245-246`

Impacto:

- Menor, pero puede hacer que implementacion/tests omitan el default legacy de `errorRecoveryAttempts`.

Ajuste requerido:

- Actualizar DoD/tests para incluir `errorRecoveryAttempts` ausente = 0.

### 3. GO condicionado - Constantes compartidas no deben vivir solo en el modulo `"use node"`

Evidencia:

- El plan ubica las constantes en `spotGridEngine.ts`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:61-67`
- La query `listRecoverableErrorSpotGridBotsInternal` vive en `spotGridBots.ts` y necesita `SPOT_GRID_MAX_ERROR_RECOVERIES`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:172-178`

Impacto:

- Importar desde un modulo `"use node"` hacia un modulo de queries/mutations no-node es una frontera mala para Convex y para los tests.

Ajuste requerido:

- Mover limites/backoffs compartidos a un helper hoja no-node, o declarar el limite que usa la query en `spotGridBots.ts`.

## Checklist GO/NO-GO pedido

1. **`instanceof TransportError` cruzando limites Convex: GO condicionado.** No vi perdida de `instanceof` en el catch principal; el SDK confirma `HttpRequestError extends TransportError` y `ApiRequestError` queda fuera. Condicion: corregir la afirmacion de que todas las ordenes llegan al catch externo.
2. **Nunca exponer HTML: GO condicionado / incompleto.** R2 cubre `bot.errorMessage` y los dos `spot_grid_orders.errorMessage` conocidos. Falta cubrir o excluir explicitamente los errores directos de actions mostrados por el portal.
3. **Fencing/lease: GO condicionado.** El reset/recover propuestos estan bajo `leaseOk` y antes del release si se implementan como dice el plan. Falta que los increments de contadores se calculen dentro de las mutations.
4. **Reset + backoff: GO condicionado.** El reset r2 esta bien ubicado. El backoff de 60s no es inerte con el cron real de 1 min; corregir documentacion y expectativas.
5. **Recuperacion money-path: NO-GO por integracion del catch.** La ruta `error` que falla otra vez debe incrementar `errorRecoveryAttempts`; el pseudocodigo principal aun no lo garantiza.
6. **Tope/estado terminal accionable: NO-GO hasta corregir el catch.** Con `errorRecoveryAttempts` separado el diseno es correcto, pero solo si se incrementa exactamente una vez por intento de recuperacion fallido.
7. **Legacy-safe: GO condicionado.** Opcionales y defaults son adecuados, pero falta incluir `errorRecoveryAttempts` en DoD/tests y ubicar constantes fuera de `spotGridEngine.ts`.

## Hechos positivos verificados

- R2 corrige el bloqueo conceptual de contador unico al agregar `errorRecoveryAttempts`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:8-12`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:53-57`
- R2 mueve el reset al punto posterior a `reconcileOneBot` exitoso, no a `setSpotGridFillCursor`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:129-136`
- R2 agrega cobertura para los dos `errorMessage: safeError(e)` persistidos en ordenes.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:143-156`
- `stopSpotGridBot` sigue teniendo claim dedicado que admite `error`, por lo que el usuario puede intentar stop/liquidar desde `error`.
  - `convex/spotGridBots.ts:475-481`

## Comandos revisados

- `git status --short`
- `stat -c '%y %n' docs/plan-jav122-spotgrid-transient-recovery.md docs/audit-prompt-jav122-plan.md docs/audit-jav122-plan-codex.md`
- `nl -ba docs/plan-jav122-spotgrid-transient-recovery.md`
- `nl -ba docs/audit-prompt-jav122-plan.md`
- `nl -ba convex/spotGridEngine.ts`
- `nl -ba convex/spotGridBots.ts`
- `nl -ba convex/spotGridActions.ts`
- `nl -ba src/components/SpotGridView.jsx`
- `rg -n "errorMessage: safeError\\(e\\)|setSpotGridStatus\\(|setSpotGridBootstrap\\(|markSpotGridOrder\\(.*errorMessage|throw new Error|catch \\(e\\)"`
- `rg -n "getSpotPrice|getSpotBalance|resolveSpotAsset|getUserFees|TransportError|safeError|catch \\(e\\)|throw"`

No ejecute typecheck ni tests: sigue siendo auditoria estatica de plan, sin codigo implementado.

## Cierre

No daria GO todavia. La correccion minima para r3 es integrar el `catch` del loop con dos politicas distintas segun `bot.status` previo: activo usa `transientFailCount`; recuperacion desde `error` usa `errorRecoveryAttempts`. Despues de eso, el plan queda cerca de GO condicionado, con pendientes documentales menores sobre cron 1 min, defaults legacy y mensajes publicos de actions.
