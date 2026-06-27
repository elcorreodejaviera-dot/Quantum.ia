# Auditoria Codex - JAV-122 plan Spot Grid transient recovery - r6

## Alcance

Reauditoria de la **Rev.6** del plan `docs/plan-jav122-spotgrid-transient-recovery.md` y del prompt
**Ronda 6** `docs/audit-prompt-jav122-plan.md`, contra el codigo actual del motor Spot Grid.

Archivos revisados:

- `docs/plan-jav122-spotgrid-transient-recovery.md`
- `docs/audit-prompt-jav122-plan.md`
- `docs/audit-jav122-plan-codex-r5.md`
- `convex/spotGridEngine.ts`
- `convex/spotGridBots.ts`
- `convex/schema.ts`
- `src/components/SpotGridView.jsx`

## Veredicto

**GO condicionado.**

Rev.6 cierra los dos NO-GO de r5 a nivel de diseno:

- `recoverToStatus` ausente ya no entra al flujo normal de recovery: la query exige
  `recoverToStatus in {"running","paused"}` y la mutation de defensa terminaliza si igual se invoca.
- La limpieza de estado fantasma queda mapeada para `setSpotGridStatus` y para el caller manual sin lease
  `pauseSpotGridBot`.

No veo un bloqueante money-path restante. Las condiciones de GO son de precision de plan/implementacion: el
claim debe usar el mismo predicate de recuperabilidad que la query, `setSpotGridStatus` debe tener semantica
explicita de borrado de `errorKind`, y hay texto residual viejo que todavia dice "no-op conservador" para
`recoverToStatus` ausente.

## Alto

### 1. GO condicionado - `recoverToStatus` ausente ya no queda en recovery infinito

Evidencia:

- Rev.6 agrega el cierre doble pedido en r5.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:76-83`
- La query recuperable exige `status==="error"`, `errorKind==="transient"`, backoff vencido, intentos bajo
  tope y `recoverToStatus in {"running","paused"}`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:300-308`
- La defensa de `recoverSpotGridFromError` terminaliza si falta `recoverToStatus`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:327-334`
- El test #15 cubre tanto que la query no lo devuelva como que una invocacion forzada terminalice.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:419-422`

Impacto:

- Cierra el bucle `claim -> recover no-op -> claim` que quedaba en r5.
- La eleccion de no default a `paused` es conservadora y correcta: no inventa intencion operacional.

Condicion:

- El predicate de `claimSpotGridReconcile` debe espejar el predicate de la query para `error` recuperable:
  `errorKind==="transient"`, `recoverToStatus` valido, `nextRetryAt<=now` y
  `errorRecoveryAttempts < SPOT_GRID_MAX_ERROR_RECOVERIES`.
- Hoy el texto del plan describe el claim mas laxo: `status === "error" && errorKind === "transient"`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:314-316`
- Aunque la lista normal ya filtra, el claim es el punto autoritativo bajo lease. Si el estado cambia entre
  listar y claimar, o si otro caller interno invoca el claim, no deberia reclamar estados que la query ya
  considera terminales/no recuperables.

### 2. GO condicionado - No hay reactivacion de pausados

Evidencia:

- La escalada guarda `recoverToStatus = bot.status === "paused" ? "paused" : "running"`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:208-217`
- La recuperacion restaura `bot.recoverToStatus`, no siempre `running`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:227-238`
- El motor actual solo coloca con `isRunning = bot.status === "running"`.
  - `convex/spotGridEngine.ts:524-528`
- El test #13 cubre `paused -> error transient -> recovery -> paused`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:412-416`

Condicion:

- Mantener sin fallback a `running`. La rama sin `recoverToStatus` debe seguir siendo terminal/excluida, no
  default `running` ni default `paused`.

## Medio

### 1. GO condicionado - La limpieza de estado fantasma esta bien mapeada, pero `errorKind` necesita borrado explicito

Evidencia:

- Rev.6 define que `setSpotGridStatus` normaliza `recoverToStatus`, `transientFailCount`,
  `errorRecoveryAttempts` y `nextRetryAt` en transiciones que no son la escalada error-transient.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:202-207`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:344-353`
