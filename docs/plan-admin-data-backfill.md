# Plan — Subtarea de dato JAV-84: poblar `initialLiquidityUsd` (Liquidez LP)

## Problema
La Fase 1 del panel Admin muestra "Liquidez LP / $ monitoreado" desde `pool.initialLiquidityUsd`, pero
ese campo está **null** en los pools existentes (p.ej. el ETH/USDC del admin) → la UI muestra
"— incompleto". Causas:
- `initialLiquidityUsd` solo se captura al **AÑADIR** un pool nuevo (`BotPortal handleAdd` →
  `fetchPositionLiquidity` → `createPool`). Pools creados antes (o cuando la RPC falló) quedaron sin él.
- Existe `internal.pools.patchPoolInitialLiquidity` (idempotente, "nunca sobreescribe el histórico") pero
  **no tiene NINGÚN caller** → nunca rellena los que faltan.

`hedgeNotionalUsd` (celda "Cobertura (cap)"): el front NO lo pasa nunca; el motor de cobertura lee la
exposición **on-chain** en tiempo de arm (`fetchPositionNotionalStrict`), así que null NO afecta a la
operación. Se trata como campo de display → **fuera de alcance de esta subtarea** (la cobertura real en
vivo llega en Fase 2). No se toca config del bot (evitar zona money-path).

## Objetivo
Que `pool.initialLiquidityUsd` quede poblado para los pools con posición viva, de forma **durable** (no un
parche manual), reutilizando la lectura on-chain fiable que ya usa el motor.

## Diseño (auto-curado en el cron de escaneo, gateado a "si falta")
Reutilizar el cron existente `internal.actions.poolScanner.checkAllPoolClosures` (ya itera todos los pools
periódicamente, aislado por pool):
1. En el worker por pool, **además** de la lógica de cierre actual (no se toca), si:
   - `pool.tokenId != null`, **y**
   - `pool.initialLiquidityUsd == null` (solo los que faltan → coste puntual, no recurrente), **y**
   - la posición NO está cerrada (status vivo),
   entonces calcular la liquidez on-chain y persistirla:
   - precio actual vía slot0 (la misma ruta que `scanPoolByTokenId`/`fetchPositionNotionalStrict`),
   - liquidez USD vía **`fetchPositionNotionalStrict`** (la MISMA lectura fiable que el motor usa para la
     cobertura → el número mostrado coincidirá con la unidad de cobertura del plan),
   - si `liquidityUsd > 0` → `ctx.runMutation(internal.pools.patchPoolInitialLiquidity, { id,
     initialLiquidityUsd, initialLiquidityAt: Date.now() })`. La mutation ya es idempotente
     (`if pool.initialLiquidityUsd != null return`) → nunca pisa un valor existente ni el histórico.
2. **Aislamiento y coste:** el bloque va en su propio try/catch (un fallo de RPC NO aborta el chequeo de
   cierre ni los demás pools). Como solo corre cuando falta el dato, una vez relleno deja de costar.
   Respeta `POOL_SCAN_CONCURRENCY` ya existente.
3. **Sin cambios de schema** (los campos ya existen). Sin tocar el money-path (solo lectura on-chain +
   patch de un campo informativo idempotente).

### Alternativa considerada (descartada)
Acción one-shot por CLI para rellenar una vez. Descartada como solución única: no es durable (un pool
añadido con RPC caída volvería a quedar null). El auto-curado en el cron cubre presentes y futuros.
(Se puede, opcionalmente, exponer también una acción interna `backfillMissingInitialLiquidity` para forzar
el relleno inmediato sin esperar al cron — útil para verlo ya en el panel del admin tras desplegar.)

## Archivos
- `convex/actions/poolScanner.ts` — extender `checkAllPoolClosures` (worker por pool) con el bloque de
  auto-curado. Reutilizar helpers internos ya presentes (lectura slot0 + `fetchPositionNotionalStrict`).
- (Opcional) `convex/actions/poolScanner.ts` — `backfillMissingInitialLiquidity` (internalAction) para
  disparo inmediato vía CLI tras el deploy.
- NO se toca `bots`/`hedgeNotionalUsd` ni el motor.

## Verificación
- `npm run typecheck`.
- Deploy a `strong-sandpiper-848`; ejecutar el backfill (o esperar un tick del cron); comprobar con una
  query interna que `pool.initialLiquidityUsd` del ETH/USDC del admin pasó de null a un número > 0.
- En el panel Admin: KPI "TVL en pools (LP)" y la columna "$ monit." del admin muestran la cifra real
  (ya no "— incompleto"); la position card muestra "Liquidez LP (inicial)".
- Money-path intacto: no se modifica config de bots ni la lectura de cobertura del motor.

## Flujo
Plan → **Codex audita el plan** → GO → implementar → **Codex audita el código** → GO → PR → CodeRabbit →
deploy → backfill → verificación. Sin tests simulados.
