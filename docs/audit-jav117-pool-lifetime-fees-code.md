# Auditoria Codex - JAV-117 codigo

## Alcance

Revision del commit `4928e9d` en la rama `elcorreodejaviera/jav-117-...`, antes de push.

Archivos revisados:

- `convex/schema.ts`
- `convex/actions/poolScanner.ts`
- `convex/pools.ts`
- `convex/cronHealth.ts`
- `convex/crons.ts`
- `convex/admin.ts`
- `convex/adminLive.ts`
- `src/components/BotPortal.jsx`
- `src/components/AdminView.jsx`

Fuentes externas primarias consultadas:

- Uniswap v3 periphery `INonfungiblePositionManager.sol`: eventos y `positions()`.
  https://raw.githubusercontent.com/Uniswap/v3-periphery/main/contracts/interfaces/INonfungiblePositionManager.sol
- Uniswap v3 periphery `NonfungiblePositionManager.sol`: comportamiento de `collect()`, `increaseLiquidity()` y `decreaseLiquidity()`.
  https://raw.githubusercontent.com/Uniswap/v3-periphery/main/contracts/NonfungiblePositionManager.sol

## Veredicto

**NO-GO antes de push.**

Los puntos criptograficos/ABI principales estan bien: topics correctos, `tokenId` como topic indexado, `amount0=word1` y `amount1=word2`, algoritmo `principalDebt` correcto, wrapper de `feesUncollectedUsd` compatible, y `typecheck`/tests/build pasan.

El bloqueo esta en consistencia operacional del cache historico: el incremental/backfill puede borrar la fuente de verdad antes de reconstruirla, y el cron puede marcar `ok` una posicion que nunca tuvo backfill historico. Eso puede terminar mostrando un lifetime incompleto como confiable.

## Hallazgos

### ALTO 1 - El refresh/backfill borra eventos antes de confirmar que puede reconstruir la ventana

Evidencia:

- `refreshOnePoolLifetime` calcula `startBlock`, borra todos los eventos `>= startBlock`, y recien despues llama `eth_getLogs`.
  - `convex/actions/poolScanner.ts:970-990`
  - `convex/pools.ts:321-331`
- Si `eth_getLogs` falla en el primer chunk, la tabla ya perdio eventos de la ventana anti-reorg que antes formaban parte del agregado finalizado. Luego `recomputePoolLifetimeAggregates` recalcula desde una tabla incompleta y persiste `status: "error"`.
  - `convex/actions/poolScanner.ts:983-990`
  - `convex/pools.ts:345-355`
- `backfillPoolLifetime` repite el mismo patron: borra desde `start` antes del primer `getLogs`; si falla, retorna sin restaurar lo borrado.
  - `convex/actions/poolScanner.ts:1057-1073`

Impacto:

- Un fallo transitorio de Alchemy/RPC puede convertir un cache previamente correcto en un subconteo.
- La UI puede seguir mostrando un valor numerico con `status: "error"`; en portal solo cambia el tooltip y en admin ni siquiera hay marca visible salvo el valor/tooltip.
  - `src/components/BotPortal.jsx:469-477`
  - `src/components/AdminView.jsx:170-196`

Ajuste requerido:

- No mutar `pool_fee_events` ni recomputar agregados hasta tener logs de una ventana contigua ya leida con exito.
- En error, mantener `cursorBlock`, `snapshotKey`, tabla y agregados previos; como mucho patch `feesLifetimeStatus: "error"`.
- Para incremental: leer/stagear logs de `[startBlock, scannedTo]`, y solo despues reemplazar atomica o transaccionalmente esa ventana y recomputar.
- Para backfill: no borrar todo antes del primer fetch. Usar staging por chunks o una mutation tipo `replacePoolFeeEventsRange(poolId, from, to, events)` que se invoque solo para rangos exitosos.

### ALTO 2 - Una posicion sin backfill historico puede pasar de `stale` a `ok`

Evidencia:

- En primera corrida con `cursor == null`, el cron inicializa `feesLifetimeCursorBlock = safeHead`, `lifetimeSnapshotKey = currentKey`, `status = "stale"` y no inserta eventos historicos ni inicializa un marcador de backfill.
  - `convex/actions/poolScanner.ts:951-957`
- En la siguiente corrida, si no hubo cambio estructural, `currentKey === storedKey` avanza el cursor y marca `status = "ok"`.
  - `convex/actions/poolScanner.ts:960-967`
- Ese `ok` no prueba que el historico anterior a `safeHead` exista en `pool_fee_events`. Si luego ocurre un `Collect`/`Decrease`/`Increase`, el recompute se hara desde una tabla que solo contiene eventos posteriores al cursor inicial, subcontando toda la vida anterior.

Impacto:

