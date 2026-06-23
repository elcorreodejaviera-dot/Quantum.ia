# Auditoría de CÓDIGO — JAV-107 Fase 3a+3b: ciclo de vida del arm + motor de armado (1 trigger SELL)

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de las sub-fases 3a y
3b (ya implementadas). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas
el código; señala fallos de corrección, carreras, fencing roto y riesgos money-path. Trabaja sobre la rama
`feat/jav107-spot-defense` (checkout hecho). Plan con GO: `docs/plan-jav107-spot-defense.md`. Fases 1 y 2
ya tuvieron GO. **El reconcile (SL/BE/TP/drift/close-confirm/auto-rearm), `stopSpotDefenseBot` y el cron son
Fase 3c — AÚN NO existen** (fuera de alcance de esta auditoría; ver "Cabos sueltos esperados").

## Contexto

Bot que defiende un holding spot con UN SHORT que dispara al CAER el precio a un trigger explícito
(manual o DCA). Motor SEPARADO del de pool, espejo recortado (single-entry, sin pool/rango/reentrada) de
`convex/triggerEngine.ts` + `convex/triggerArms.ts`. La reserva/cap/sizing (Fase 2,
`reserveSpotDefenseArm`) ya tuvo GO.

## Diff a auditar (commits `216d113` Fase 3a y `fc99b3a` Fase 3b)

### 3a — mutations de ciclo de vida (`convex/spotDefenseBots.ts`, NON-node)
- `ALLOWED_SD` (máquina de estados de `spot_defense_arms`), `ARM_TERMINAL={disarmed,closed,failed}`,
  `SD_SUBMIT_QUARANTINE_MS=90s`, `SD_RECONCILE_LEASE_MS = SPOT_DEFENSE_LEASE_MS (2min)`.
- `getSpotDefenseBotInternal`, `getSpotDefenseArmInternal` (arm+orders), `getLiveSpotDefenseArmInternal`
  (arm no-terminal del bot).
- `claimSpotDefenseReconcile` / `renewSpotDefenseReconcile` / `releaseSpotDefenseReconcile` (lease+token).
- `setSpotDefenseOrderObserved` (actualiza orden por rol entry/sl/tp[+tpIndex] bajo lease: observedStatus/oid).
- `settleSpotDefenseArm` (fencing por token+lease, `ARM_TERMINAL` no-reentrante, `ALLOWED_SD`, `closed`
  exige `closeReason`, **cuarentena**: no terminaliza si `submittedAt!=null` y dentro de 90s; al alcanzar
  terminal con `disarmPending` → bot `active:false,status:"stopped"`).
- `failSpotDefensePreOrder` (cierra a `failed` SIN cuarentena SOLO si: lease vigente, status submitting,
  sin fill, y la orden `entry` sigue pre-envío: pending, sin oid, sin submittedAt).

### 3b — motor de armado (`convex/spotDefenseEngine.ts`, "use node")
`armSpotDefenseInternal(botId, rearmToken?)`:
1. Lee bot (active/running/!disarmPending, red==hlNetwork) + credencial (owned) → `makeClients` +
   `getAssetMeta` (assetId/szDecimals/markPx/maxLeverage).
2. **Unified** (`userAbstraction`), **FLAT** (`clearinghouseState` szi==0 del coin),
   **sin órdenes** del coin (`frontendOpenOrders`).
3. `triggerPxNorm = roundHlPrice(bot.triggerPrice, szDecimals, "floor")`; gate `markPx > triggerPxNorm`
   ([transient] si no — "no nace disparado").
4. `availableCollateral` = USDC spot libre (`spotClearinghouseState`, total−hold).
5. `reserveSpotDefenseArm` (OCC, Fase 2) → {armId, cloid, appliedLeverage, size}.
6. `markArmSubmitting` → token; `updateLeverage` (TransportError → release+gated; determinista →
   `failSpotDefensePreOrder` + throw); `gateArmBeforeOrder` (fail → release+gated).
