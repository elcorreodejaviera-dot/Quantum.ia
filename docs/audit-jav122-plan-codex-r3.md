# Auditoria Codex - JAV-122 plan Spot Grid transient recovery - r3

## Alcance

Reauditoria de la Rev.3 del plan `docs/plan-jav122-spotgrid-transient-recovery.md`, contra el prompt r3
`docs/audit-prompt-jav122-plan.md` y el codigo actual del motor Spot Grid.

Archivos revisados:

- `docs/plan-jav122-spotgrid-transient-recovery.md`
- `docs/audit-prompt-jav122-plan.md`
- `docs/audit-jav122-plan-codex-r2.md`
- `convex/spotGridEngine.ts`
- `convex/spotGridBots.ts`
- `convex/spotGridActions.ts`
- `convex/crons.ts`
- `convex/log.ts`
- `convex/hyperliquidSpot.ts`
- `src/components/SpotGridView.jsx`
- `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts`
- `node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/_base/errors.ts`

## Veredicto

**NO GO todavia.**

La Rev.3 cierra el NO-GO r2 principal en el papel: separa la rama `wasError`, mueve los incrementos dentro de mutations bajo lease, cubre las actions user-facing y corrige la cadencia real del cron. Pero queda un riesgo de origen stale: `wasError` se toma desde la lista inicial, no desde el estado actual reclamado por `claimSpotGridReconcile`, y `recoverSpotGridFromError` no queda especificada como "solo si el bot SIGUE en `error`". Eso puede revivir a `running` un bot que fue pausado/cambiado concurrentemente durante la recuperacion.

## Bloqueante

### 1. NO-GO - `wasError` tomado desde la lista puede quedar stale y `recoverSpotGridFromError` puede sobrescribir una pausa/cambio concurrente

Evidencia:

- Rev.3 propone capturar `wasError` desde el objeto `bot` de la lista, antes del claim/gate:
  - `docs/plan-jav122-spotgrid-transient-recovery.md:113-114`
- La lista se obtiene antes de reclamar cada bot:
  - `convex/spotGridEngine.ts:689-700`
- El estado puede cambiar por fuera entre lista y claim, o durante la ronda. La mutation publica `pauseSpotGridBot` permite pausar cualquier bot que no este `stopped`; no exige lease y tambien permite `status:"error"`.
  - `convex/spotGridBots.ts:257-265`
- Rev.3 dice que si `wasError` es true y la ronda completa, se llama `recoverSpotGridFromError` para volver a `running`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:30-32`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:240-245`
- El plan no exige que `recoverSpotGridFromError` revalide dentro de la mutation que el bot actual siga en `status:"error"` y `errorKind:"transient"`.

Escenario:

1. La query de recuperables devuelve un bot `status:"error"`, por lo que el loop guarda `wasError=true`.
2. Antes o durante el reconcile, una mutation publica pausa ese bot (`status:"paused"`).
3. El reconcile re-lee el bot y, si lo ve `paused`, no coloca nuevas ordenes porque `isRunning=false`.
   - `convex/spotGridEngine.ts:526-528`
4. Al volver sin throw, el loop usa el `wasError` stale y llama `recoverSpotGridFromError`.
5. Si esa mutation no revalida estado actual, vuelve el bot a `running`, anulando la pausa.

Impacto:

- Money-path: puede reactivar colocacion en ticks posteriores contra una intencion de pausa o un cambio de estado ocurrido despues de la lista inicial.
- El origen correcto no debe depender de un snapshot previo al claim; debe salir de la transaccion que toma el lease o de una revalidacion final dentro de la mutation de recovery.

Ajuste requerido:

- Hacer que `claimSpotGridReconcile` devuelva el estado actual reclamado, por ejemplo `{ ok:true, token, wasError: bot.status === "error" }`, calculado dentro de la mutation despues de leer DB.
- `recoverSpotGridFromError` debe ser no-op salvo que, al momento de ejecutarse bajo `leaseOk`, el bot siga en `status:"error"` y `errorKind:"transient"`. Si el estado actual ya no es `error`, no debe pasar a `running`.
- Agregar test de carrera: lista devuelve `error`, luego se pausa antes del success; `recoverSpotGridFromError` no debe revertir a `running`.

