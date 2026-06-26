# Auditoria Codex - JAV-117 pool lifetime fees

## Alcance auditado

- Plan: `docs/plan-pool-lifetime-fees.md`.
- Codigo revisado:
  - `convex/actions/poolScanner.ts`
  - `convex/schema.ts`
  - `convex/pools.ts`
  - `convex/admin.ts`
  - `convex/adminLive.ts`
  - `convex/crons.ts`
  - `convex/actions/uniswap.ts`
  - `src/components/BotPortal.jsx`
  - `src/components/AdminView.jsx`
- Fuentes externas primarias revisadas:
  - Uniswap v3 periphery `INonfungiblePositionManager`: eventos `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect` con `tokenId indexed`.
    https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/INonfungiblePositionManager.sol
  - Uniswap v3 periphery `NonfungiblePositionManager`: `decreaseLiquidity` suma principal + fees a `tokensOwed`; `collect` cobra `tokensOwed`.
    https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol
  - Alchemy `eth_getLogs`: limites actuales por tier.
    https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs
  - The Graph Post-Sunrise FAQ: hosted service query endpoints no longer available; Sunrise ended June 12, 2024.
    https://thegraph.com/docs/en/archived/sunrise/

## Veredicto

**NO GO** para escribir codigo tal como esta el plan.

La direccion de producto es correcta, pero hay dos bloqueantes: la formula propuesta puede mezclar principal retirado con fees cuando existe `DecreaseLiquidity` no totalmente cobrado, y Alchemy Free no es viable para un backfill retroactivo amplio con `eth_getLogs` segun la documentacion actual. Corregidos esos dos puntos, el plan queda cerca de **GO condicionado** con los ajustes altos/medios listados abajo.

## Bloqueante

### 1. La formula `ΣCollect - ΣDecrease + feesUncollected` no es segura si hay principal pendiente de cobro

Evidencia:

- El plan asume que `feesUncollectedUsd` cubre solo fees actuales sin cobrar (`docs/plan-pool-lifetime-fees.md:45-49`).
- En Uniswap v3, `DecreaseLiquidity` suma a `tokensOwed` el principal retirado (`amount0/amount1`) mas las fees acumuladas por feeGrowth; luego `Collect` cobra desde `tokensOwed`.
- El scanner actual obtiene `feesUncollectedUsd` simulando `collect()` con maximos (`convex/actions/poolScanner.ts:277-323`), por lo que el dato puede incluir principal pendiente si hubo un `DecreaseLiquidity` previo no cobrado.

Riesgo:

- Si el usuario reduce liquidez y no cobra todo inmediatamente, `ΣDecrease` resta principal que aun no aparece en `ΣCollect`, y el `collect` simulado devuelve principal + fees. El lifetime puede quedar subestimado, sobreestimado o clamped a 0 de forma incorrecta.
- Ejemplo por token: `Decrease=1000`, fees pendientes `100`, `Collect=0`. La formula del plan da `feesCobradas=0` por clamp, y al sumar `feesUncollected=1100` mostraria `1100` como fees, cuando fees reales son `100`.

Ajuste requerido:

- Procesar eventos cronologicamente por token y mantener una deuda de principal pendiente:
  - `principalDebt += DecreaseLiquidity.amount`
  - en cada `Collect`, primero reducir `principalDebt` hasta 0; solo el excedente cuenta como fee cobrada
  - `feesPendientes = max(0, collectCallStaticAmount - principalDebtActual)`
  - `feesLifetime = feesCobradas + feesPendientes`
- Evitar usar `feesUncollectedUsd` bruto como "fees" despues de cualquier `DecreaseLiquidity`; si se reutiliza el helper, debe devolver cantidades raw por token y el calculo debe descontar principal pendiente.

### 2. Alchemy Free no valida el backfill retroactivo amplio planteado

Evidencia:

