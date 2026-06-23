# Auditoría de CÓDIGO — JAV-107 Fase 4b (SpotDefenseBotModal: modal real de defensa spot)

Eres un auditor senior de UI money-path en Hyperliquid. Audita el **CÓDIGO** de la sub-fase 4b (commit
`97e2694`). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas el código.
Rama `feat/jav107-spot-defense` (checkout hecho). Plan con GO: `docs/plan-jav107-spot-defense.md` (Fase 4
= "UI: modal real + tarjeta en vivo"). Fases 1, 2, 3*, 3c-3c (r4) y 4a ya tuvieron GO de Codex.

## Contexto

Bot que defiende un HOLDING spot con UN short (trigger SELL que dispara al CAER el precio al trigger).
4b añade el **modal de configuración** `SpotDefenseBotModal` en `src/components/BotPortal.jsx`, clonado de
`ProtectionBotModal` (bot IL de pool) pero adaptado a una posición spot. **El componente aún NO está
cableado** (no se renderiza): el cableado en el sitio de `SpotProtectorBot`, la tarjeta en vivo
`DefensaSpotViva` y el borrado del camino de simulación son 4c. 4b es solo la definición del modal +
la constante `HL_NETWORK`.

Backend ya auditado y disponible:
- `persistSpotDefenseBot` (mutation, Fase 2): valida ownership/cuenta/exclusividad/Σ closePct, persiste
  el bot, NO arma. Args: spotPositionId, hlAccountId, leverage, autoLeverage, bufferPct, stopLossPct,
  breakevenPct, tps, autoRearm, triggerMode ("manual"|"dca"), triggerPrice, requestedNotionalUsd,
  minCoveragePct, active.
- `armSpotDefenseBot` (action, Fase 4a, GO): auth (canTradeLive+canManageBots+ownership) +
  assertExpectedNetwork + confirm → delega en armSpotDefenseInternal (revalida flat/sin órdenes/mark>trigger
  /reserva OCC/CAS/envío). **reserveSpotDefenseArm** capa el nocional por margen real + tope de plan y
  BLOQUEA si `effectiveNotionalUsd < minCoveragePct% · requested`.

## Diff a auditar — commit `97e2694`, `src/components/BotPortal.jsx`

1. `const HL_NETWORK = IS_TESTNET ? 'testnet' : 'mainnet'` (la red que el cliente cree; el backend la
   revalida con assertExpectedNetwork).
2. `function SpotDefenseBotModal({ position, bot, canTradeLive, onClose, onSaved })`:
   - Estado precargado del `bot` existente (reconfigurar) o defaults (crear): hlAccountId, leverage(20),
     autoLeverage(false), bufferPct(100), stopLossPct(1), breakevenPct(0.5), tps([0.5/40, 1.5/60]),
     autoRearm(true), triggerMode('dca'), manualTrigger(position.dca), minCoveragePct(80), acceptPartial.
   - `effTriggerPrice` = `position.dca` si triggerMode==='dca' else `Number(manualTrigger)`.
   - `requestedNotionalUsd = position.amount × effTriggerPrice × (1 + bufferPct/100)`.
   - Cobertura ESTIMADA (cliente): `usableEst = withdrawable + spotUsdcFree`; `maxNotionalEst = usableEst ×
     leverage`; `coverageEstPct = min(100, maxNotionalEst/requested × 100)`. `partialEst = coverageEstPct
     < 99.5`. Etiquetada explícitamente como techo orientativo (no descuenta margen de otros bots).
   - `triggerAbovePrice = currentPrice != null && effTriggerPrice >= currentPrice`.
   - `handleSave`: gates de cliente (canTradeLive, cuenta, trigger>0, !triggerAbovePrice, requested>0,
     partialEst⇒acceptPartial) → `persist(pruneUndefined({...}))` → `arm({ botId, expectedNetwork:
     HL_NETWORK, confirm: true })`. Si el arm lanza, NO cierra el modal y muestra el motivo.
   - Botón "Activar Defensa" deshabilitado si saving / sin cuenta / triggerAbovePrice / requested<=0 /
     (partialEst && !acceptPartial).

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER

1. **persist→arm no atómico:** persist crea el bot (active:true) y luego arm puede fallar (mark≤trigger
   transitorio, margen, gate). Queda un bot CREADO pero SIN armar y **ningún cron arma un bot recién
   creado** (4a). El modal no cierra y muestra el error; reabrir+“Guardar cambios” reintenta (persist
   sobre bot existente sin arm vivo → patch; luego arm). ¿Es aceptable como recovery, o hace falta algo
   más (p.ej. una action única create-and-arm, o un cron de arranque inicial)? Severidad sugerida.
2. **Coherencia del nocional cliente vs backend:** `requestedNotionalUsd` se calcula en el cliente
   (holding×trigger×(1+buffer)) y el backend lo recapa. ¿Hay riesgo de que el número mostrado engañe
   (p.ej. la cobertura estimada use techo sin descontar margen comprometido)? ¿La etiqueta deja claro que
   es estimación y que la verdad es `effectiveNotionalUsd` (tarjeta viva 4c)?
3. **Guard del trigger:** `triggerAbovePrice` usa `>=`. El backend exige `markPx > triggerPxNorm` (estricto)
   con lectura FRESCA + floor al tick. ¿El guard de cliente (con `position.currentPrice`, posiblemente algo
   stale) es suficiente como pre-check, sabiendo que el backend es la verdad? ¿Falta cubrir currentPrice
   null (no bloquea, deja decidir al backend)?
4. **minCoveragePct / cobertura parcial:** el cliente exige `acceptPartial` cuando la estimación <100% y
   pasa `minCoveragePct` (backend bloquea si el efectivo cae por debajo). ¿La doble barrera es coherente?
   ¿`minCoveragePct` sin acotar a [0,100] en el input puede romper algo? (el backend valida).
5. **Reconfigurar (bot existente):** persistSpotDefenseBot RECHAZA patch si hay arm NO terminal vivo.
   ¿El modal de "Guardar cambios" maneja ese error con claridad (no deja estado a medias)?
6. **Solo-real / permisos:** sin `canTradeLive` no crea (igual que los otros modales). ¿Algún camino
   donde se llame persist/arm sin el gate? ¿`RealModeNotice` informa?
7. **Secretos/datos sensibles:** ¿el modal expone algo sensible (la cuenta solo muestra
   withdrawable/spot vía HLAccountSelect)? ¿`pruneUndefined` evita mandar campos undefined al backend?
8. **Estado dead-code:** el componente no está cableado en 4b (lo hace 4c). ¿Es aceptable como staging
   incremental, o preferís cablearlo en el mismo commit?

## Nota de verificación

No hay test de UI ni lint independiente en el repo; `npm run build` despliega prod (prohibido en local),
así que se verificó con `npx vite build` aislado (JSX compila, referencias resuelven). `typecheck` (solo
convex) EXIT 0; `npm test` **243/243** (sin cambios de backend en 4b).

Devuelve: hallazgos (severidad + fix) y veredicto **GO / NO-GO** para 4b.
