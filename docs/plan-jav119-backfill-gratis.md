# Plan — JAV-119: Back-fill lifetime fees GRATIS y de un botón

> Mejora operativa de JAV-117. Rama `elcorreodejaviera/jav-119-backfill-lifetime-gratis`. Pendiente GO de Codex (plan + código) antes de push.

## Problema
`backfillPoolLifetime` (JAV-117) reconstruía el histórico con Alchemy. La llave **gratis** limita `eth_getLogs` a 10 bloques → back-fill desde el origen inviable. Además había que correrlo a mano por pool con `fromBlock`/`rpcUrl`. Usuario: llave gratis, 2 pools.

## Solución (gratis, un botón) — todo en `convex/actions/poolScanner.ts`
1. **`LOGS_RPC`**: RPC públicos de archivo por red (dRPC + PublicNode), SIN API key. Se usan SOLO en el back-fill. El cron incremental sigue con Alchemy (intacto).
2. **`getLogsAdaptive` + range-halving**: recorre `[start, safeHead]` en trozos de `BACKFILL_INITIAL_SPAN` (1M); si un proveedor rechaza el rango (`GetLogsRangeTooLargeError`: HTTP 413/400, o mensaje "range/too many results/…", o timeout) parte el trozo a la mitad y reintenta. `getLogsRangeMulti` prueba varios proveedores antes de partir. Acotado por `BACKFILL_CALL_BUDGET` (600).
3. **Auto start-block**: si no se pasa `fromBlock`, se deriva de `initialLiquidityAt − 45 días` (margen, porque ese campo es la 1ª observación del sistema, no el mint real) vía `blockAtOrBeforeTimestamp` (búsqueda binaria con `eth_getBlockByNumber`). Sin marca temporal → `start = 0`.
4. **`backfillAllPoolLifetimes`**: un internal action que recorre todos los pools (secuencial, acotado por `limit`) → un clic, sin args.

## Invariantes preservados (de JAV-117)
- **Atomicidad/anti-reorg**: sigue aplicando vía `applyPoolFeeEventsWindow` (borra `[start,safeHead]` + inserta + recompute en una transacción).
- **No mutar ante fallo**: si el transporte falla, o la cobertura es PARCIAL (presupuesto agotado → posibles huecos no contiguos), NO se toca la tabla (cache previo intacto); se reporta `ok:false`.
- **ALTO-2**: `backfilledAt`/status `ok` solo si `coversHistory` (autoStart cubre desde ≈creación, o `start===0`, o ya había backfill previo).
- Eventos previos a `start` (de un backfill from-0 anterior) se conservan: `applyPoolFeeEventsWindow` solo borra dentro de la ventana y recomputa desde la tabla completa.

## Caveat documentado
`initialLiquidityAt` puede ser posterior al mint; el margen de 45 días cubre el caso normal (usuario registra el pool poco después de crearlo). Una posición observada >45 días tras su creación podría perder eventos muy tempranos (raro). `fromBlock: 0` explícito fuerza cobertura total si hiciera falta.

## Uso (tras merge, en dashboard Convex prod)
- Un clic: ejecutar `internal.actions.poolScanner.backfillAllPoolLifetimes` (sin args).
- Por pool: `backfillPoolLifetime { poolId }` (autodetecta inicio) o `{ poolId, fromBlock: 0 }` para forzar desde el origen, o `{ poolId, rpcUrl }` para un proveedor propio.

## Verificación
`npm run typecheck` OK · `npm test` 265/265 OK.
