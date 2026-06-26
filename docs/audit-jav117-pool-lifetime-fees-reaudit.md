# Reauditoria Codex - JAV-117 pool lifetime fees

## Alcance auditado

- Plan actualizado: `docs/plan-pool-lifetime-fees.md`.
- Auditoria previa usada como base: `docs/audit-jav117-pool-lifetime-fees.md`.
- Codigo revisado para compatibilidad:
  - `convex/actions/poolScanner.ts`
  - `convex/schema.ts`
  - `convex/pools.ts`
  - `convex/admin.ts`
  - `convex/adminLive.ts`
  - `convex/crons.ts`
  - `convex/actions/uniswap.ts`
  - `src/components/BotPortal.jsx`
  - `src/components/AdminView.jsx`
- Fuentes externas verificadas de nuevo:
  - Alchemy `eth_getLogs`: https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs
  - The Graph Post-Sunrise FAQ: https://thegraph.com/docs/en/archived/sunrise/
  - Uniswap v3 periphery interfaces/manager:
    - https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/INonfungiblePositionManager.sol
    - https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol

## Veredicto

**GO condicionado**, no GO limpio.

El plan ya incorpora los bloqueantes principales de la auditoria anterior: elimina la formula ingenua `ΣCollect - ΣDecrease`, usa `principalDebt`, cachea cantidades raw, acepta vida total con `initialLiquidityAt`, y manda los subgraphs muertos a JAV-118.

Puede pasar a codigo si antes se corrigen dos ajustes de plan: el incremental con Alchemy Free debe quedar acotado matematicamente, y el esquema debe soportar dedupe real cuando se re-escanea una ventana anti-reorg.

## Bloqueante

No quedan bloqueantes de producto si se aplican los condicionantes de severidad alta antes de implementar.

## Alto

### 1. Alchemy Free tambien limita el incremental, no solo el back-fill

Evidencia:

- El plan corrigio el back-fill amplio con un script externo puntual (`docs/plan-pool-lifetime-fees.md:75-85`, `:156-160`).
- Pero mantiene que el cron incremental recurrente use Alchemy Free (`docs/plan-pool-lifetime-fees.md:84`, `:141-146`).
- La documentacion actual de Alchemy indica que `eth_getLogs` Free soporta rango de 10 bloques en Ethereum, Base, Optimism y Arbitrum, mientras PAYG/Enterprise son `unlimited` para esas cadenas.

Riesgo:

- Un cron cada 10 minutos en L2 puede acumular cientos de bloques por posicion. Con rango maximo 10, eso se convierte en decenas o cientos de requests por posicion y por corrida, incluso cuando no hay eventos.
- Si el cron se retrasa, se apaga o hay muchas posiciones, el cursor queda atras y el mantenimiento incremental puede volverse inviable o degradar a "—" permanentemente.

Ajuste requerido antes de codigo:

- Elegir una de estas opciones y dejarla explicita en el plan:
  - usar Alchemy PAYG para el cron incremental;
  - usar un proveedor/log API que permita rangos amplios tambien en incremental;
  - usar suscripcion/webhook/indexer externo para eventos `Collect/Decrease/Increase`;
  - mantener Free, pero con un presupuesto duro: max blocks por corrida, max requests por posicion, backlog queue, y estado visible `stale` si no alcanza.

### 2. El schema propuesto no permite dedupe anti-reorg sin doble conteo

Evidencia:

- El plan propone re-escanear desde `cursor - margenReorg`, dedupe por `(txHash, logIndex)` y avanzar hasta `latest - confirmations` (`docs/plan-pool-lifetime-fees.md:99-104`).
- El schema propuesto guarda agregados raw y cursor (`feesCollectedRaw0/1`, `principalDebt0/1`, `feesLifetimeCursorBlock`) pero no guarda ids de logs procesados ni un checkpoint anterior al margen (`docs/plan-pool-lifetime-fees.md:86-95`).

Riesgo:

- Si se re-escanea una ventana ya incluida en los agregados, los eventos del overlap se vuelven a sumar. Con solo agregados no hay forma de saber que `(txHash, logIndex)` ya fue aplicado.
- Esto puede duplicar fees o principalDebt justo en el mecanismo creado para evitar reorgs.

Ajuste requerido antes de codigo:

- Agregar uno de estos modelos:
  - guardar una tabla `pool_fee_events` con `poolId`, `txHash`, `logIndex`, `blockNumber`, `eventType`, amounts raw, y dedupe por log id;
  - guardar en `pools` una lista acotada de `recentProcessedLogIds` para la ventana anti-reorg;
  - crear checkpoints por bloque finalizado y recomputar el overlap desde el checkpoint, no sumar encima del agregado existente.

