# Auditoría de CÓDIGO — JAV-107 Fase 3c-2: cierre activo en pausa + cron 1/min + stop

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de la sub-fase 3c-2 (ya
implementada). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas el
código; señala fallos de corrección, carreras, fencing roto y riesgos money-path. Trabaja sobre la rama
`feat/jav107-spot-defense` (checkout hecho). Plan con GO: `docs/plan-jav107-spot-defense.md`. Fases 1,
2, 3a, 3b y 3c-1 ya tuvieron GO de Codex.

## Contexto

Bot que defiende un holding spot con UN SHORT que dispara al CAER el precio a un trigger explícito.
3c-1 cerró el reconcile (fill→SL→close-confirm + drift). 3c-2 añade: cierre ACTIVO cuando se pausa con
posición abierta, el cron 1/min, y el stop. **BE (break-even), TPs parciales y auto-rearm son Fase 3c-3 —
AÚN NO existen** (ver "Cabos sueltos esperados").

## Diff a auditar (commit `b150494`)

### `convex/spotDefenseEngine.ts` — `reconcileSpotDefenseArm` (fase de posición, rama wantDisarm)
Tras la rama `flat` (cierre natural) y la limpieza de `closeConfirmSince`, ANTES del bloque SL:
```
if (wantDisarm) {              // posición ABIERTA + pausa/kill
  await ensureSpotDefenseOrdersDead(info, exchange, user, assetId, ownCloids);   // cancela SL/entry propios
  await setSpotDefenseEmergencyClosing(value:"disarm");
  const renewC = renewSpotDefenseReconcile(...); if (!renewC.ok) return lease_lost;
  // market close del SHORT = BUY reduceOnly, IOC, banda agresiva (mark*1.02), size = floor(realSize, szDecimals)
  exchange.order({ orders:[{ a:assetId, b:true, p:aggressiveHlPriceStr(mark*1.02), s:floor(realSize), r:true, t:{limit:{tif:"Ioc"}} }], grouping:"na" })  // sin cloid, try/catch
  return { result:"closing" };
}
```
La rama `flat` ahora calcula `closeReason = emergencyClosing==="disarm"?"disarm": emergencyClosing==="emergency"?"emergency": slConfirmed?"sl":"manual"`.

### `convex/spotDefenseEngine.ts` — `reconcileAllSpotDefense` (internalAction, cron)
`listLiveSpotDefenseArmIdsInternal` (tope 200) → por cada armId `ctx.runAction(reconcileSpotDefenseArm)`
en try/catch (un fallo no aborta el barrido). Anotado `Promise<any>`.

### `convex/spotDefenseBots.ts`
- `listLiveSpotDefenseArmIdsInternal`: recorre los estados VIVOS (`SD_LIVE_STATUSES`, incluye
  `manual_intervention`) por índice `by_status_updated`, topado a `limit ?? 200`.
- `setSpotDefenseEmergencyClosing(armId, token, "emergency"|"disarm")` bajo lease.
- `pauseSpotDefenseBot`: con arm vivo → `disarmPending` (el cron cierra); SIN arm vivo →
  `active:false,status:"stopped"` directo. Anotado `Promise<any>`.
- `persistSpotDefenseBot`: ya NO agenda el motor (se rompió el ciclo de tipos spotDefenseBots↔engine; el
  arranque del arm lo hará la action de creación de Fase 4).

### `convex/cronHealth.ts` + `convex/crons.ts`
`reconcileSpotDefenseWithHealth` (wrapper best-effort, `Promise<any>`) + cron "reconcile spot defense"
cada 1 min.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **Cierre activo (market close):** ¿el BUY reduceOnly IOC con `size=floor(realSize)` cierra el SHORT
   sin riesgo de sobre-cierre/invertir la posición (reduceOnly lo acota)? ¿La banda `mark*1.02` basta
   para llenar en un gap? ¿Repetir el market close cada ciclo hasta confirmar flat es seguro (reduceOnly
   ⇒ no-op si ya flat)? ¿Conviene cloid para idempotencia o el reduceOnly+flat-check es suficiente?
2. **Orden de operaciones en wantDisarm:** se cancela (`ensureSpotDefenseOrdersDead`) ANTES del market
   close. ¿Correcto cancelar el SL antes de cerrar (evita que el SL y el close compitan)? Si el market
   close falla (catch), el SL ya está cancelado → ¿la posición queda momentáneamente sin SL hasta el
   próximo ciclo? ¿Es aceptable o debería recolocar/reintentar SL si el close no confirma?
3. **closeReason / emergencyClosing:** ¿`emergencyClosing` se setea bajo lease y la rama flat lo lee
   correctamente para cerrar con `disarm`? ¿Hay un camino donde un cierre por SL real se etiquete
   `disarm` (o viceversa) y eso afecte al auto-rearm de 3c-3 (que solo debe disparar con `sl`)?
4. **Drift vs wantDisarm:** el detector de drift corre ANTES de la rama wantDisarm. Si hay drift Y pausa,
   ¿se marca `manual_intervention` (correcto, no market close ciego) en vez de cerrar? ¿Es el orden deseado?
5. **Cron / barrido:** ¿`listLiveSpotDefenseArmIdsInternal` (tope 200, por estado) puede sufrir
   starvation o saltarse arms si hay >200 vivos? ¿`reconcileAllSpotDefense` aísla fallos por arm
   (try/catch) sin dejar el lease tomado? ¿El lease individual (claim/release en reconcileSpotDefenseArm)
   evita solapamiento entre el cron y el barrido?
6. **pause sin arm:** marcar `stopped`+inactivo directo cuando no hay arm vivo, ¿es seguro (no hay nada
   que cancelar en HL)? ¿Y si hay un arm en estado `arming` sin orden enviada (lo cuenta como vivo →
   disarmPending → el cron lo recupera)?
7. **TS2589 / ciclo de tipos:** quitar el `scheduler.runAfter(internal.spotDefenseEngine.*)` de las
   mutations rompe el ciclo, pero deja el arranque del arm SOLO en manos de la action de creación (Fase 4)
   y del cron (que NO crea arms nuevos, solo reconcilia existentes). ¿Hay riesgo de que un bot quede
   `active` sin arm si la action de creación falla tras persistir? (¿debería el cron detectar bots activos
   sin arm y armarlos, o es responsabilidad de la action/UI?)
8. **Secretos/logs:** ¿algún `elog`/throw filtra clave/payload sensible?

## Cabos sueltos ESPERADOS (Fase 3c-3, NO bloqueantes)
- BE (mover SL a break-even al alcanzar `breakevenPct`) y TPs parciales aún no se colocan (`void markPx`).
- Auto-rearm durable (reabrir tras un cierre por `sl` si `bot.autoRearm`) aún no existe; `closeReason:"sl"`
  ya se persiste para habilitarlo.
- El arranque del arm al crear el bot lo hará la action de creación de Fase 4 (hoy `persist` no arma).
- `slAttempts` no tiene deadline de emergencia (SL_PROTECT_DEADLINE) todavía.

Devuelve: hallazgos (severidad + descripción + fix) y veredicto **GO / NO-GO** para 3c-2.
Verde actual: `npm run typecheck` EXIT 0, `npm test` 230/230.
