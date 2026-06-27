# Auditoria Codex - JAV-122 plan Spot Grid transient recovery - r5

## Alcance

Reauditoria de la **Rev.5** del plan `docs/plan-jav122-spotgrid-transient-recovery.md` y del prompt
**Ronda 5** `docs/audit-prompt-jav122-plan.md`, contra el codigo actual del motor Spot Grid.

Archivos revisados:

- `docs/plan-jav122-spotgrid-transient-recovery.md`
- `docs/audit-prompt-jav122-plan.md`
- `docs/audit-jav122-plan-codex-r4.md`
- `convex/spotGridEngine.ts`
- `convex/spotGridBots.ts`
- `convex/spotGridActions.ts`
- `convex/schema.ts`
- `convex/crons.ts`
- `convex/log.ts`
- `convex/hyperliquid.ts`
- `convex/hyperliquidSpot.ts`
- `convex/triggerRearm.ts`
- `src/components/SpotGridView.jsx`

## Veredicto

**NO GO todavia.**

Rev.5 cierra el bloqueante money-path de r4: al escalar guarda `recoverToStatus` y la recuperacion restaura
`running` o `paused`, por lo que un bot pausado ya no deberia reactivarse como `running`.

Queda un hueco alto en el diseno de legacy/terminalidad: el no-op conservador ante `recoverToStatus` ausente
evita revivir a ciegas, pero deja al bot dentro del set recuperable. Si HL responde OK, el cron puede
reconciliarlo una y otra vez, ejecutar `recoverSpotGridFromError`, recibir `{ok:false}` y volver a reclamarlo en
el siguiente tick sin volverlo accionable ni consumir intentos. Tambien falta explicitar que los paths que llevan
un `error` transitorio a `fatal` o a una politica de gate limpian `recoverToStatus`/campos de recovery para no
dejar estado fantasma.

## Bloqueante

No quedan bloqueantes money-path equivalentes al r4. La preservacion `running` vs `paused` esta bien planteada si
se implementa literalmente.

## Alto

### 1. NO-GO - `recoverToStatus` ausente es no-op, pero sigue siendo recuperable para siempre

Evidencia:

- Rev.5 agrega `recoverToStatus` opcional y declara que, si falta, `recoverSpotGridFromError` hace no-op
  conservador.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:111-114`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:209-217`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:301-310`
- La query de recuperables filtra por `status==="error"`, `errorKind==="transient"`,
  `nextRetryAt<=now` y `errorRecoveryAttempts<SPOT_GRID_MAX_ERROR_RECOVERIES`; no excluye
  `recoverToStatus` ausente.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:281-287`
- En el camino de exito de recuperacion, la mutation no incrementa `errorRecoveryAttempts`, no cambia
  `nextRetryAt` y, segun el texto, no parchea nada cuando falta `recoverToStatus`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:301-310`
- El prompt r5 pide revisar explicitamente si el no-op conservador ante ausencia es correcto.
  - `docs/audit-prompt-jav122-plan.md:76-80`

Escenario:

1. Existe un bot `status:"error"` + `errorKind:"transient"` sin `recoverToStatus` por legacy, dato parcial,
   migracion manual o bug de una version intermedia.
2. `listRecoverableErrorSpotGridBotsInternal` lo devuelve porque los filtros no dependen de `recoverToStatus`.
3. El cron lo claima y HL responde OK; como `status` del bot es `error`, `reconcileOneBot` no coloca ordenes
   (`isRunning` es falso), pero puede completar una ronda de observacion.
4. En el punto de exito, `recoverSpotGridFromError` detecta que falta `recoverToStatus` y devuelve `{ok:false}`
   sin tocar el bot.
5. En el siguiente tick, el mismo bot vuelve a estar en la query recuperable. No consume intentos, no queda
   terminal y no aparece un mensaje accionable distinto.

Impacto:

- No es un doble-orden directo, porque el no-op no revive el bot, pero si rompe la convergencia: un caso marcado
  recuperable puede quedar en bucle infinito de recovery exitoso/no-op.
- El estado no es realmente "para intervencion" si el sistema lo sigue reclamando automaticamente.
- El test propuesto como variante "sin recoverToStatus -> no-op, queda en error" no verifica que salga del set
  recuperable o que quede accionable.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:368-374`

