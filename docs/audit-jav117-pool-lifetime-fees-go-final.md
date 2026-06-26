# Auditoria Codex - JAV-117 GO final de plan

## Alcance auditado

- Plan final: `docs/plan-pool-lifetime-fees.md`.
- Auditorias previas:
  - `docs/audit-jav117-pool-lifetime-fees.md`
  - `docs/audit-jav117-pool-lifetime-fees-reaudit.md`
  - `docs/audit-jav117-pool-lifetime-fees-final.md`
- Codigo de referencia revisado en rondas previas:
  - `convex/actions/poolScanner.ts`
  - `convex/schema.ts`
  - `convex/pools.ts`
  - `convex/admin.ts`
  - `convex/adminLive.ts`
  - `src/components/BotPortal.jsx`
  - `src/components/AdminView.jsx`

## Veredicto

**GO limpio para implementar el plan JAV-117.**

Las condiciones v3 quedaron incorporadas en las secciones operativas del plan:

- Convex: `by_pool_log` queda como indice de busqueda, no constraint. La idempotencia se hace en la mutation buscando por `(poolId, txHash, logIndex)` y con dedupe por lote.
- Senal incremental: ya no trata `positions().tokensOwed` como live. Usa `positions()` para checkpoint almacenado (`liquidity`, `tokensOwed`, `feeGrowthInside*`) y `collect callStatic` raw para `tokensOwed` live.
- Anti-reorg: al re-escanear se limpia/recalcula la ventana `blockNumber >= fromBlock` o se compara `blockHash`, y los agregados se recomputan desde `pool_fee_events`.
- Binary-search historico: tiene fallback a chunks de 10 + `stale` si el RPC no soporta `eth_call` historico.

## Bloqueante

Sin hallazgos bloqueantes.

## Alto

Sin hallazgos altos pendientes.

## Medio

Sin hallazgos medios pendientes.

## Bajo

Solo quedan detalles editoriales no bloqueantes:

- El encabezado todavia dice "pendiente GO final de Codex"; conviene actualizarlo despues de este GO.
- La seccion historica de reauditoria v2 aun menciona "indice unico"; la seccion v3 y las secciones operativas ya lo corrigen como indice de busqueda + idempotencia por mutation.

## Pruebas/comandos revisados

- `nl -ba docs/plan-pool-lifetime-fees.md`
- `rg -n "Convex|indice|índice|unique|únic|idempot|by_pool_log|positions\\(\\)|tokensOwed|feeGrowthInside|callStatic|eth_call histórico|historico|binary|chunks de 10|blockHash|blockNumber >= fromBlock|fromBlock|re-escan|recalcular|stale|GO limpio" docs/plan-pool-lifetime-fees.md`
- `git status --short`

No se ejecutaron tests porque esta fue una auditoria de plan, sin cambios de codigo runtime.
