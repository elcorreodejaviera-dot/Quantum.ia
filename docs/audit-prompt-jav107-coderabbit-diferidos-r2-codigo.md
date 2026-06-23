# Re-auditoría r2 — JAV-107: 2 fixes money-path diferidos (cierre de NO-GO)

Audita el **CÓDIGO** del commit `d60dc55` (rama `feat/jav107-spot-defense`). Emite **GO / NO-GO** por fix.
Base del NO-GO previo: `659696c`. Los 2 hallazgos eran ALTO (Fix 1) y MEDIO (Fix 2); el guard
`rearmStatus===undefined` quedó GO.

## Fix 1 — entry pre-fill muerta: ahora con `orderStatus` (Codex ALTO r2)

NO-GO previo: `openByCloid` (frontendOpenOrders) no distingue una entry que DISPARÓ (sale del book pero
está llenándose, userFills laggea) de una muerta → falso negativo que marcaba `failed`.

Fix (`convex/spotDefenseEngine.ts`, rama PRE-FILL, tras `wantDisarm`): espejo del reconcile de TP/
triggerEngine.
- `spe = info.orderStatus({ user, oid: entry.cloid })`; `speState = spe.status==="order" ? spe.order.status : undefined`.
- VIVA/pendiente → `armed_waiting` (no tocar): `entryOpen(openByCloid) || speState ∈ {open, triggered,
  waitingForTrigger, waitingForFill}`.
- `speState==="filled"` pero `fillsByCloid` aún 0 → `skipped: entry_fill_pending` (esperar fill data).
- Solo si terminal/rechazada/unknown (ni open, ni triggered/filling, ni filled): grace
  (`arm.submittedAt`, 60s) → `ensureSpotDefenseOrdersDead` → re-`fillsByCloid` (si llenó → `filled`) →
  `settle(failed)` (libera reserva; auto-rearm reabre si aplica). Cuarentena 90s del settle → si bloquea,
  `entry_dead_quarantined` (reintenta).

### Preguntas Fix 1
1. ¿La cascada open/triggered/waiting*/filled cubre TODOS los estados vivos/pendientes de HL para un
   trigger SELL? ¿Algún estado que deba tratarse como vivo y no esté contemplado?
2. `openByCloid` como red de seguridad además de orderStatus: ¿correcto que un `entryOpen=true` mantenga
   `armed_waiting` aunque orderStatus devuelva algo inesperado?
3. La cuarentena (90s) > grace (60s): entre 60–90s el settle puede quedar `quarantined` → skip → reintento.
   ¿Sin loop ni estado atascado? ¿La entry terminaliza siempre tras 90s si está muerta?
4. NOTA (no parte de este fix; ver más abajo): `entry.cloid` se almacena como el INPUT crudo de
   `spotDefenseCloidInput` (no `toHlCloid`), a diferencia de SL/TP. Este fix usa `entry.cloid` igual que el
   resto del módulo (place/openByCloid/ensureDead). ¿Confirmás que `orderStatus({oid: entry.cloid})`
   resuelve con el MISMO identificador con que se colocó la orden? (Si el cloid del entry estuviera mal
   formado para HL, sería un bug PRE-EXISTENTE separado — señalado al usuario aparte.)

## Fix 2 — auto-rearm durable centralizado (Codex MEDIO r2)

NO-GO previo: el rearm tras `failed` solo corría en `settleSpotDefenseArm`; los caminos que parchean
`status:"failed"` DIRECTO (markArmSubmitting / gateArmBeforeOrder / failSpotDefensePreOrder) no agendaban.

Fix (`convex/spotDefenseBots.ts`): helper único `scheduleDurableRearmAfterFailed(ctx, botId, error, now)`
— guard `!disarmPending && active && running && autoRearm===true && rearmStatus===undefined` → agenda
`rearmStatus="pending"`, `nextRearmAt`, `rearmAttempts=0`, `lastRearmError`. Llamado desde:
`settleSpotDefenseArm` (rama `failed`), `markArmSubmitting`, `gateArmBeforeOrder`, `failSpotDefensePreOrder`.

### Preguntas Fix 2
1. ¿Quedó CUBIERTO todo camino que terminaliza `failed`? (los 3 directos + el settle; la recuperación de
   `arming` abandonado y el rechazo post-envío pasan por settle). ¿Falta alguno?
2. Durante un rearm-cycle del cron, los caminos directos corren con `rearmStatus==="running"` → el helper
   se salta (guard) y deja que `settleSpotDefenseRearm` gestione backoff/blocked/attempts. ¿Correcto?
3. ¿El helper respeta `disarmPending` (pausa) y no agenda un rearm que reabriría algo que se está pausando?

## Verificación
`npm run typecheck` EXIT 0; `npm test` **253/253** (+3 tests rearm). El engine ("use node") queda fuera del
harness por diseño. NO pusheado: pendiente de este re-GO.

Devuelve hallazgos + veredicto **GO / NO-GO** por fix.