7. Coloca UNA orden trigger SELL (`b:false`, `r:false`, `isMarket:true`, `tpsl:"sl"`, banda agresiva
   floor) con `cloid`; interpreta resting/filled/waitingForTrigger/error/ambiguo →
   `setSpotDefenseOrderObserved` + `settleSpotDefenseArm` (filled/armed/unknown/failed).
8. Defensa post-envío: si `desiredState==="disarmed"` → `cancelByCloid`; release lease.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **Fencing/lease:** ¿`settleSpotDefenseArm`, `setSpotDefenseOrderObserved`, `release/renew` validan token
   + lease vigente de forma que un worker con lease expirado NO pueda mutar el arm? ¿`claim` respeta un
   lease vivo (no roba)? ¿El `release` tras settle en el camino feliz puede pisar un claim posterior?
2. **Cuarentena + pre-order fail:** ¿`SD_SUBMIT_QUARANTINE_MS` protege contra terminalizar un arm cuya
   orden pudo materializarse tarde en HL? ¿`failSpotDefensePreOrder` es seguro (sus 5 guards prueban
   "sin orden enviada") y no puede cerrar a `failed` un arm con orden potencialmente viva? ¿El throw tras
   `failSpotDefensePreOrder` deja el arm coherente?
3. **ALLOWED_SD:** ¿la máquina de estados permite SOLO transiciones válidas y no degrada (p.ej.
   protected→armed)? ¿Falta alguna transición que el reconcile (3c) necesitará, o sobra alguna peligrosa?
   ¿`manual_intervention` tiene salidas correctas (closed/disarmed/failed)?
4. **Colocación de la orden (3b):** ¿`tpsl:"sl"` + `b:false` (sell) + banda agresiva FLOOR es correcto
   para un trigger que dispara al BAJAR y debe llenar como market a la baja? ¿La interpretación de
   `statuses[0]` (resting/filled/waitingForTrigger/error) cubre todos los casos del SDK? ¿`size`/`cloid`
   provienen de la reserva (prometido==colocado) sin recomputar?
5. **Idempotencia / doble-envío:** entre `markArmSubmitting` y la colocación corre `updateLeverage`
   (espera). ¿`gateArmBeforeOrder` cierra esa ventana? Si el cron disparara `armSpotDefenseInternal` dos
   veces para el mismo bot, ¿la unicidad (1 arm no-terminal) + el CAS impiden dos órdenes?
6. **Flat/sin-órdenes:** ¿leer `clearinghouseState`/`frontendOpenOrders` por `coin === asset` es la
   comparación correcta (mayúsculas, símbolo HL)? ¿Hay TOCTOU entre esta lectura y el envío que deba
   cubrir el reconcile/drift de 3c?
7. **Secretos/logs:** ¿algún `elog`/throw filtra clave privada, cloid sensible o payload del SDK? (la
   redacción defensiva es regla del proyecto, JAV-94).
8. **Coherencia con Fase 2:** ¿el motor respeta que la reserva es la fuente de verdad (no recalcula
   margen/leverage/sizing) y que los gates live se revalidan en reserva + ambos CAS?

## Cabos sueltos ESPERADOS (Fase 3c, NO los marques como bloqueantes de esta auditoría)
- No hay reconcile → un arm `armed`/`unknown`/`submitting` no progresa solo todavía; un fallo de
  `updateLeverage` TransportError deja el arm reconciliable (lease liberado) a la espera del reconcile.
- No hay `stopSpotDefenseBot` ni cron ni auto-rearm ni colocación de SL/TP/BE ni detector de drift.
- `pauseSpotDefenseBot` marca `disarmPending` pero el desarme efectivo en HL lo hará 3c.

Devuelve: hallazgos (severidad + descripción + fix) y veredicto **GO / NO-GO** para 3a+3b.
Verde actual: `npm run typecheck` EXIT 0, `npm test` 224/224.
