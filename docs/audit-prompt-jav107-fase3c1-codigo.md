# Auditoría de CÓDIGO — JAV-107 Fase 3c-1: reconcile (fill→SL→close-confirm) + detector de drift

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de la sub-fase 3c-1 (ya
implementada). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas el
código; señala fallos de corrección, carreras, fencing roto y riesgos money-path. Trabaja sobre la rama
`feat/jav107-spot-defense` (checkout hecho). Plan con GO: `docs/plan-jav107-spot-defense.md`. Fases
1, 2, 3a y 3b ya tuvieron GO de Codex.

## Contexto

Bot que defiende un holding spot con UN SHORT que dispara al CAER el precio a un trigger explícito.
Motor SEPARADO, espejo recortado (single-entry, sin pool/rango/reentrada) de `convex/triggerEngine.ts`
`reconcileArm`. La reserva/cap/sizing (Fase 2) y el arm/colocación (3b) + el ciclo de vida (3a) ya
tuvieron GO. **BE, TPs, `stopSpotDefenseBot`, el cron 1/min, el arranque del arm al crear el bot y el
auto-rearm son Fase 3c-2 — AÚN NO existen** (ver "Cabos sueltos esperados").

## Diff a auditar (commit `2705f8a`)

### `convex/spotDefenseEngine.ts` — `reconcileSpotDefenseArm` (internalAction, "use node")
Bajo `claimSpotDefenseReconcile` (lease+token), en `finally` hace `releaseSpotDefenseReconcile`:
1. `getSpotDefenseArmInternal` → {arm, orders}; `entry` = orden role "entry".
2. **Recuperación:** `arm.status==="arming" && submittedAt==null` y `edad > ARMING_RECOVER_GRACE_MS
   (3min)` → `settleSpotDefenseArm(failed)`; si reciente → skip.
3. Cliente desde `arm.network` (NO el HL_NETWORK actual); `getAssetMeta` (assetId/szDecimals/markPx).
4. **Kill/pausa:** `tradingEnabled!=true || simulationMode==true || !bot || !bot.active ||
   bot.status!=="running" || bot.disarmPending || hlNetwork()!==arm.network || bot.hlAccountId!==arm.hlAccountId ||
   !canLive || credential.userId!==arm.userId` → `wantDisarm` (también si `desiredState==="disarmed"`).
