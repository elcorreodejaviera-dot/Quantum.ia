# Auditoría de CÓDIGO — JAV-107 Fase 3c-3a (break-even) + 3c-3b (auto-rearm)

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de las sub-fases 3c-3a
y 3c-3b (ya implementadas). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No
reescribas el código; señala fallos de corrección, carreras, fencing roto y riesgos money-path. Trabaja
sobre la rama `feat/jav107-spot-defense` (checkout hecho). Plan con GO: `docs/plan-jav107-spot-defense.md`.
Fases 1, 2, 3a, 3b, 3c-1 y 3c-2 ya tuvieron GO de Codex.

## Contexto

Bot que defiende un holding spot con UN SHORT que dispara al CAER el precio a un trigger explícito. El SL
de un short es un **Buy reduceOnly por ENCIMA de la entrada**. 3c-1/3c-2 ya cubren reconcile, SL,
close-confirm, drift, cierre activo y cron. Ahora: **break-even** (3c-3a) y **auto-rearm** (3c-3b).
**Los TPs parciales son Fase 3c-3c — AÚN NO existen** (ver "Cabos sueltos esperados").

## Diff a auditar

### 3c-3a — Break-even (commit `5be9a7e`), `convex/spotDefenseEngine.ts` (fase de posición, SL vivo)
Cuando el SL está confirmado VIVO en HL (`openByCloid`) y `!beMoved` y `arm.breakevenPct>0`:
- `profitFrac = (posEntryPx − markPx) / posEntryPx` (short gana cuando `markPx<entry`).
- `beTrigger = posEntryPx · (1 − BE_OFFSET_FRACTION)` (BE_OFFSET=0.0005, un pelín BAJO la entrada → cubre fees).
- Si `profitFrac ≥ breakevenPct/100` **y** `beTrigger > markPx·(1+1e-4)` (guard anti-auto-disparo):
  `cancelOwnByCloid([slOrder.cloid])` + `setSpotDefenseOrderObserved(sl, "canceled")` +
  `setSpotDefenseBeMoved` (latch one-way) + `beMoved=true; slAlive=false` → fuerza recolocar.
- La recolocación del SL usa `slTriggerPx = beMoved ? posEntryPx·(1−BE_OFFSET) : posEntryPx·(1+stopLossPct/100)`
  y `placeStopLoss(..., slTriggerPx)` (triggerPxOverride). Cloid rota por `attempt = slAttempts+1`.
- Mutation `setSpotDefenseBeMoved(armId, token)` (bajo lease) → `beMoved=true`.

### 3c-3b — Auto-rearm durable (commit `59351c3`)
- `settleSpotDefenseArm` (`convex/spotDefenseBots.ts`): al terminal, si `status==="closed" &&
  closeReason==="sl" && bot.active && bot.status==="running" && bot.autoRearm===true` → patch del bot:
  `rearmStatus:"pending", nextRearmAt: now + SD_REARM_COOLDOWN_MS (5min), rearmAttempts:0`. (NO agenda el
  motor → evita el ciclo de tipos; el cron lo recoge.) El caso `disarmPending` sigue cerrando el bot.
- `listDueSpotDefenseRearmsInternal`: bots con `rearmStatus` pending|blocked, `nextRearmAt<=now`, activos,
  running, sin disarmPending (tope 50).
- `claimSpotDefenseRearm(botId)`: lease (`rearmLeaseToken`/`rearmLeaseUntil`, 2min) → `rearmStatus:"running"`;
  rechaza si lease vivo o si YA hay un arm vivo (en ese caso limpia el rearm).
- `settleSpotDefenseRearm(botId, token, outcome)`: ok|cancel → limpia; transient → pending + backoff 5min;
  blocked → blocked + backoff. Bajo token+lease.
