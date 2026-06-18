# Prompt de auditoría (Codex) — CÓDIGO subtarea de dato JAV-84 (backfill initialLiquidityUsd)

Audita el **código** (working tree, sin commit) según `docs/plan-admin-data-backfill.md` y las 5 condiciones
del GO de plan. Único archivo: `convex/actions/poolScanner.ts`.

Cambios:
- Extraído `scanPositionCore(network, tokenId)` (función SIN auth) con el cuerpo de lectura on-chain;
  `scanPoolByTokenId` (action pública) ahora hace `requireAuth` + validación + `return scanPositionCore(...)`.
- `backfillOneInitialLiquidity(ctx, pool)` (helper): si falta `initialLiquidityUsd` y la posición es viva,
  lee precio con `scanPositionCore`, nocional con `fetchPositionNotionalStrict` (autoritativa, la del motor),
  valida `reason==="ok" && Number.isFinite && >0`, y persiste con `internal.pools.patchPoolInitialLiquidity`
  (idempotente). try/catch propio → devuelve "filled|skipped|failed", NUNCA lanza. `ctx:any` para cortar TS2589.
- `checkAllPoolClosures`: tras `reopenPoolIfClosed` y SOLO si `initialLiquidityUsd == null`, llama al helper
  antes de `return "active"`. No altera las ramas closed/unavailable/skipped.
- `backfillMissingInitialLiquidity` (internalAction, CLI): tope `limit` (máx 100) + `POOL_SCAN_CONCURRENCY`.

Verifica GO/NO-GO:
1. ¿El backfill está realmente AISLADO? ¿Puede algún camino impedir `markPoolClosedAndPauseBots`/
   `reopenPoolIfClosed`/`touchPoolChecked` o cambiar la categoría devuelta? (Solo corre en rama "active".)
2. `scanPositionCore`: ¿la extracción preserva exactamente el comportamiento previo de `scanPoolByTokenId`
   (mismos throws, mismo objeto)? ¿Algún cambio de semántica para el caller con auth?
3. ¿`currentPrice` de `scanPositionCore` es el `priceUsd` correcto para `fetchPositionNotionalStrict` (coherente
   con cómo lo usa el front en `fetchPositionLiquidity`)? ¿Riesgo invert/decimales/fuera de rango?
4. Idempotencia/carreras: dos ticks del cron solapados o cron + acción manual a la vez sobre el mismo pool →
   ¿`patchPoolInitialLiquidity` (if != null return) basta? ¿doble lectura RPC desperdiciada aceptable?
5. Coste: doble lectura on-chain (scanPositionCore + fetchPositionNotionalStrict) por pool-sin-dato. ¿Tope/
   concurrencia suficientes? ¿rate-limit RPC?
6. TS2589: `ctx:any` + `Promise<any>` ¿bastan para no reintroducir la cascada del grafo internal.*?
7. ¿Se respeta NO money-path (no toca bots/hedgeNotionalUsd ni reserva/arming)?
8. ¿Algún caso en que se persista un valor engañoso (>0 pero incorrecto)?