- El plan propone `fromBlock = mintBlock (o "earliest")` y espera que un request amplio por evento/tokenId sea viable en Alchemy Free (`docs/plan-pool-lifetime-fees.md:77-80`, `:150`).
- La referencia actual de Alchemy para `eth_getLogs` lista para Free un rango soportado de 10 bloques en Ethereum/Base/Optimism/Arbitrum, con respuestas capadas a 150 MB. PAYG/Enterprise figuran como `unlimited` para esas cadenas.

Riesgo:

- Con Free, un backfill desde mint/earliest por posicion requeriria demasiadas llamadas si el rango real son millones de bloques, aunque el filtro por `tokenId` sea selectivo.
- La implementacion podria quedarse incompleta, golpear rate limits o degradar a "—" para casi todas las posiciones antiguas, contradiciendo el objetivo "exacto y retroactivo".

Ajuste requerido:

- No aprobar "Alchemy Free + eth_getLogs retroactivo" como base de produccion.
- Opciones validas:
  - usar Alchemy PAYG/plan con rango amplio para el backfill historico;
  - hacer un job one-shot/offline de backfill con proveedor que soporte rangos amplios y luego mantener incremental barato;
  - cambiar el alcance v1 a no retroactivo para Free, guardando `startBlock` al registrar posicion.
- Si se mantiene Free, el plan debe declarar explicitamente que las posiciones preexistentes no tendran retroactivo fiable.

## Alto

### 1. El cache propuesto guarda USD, pero la valuacion elegida es spot actual

Evidencia:

- El plan dice que v1 valua a precio spot actual (`docs/plan-pool-lifetime-fees.md:59-63`).
- El schema propuesto guarda `feesCollectedLifetimeUsd` y `feesLifetimeUsd` (`docs/plan-pool-lifetime-fees.md:87-92`).

Riesgo:

- Si se cachea USD, el componente "collected" queda valuado al precio del ultimo cron, no al spot actual de pantalla. Luego `feesCollectedLifetimeUsd + feesUncollectedUsd vivo` mezcla precios de momentos distintos.

Ajuste requerido:

- Persistir cantidades raw o decimal-string por token, no solo USD:
  - `feesCollected0Raw`, `feesCollected1Raw`
  - `principalDebt0Raw`, `principalDebt1Raw`
  - `lastScannedBlock`, idealmente `lastScannedBlockHash`
  - `lastCollectAt`
- Calcular USD en cada refresco con el spot actual, o exponer tambien una cache USD solo como display stale/temporal con `calcAt`.

### 2. `initialLiquidityAt` no se reinicia hoy al reabrir

Evidencia:

- El plan propone que v1 cuente desde `initialLiquidityAt` vigente y se reinicie al reabrir (`docs/plan-pool-lifetime-fees.md:130`, `:163`).
- `patchPoolInitialLiquidity` nunca sobreescribe `initialLiquidityAt` si ya existe (`convex/pools.ts:142-148`).
- `reopenPoolIfClosed` limpia `closedAt` pero no modifica `initialLiquidityAt` (`convex/pools.ts:207-227`).

Riesgo:

- La UI mostraria vida total desde la primera captura, no vida desde reapertura, aunque el plan diga lo contrario.

Ajuste requerido:

- Decidir producto:
  - si "vida actual" es lo correcto, agregar `activeSinceAt` o actualizar un campo especifico en `reopenPoolIfClosed`;
  - si "vida historica total" es lo correcto, usar `initialLiquidityAt` y cambiar el copy del plan/UI.
- No reutilizar `initialLiquidityAt` para dos significados distintos.

### 3. La deteccion de cobro por caida de `feesUncollectedUsd` puede dar falsos positivos/negativos

Evidencia:

- El plan propone refrescar al detectar que `feesUncollected` cayo respecto al snapshot anterior (`docs/plan-pool-lifetime-fees.md:98-101`).
- El scanner actual solo expone USD (`convex/actions/poolScanner.ts:313-319`), valuado con spot actual.

Riesgo:

- Una baja de precio spot puede parecer cobro aunque los raw fees suban.
- Un cobro puede quedar oculto si el precio sube lo suficiente.

Ajuste requerido:

