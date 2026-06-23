# Auditoría de CÓDIGO — JAV-107 Fase 3c-3c (TPs parciales + drift detector ajustado)

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de la sub-fase 3c-3c
(ya implementada, commit `ab20e53`). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO /
BAJO). No reescribas el código; señala fallos de corrección, carreras, fencing roto y riesgos money-path.
Trabaja sobre la rama `feat/jav107-spot-defense` (checkout hecho). Plan con GO:
`docs/plan-jav107-spot-defense.md`. Fases 1, 2, 3a, 3b, 3c-1, 3c-2 y 3c-3a+3c-3b ya tuvieron GO de Codex
(la última, 3c-3a+3c-3b, en r5 sobre `83efb5c`).

## Contexto

Bot que defiende un holding spot con UN SHORT que dispara al CAER el precio a un trigger explícito. El SL
de un short es un **Buy reduceOnly por ENCIMA de la entrada**. Las fases previas cubren reconcile, SL,
close-confirm, drift, cierre activo, cron, break-even (3c-3a) y auto-rearm (3c-3b). Ahora 3c-3c añade:
**TPs parciales** (toma de ganancias del short = Buy reduceOnly por DEBAJO de la entrada) y el **ajuste
del detector de drift** para que un TP llenado NO se confunda con intervención manual.

## Diff a auditar — commit `ab20e53`, 2 archivos de código + 1 test

### A) `recordSpotDefenseTpOrder` (`convex/spotDefenseBots.ts`)
- Upsert idempotente de un TP (`role:"tp"`, único por `tpIndex`) bajo lease del reconcile
  (`reconcileLeaseToken` + `reconcileLeaseUntil > now`, si no `ok:false`).
- Si existe la fila → `patch` de `observedStatus/triggerPx/size/cloid/updatedAt` (+`oid` si viene,
  +`submittedAt=now` solo si `markSubmitted`). Si no → `insert` con `reduceOnly:true`.

### B) Confirmación de fills de TP ANTES del drift (`convex/spotDefenseEngine.ts`, rama de posición)
- Antes del detector de drift, recorre `tpOrders` (`role:"tp"`) y por cada uno: `fillsByCloid(tp.cloid)`;
  si `size>0` → `filledTpQty += tf.size` y, si la fila no estaba `filled`, `setSpotDefenseOrderObserved`
  → `"filled"`.
- **Drift ajustado:** `expected = max(0, arm.size − filledTpQty)` y el gate ahora exige
  `!flat && expected > 0 && |realSize − expected| > expected·DRIFT_TOL` (antes `expected = arm.size`).

### C) Colocación de TPs parciales (`convex/spotDefenseEngine.ts`, tras declarar el SL protected/protecting)
- Para cada `tps[i]` de `arm.tps`: si ya hay fila `live` (`filled|open|triggered` o `pending` con
  `submittedAt!=null`) → skip.
- `tpCloid` determinista = `toHlCloid(spotDefenseCloidInput(armId, generation, "tp", 0, i))`. Si
  `openByCloid(tpCloid)` → marca `"open"` y continúa (recovery tras crash).
- `tpTriggerPx = roundHlPrice(posEntryPx·(1 − gainPct/100), szDecimals, "floor")`,
  `tpSize = floorToDecimals(arm.size·closePct/100, szDecimals)`; si `tpSize<=0 || tpTriggerPx<=0` → skip.
- `renewSpotDefenseReconcile` (si `!ok` → `{skipped:"lease_lost"}`), luego **pre-record** `pending`,
  luego `exchange.order` (Buy `b:true`, `r:true` reduceOnly, `t.trigger.isMarket`, `tpsl:"tp"`,
  `triggerPx=formatHlPrice(tpTriggerPx)`, `limitPx = aggressiveHlPriceStr(tpTriggerPx·(1+ENTRY_TRIGGER_SLIPPAGE), ceil)`).
- Mapea status → `filled|open|rejected` (incluye `"waitingForTrigger"`→open), `recordSpotDefenseTpOrder`
  con `markSubmitted:true`; en `catch` → `recordSpotDefenseTpOrder` `"rejected"` (reintenta próximo ciclo),
  `finally` limpia el abort.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **Drift vs TP — consistencia del mismo ciclo:** `filledTpQty` se calcula de `fillsByCloid` y `expected`
   resta esa cantidad **filled**. ¿Es consistente con `realSize` (szi neto del mismo snapshot)? ¿Un fill
   PARCIAL de un TP (`tf.size` < `tpSize`) deja `expected` y `realSize` cuadrados, o puede abrir una
   ventana de falso drift / drift no detectado por desfase de eventual-consistency entre fills y posición?