- `processSpotDefenseRearms` (`spotDefenseEngine.ts`, internalAction, cron 1/min vía
  `cronHealth.processSpotDefenseRearmsWithHealth`, `Promise<any>`): por cada bot due → claim → try
  `armSpotDefenseInternal(botId, rearmToken)` → `settleSpotDefenseRearm("ok")`; catch → clasifica el
  prefijo del error (`[cancel]`→cancel, `[blocked`→blocked, resto→transient) → settle con backoff.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **BE — protección durante la transición:** al activar BE se CANCELA el SL actual y se recoloca en
   break-even en el MISMO ciclo. ¿Hay una ventana donde la posición quede sin SL si la recolocación
   falla/timeoutea (placeStopLoss lanza → `protecting`/`sl_rejected`)? ¿El próximo ciclo recoloca el SL
   (ahora con `beMoved=true`) sin volver a dejarla desnuda? ¿Es aceptable o debería colocar el nuevo SL
   ANTES de cancelar el viejo (ambos reduceOnly no sobre-cierran)?
2. **BE — guard anti-auto-disparo:** ¿`beTrigger > markPx·(1+1e-4)` basta para que el nuevo SL (Buy) no
   se dispare al colocarse? Para un short en ganancia `markPx<entry`, `beTrigger≈entry·(1−0.0005)`; ¿puede
   `beTrigger ≤ markPx` en algún caso (p.ej. ganancia mínima ~breakevenPct pequeño) y disparar el SL al
   instante (cierre a break-even prematuro)? ¿El latch `beMoved` evita reactivaciones/flapping?
3. **BE — fencing:** `setSpotDefenseBeMoved` y el cancel+recoloca corren bajo el lease del reconcile;
   ¿pueden perder el lease entre el cancel del SL viejo y la recolocación? ¿`beMoved` se persiste antes
   de recolocar (si crashea después del setBeMoved, el próximo ciclo recoloca en BE correctamente)?
4. **Auto-rearm — no rearmar lo que no toca:** ¿el gate `closeReason==="sl" && !disarmPending &&
   bot.active && autoRearm` evita rearmar tras un cierre MANUAL/disarm/emergency o con el bot pausado?
   ¿Un cierre por `manual` (SL no confirmado en la rama flat) puede colarse como rearmable?
5. **Auto-rearm — anti-doble / carreras:** `claimSpotDefenseRearm` rechaza si hay arm vivo y toma lease.
   ¿Dos ejecuciones del cron concurrentes pueden rearmar dos veces el mismo bot? ¿`armSpotDefenseInternal`
   (que crea un arm nuevo, unicidad 1-arm-no-terminal + CAS) cierra la ventana? ¿El `rearmToken` se usa
   para algo en el arm o solo es el lease del bot (no se consume en `reserveSpotDefenseArm`)?
6. **Auto-rearm — clasificación del error:** mapear por substring del mensaje (`[cancel]`/`[blocked`)
   ¿es robusto? Si `armSpotDefenseInternal` lanza `[transient]` (mark≤trigger: el trigger nacería
   disparado) tras un SL, ¿reintentar con backoff indefinido es correcto (el precio aún no se recuperó),
   o debería haber un tope de intentos / alerta de whipsaw (como el pool)?
7. **Auto-rearm — flat al rearmar:** `armSpotDefenseInternal` exige precondición FLAT + sin órdenes del
   coin. Tras un cierre por SL, ¿la posición está realmente flat y sin órdenes residuales cuando el cron
   rearma (cooldown 5min + el reconcile ya canceló/cerró)? ¿Puede el rearm chocar con un SL residual no
   cancelado?
8. **Secretos/logs + TS2589:** ¿algún `elog`/throw filtra payload sensible? ¿Las anotaciones `Promise<any>`
   en los wrappers de cron y handlers cíclicos siguen conteniendo la cascada de tipos?

## Cabos sueltos ESPERADOS (Fase 3c-3c, NO bloqueantes)
- TPs parciales (Buy reduceOnly por DEBAJO de la entrada) aún no se colocan; el detector de drift usa
  `expected = arm.size` (sin restar TPs cerrados, porque aún no hay TPs).
- No hay tope de intentos de rearm / alerta de whipsaw (consecutiveStops) todavía.
- El arranque del arm al CREAR el bot lo hará la action de creación de Fase 4 (hoy `persist` no arma).
- No hay deadline de emergencia del SL (SL_PROTECT_DEADLINE) todavía.

Devuelve: hallazgos (severidad + descripción + fix) y veredicto **GO / NO-GO** para 3c-3a+3c-3b.
Verde actual: `npm run typecheck` EXIT 0, `npm test` 233/233.