- Comparar cantidades raw por token, no USD.
- Preferir que el cron incremental detecte `Collect` por eventos y actualice `lastCollectAt`.
- Si se usa el collect simulado como senal, extender el helper para devolver `amount0Raw/amount1Raw` junto a USD.

### 4. Escaneo incremental necesita margen de finalidad/reorg y no solo `fromBlock = ultimo + 1`

Evidencia:

- El plan propone guardar `feesLifetimeFromBlock` y pedir solo `ultimo + 1` (`docs/plan-pool-lifetime-fees.md:101`, `:161`).

Riesgo:

- Reorgs o logs removidos en L2 pueden dejar eventos perdidos o duplicados si se avanza el cursor sin margen.

Ajuste requerido:

- Escanear hasta `latest - confirmations`.
- En cada corrida re-escanear una ventana de seguridad (`lastScannedBlock - margin`) y deduplicar por `transactionHash + logIndex`.
- Guardar `lastScannedBlockHash` o estructura equivalente si se quiere detectar reorgs explicitamente.

## Medio

### 1. Campos en `pools` es aceptable, pero incompleto para el estado necesario

Campos en `pools` esta bien para una fila por posicion y UI simple. No hace falta tabla nueva para v1 si se guardan agregados raw y cursores. Pero si se quiere auditar/reproducir eventos o depurar discrepancias, una tabla `pool_fee_events` o `pool_fee_state` separada seria mas limpia.

Recomendacion:

- V1: campos en `pools`, pero con raw amounts y cursores.
- Tabla nueva solo si se necesita historial/eventos visibles o reconciliacion avanzada.

### 2. Admin no recibira los campos nuevos solo por tocar schema

Evidencia:

- Portal `listPools` devuelve la fila completa (`convex/pools.ts:6-17`).
- Admin `getUserDetail` arma un objeto `pool` manual y hoy solo incluye `initialLiquidityUsd`, `tvl`, `fees1d`, `closed`, etc. (`convex/admin.ts:181-190`).
- Admin live `getUserAdminLiveSnapshot` hoy expone `feesUncollectedUsd` pero no lifetime (`convex/adminLive.ts:70-98`).

Riesgo:

- Portal puede ver campos nuevos automaticamente, pero admin no, salvo que se serialicen expresamente.

Ajuste requerido:

- Anadir `initialLiquidityAt`, `feesLifetimeUsd`/raw-calculado y estado de disponibilidad en `getUserDetail`.
- Si admin live recalcula con spot actual, exponer el valor ya compuesto ahi; si no, mantenerlo como DB-cache y mostrar stale con `calcAt`.

### 3. Degradacion sin Alchemy es correcta, pero debe aislarse de queries y cron

La degradacion a "—" es correcta si falta `ALCHEMY_API_KEY`. Debe implementarse como dato opcional, sin lanzar desde queries ni desde el scanner existente. El cron debe marcar `unavailable`/`skipped`, no abortar el cron de cierre ni las lecturas actuales de liquidez/fees.

### 4. Backfill desde `earliest` debe evitarse incluso con proveedor capaz

Mejor `fromBlock = mintBlock` que `earliest`. Para obtenerlo:

- primera opcion: el primer `IncreaseLiquidity` del `tokenId` es el mint;
- si el usuario registra una posicion nueva, guardar `registeredBlock`/`observedFromBlock` en ese momento;
- para posiciones viejas, el backfill one-shot puede buscar el primer `IncreaseLiquidity` o `Transfer` mint del NFT.

## Bajo

### 1. Documentar que USD lifetime no es USD historico realizado

La cantidad por token puede ser exacta; el USD a spot actual no representa el USD recibido en cada fecha de cobro. El copy de UI debe decir algo como "valorado a precio actual" para evitar interpretacion financiera equivocada.

### 2. Nombre de archivo/ruta en el prompt

El prompt menciona `poolScanner.ts:277-323`; en el repo la ruta real es `convex/actions/poolScanner.ts:277-323`.

## Respuestas a las 8 preguntas de la seccion 13