2. **Drift apagado cuando `expected==0`:** el nuevo gate exige `expected > 0`. Si los TPs cierran casi todo
   (`arm.size − Σfilled ≈ 0`), el drift queda **desactivado**. ¿Es correcto, o puede un residuo manipulado
   (usuario abre tamaño nuevo del mismo coin tras los TPs) quedar sin detección y sin cancelar lo propio?
   ¿Debería el SL recolocarse/encogerse al tamaño restante, o cerrar terminal cuando `expected==0`?
3. **TP marcado `filled` en fill parcial:** al detectar `tf.size>0` se marca la fila `"filled"` (no
   `partially_filled`). El check `live` trata `filled` como vivo → no recoloca. ¿Correcto para un trigger
   reduceOnly (una vez disparado no vuelve), o se pierde el resto de un TP parcialmente llenado?
4. **Sobre-cierre SL + TPs (ambos reduceOnly Buy):** SL (full size por encima de entrada) y los TPs
   (`Σ closePct%` por debajo) conviven como Buys reduceOnly. ¿`reduceOnly` garantiza que no se sobre-cierre
   si varios disparan? ¿Se valida en creación del arm que `Σ closePct ≤ 100`? Si `Σ closePct > 100`, ¿qué
   pasa (TPs que exceden la posición, rechazos, o cierre mayor al holding)?
5. **Idempotencia / recovery del TP:** cloid determinista por `(armId, gen, "tp", 0, i)` + `openByCloid` +
   pre-record `pending` (sin `submittedAt`) → `order` → record `markSubmitted`. Si crashea **entre**
   pre-record y `order`, el próximo ciclo ve `pending` sin `submittedAt` (= no `live`) y reintenta; si el
   order SÍ se envió pero se perdió la respuesta, ¿`openByCloid` lo recupera siempre antes de reenviar
   (evita TP duplicado)? ¿Qué pasa si el fill ocurrió en esa ventana (estado `triggered/filled` en HL pero
   fila `pending` local)?
6. **Trigger del TP — anti-auto-disparo / dirección:** `tpsl:"tp"` Buy con `triggerPx < posEntryPx`
   (markPx baja = ganancia del short). ¿La semántica de HL para un TP buy es "dispara cuando el precio
   CAE a triggerPx"? ¿Puede `tpTriggerPx ≥ markPx` actual al colocarse (mark ya por debajo del TP) y
   disparar al instante un cierre prematuro? ¿Hace falta un guard como el de BE (`beTrigger > markPx·…`)?
   ¿El `limitPx` aggressive (ceil) garantiza ejecución sin cruzar de más?
7. **Fencing / lease en la colocación de TPs:** `renewSpotDefenseReconcile` se llama **por cada** TP antes
   del pre-record, pero el bucle de confirmación de fills (arriba) y el `setSpotDefenseOrderObserved` no
   renuevan. ¿Pueden perder el lease a mitad del bucle y escribir con token vencido (las mutations chequean
   token)? ¿El orden pre-record → order → record es seguro ante pérdida de lease entre medias?
8. **Redondeo / dust:** `tpTriggerPx` floor y `tpSize` floor. ¿El floor del size deja dust que impide el
   cierre completo o descuadra `expected`? ¿`tpSize<=0` (closePct minúsculo) se omite silenciosamente sin
   marcar la fila — puede reintentarse infinitamente cada ciclo?
9. **¿TPs solo con posición protegida?** La colocación vive tras declarar `protected/protecting`. ¿Se
   colocan TPs aunque el SL haya quedado `protecting` (SL no resting)? ¿Es aceptable tener TPs vivos sin SL
   confirmado, o deberían condicionarse a SL vivo?
10. **Secretos/logs + TS2589:** ¿algún `elog`/throw nuevo filtra payload sensible (cloids, oids, px, size
    son escalares no sensibles)? ¿Las anotaciones de tipo siguen conteniendo la cascada (sin nuevo TS2589)?

## Cabos sueltos ESPERADOS (fases posteriores, NO bloqueantes)
- No hay tope de intentos de rearm / alerta de whipsaw (`consecutiveStops`) todavía.
- El arranque del arm al CREAR el bot lo hará la action de creación de Fase 4 (hoy `persist` no arma).
- No hay deadline de emergencia del SL (`SL_PROTECT_DEADLINE`) todavía.

Devuelve: hallazgos (severidad + descripción + fix) y veredicto **GO / NO-GO** para 3c-3c.
Verde actual: `npm run typecheck` EXIT 0, `npm test` 236/236.