Ajuste requerido:

- Mantener el no-op como default money-path conservador, pero hacerlo **terminal/accionable** o excluirlo del set
  recuperable.
- Opciones aceptables:
  - La query recuperable exige `recoverToStatus === "running" || recoverToStatus === "paused"`.
  - O el branch de `recoverSpotGridFromError` con `recoverToStatus` ausente setea `errorKind:"fatal"` o
    `errorRecoveryAttempts: SPOT_GRID_MAX_ERROR_RECOVERIES`, limpia `recoverToStatus`, y deja
    `errorMessage` accionable.
- Agregar test: bot `error` + `errorKind:"transient"` + sin `recoverToStatus` no vuelve a ser reclamado
  indefinidamente despues del intento de recovery.

### 2. GO condicionado - La preservacion `paused` cierra el bloqueante r4 si se implementa literalmente

Evidencia:

- Rev.5 captura el estado previo al escalar:
  `recoverToStatus = bot.status === "paused" ? "paused" : "running"`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:57-65`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:190-199`
- `recoverSpotGridFromError` restaura `bot.recoverToStatus` y limpia el campo.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:209-217`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:301-310`
- En el codigo actual, `reconcileOneBot` solo coloca si `bot.status === "running"`.
  - `convex/spotGridEngine.ts:525-528`
- El cron actual reconcilia `running` y `paused`, por eso preservar `paused` era necesario.
  - `convex/spotGridBots.ts:701-708`
- El test #13 cubre `paused -> error transient -> recovery -> paused`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:368-372`

Condiciones de implementacion:

- `bumpSpotGridTransient` debe leer el `bot.status` actual dentro de la mutation, bajo `leaseOk(token)`, justo
  antes del patch de escalada.
- `recoverSpotGridFromError` no debe tener ningun fallback a `running`.
- La variante `recoverToStatus:"running"` debe seguir cubierta para no dejar bots originalmente activos en error
  innecesariamente.

### 3. GO condicionado - `claim.wasError` y revalidacion bajo lease cierran la carrera r3/r4

Evidencia:

- `claimSpotGridReconcile` debe devolver `wasError` leido del documento al tomar el lease.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:149-157`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:293-299`
- `recoverSpotGridFromError` y `bumpSpotGridErrorRecovery` revalidan `status:"error"` +
  `errorKind:"transient"` bajo `leaseOk`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:200-217`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:301-317`

Impacto:

- Un snapshot rancio de la lista ya no decide si la ronda es activa o de recuperacion.
- Una pausa/stop/flip concurrente ya no deberia ser revertida por el success de recovery.

Condicion:

- La action debe usar solo `claim.wasError`, no recalcular desde `bot.status` de la lista.

## Medio

### 1. NO-GO condicionado - Falta limpiar `recoverToStatus` al pasar a fatal o al aplicar una politica de gate

Evidencia:

- El catch fatal del plan llama `setSpotGridStatus(... status:"error", errorKind:"fatal", errorMessage: message)`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:171-176`
- `setSpotGridStatus` solo se describe extendido con args opcionales `errorKind`, `transientFailCount` y
  `errorRecoveryAttempts`; no menciona `recoverToStatus` ni limpieza de campos de recovery en cambios no
  recuperables.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:186-189`
- El gate live actual puede devolver `policy:"error"` para `bot_not_found`, `owner_not_found` o
  `hl_network_unset`, y `policy:"paused"` para switches/permisos/red.
  - `convex/spotGridBots.ts:762-781`
- El loop actual aplica `gate.policy` via `setSpotGridStatus` antes de tocar HL.
  - `convex/spotGridEngine.ts:702-708`