## Alto

### 1. GO condicionado - La rama fatal durante recuperacion sale del set recuperable, pero debe limpiar/actualizar campos de recuperacion

Evidencia:

- Rev.3 cubre fatal durante recuperacion con `setSpotGridStatus(... errorKind:"fatal" ...)`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:129-135`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:252`
- `setSpotGridStatus` actual solo cambia `status` y `errorMessage`; Rev.3 propone agregar args opcionales para `errorKind`, `transientFailCount`, `errorRecoveryAttempts`.
  - `convex/spotGridBots.ts:616-630`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:144-147`

Impacto:

- Si fatal ocurre durante recuperacion, `errorKind:"fatal"` basta para que la query no lo recupere. Pero para estado accionable conviene limpiar `nextRetryAt` y preservar un mensaje fatal claro, no dejar backoff/attempts de transient como senales activas.

Condicion:

- Al marcar fatal, setear `nextRetryAt:0` y dejar `errorRecoveryAttempts` como trazabilidad o resetearlo de forma documentada. No debe quedar un `nextRetryAt` de recuperacion que sugiera retry pendiente.

### 2. GO condicionado - Actions user-facing quedan cubiertas si el wrapper preserva finally y no reclasifica errores internos ya saneados

Evidencia:

- Rev.3 agrega wrapper para `createSpotGridBot` y `stopSpotGridBot`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:191-206`
- `createSpotGridBot` hace lecturas HL directas que pueden lanzar `TransportError`.
  - `convex/spotGridActions.ts:53-57`
- `stopSpotGridBot` usa `try/finally` para liberar lease.
  - `convex/spotGridEngine.ts:737-838`

Impacto:

- El objetivo "nunca HTML al portal" queda bien cubierto si el catch externo no rompe el `finally` de stop.

Condicion:

- Implementar el saneo alrededor del cuerpo completo conservando el `finally` interno de `stopSpotGridBot`; no reemplazar ni saltar `releaseSpotGridReconcile`.
- Testear `TransportError` en create y stop, y un error determinista existente, como ya propone el plan.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:291-293`

## Medio

### 1. GO condicionado - Contadores dentro de mutations cierra la race r2, pero la terminalidad por tope debe quedar observable

Evidencia:

- Rev.3 mueve el incremento a `bumpSpotGridTransient` y `bumpSpotGridErrorRecovery` bajo `leaseOk`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:140-160`
- La query deja de devolver bots con `errorRecoveryAttempts >= SPOT_GRID_MAX_ERROR_RECOVERIES`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:222-228`

Impacto:

- El tope ya no queda inerte. Pero el estado terminal es implicito: `status:"error"`, `errorKind:"transient"`, attempts al tope. La UI actual solo muestra `bot.errorMessage`.
  - `src/components/SpotGridView.jsx:350`

Condicion:

- Cuando `bumpSpotGridErrorRecovery` alcanza el tope, actualizar `errorMessage` a un texto accionable tipo "reintentos de recuperacion agotados; detener o revisar HL" o agregar un campo/alerta visible. Si no, el usuario puede ver un error transitorio generico sin saber que ya no se intentara mas.

### 2. GO condicionado - Constantes compartidas siguen ubicadas en un modulo `"use node"`

Evidencia:

- El plan aun dice "Constantes (en `spotGridEngine.ts`)".
  - `docs/plan-jav122-spotgrid-transient-recovery.md:82-90`
- Pero las nuevas mutations y query viven en `spotGridBots.ts`, que es non-node y ya evita importar constantes desde modulos `"use node"`.
  - `convex/spotGridBots.ts:16-22`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:148-160`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:222-228`

Impacto:

- Si se implementa literalmente importando desde `spotGridEngine.ts`, se contamina el modulo non-node o se abre una dependencia mala para Convex/tests.

Condicion:

- Mover constantes compartidas a un helper hoja non-node, o duplicar explicitamente en `spotGridBots.ts` como ya se hace con `MIN_SPOT_NOTIONAL_USD`/`ABS_MAX_GRID_LEVELS`.

## Bajo

### 1. GO - Cron de 1 min y legacy-safe ya estan corregidos documentalmente

Evidencia:

- Rev.3 corrige la cadencia a 1 min y ajusta la expectativa de 12 ticks.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:82-88`
  - `convex/crons.ts:49-52`