- El gate-loop debe pasar `errorKind:"fatal"` para `policy:"error"` y limpiar `errorKind` en
  `policy:"paused"`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:347-353`
  - `convex/spotGridEngine.ts:702-708`
- `pauseSpotGridBot` es correctamente identificado como caller manual sin lease y debe limpiar su propio
  estado.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:355-362`
  - `convex/spotGridBots.ts:257-264`
- Los callers actuales de `setSpotGridStatus` en stop/gate/fatal son no-error-transient.
  - `convex/spotGridEngine.ts:706`
  - `convex/spotGridEngine.ts:719`
  - `convex/spotGridEngine.ts:771`
  - `convex/spotGridEngine.ts:789`
  - `convex/spotGridEngine.ts:816`
  - `convex/spotGridEngine.ts:826`
  - `convex/spotGridEngine.ts:831`

Riesgo de implementacion:

- El plan dice "persistir `errorKind` cuando se pasa", pero tambien dice que `gate.policy==="paused"` pasa
  `errorKind: undefined` para limpiar. Esa semantica debe ser explicita en codigo, porque un loop tipo
  `if (a.errorKind !== undefined) patch.errorKind = a.errorKind` no borra el campo.
- Los paths de stop ponen `status:"error"` sin `errorKind`. Si el bot venia de `errorKind:"transient"` y el
  patch no borra `errorKind`, puede quedar un error no recuperable con clasificacion vieja.

Condicion:

- Definir una semantica clara: para `status !== "error"`, borrar `errorKind` y `errorMessage` si corresponde;
  para `status === "error"` sin `errorKind:"transient"`, borrar o setear `errorKind:"fatal"` segun el caso.
- En particular, los errores de stop son no-transient y deberian quedar `errorKind:"fatal"` o `errorKind`
  borrado, pero nunca conservar un `transient` previo.

### 2. GO condicionado - `pauseSpotGridBot` queda cubierto como caller manual sin lease

Evidencia:

- El codigo actual permite pausar cualquier bot que no este `stopped`, incluido `error`.
  - `convex/spotGridBots.ts:257-264`
- Rev.6 agrega limpieza explicita para `pauseSpotGridBot`: `errorKind`, `errorMessage`, `recoverToStatus`,
  contadores y backoff.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:355-362`
- El test #17 cubre el caso.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:428-431`

Condicion:

- Implementar la limpieza en el patch directo de `pauseSpotGridBot`; no depender de `setSpotGridStatus`, porque
  esta mutation no tiene lease/token.

### 3. GO condicionado - Queda texto residual contradictorio sobre `recoverToStatus` ausente

Evidencia:

- La seccion Rev.6 y el flujo principal dicen que ausencia de `recoverToStatus` no se reclama y, si se fuerza,
  terminaliza.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:76-83`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:331-334`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:419-422`
- Pero aun hay texto viejo que dice que `recoverSpotGridFromError` es no-op conservador o que la variante legacy
  queda en error por no-op.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:126-129`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:415-416`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:451-454`

Impacto:

- No cambia la intencion de Rev.6, pero si deja una instruccion ambigua para quien implemente.

Condicion:

- Actualizar esas tres referencias para decir: sin `recoverToStatus` no entra en la query recuperable; si
  `recoverSpotGridFromError` se invoca igualmente, terminaliza con `errorKind:"fatal"` y mensaje accionable.

## Bajo

### 1. GO condicionado - `setSpotGridBootstrap` escribe `status:"error"` fuera de `setSpotGridStatus`

Evidencia:

- El bootstrap determinista usa `setSpotGridBootstrap({ status:"error" })`.
  - `convex/spotGridEngine.ts:419`
  - `convex/spotGridEngine.ts:430`
  - `convex/spotGridEngine.ts:447`
  - `convex/spotGridEngine.ts:472`
  - `convex/spotGridEngine.ts:486`