- El plan conserva ese gate y dice que, si no es admisible, lo manda a su `policy` como hoy.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:293-299`

Riesgo:

- Un bot que venia de `errorKind:"transient"` puede terminar en `policy:"error"` por gate no admisible sin que
  el plan obligue a setear `errorKind:"fatal"` ni limpiar `recoverToStatus`.
- Si queda `status:"error"` + `errorKind:"transient"` por no pasar `errorKind`, la query de recovery puede
  seguir tomandolo aunque el motivo real ya no sea transitorio de HL.
- Si queda `status:"paused"` con `recoverToStatus`/`errorKind` viejos, no hay doble orden inmediato, pero queda
  estado fantasma que puede contaminar futuras transiciones.

Ajuste requerido:

- Cuando `gate.policy === "error"`, persistir `errorKind:"fatal"` y limpiar campos de recovery
  (`recoverToStatus`, contadores/backoff si corresponde).
- Cuando `gate.policy === "paused"`, limpiar `errorKind`, `errorMessage` y `recoverToStatus` si el bot venia de
  una recuperacion, o documentar explicitamente por que se conservan.
- Extender `setSpotGridStatus` para aceptar/limpiar `recoverToStatus` o crear mutations especificas para estos
  outcomes.

### 2. GO - Terminalidad accionable por `MAX_ERROR_RECOVERIES` esta cerrada para el caso normal

Evidencia:

- `bumpSpotGridErrorRecovery` setea un texto accionable al alcanzar el tope.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:200-208`
- La UI muestra `bot.errorMessage` cuando el bot esta en `error`.
  - `src/components/SpotGridView.jsx:350`
- La query deja de devolver bots con `errorRecoveryAttempts >= SPOT_GRID_MAX_ERROR_RECOVERIES`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:281-287`

Condicion:

- El ajuste del hallazgo alto #1 debe aplicar tambien al caso `recoverToStatus` ausente, porque hoy ese caso no
  consume intentos ni llega al mensaje accionable.

### 3. GO - Constantes en modulo hoja non-node cierra el riesgo de import contaminado

Evidencia:

- Rev.5 mueve `SPOT_GRID_*` a `convex/spotGridConstants.ts`, sin `"use node"`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:70-74`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:116-127`
- `classifySpotGridError` queda en tierra node porque depende de `TransportError`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:129-143`

Impacto:

- `spotGridBots.ts` puede importar constantes sin arrastrar el SDK/node graph.

## Bajo

### 1. GO condicionado - `markSpotGridReconcileSuccess` no necesita revalidar status si solo resetea contadores

Evidencia:

- El plan limita la mutation a `{ transientFailCount: 0, nextRetryAt: 0, updatedAt }`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:220-227`
- El prompt r4/r5 conserva la pregunta de simetria con el path de recovery.
  - `docs/audit-prompt-jav122-plan.md:57-61`

Impacto:

- Un reset de contadores/backoff sobre un bot pausado concurrentemente es inocuo para el money-path: no cambia
  `status` ni coloca ordenes.

Condicion:

- No ampliar esta mutation para limpiar `errorKind`, `errorMessage` o `recoverToStatus`; esas limpiezas deben
  vivir en outcomes explicitamente recuperados/fatales.

### 2. GO - Clasificacion `TransportError` y no-HTML siguen cubiertos a nivel de diseno

Evidencia:

- El repo ya usa `e instanceof TransportError` como separador canonico de transporte vs determinista.
  - `convex/hyperliquid.ts:6`
  - `convex/hyperliquid.ts:238-253`
  - `convex/hyperliquid.ts:591-597`
- Las llamadas HL principales del reconcile son JS planas en el mismo contexto del catch del loop; no cruzan
  `runMutation` antes de llegar al catch.
  - `convex/spotGridEngine.ts:702-720`
  - `convex/hyperliquidSpot.ts:291-347`
- Los catches de ordenes que hoy persisten `safeError(e)` estan identificados para pasar por el clasificador.
  - `convex/spotGridEngine.ts:595-601`
  - `convex/spotGridEngine.ts:671-676`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:235-248`