1. **Formula `ΣCollect - ΣDecrease`:** correcta solo cuando todo principal liberado por `DecreaseLiquidity` ya fue cobrado, y no se suma un `collect` simulado que contiene principal pendiente. Para producto real, ajustar a procesamiento cronologico con `principalDebt` por token.
2. **Valuacion spot actual:** aceptable en v1 si se comunica como aproximacion USD a precio actual. Para consistencia, persistir raw token amounts y valuar al spot de calculo/display.
3. **`getLogs` por `tokenId`:** el filtro es correcto porque `tokenId` es indexado. Pero con Alchemy Free actual no es viable un request amplio desde mint/earliest; requiere plan PAYG/backfill externo o scope no retroactivo.
4. **Cache en `pools` vs tabla nueva:** `pools` es aceptable para v1, pero los campos deben incluir raw amounts y cursor/reorg metadata. Tabla nueva solo si se quiere historial auditable.
5. **Senal de refresco:** no comparar USD. Comparar raw amounts o, mejor, detectar `Collect` por eventos en cron incremental.
6. **Incremental + reorgs:** si, guardar cursor, pero con margen de confirmaciones, re-scan de ventana y dedupe por log id.
7. **Sin Alchemy:** OK mostrar "—" si se aisla el fallo y no se toca el resto del scanner/queries.
8. **Cierre + reapertura:** el plan y el codigo no coinciden. Hoy `initialLiquidityAt` no se reinicia. Elegir "vida actual" con campo nuevo/actualizacion en reapertura, o "vida total" usando el campo existente.

## Hallazgo colateral: subgraphs hosted-service

Confirmado: conviene abrir issue aparte.

Evidencia:

- El repo usa endpoints `https://api.thegraph.com/subgraphs/name/...` en `convex/actions/uniswap.ts:7-11`.
- The Graph documenta que el hosted service termino el 12-jun-2024 y que sus query endpoints ya no estan disponibles.

Impacto:

- `fetch Uniswap V3 subgraph` puede estar permanentemente sin datos y solo fallar silenciosamente.
- Afecta caches `subgraphVolumeUsd1d`, `subgraphFeesUsd1d`, `subgraphTvlUsd` y fallbacks admin, pero no bloquea JAV-117 si lifetime fees no depende de esos subgraphs.

Recomendacion:

- Issue separado para retirar/migrar `convex/actions/uniswap.ts` a Subgraph Studio/Gateway o eliminar el cron si DeFiLlama/on-chain cubre esos datos.

## Pruebas/comandos revisados

- `nl -ba docs/plan-pool-lifetime-fees.md`
- `nl -ba convex/actions/poolScanner.ts | sed -n '1,130p'`
- `nl -ba convex/actions/poolScanner.ts | sed -n '260,340p'`
- `nl -ba convex/actions/poolScanner.ts | sed -n '420,700p'`
- `nl -ba convex/actions/poolScanner.ts | sed -n '687,790p'`
- `nl -ba convex/schema.ts | sed -n '1,120p'`
- `nl -ba convex/pools.ts | sed -n '1,230p'`
- `nl -ba convex/admin.ts | sed -n '1,260p'`
- `nl -ba convex/adminLive.ts | sed -n '1,130p'`
- `nl -ba convex/crons.ts`
- `nl -ba convex/actions/uniswap.ts | sed -n '1,220p'`
- `nl -ba src/components/BotPortal.jsx | sed -n '400,610p'`
- `nl -ba src/components/AdminView.jsx | sed -n '90,310p'`
- `rg -n "feesUncollectedUsd|feesCollectedLifetime|feesLifetime|initialLiquidityAt|lastCollectAt|subgraphs|thegraph|poolScanner|PoolCard|PositionCard|UserRow"`
- `rg -n "pool_events|markPoolClosedAndPauseBots|reopenPoolIfClosed|initialLiquidityAt|closedAt" convex src docs/plan-pool-lifetime-fees.md`
- `rg -n "gql\\(|api\\.thegraph\\.com|subgraph" convex src docs`

No se ejecutaron tests porque fue una auditoria de plan, sin cambios de codigo de runtime.