- DoD incluye los cuatro campos opcionales, incluido `errorRecoveryAttempts`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:306-308`

## Checklist GO/NO-GO pedido

1. **Clasificacion / `instanceof TransportError`: GO.** Sigue siendo correcto para el catch node; `HttpRequestError` extiende `TransportError` y `ApiRequestError` no.
2. **No exponer HTML nunca: GO condicionado.** Bot, ordenes y actions user-facing estan contemplados. Condicion: el wrapper de stop debe preservar el `finally`.
3. **Fencing / lease: GO condicionado.** Bumps/reset/recover bajo `leaseOk` estan bien, pero `recoverSpotGridFromError` debe revalidar estado actual antes de volver a `running`.
4. **Convergencia / no-flapping + origen: NO-GO.** `wasError` desde la lista no es suficientemente robusto ante cambios entre lista y claim/ronda. Usar origen devuelto por claim y guard final en recovery.
5. **Recuperacion money-path: NO-GO por race de recovery.** La idempotencia HL/DB sigue bien encaminada, pero una recuperacion exitosa no debe anular una pausa/cambio concurrente.
6. **Tope / terminalidad: GO condicionado.** El contador ya avanza; falta hacer visible/accionable el agotamiento de recuperacion.
7. **Legacy-safe: GO.** Los cuatro campos estan documentados como opcionales/ausente=0.
8. **Huecos nuevos: NO-GO por stale origin.** Es el hueco restante que bloquearia el GO limpio.

## Hechos positivos verificados

- El bloqueo r2 de "transitorio durante recuperacion incrementa el contador equivocado" esta resuelto en el diseño por rama `wasError`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:113-128`
- Los contadores ya no se calculan en la action; el plan mueve lectura+incremento a mutations bajo lease.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:140-160`
- El saneo de create/stop se incorporo al plan.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:191-206`
- Los tests propuestos cubren origen de recuperacion, action user-facing sin HTML y token invalido/vencido.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:288-295`

## Comandos revisados

- `git status --short`
- `stat -c '%y %n' docs/plan-jav122-spotgrid-transient-recovery.md docs/audit-prompt-jav122-plan.md docs/audit-jav122-plan-codex-r2.md`
- `nl -ba docs/plan-jav122-spotgrid-transient-recovery.md`
- `nl -ba docs/audit-prompt-jav122-plan.md`
- `nl -ba convex/spotGridEngine.ts`
- `nl -ba convex/spotGridBots.ts`
- `nl -ba convex/spotGridActions.ts`
- `rg -n "SPOT_GRID_MAX|SPOT_GRID_TRANSIENT|ERROR_RETRY|constants|use node|markSpotGridReconcileSuccess|bumpSpotGridTransient|bumpSpotGridErrorRecovery|recoverSpotGridFromError|wasError|gate.policy|setSpotGridStatus"`
- `rg -n "pauseSpotGridBot|resume|setSpotGridStatus|status: \"paused\"|status: \"running\"|claimSpotGridReconcile"`

No ejecute typecheck ni tests: sigue siendo auditoria estatica de plan, sin codigo implementado.

## Cierre

No daria GO todavia. La correccion minima para r4 es pequena pero importante: que el claim devuelva el origen actual (`wasError`) desde DB y que `recoverSpotGridFromError` sea no-op si el bot ya no sigue en `error` transitorio bajo ese lease. Con eso, el plan quedaria cerca de **GO condicionado** para implementar.
