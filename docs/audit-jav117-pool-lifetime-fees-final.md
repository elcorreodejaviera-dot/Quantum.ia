# Auditoria final Codex - JAV-117 pool lifetime fees

## Alcance auditado

- Plan actualizado: `docs/plan-pool-lifetime-fees.md`.
- Reauditoria previa: `docs/audit-jav117-pool-lifetime-fees-reaudit.md`.
- Codigo de referencia:
  - `convex/actions/poolScanner.ts`
  - `convex/schema.ts`
  - `convex/pools.ts`
  - `convex/admin.ts`
  - `convex/adminLive.ts`
  - `src/components/BotPortal.jsx`
  - `src/components/AdminView.jsx`
- Fuentes externas revisadas:
  - Alchemy `eth_getLogs`: https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs
  - The Graph Post-Sunrise FAQ: https://thegraph.com/docs/en/archived/sunrise/
  - Uniswap v3 periphery:
    - https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/INonfungiblePositionManager.sol
    - https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol

## Veredicto

**GO condicionado final**, no GO limpio todavia.

El plan ya resolvio los hallazgos de fondo: `principalDebt`, raw amounts, backfill externo, `stale`, tabla de eventos, UI/admin cache-only y subgraphs fuera de alcance. Quedan tres ajustes puntuales antes de escribir codigo. Son pequenos de plan, pero importantes para no implementar una dedupe falsa o saltarse un cobro real.

## Bloqueante

No quedan bloqueantes de producto si se aplican los ajustes altos de abajo antes de implementar.

## Alto

### 1. Convex no hace indices unicos por schema

Evidencia:

- El plan dice: indice **unico** `by_pool_log = (poolId, txHash, logIndex)` e insert idempotente (`docs/plan-pool-lifetime-fees.md:99-105`).
- En Convex, un `.index(...)` acelera consultas, pero no impone unicidad como una constraint SQL.

Riesgo:

- Si se implementa confiando en la "unicidad" del indice, un re-scan puede insertar dos veces el mismo log y duplicar fees/principal.

Ajuste requerido:

- Cambiar el plan a: `by_pool_log` es indice de busqueda, no constraint.
- La mutation debe hacer upsert/idempotencia explicita: consultar por `(poolId, txHash, logIndex)` dentro de la misma mutation y no insertar si existe.
- Los agregados deben recomputarse desde eventos distintos. Si se procesa en lote, deduplicar tambien en memoria por `txHash:logIndex`.

### 2. La senal "sin getLogs" no puede basarse en `positions().tokensOwed` como si fuera live

Evidencia:

- El plan dice que el scan barato `positions()` ya da `liquidity` y `tokensOwed`, y si `liquidity` no cambio y `tokensOwed` solo crecio, no hubo `Increase/Decrease/Collect` (`docs/plan-pool-lifetime-fees.md:86-90`).
- En Uniswap v3, `positions().tokensOwed0/1` es un checkpoint almacenado; las fees pasivas por swaps no se actualizan ahi hasta un `collect`, `increaseLiquidity`, `decreaseLiquidity` o poke equivalente.
- El repo actual usa `collect` callStatic precisamente para obtener fees cobrables actuales (`convex/actions/poolScanner.ts:277-323`).

Riesgo:

- Un `Collect` puede dejar `positions().tokensOwed` igual que antes si antes era 0 y las fees no estaban checkpointed; el cambio real solo se ve comparando el `collect` callStatic raw antes/despues o los snapshots de `feeGrowthInside`.
- Una secuencia `DecreaseLiquidity` + `IncreaseLiquidity` dentro del mismo intervalo puede terminar con la misma `liquidity` final, pero si no se escanean logs cambia la contabilidad de `principalDebt`.

Ajuste requerido:

- Separar senales:
  - `positions()` para estado persistido: `liquidity`, `tokensOwed0/1` almacenado, `feeGrowthInside0LastX128/1LastX128`.
  - `collect` callStatic raw para `tokensOwedNow0/1` live.
