# Plan — JAV-119: Back-fill lifetime fees GRATIS y de un botón

> Mejora operativa de JAV-117. Rama `elcorreodejaviera/jav-119-backfill-lifetime-gratis`. Pendiente GO de Codex (plan + código) antes de push.

## Problema
`backfillPoolLifetime` (JAV-117) reconstruía el histórico con Alchemy. La llave **gratis** limita `eth_getLogs` a 10 bloques → back-fill desde el origen inviable. Además había que correrlo a mano por pool con `fromBlock`/`rpcUrl`. Usuario: llave gratis, 2 pools.

## Solución (gratis, un botón) — todo en `convex/actions/poolScanner.ts`
1. **`LOGS_RPC`**: RPC públicos de archivo por red (dRPC + PublicNode), SIN API key. Se usan SOLO en el back-fill. El cron incremental sigue con Alchemy (intacto).
2. **`getLogsAdaptive` + range-halving**: recorre `[start, safeHead]` partiendo de un único trozo inicial (todo el rango); si un proveedor rechaza el rango (`GetLogsRangeTooLargeError`: HTTP 413/400, o mensaje "range/too many results/…", o timeout) parte el trozo a la mitad y reintenta. `getLogsRangeMulti` prueba varios proveedores antes de partir. Acotado por `BACKFILL_CALL_BUDGET` (2000).
3. **Inicio = ORIGEN (bloque 0)** por defecto (fix Codex): se escanea `[0, safeHead]` en un trozo inicial y el range-halving abarata los rangos vacíos. NO se usa heurística de `initialLiquidityAt` (era 1ª observación, no mint → certificaría histórico incompleto). `fromBlock` explícito permite arrancar más arriba pero entonces **NO** se certifica histórico (queda `stale`).
4. **`backfillAllPoolLifetimes`**: un internal action que recorre todos los pools (secuencial, acotado por `limit`) → un clic, sin args.

## Invariantes preservados (de JAV-117)
- **Atomicidad/anti-reorg**: sigue aplicando vía `applyPoolFeeEventsWindow` (borra `[start,safeHead]` + inserta + recompute en una transacción).
- **No mutar ante fallo**: si el transporte falla, o la cobertura es PARCIAL (presupuesto agotado → posibles huecos no contiguos), NO se toca la tabla (cache previo intacto); se reporta `ok:false`.
- **ALTO-2**: `backfilledAt`/status `ok` solo si `coversHistory` (`start === 0`, o ya había backfill previo). Un `fromBlock > 0` explícito queda `stale` (no certifica histórico).
- Eventos previos a `start` (de un backfill from-0 anterior) se conservan: `applyPoolFeeEventsWindow` solo borra dentro de la ventana y recomputa desde la tabla completa.

## Caveat documentado
El back-fill por defecto escanea desde el **bloque 0**, así que cubre el histórico completo sin depender de heurísticas (no se usa `initialLiquidityAt`). Eficiencia: depende de que el RPC público admita rangos amplios filtrando por `tokenId` (dRPC suele permitirlo → pocas llamadas); si un proveedor acota mucho el rango, el range-halving lo adapta y el `BACKFILL_CALL_BUDGET` (2000) evita runaway (si se agota → `ok:false`, sin mutar; reintentar o usar `rpcUrl` propio).

## Uso (tras merge, en dashboard Convex prod)
- Un clic: ejecutar `internal.actions.poolScanner.backfillAllPoolLifetimes` (sin args).
- Por pool: `backfillPoolLifetime { poolId }` (autodetecta inicio) o `{ poolId, fromBlock: 0 }` para forzar desde el origen, o `{ poolId, rpcUrl }` para un proveedor propio.

## Verificación
`npm run typecheck` OK · `npm test` 265/265 OK.
