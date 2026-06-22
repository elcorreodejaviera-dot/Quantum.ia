# JAV-107 Fase 3c-3a + 3c-3b - Auditoria Codex

Commit prompt auditado: `9d5861e`

Commits de codigo auditados:
- `5be9a7e` - break-even
- `59351c3` - auto-rearm

Veredicto: **NO-GO**

## Bloqueantes

1. **ALTO - BE cancela el SL viejo antes de tener SL nuevo confirmado**
   - En `convex/spotDefenseEngine.ts:361-376`, al activar BE se cancela el SL actual y recien despues se marca `beMoved`.
   - En `convex/spotDefenseEngine.ts:388-420`, el SL nuevo se intenta colocar despues.
   - Si `placeStopLoss` falla, timeoutea deterministicamente, se pierde el lease, o la action crashea entre cancel y place, el short queda sin SL hasta el proximo reconcile.
   - Fix: no cancelar el SL viejo hasta tener el SL BE nuevo aceptado/confirmable por CLOID. Alternativa: patron tipo pool: activar `beMoved` + `protecting`, mantener SL viejo vivo, rotar con confirmacion y deadline/emergencia.

2. **ALTO - Auto-rearm trata `armSpotDefenseInternal` con `ok:false` como exito**
   - `processSpotDefenseRearms` llama `armSpotDefenseInternal` en `convex/spotDefenseEngine.ts:481-483` y luego hace `settleSpotDefenseRearm("ok")` sin mirar el retorno.
   - Pero `armSpotDefenseInternal` puede devolver `ok:false` sin throw en paths como `markArmSubmitting` fallido, gate fallido, `updateLeverage_transport`, o rechazo post-envio (`convex/spotDefenseEngine.ts:122-147`, `130-134`, `187-190`).
   - Resultado: se limpia `rearmStatus` como si hubiera rearmado, aunque no haya quedado cobertura real.
   - Fix: inspeccionar `r?.ok === true` antes de `settle ok`; si no, clasificar `status/reason` como transient/blocked/cancel y reprogramar. Solo marcar OK si hay arm vivo/orden enviada.

3. **ALTO - Rearm `running` no se recupera si muere el worker**
   - `listDueSpotDefenseRearmsInternal` solo lista `pending|blocked` (`convex/spotDefenseBots.ts:512-524`).
   - `claimSpotDefenseRearm` tambien rechaza todo lo que no sea `pending|blocked` (`convex/spotDefenseBots.ts:536-538`).
   - Si el cron crashea despues del claim y antes del settle, el bot queda `rearmStatus:"running"` para siempre, aunque venza `rearmLeaseUntil`.
   - Fix: incluir `running` con lease vencido en el listado y permitir reclaim, priorizando `running` expirado como hace el motor de pool.

## No bloqueantes

- `rearmToken` se pasa a `armSpotDefenseInternal`, pero el handler no lo consume. La unicidad de arm evita doble arm inmediato, pero conviene consumir/validar el token en reserva para hacer el rearm realmente idempotente.
- `breakevenPct` no se valida en `validateSpotDefenseConfig`; el guard evita auto-disparo, pero falta validar finitud/rango como en pool.
- Faltan tests de fallo para BE sin SL, `ok:false` en auto-rearm y recuperacion de `running` expirado.

## Verificacion

- `npm run typecheck`: OK.
- `npm test -- --run`: OK, `233/233`.

Resultado final: **NO-GO**.