- Rompe la promesa central de JAV-117: lifetime exacto y retroactivo.
- Es especialmente riesgoso en deploy: si el cron corre antes del backfill externo de posiciones existentes, puede dejar el sistema en estado aparentemente confiable sin historico.

Ajuste requerido:

- Agregar un marcador explicito de cobertura historica, por ejemplo `feesLifetimeFromBlock`/`feesLifetimeBackfilledAt`/`feesLifetimeBackfillComplete`.
- No permitir `status: "ok"` por camino `nochange` si no existe ese marcador de backfill completo.
- Para pools nuevos creados despues del deploy, inicializar de forma explicita el origen aceptado (por ejemplo `feesLifetimeFromBlock = safeHead` con semantica de "sin historico previo porque es posicion nueva"), no mezclarlo con posiciones existentes.
- Alternativa minima: si `feesCollectedRaw0/1` y `principalDebt0/1` estan ausentes, el camino `nochange` debe conservar `stale`, no `ok`.

### MEDIO 1 - `no_key`/`error` no degradan realmente a "sin dato" si ya hay raw cacheado

Evidencia:

- `listPools` devuelve el documento completo del pool, incluyendo raw lifetime cacheado.
  - `convex/pools.ts:6-16`
- Portal pasa `feesCollectedRaw*` y `principalDebt*` a `fetchPositionLiquidity` aunque `feesLifetimeStatus` sea `no_key` o `error`.
  - `src/components/BotPortal.jsx:3793-3799`
- Si la action puede valuar esos raws, el portal mergea `feesLifetimeUsd` y lo muestra como numero. Solo `stale` agrega `*`; `no_key` y `error` no tienen marca visible.
  - `src/components/BotPortal.jsx:3860-3862`
  - `src/components/BotPortal.jsx:469-477`
- Admin hace lo mismo con `live?.feesLifetimeUsd`, y solo agrega `*` para `stale`.
  - `src/components/AdminView.jsx:170-174`

Impacto:

- El requisito original era degradar a `—` si falta `ALCHEMY_API_KEY`.
- Con cache previo, un ambiente sin key puede seguir mostrando un numero como si fuera utilizable, aunque no pueda refrescar eventos.

Ajuste requerido:

- Definir una semantica unica:
  - si `no_key`/`error` deben degradar, no mostrar `feesLifetimeUsd` y pintar `—`;
  - si se acepta mostrar ultimo cache, debe tener marca visible (`*`, badge o texto corto) y tooltip claro de "ultimo cache, no refrescable".
- En ambos casos, no tratarlo visualmente igual que `ok`.

## Validaciones positivas

- Topics verificados localmente con `viem`:
  - `IncreaseLiquidity(uint256,uint128,uint256,uint256)` -> `0x3067048b...5847e35f`
  - `DecreaseLiquidity(uint256,uint128,uint256,uint256)` -> `0x26f6a048...9d2377b4`
  - `Collect(uint256,address,uint256,uint256)` -> `0x40d0efd1...a8b8f01`
- La decodificacion `amount0=word1`, `amount1=word2` es correcta para los tres eventos segun la interfaz de Uniswap.
- `computeLifetimeAggregates` procesa eventos en orden `blockNumber/logIndex`; `Decrease` acumula `principalDebt`, `Collect` paga principal primero, e `Increase` no suma fees. Correcto.
  - `convex/pools.ts:244-268`
- `fetchPositionLiquidity` descuenta `principalDebt` del cobrable vivo antes de sumar lifetime. Correcto.
  - `convex/actions/poolScanner.ts:612-624`
- El wrapper mantiene compatibilidad de `feesUncollectedUsd` como `number | null`.
  - `convex/actions/poolScanner.ts:441-450`
- La senal `lifetimeSnapshotKey` usa `positions()` slots 7..11. Segun el contrato de Uniswap, `IncreaseLiquidity`, `DecreaseLiquidity` y `Collect` actualizan `liquidity`, `feeGrowthInside*Last` y/o `tokensOwed*`. Como optimizacion para "no hubo evento estructural", el enfoque es valido.
  - `convex/actions/poolScanner.ts:190-207`

## Comandos

- `git show --stat --oneline --decorate 4928e9d`
- `git diff --stat 4928e9d^ 4928e9d`
- `node -e "import('viem').then(... keccak256(toBytes(sig)) ...)"`
- `npm run typecheck` -> OK
- `npm test` -> OK, 17 archivos / 265 tests
- `npx vite build` -> OK, warnings no bloqueantes de Rollup/chunk

## Cierre

No hay evidencia de regresion en el money-path de ejecucion/cobertura. Pero para JAV-117 no daria push todavia: corregir primero los dos estados ALTO para que el cache historico no pueda degradarse ni marcarse `ok` sin backfill real. Luego reauditar el diff corto.