- Avanzar cursor sin getLogs solo si:
  - el snapshot persistido de `positions()` no cambio en campos estructurales relevantes;
  - `collect` callStatic raw no bajo;
  - no hay backlog/stale previo para ese pool.
- Si cambia `liquidity`, `tokensOwed` almacenado o `feeGrowthInside*LastX128`, o si baja el raw live de callStatic, disparar getLogs.

### 3. La limpieza anti-reorg debe borrar/recalcular la ventana re-escaneada, no solo eventos `> latest - confirmations`

Evidencia:

- El plan re-escanea desde `cursor - margenReorg` hasta `latest - confirmations` (`docs/plan-pool-lifetime-fees.md:122-126`).
- Pero la seccion de reorg dice borrar eventos con `blockNumber > latest - confirmations` (`docs/plan-pool-lifetime-fees.md:105`).

Riesgo:

- Si una reorg afecta la ventana de overlap, los logs viejos de esa ventana quedan en la tabla y los nuevos se insertan al lado. El dedupe por `txHash/logIndex` no elimina logs de una rama vieja con hash/log diferente.

Ajuste requerido:

- Antes de reinsertar el overlap, borrar eventos del pool con `blockNumber >= fromBlock` para esa ventana y recomputar agregados desde la tabla; o guardar `blockHash` y remover logs cuyo bloque ya no coincide.
- Mantener el cursor solo en bloque finalizado (`latest - confirmations`).

## Medio

### 1. Binary-search por `eth_call` historico debe tener fallback

El plan propone binary-search por `blockNumber` con `eth_call positions()` (`docs/plan-pool-lifetime-fees.md:89`). Eso es razonable para ventanas recientes, pero algunos RPC publicos pueden rechazar llamadas historicas. Si falla, no debe bloquear el scanner: caer a chunking de 10 bloques con presupuesto y marcar `stale` si no alcanza.

### 2. El orden de implementacion debe poner el backfill/script despues del schema y antes de confiar en UI completa

El plan lista el script de backfill como paso 7, despues de UI (`docs/plan-pool-lifetime-fees.md:163-172`). Para codigo esta bien, pero para validacion funcional conviene correr backfill antes de declarar la feature lista; si no, UI mostrara `stale`/`—` en pools viejos.

## Bajo

### 1. Actualizar el encabezado del plan

El encabezado todavia dice "pendiente GO final de Codex" y solo lista decisiones A/B en las primeras lineas, aunque ya existe decision C (`docs/plan-pool-lifetime-fees.md:3-9`, `:181-188`). No afecta implementacion, pero conviene sincronizarlo para que Claude no lea un estado viejo.

## Respuestas finales

- Formula con `principalDebt`: **GO**.
- Spot actual: **GO**, documentado como valuacion actual.
- Backfill externo: **GO**.
- Incremental Free + stale: **GO condicionado** a corregir la senal de deteccion y fallback.
- `pool_fee_events`: **GO condicionado** a idempotencia explicita, porque el indice Convex no es unico.
- Anti-reorg: **GO condicionado** a borrar/recalcular la ventana re-escaneada.
- Degradacion sin key/stale/error: **GO**.
- Vida total con `initialLiquidityAt`: **GO**.
- Subgraphs: **GO** como JAV-118 aparte.

## Pruebas/comandos revisados

- `nl -ba docs/plan-pool-lifetime-fees.md`
- `rg -n "Decisión C|Free|presupuesto|stale|pool_fee_events|unique|txHash|logIndex|binary|blockNumber|tokensOwed|lastTokensOwed|feesLifetimeStatus|recompute|recomput|reorg|confirmations|getLogs|adminLive|getUserDetail|wrapper|raw" docs/plan-pool-lifetime-fees.md convex src`
- `git status --short`

No se ejecutaron tests porque fue auditoria de plan, sin cambios de codigo runtime.