- El plan dice pasar `errorKind:"fatal"` en esos casos.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:287-290`

Impacto:

- No veo un camino normal donde esto deje `recoverToStatus` fantasma: el bootstrap solo coloca si el bot esta
  `running`, y la recuperacion limpia campos antes de volver a `running`.
- Aun asi, por consistencia con la regla "toda transicion no-error-transient limpia recovery", conviene que
  `setSpotGridBootstrap` tambien limpie campos de recovery cuando setea `status:"error"` fatal.

## Checklist GO/NO-GO pedido

1. **Clasificacion correcta y completa: GO.** Sin cambios frente a r5: `TransportError` sigue siendo el
   criterio correcto para transporte HL; deterministas quedan fatales.
2. **No exponer HTML nunca: GO condicionado.** Mantener los wrappers `classifySpotGridError` en bot, ordenes y
   actions user-facing.
3. **Fencing / lease: GO condicionado.** Las mutations nuevas estan bajo `leaseOk`; condicion nueva: el claim
   debe espejar el predicate completo de recuperabilidad.
4. **Convergencia / origen: GO condicionado.** `claim.wasError` sigue siendo correcto; `recoverToStatus`
   ausente ya no queda en bucle si se implementa Rev.6 literalmente.
5. **Recuperacion segura money-path: GO condicionado.** `paused` se preserva; no hay reactivacion automatica
   de bots pausados.
6. **Tope / estado terminal: GO condicionado.** El tope normal es accionable; ausencia de `recoverToStatus`
   debe quedar terminal/excluida y no descrita como no-op.
7. **Legacy-safe: GO condicionado.** Los campos opcionales son seguros, con la condicion de quitar el texto
   viejo de no-op y reflejar el predicate completo en claim/query.
8. **Huecos nuevos: GO condicionado.** No veo doble-orden ni fatal reintentando para siempre; los riesgos
   restantes son de precision de implementacion.

## Hechos positivos verificados

- Lei la version actual: `Rev.6` en `docs/plan-jav122-spotgrid-transient-recovery.md:76-89` y `RONDA 6` en
  `docs/audit-prompt-jav122-plan.md:82-101`.
- El mapeo de callers de `setSpotGridStatus` es correcto para los paths principales; el caller manual
  `pauseSpotGridBot` fue identificado y cubierto.
- No hay `resume` en la UI revisada; las acciones visibles son pause/stop/delete/create.
  - `src/components/SpotGridView.jsx:295-340`

## Comandos revisados

- `git status --short docs/plan-jav122-spotgrid-transient-recovery.md docs/audit-prompt-jav122-plan.md docs/audit-jav122-plan-codex-r6.md`
- `rg -n "Rev\\.6|RONDA 6|recoverToStatus|listRecoverableErrorSpotGridBotsInternal|setSpotGridStatus|pauseSpotGridBot|gate\\.policy|errorKind|terminaliza|fantasma|Tests #15|15\\.|16\\.|17\\." docs/plan-jav122-spotgrid-transient-recovery.md docs/audit-prompt-jav122-plan.md`
- `nl -ba docs/plan-jav122-spotgrid-transient-recovery.md`
- `nl -ba docs/audit-prompt-jav122-plan.md`
- `nl -ba docs/audit-jav122-plan-codex-r5.md`
- `nl -ba convex/spotGridBots.ts`
- `nl -ba convex/spotGridEngine.ts`
- `nl -ba src/components/SpotGridView.jsx`
- `nl -ba convex/schema.ts`
- `rg -n 'recoverToStatus|no-op conservador|SIN `recoverToStatus`|sin `recoverToStatus`|claimSpotGridReconcile|listRecoverableErrorSpotGridBotsInternal|setSpotGridStatus|errorKind: undefined|errorKind:"fatal"|errorKind: "fatal"' docs/plan-jav122-spotgrid-transient-recovery.md docs/audit-prompt-jav122-plan.md convex/spotGridEngine.ts convex/spotGridBots.ts`

No ejecute typecheck ni tests: sigue siendo auditoria estatica de plan, sin codigo implementado.

## Cierre

Daria **GO condicionado** para pasar a implementacion si antes se corrigen las tres ambiguedades:

1. `claimSpotGridReconcile` debe validar la misma recuperabilidad que la query.
2. `setSpotGridStatus` debe borrar/setear `errorKind` de forma explicita en transiciones no-transient.
3. El plan debe quitar las referencias viejas a no-op conservador para `recoverToStatus` ausente.