- Las actions user-facing quedan saneadas sin cambiar validaciones deterministas.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:250-265`

Condicion:

- En implementacion, ningun path money que pueda recibir `TransportError` debe persistir o relanzar
  `safeError(e)` directamente hacia UI.

## Checklist GO/NO-GO pedido

1. **Clasificacion correcta y completa: GO.** `TransportError` cubre transporte de HL sin parsear HTML; los
   errores deterministas quedan fatales. Las excepciones HL relevantes no cruzan `runMutation` antes del catch
   principal.
2. **No exponer HTML nunca: GO condicionado.** El plan cubre bot, ordenes y actions; queda como disciplina de
   implementacion no dejar `safeError(e)` en paths de UI/persistidos que vean `TransportError`.
3. **Fencing / lease: GO condicionado.** Las mutations nuevas estan bajo `leaseOk` y antes del `release`; los
   bumps calculan contadores dentro de la mutation. Vigilar lease vencido como outcome no-op.
4. **Convergencia / origen: GO condicionado.** `claim.wasError` es el origen correcto. `markSpotGridReconcileSuccess`
   no necesita revalidacion de status mientras sea solo contadores/backoff.
5. **Recuperacion segura money-path: GO condicionado.** `recoverToStatus` cierra `paused -> running`, pero falta
   hacer terminal/excluido el caso `recoverToStatus` ausente.
6. **Tope y estado terminal: NO-GO parcial.** El tope normal queda accionable, pero el branch sin
   `recoverToStatus` no consume tope ni sale de la query.
7. **Legacy-safe: NO-GO.** Campos opcionales bien planteados, salvo `recoverToStatus` ausente: no revive, pero
   tampoco converge.
8. **Huecos nuevos: NO-GO.** Falta limpiar/terminalizar `recoverToStatus` al ir a fatal/gate y falta sacar de
   recovery los bots sin estado de retorno.

## Hechos positivos verificados

- Lei la version actual: `Rev.5` en `docs/plan-jav122-spotgrid-transient-recovery.md:57-74` y `RONDA 5` en
  `docs/audit-prompt-jav122-plan.md:63-80`.
- El bloqueante r4 de reactivar pausados esta cerrado a nivel de diseno con `recoverToStatus`.
- Los dos medios r4 estan cerrados para el caso normal: terminalidad visible al tope y constantes en modulo
  hoja non-node.

## Comandos revisados

- `git status --short`
- `rg -n "Rev\\.5|RONDA 5|recoverToStatus|MAX_ERROR_RECOVERIES|spotGridConstants|markSpotGridReconcileSuccess|recoverSpotGridFromError|bumpSpotGridErrorRecovery|bumpSpotGridTransient" docs/plan-jav122-spotgrid-transient-recovery.md docs/audit-prompt-jav122-plan.md`
- `nl -ba docs/plan-jav122-spotgrid-transient-recovery.md`
- `nl -ba docs/audit-prompt-jav122-plan.md`
- `nl -ba docs/audit-jav122-plan-codex-r4.md`
- `nl -ba convex/spotGridEngine.ts`
- `nl -ba convex/spotGridBots.ts`
- `nl -ba convex/spotGridActions.ts`
- `nl -ba convex/schema.ts`
- `nl -ba convex/log.ts`
- `nl -ba convex/hyperliquid.ts`
- `nl -ba convex/hyperliquidSpot.ts`
- `nl -ba convex/triggerRearm.ts`
- `nl -ba src/components/SpotGridView.jsx`
- `rg -n "pauseSpotGridBot|resumeSpotGridBot|status: \"running\"|status: \"paused\"|setSpotGridStatus\\(|recoverToStatus|errorKind|nextRetryAt|transientFailCount|errorRecoveryAttempts" convex src docs/plan-jav122-spotgrid-transient-recovery.md`
- `rg -n "policy: \"error\"|policy: \"paused\"|assertSpotGridLiveAdmissibleInternal|setSpotGridStatus, \\{ botId: bot\\._id, token, status: gate.policy" convex/spotGridBots.ts convex/spotGridEngine.ts docs/plan-jav122-spotgrid-transient-recovery.md`

No ejecute typecheck ni tests: sigue siendo auditoria estatica de plan, sin codigo implementado.

## Cierre

No daria GO hasta ajustar el tratamiento de `recoverToStatus` ausente y la limpieza de campos de recovery al
salir del estado transitorio. La parte money-path que motivo r4 esta corregida; el NO-GO r5 es de convergencia,
legacy-safe y terminalidad accionable.
