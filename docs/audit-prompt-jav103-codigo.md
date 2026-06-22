# Prompt Codex — Auditoría de CÓDIGO JAV-103 (siembra de inventario, Spot Grid)

Auditas la IMPLEMENTACIÓN de la siembra de inventario (plan GO en `docs/plan-jav103-seeding.md`). Es
MONEY-PATH (órdenes reales en Hyperliquid Spot, mainnet). Haz checkout de `feat/jav103-seeding` y revisa
el diff contra `master`. Decide **GO / NO-GO** del código; clasifica hallazgos ALTO/MEDIO/BAJO.

Estado base: typecheck EXIT 0, 187/187 tests verdes, vite transforma OK.

## Archivos cambiados
- `convex/cloids.ts`: `spotGridCloidInput` gana `kind` (default "grid" = string idéntico → legacy-safe).
- `convex/hyperliquidSpot.ts`: `tif` admite "Ioc" (LIMIT marketable).
- `convex/schema.ts`: campos seed en `spot_grid_bots` (seedPercent/seedQty/seedAvgPx/seedNotionalReal/
  seedStatus/bootstrapPhase) y en `spot_grid_orders` (kind/repostBuyPrice). Todos opcionales.
- `convex/spotGridEngine.ts`: `calculateSellLadder`, `deriveSeededGrid`, `allocateSeededSells` (puros);
  `fillsForCloid`, `gatedPlaceIoc`; `runSeededBootstrap` (fases seed→sells→buys); guardas por `kind` en el
  loop de fills; liquidación opcional en `stopSpotGridBot`.
- `convex/spotGridBots.ts`: `recordSpotGridOrder` (kind/repostBuyPrice); `closeCycleAndRepost`
  (repostBuyPrice); `claimSpotGridReconcileForStop`; `setSpotGridBootstrap`; `getSeedMaxSlippageInternal`;
  `getSpotGridOrderByCloidInternal`; persist (seeded/seedPercent); `getSpotGridDetail` (accounting).
- `convex/spotGridActions.ts`: AUTO usa `deriveSeededGrid` (siembra siempre activa).
- `src/components/SpotGridView.jsx`: KPIs realizado/flotante/total + confirm de liquidación al detener.

## Verifica especialmente (money-path)
1. **Doble compra de la semilla:** el bootstrap "seed" ¿puede enviar el IOC dos veces ante reintento/
   reinicio/lease? Revisa: resolución por `fillsForCloid` antes de enviar; marca de "enviado" por
   `attempt>=2`; fail-closed tras `SEED_GRACE_MS` SIN reenviar. ¿Hay carrera entre la lectura de fills y
   el envío? ¿`sinceMs` (fillCursor=0) capta el fill correcto en cuenta dedicada?
2. **Idempotencia de fases:** `runSeededBootstrap` ¿es re-entrante? recordSpotGridOrder/placeOrder por
   cloid + advance de `bootstrapPhase`. ¿Re-correr una fase duplica órdenes?
3. **Namespace de cloid:** ¿`kind` evita TODA colisión por `by_cloid` entre seed/grid/liquidation? ¿La
   reposición de una SELL sembrada (kind grid, newCycle) colisiona con algo?
4. **closeCycleAndRepost:** ¿`repostBuyPrice` repone bien la BUY de una SELL sembrada (sin BUY previa)?
   ¿netProfit usa el costBasis de la semilla? Fallbacks legacy intactos.
5. **Fills loop:** las guardas `kind==="seed"&&side==="buy"` y `kind==="liquidation"` ¿evitan
   doble-conteo y post-sell/closeCycle indebidos? ¿El fillCursor avanza correctamente sin re-aplicar la
   compra semilla?
6. **Liquidación (stop):** DB-intent + cloid determinista + `gatedPlaceIoc` (gates live/red/lease) +
   `min(free, ...)` + dust (valor < min-notional) + `stopped` solo sin residuo. Reintentable desde
   `error` vía `claimSpotGridReconcileForStop`. ¿Vende más base de la que hay? ¿Marca stopped con residuo?
7. **gatedPlaceIoc:** ¿revalida gate+red+lease antes de CADA envío como `gatedPlace`? ¿IOC sin fill se
   trata bien (no asume fill)?
8. **deriveSeededGrid:** M≥2/K≥2 o error; M+K≤50; orderSize uniforme ≥ min-notional ambos lados; oráculo
   prometido==colocado. ¿Algún N degenera? ¿`UPSIDE_CAP_FRAC` deja casos raros?
9. **Contabilidad (getSpotGridDetail):** ¿realizado/flotante/total sin doble-conteo (semilla+buys−ventas)?
   ¿`priceStale` y `accountingTruncated` correctos? ¿Lectura acotada?
10. **Invariantes QSG:** solo LIMIT (IOC incluido), cloid propio, sin secretos en logs, cuenta dedicada,
    gate mainnet, tick/lot/min-notional, balance previo, red efectiva == bot.network.
11. **Legacy-safe:** el grid de $500 ya vivo (sin bootstrapPhase) ¿sigue por el camino actual sin cambios
    de cloid ni comportamiento?

Responde: GO/NO-GO, hallazgos por severidad con archivo:línea y arreglo concreto. Si NO-GO, qué cambiar
para el GO. No apliques cambios.