## Medio

### 1. El helper actual de fees devuelve USD, pero el plan necesita raw tokens owed

Evidencia:

- `fetchUncollectedFeesUsd` retorna solo USD (`convex/actions/poolScanner.ts:277-323`).
- El plan ahora necesita `tokensOwedNow0/1` raw para descontar `principalDebt` (`docs/plan-pool-lifetime-fees.md:57-64`, `:108-112`).

Ajuste requerido:

- Cambiar o envolver el helper para devolver `{ amount0Raw, amount1Raw, feesUsd? }`.
- Mantener compatibilidad con los consumidores actuales de `feesUncollectedUsd` para no romper portal/admin.

### 2. Admin requiere serializacion explicita de los campos nuevos

Evidencia:

- Portal `listPools` devuelve la fila completa de `pools`.
- `getUserDetail` en admin arma manualmente el objeto `pool` y hoy no incluye `initialLiquidityAt` ni lifetime fields (`convex/admin.ts:181-190`).
- `adminLive` devuelve `feesUncollectedUsd` vivo, pero no lifetime (`convex/adminLive.ts:70-98`).

Ajuste requerido:

- Agregar `initialLiquidityAt`, estado de lifetime y valores raw/valuados donde corresponda en `getUserDetail` y/o `getUserAdminLiveSnapshot`.
- Evitar llamadas historicas desde la UI o desde expandir usuario; la UI debe consumir cache/estado ya preparado.

### 3. Renombrar `lastCollectRaw0/1`

Evidencia:

- El plan define `lastCollectRaw0/1` como "ultimo `tokensOwed` raw visto" (`docs/plan-pool-lifetime-fees.md:93`).

Riesgo:

- El nombre parece evento `Collect`, pero representa snapshot de `tokensOwed`. Puede inducir una implementacion equivocada.

Ajuste recomendado:

- Usar `lastTokensOwedRaw0/1`.

## Bajo

### 1. Documentar estado `stale`

Ademas de "—", conviene exponer un estado tipo `feesLifetimeCalcAt`/`stale` cuando hay cache raw vieja pero el incremental no alcanzo a ponerse al dia. Esto evita ocultar que el numero puede estar atrasado.

### 2. Subgraphs muertos quedan correctamente fuera de JAV-117

El plan ya apunta el colateral a JAV-118. Confirmado: el repo usa `api.thegraph.com/subgraphs/name/...` en `convex/actions/uniswap.ts`, y The Graph documenta que el hosted service termino el 12-jun-2024 y que sus query endpoints ya no estan disponibles.

## Respuestas actualizadas a las 8 preguntas

1. **Formula:** ahora si, el enfoque con `principalDebt` cronologico es el correcto. Condicion: descontar tambien `principalDebt` del `tokensOwed` vivo raw.
2. **Spot actual:** aceptable en v1 si se comunica como valuacion a precio actual, no USD historico realizado.
3. **getLogs por tokenId:** filtro correcto porque `tokenId` es indexed. Back-fill externo soluciona el historico; incremental con Free aun necesita presupuesto o proveedor distinto.
4. **Cache en pools vs tabla nueva:** agregados en `pools` sirven, pero para anti-reorg real hace falta tabla de eventos, lista reciente de log ids, o checkpoints.
5. **Senal de refresco:** raw/eventos correcto; no USD.
6. **Incremental + reorgs:** concepto correcto, pero incompleto sin persistir dedupe/checkpoint para el overlap.
7. **Sin Alchemy:** OK mostrar "—" si no rompe scanner/queries. Mejor distinguir "sin key", "stale" y "error".
8. **Cierre + reapertura:** decision cerrada de vida total con `initialLiquidityAt`; consistente con el codigo actual.

## Pruebas/comandos revisados

- `git status --short`
- `nl -ba docs/plan-pool-lifetime-fees.md`
- `rg -n "principalDebt|feesCollected.*Raw|feesLifetime|activeSinceAt|ALCHEMY|eth_getLogs|fromBlock|lastScanned|confirmations|reorg|Collect|DecreaseLiquidity|IncreaseLiquidity|initialLiquidityAt" docs convex src`
- Revision previa de:
  - `convex/actions/poolScanner.ts`
  - `convex/schema.ts`
  - `convex/pools.ts`
  - `convex/admin.ts`
  - `convex/adminLive.ts`
  - `convex/crons.ts`
  - `convex/actions/uniswap.ts`
  - `src/components/BotPortal.jsx`
  - `src/components/AdminView.jsx`

No se ejecutaron tests porque fue una reauditoria de plan, sin cambios de codigo de runtime.