5. **Fase posición** (`filled`/`protecting`/`protected`):
   - Confirma datos de fill (si faltan, `fillsByCloid(entry.cloid)` → settle filled; si no, skip).
   - Lee `clearinghouseState` → `szi` del coin; `flat = |szi|==0`; `realSize = |szi| || arm.filledSize`;
     `posEntryPx` del position o `arm.entryPrice`.
   - **DETECTOR DE DRIFT (Codex r2 #2):** si `!flat && |realSize − arm.size| > arm.size×DRIFT_TOL(0.02)` →
     `cancelOwnByCloid(ownCloids)` + `settleSpotDefenseArm(manual_intervention)`, **sin market close**.
   - **flat:** grace `CLOSE_CONFIRM_GRACE_MS(2min)` desde `filledAt`; renueva lease; confirma SL llenado
     (observed + `fillsByCloid`); cancela las órdenes propias por cloid; `settleSpotDefenseArm(closed,
     closeReason: slConfirmed?"sl":"manual")`.
   - **posición abierta y `!wantDisarm`:** si no hay SL vivo (open/triggered/pending) → `placeStopLoss`
     (side "Short" → Buy por encima de la entrada, `realSize`, `posEntryPx`, `arm.stopLossPct`, cloid
     `spotDefenseCloidInput(armId, gen, "sl", attempt)` → `toHlCloid`) → `recordSpotDefenseSlOrder` +
     `settleSpotDefenseArm(protecting|protected)`.
6. **Fase pre-fill** (`armed`/`submitting`/`unknown`): si `wantDisarm` → cancela propio + settle
   `disarmed`. Si `fillsByCloid(entry.cloid)` > 0 → settle `filled`. Si no → "armed_waiting".

### `convex/spotDefenseBots.ts` — `recordSpotDefenseSlOrder` (internalMutation)
Upsert idempotente de la orden role "sl" (uno por arm) bajo lease+token: si existe, patch
(observed/oid/triggerPx/size/cloid); si no, insert (reduceOnly:true). Fencing por token.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **Cierre prematuro / huérfanos:** ¿el `flat` + grace + cancelación de órdenes propias ANTES de
   `closed` evita declarar cerrado con un trigger aún vivo en el book? ¿El grace (`filledAt`) y la
   doble lectura son suficientes contra un `szi==0` transitorio por lag de `clearinghouseState`?
2. **Detector de drift:** ¿`|realSize − arm.size| > arm.size×0.02` es una condición correcta para
   "intervención manual" sin falsos positivos por fills parciales del propio bot (en 3c-1 aún no hay TPs,
   pero ¿un fill parcial de la entrada dispararía drift?)? ¿`manual_intervention` + cancelar SOLO lo
   propio + NO market close es seguro (no toca exposición ajena)? ¿Debería confirmarse con doble lectura
   antes de marcar drift?
3. **SL:** ¿`placeStopLoss("Short", realSize, posEntryPx, stopLossPct)` coloca el SL correcto (Buy por
   encima de la entrada) y con `realSize` (tamaño REAL de la posición, no `arm.size`)? ¿La condición
   `slAlive` (open/triggered/pending) evita recolocar un SL ya vivo (doble SL)? ¿El cloid con `attempt`
   = `arm.slAttempts+1` rota bien, pero `arm.slAttempts` NUNCA se incrementa en 3c-1 → cada ciclo usaría
   attempt=1 (mismo cloid) — ¿es un problema (idempotente) o un cabo para 3c-2?
4. **Fencing/lease:** entre `placeStopLoss` (RPC lento) y `recordSpotDefenseSlOrder`/`settle`, ¿el lease
   puede expirar y otro worker pisar? ¿Conviene `renew` antes de colocar el SL (como se hace antes de
   `closed`)? ¿El `release` en `finally` puede borrar un lease renovado por el propio ciclo?
5. **Cliente por red:** ¿construir el cliente desde `arm.network` (no `hlNetwork()`) es correcto para
   cancelar/cerrar aunque el deploy haya cambiado de red, y a la vez `wantDisarm` fuerza el desarme si
   `hlNetwork()!==arm.network`?
6. **Estados/transiciones:** ¿todas las `settleSpotDefenseArm` llamadas respetan `ALLOWED_SD`
   (p.ej. filled→manual_intervention, filled→closed, armed→disarmed, submitting/unknown→disarmed)?
   ¿Alguna transición que el reconcile intente y `ALLOWED_SD` rechace, dejando el arm atascado?
   (Nota: `submitting`/`unknown` NO permiten →`disarmed` en ALLOWED_SD — ¿es un hueco?)
7. **Idempotencia:** dos ciclos de reconcile solapados (lease ya lo evita) o un fill confirmado dos
   veces, ¿pueden duplicar SL o ciclos? ¿`fillsByCloid` por cloid del entry/SL es robusto?
8. **Secretos/logs:** ¿algún `elog`/throw filtra clave/payload sensible?

## Cabos sueltos ESPERADOS (Fase 3c-2, NO bloqueantes)
- BE (mover SL a break-even) y TPs parciales aún no se colocan (`void markPx`).
- `stopSpotDefenseBot` (cierre activo a mercado reduceOnly del tamaño contable, abortando ante drift) y
  el desarme de una posición ABIERTA con `wantDisarm` (hoy solo se desarma en pre-fill; con posición
  abierta + wantDisarm el reconcile no cierra todavía) → 3c-2.
- Cron "reconcile spot defense" 1/min, arranque del arm al crear el bot, y auto-rearm durable → 3c-2.
- `arm.slAttempts` no se incrementa todavía (sin reintentos de SL ni deadline de emergencia).

Devuelve: hallazgos (severidad + descripción + fix) y veredicto **GO / NO-GO** para 3c-1.
Verde actual: `npm run typecheck` EXIT 0, `npm test` 226/226.
