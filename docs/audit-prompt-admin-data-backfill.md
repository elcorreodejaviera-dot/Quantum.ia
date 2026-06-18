# Prompt de auditoría (Codex) — Plan subtarea de dato JAV-84 (poblar initialLiquidityUsd)

Audita el **PLAN** `docs/plan-admin-data-backfill.md`. Objetivo: poblar `pool.initialLiquidityUsd` (hoy null
en pools existentes) para que el panel Admin muestre la Liquidez LP real, reutilizando la lectura on-chain
del motor, de forma durable (auto-curado en el cron `checkAllPoolClosures`, gateado a "si falta").

Contexto repo (Quantum.ia): Convex + Hyperliquid; `patchPoolInitialLiquidity` (pools.ts) es idempotente y
hoy NO tiene callers; `fetchPositionNotionalStrict` (poolScanner) es la lectura fiable de cobertura que usan
hyperliquid.ts:490 y triggerEngine.ts:221; `checkAllPoolClosures` es un cron que itera pools con
`POOL_SCAN_CONCURRENCY` y aísla fallos por pool. `hedgeNotionalUsd` lo lee el motor on-chain (null no rompe).

Responde GO/NO-GO con hallazgos accionables:
1. ¿Es correcto y seguro auto-curar dentro de `checkAllPoolClosures`? ¿El bloque nuevo puede interferir con
   la detección de cierre / `markPoolClosedAndPauseBots` / `reopenPoolIfClosed`? ¿Debe ir aislado en su
   try/catch para no abortar el chequeo de cierre?
2. ¿El gate (`tokenId != null` && `initialLiquidityUsd == null` && posición viva) evita coste recurrente y
   evita pisar el histórico? ¿`patchPoolInitialLiquidity` idempotente es suficiente ante carreras del cron?
3. ¿Usar `fetchPositionNotionalStrict` para el valor mostrado es coherente con la unidad de cobertura del
   plan (JAV-77) y con lo que el motor reserva? ¿O initialLiquidityUsd debería ser "sin buffer" explícito?
4. Coste/latencia: añadir una lectura on-chain por pool-sin-dato por tick, ¿aceptable con la concurrencia
   actual? ¿algún riesgo de rate-limit RPC o de alargar el cron?
5. ¿Conviene además la acción `backfillMissingInitialLiquidity` para disparo inmediato? ¿riesgos?
6. ¿Algún caso en que `liquidityUsd > 0` sea engañoso (posición fuera de rango, token0/1 invert, decimales)?
7. Frontera testnet/mainnet y multi-red (RPC por `pool.network`).
8. ¿Se respeta NO tocar money-path (no se cambia config de bots ni la lógica de reserva/arming)?
