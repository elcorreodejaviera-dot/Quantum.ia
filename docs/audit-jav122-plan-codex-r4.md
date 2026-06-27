# Auditoria Codex - JAV-122 plan Spot Grid transient recovery - r4

## Alcance

Reauditoria de la **Rev.4** del plan `docs/plan-jav122-spotgrid-transient-recovery.md` y del prompt
**Ronda 4** `docs/audit-prompt-jav122-plan.md`, contra el codigo actual del motor Spot Grid.

Archivos revisados:

- `docs/plan-jav122-spotgrid-transient-recovery.md`
- `docs/audit-prompt-jav122-plan.md`
- `docs/audit-jav122-plan-codex-r3.md`
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

La Rev.4 cierra correctamente el NO-GO r3: `claimSpotGridReconcile` devuelve `wasError` leido de DB bajo el lease, y `recoverSpotGridFromError` / `bumpSpotGridErrorRecovery` revalidan que el bot siga en `error` + `errorKind:"transient"`. Pero queda un bloqueo money-path: el plan recupera siempre a `status:"running"`, incluso si el bot que escalo a `error` venia de `paused`. Un bot pausado puede terminar reactivado por una recuperacion automatica.

## Bloqueante

### 1. NO-GO - La recuperacion siempre vuelve a `running` y puede reactivar un bot que estaba `paused`

Evidencia:

- El cron actual reconcilia bots `running` y `paused`.
  - `convex/spotGridBots.ts:702-708`
- La Rev.4 mantiene el path activo como `running/paused`: el claim admite activos y el reset de exito se declara para "running o paused".
  - `docs/plan-jav122-spotgrid-transient-recovery.md:16-18`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:256-262`
- `bumpSpotGridTransient` escala a `status:"error"` sin registrar si el estado previo era `running` o `paused`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:162-169`
- `recoverSpotGridFromError` siempre parchea `status:"running"`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:176-181`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:264-271`
- En el motor actual, `reconcileOneBot` decide si coloca nuevas ordenes con `isRunning = bot.status === "running"`.
  - `convex/spotGridEngine.ts:526-528`

Escenario:

1. Usuario deja el grid en `paused`.
2. El cron sigue reconciliando el bot pausado para observar estado/fills.
3. HL falla de forma transitoria durante varios ticks; `bumpSpotGridTransient` escala el bot pausado a `error` + `errorKind:"transient"`.
4. HL vuelve a responder; la recuperacion automatica ejecuta `recoverSpotGridFromError`.
5. El plan lo devuelve a `running`, no a `paused`; el siguiente tick puede volver a colocar ordenes.

Impacto:

- Money-path: una pausa del usuario puede quedar anulada despues de un periodo de errores transitorios.
- Esto cambia semantica operacional: "paused" deja de ser estable si el bot pasa por `error` transitorio.

Ajuste requerido:

- Persistir el estado de retorno al escalar, por ejemplo `recoverToStatus: "running" | "paused"` o `preErrorStatus`.
- `bumpSpotGridTransient`, al escalar, debe guardar `recoverToStatus = bot.status === "paused" ? "paused" : "running"`.
- `recoverSpotGridFromError` debe volver a ese estado, no siempre a `running`.
- Para legacy sin `recoverToStatus`, definir explicitamente el default. Recomendacion conservadora: si falta, no revivir a `running` sin una decision explicita, o default documentado con test.
- Agregar test: bot `paused` + 12 transitorios -> `error` transient -> recovery OK -> queda `paused` y no `running`.

## Alto

### 1. GO condicionado - El cierre de la carrera r3 es correcto si se implementa literalmente

Evidencia:

- Rev.4 mueve el origen a `claim.wasError`, leido de DB al tomar el lease.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:46-55`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:123-128`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:256-262`
- `recoverSpotGridFromError` y `bumpSpotGridErrorRecovery` revalidan bajo `leaseOk` que el bot siga en `status:"error"` + `errorKind:"transient"`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:170-181`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:264-278`
- El test de carrera queda incorporado.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:323-327`

Impacto:

- Cierra el riesgo de que un snapshot rancio de la lista reviva una pausa/stop concurrente.

Condicion:

- En codigo, `claimSpotGridReconcile` debe devolver `wasError` desde el documento que acaba de leer/claimar, no recalculado en la action.
- `recoverSpotGridFromError` debe ser no-op si la revalidacion falla, como dice el plan.

### 2. GO condicionado - El path activo (`markSpotGridReconcileSuccess`) no necesita la misma revalidacion de status, pero debe ser estrictamente no-status

Evidencia:

- `markSpotGridReconcileSuccess` se limita a `{ transientFailCount:0, nextRetryAt:0, updatedAt }`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:183-190`
- No cambia `status`, `errorKind`, ordenes ni inventario.

Impacto:

- Si un usuario pausa concurrentemente un bot activo, un reset de contadores/backoff sobre el bot pausado es inocuo respecto al money-path: no lo vuelve a `running`.

Condicion:

- Mantener `markSpotGridReconcileSuccess` estrictamente limitado a contadores/backoff. No debe limpiar `errorKind`, `errorMessage` ni tocar `status`.

## Medio

### 1. GO condicionado - Terminalidad por tope sigue siendo implicita

Evidencia:

- El plan define que al superar `SPOT_GRID_MAX_ERROR_RECOVERIES`, la query deja de devolver el bot.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:272-278`
- La UI actual muestra `bot.errorMessage` cuando el bot esta en `error`.
  - `src/components/SpotGridView.jsx:350`

Impacto:

- El bot queda terminal por ausencia de reintentos, pero el usuario puede no distinguir "seguira reintentando" vs "agotado".

Condicion:

- Al llegar al tope, actualizar `errorMessage` a un texto accionable o agregar un campo visible/alerta de terminalidad.

### 2. GO condicionado - Constantes compartidas siguen declaradas en `spotGridEngine.ts`

Evidencia:

- El plan ubica las constantes en `spotGridEngine.ts`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:93-101`
- Las nuevas mutations y query viven en `spotGridBots.ts`, que es non-node y ya evita importar desde modulos `"use node"` duplicando constantes.
  - `convex/spotGridBots.ts:16-22`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:158-181`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:244-250`

Impacto:

- Implementar literalmente un import desde `spotGridEngine.ts` hacia `spotGridBots.ts` puede contaminar el modulo non-node o romper tests.

Condicion:

- Mover constantes compartidas a un helper hoja non-node o duplicarlas explicitamente en `spotGridBots.ts`.

## Bajo

### 1. GO - Clasificacion, no-HTML, cron 1 min y legacy-safe estan cubiertos a nivel de plan

Evidencia:

- `HttpRequestError` del SDK extiende `TransportError`; `ApiRequestError` no.
  - `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts:61-88`
  - `node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/_base/errors.ts:37-50`
- El plan cubre bot, ordenes y actions user-facing con `classifySpotGridError`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:198-228`
- El cron esta corregido a 1 min.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:93-99`
  - `convex/crons.ts:49-52`
- DoD incluye los cuatro campos opcionales.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:340-342`

## Checklist GO/NO-GO pedido

1. **Clasificacion correcta y completa: GO.** `TransportError` cubre 502/timeout/red y no cubre `ApiRequestError`.
2. **No exponer HTML nunca: GO condicionado.** El plan cubre persistidos y actions; condicion: implementar wrapper sin romper `finally` de stop.
3. **Fencing / lease: GO condicionado.** Las mutations nuevas estan planteadas bajo `leaseOk`; `claim.wasError` y revalidacion de recover cierran la carrera r3.
4. **Convergencia / origen: GO condicionado.** El origen por claim es correcto. `markSpotGridReconcileSuccess` no necesita revalidar status si no toca status.
5. **Recuperacion money-path: NO-GO.** Falta preservar si el bot era `paused` antes de escalar a `error`; recovery no debe volver siempre a `running`.
6. **Tope / estado terminal: GO condicionado.** El tope funciona, pero debe quedar accionable/visible.
7. **Legacy-safe: GO condicionado.** Los cuatro campos estan contemplados; si se agrega `recoverToStatus`, debe ser opcional y con default seguro.
8. **Huecos nuevos: NO-GO por recuperacion de paused->running.**

## Hechos positivos verificados

- Rev.4 confirma que lei la version actual: encabezado `Rev.4` en `docs/plan-jav122-spotgrid-transient-recovery.md:46-55` y `RONDA 4` en `docs/audit-prompt-jav122-plan.md:46-61`.
- El NO-GO r3 de `wasError` stale queda cerrado en el diseño.
- La pregunta del prompt sobre simetria del path activo: no veo necesidad de revalidacion equivalente para `markSpotGridReconcileSuccess` mientras no toque `status`.

## Comandos revisados

- `git status --short`
- `stat -c '%y %n' docs/plan-jav122-spotgrid-transient-recovery.md docs/audit-prompt-jav122-plan.md docs/audit-jav122-plan-codex-r3.md`
- `nl -ba docs/plan-jav122-spotgrid-transient-recovery.md`
- `nl -ba docs/audit-prompt-jav122-plan.md`
- `nl -ba convex/spotGridEngine.ts`
- `nl -ba convex/spotGridBots.ts`
- `nl -ba convex/spotGridActions.ts`
- `rg -n "pauseSpotGridBot|resume|setSpotGridStatus|status: \"paused\"|status: \"running\"|claimSpotGridReconcile"`

No ejecute typecheck ni tests: sigue siendo auditoria estatica de plan, sin codigo implementado.

## Cierre

No daria GO hasta que el plan preserve el estado previo a `error` (`running` vs `paused`) y `recoverSpotGridFromError` restaure ese estado, no siempre `running`. El cierre r3/r4 de carrera esta bien encaminado; este es el bloqueo restante.
