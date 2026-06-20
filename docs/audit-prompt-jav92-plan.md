# Prompt de auditoría Codex — PLAN de JAV-92 (Motor Live Spot Grid, QSG PR3)

Eres un auditor senior. Audita el **PLAN** (no código) del motor money-path del Quantum Spot Grid (PR3 de
la épica JAV-89). Coloca/mantiene órdenes LIMIT reales en Hyperliquid Spot. Responde **GO / NO-GO** con
hallazgos numerados (ALTO/MEDIO/BAJO).

## Documentos / contexto
- Plan: `docs/plan-jav92-spot-grid-engine.md`.
- Ya mergeado y reutilizable: `convex/hyperliquidSpot.ts` (PR1: resolveSpotAsset, getSpotPrice,
  getSpotBalance, getUserFees, roundSpotPrice, floorSpotSize, roundAndValidateSpotOrder, assertMinNotional,
  buildSpotLimitOrder, placeSpotLimit, cancelSpotByCloid, makeSpotClients, withSpotTimeout,
  MIN_SPOT_NOTIONAL_USD), `convex/cloids.ts` (toHlCloid, spotGridCloidInput), `convex/spotGridBots.ts` (PR2:
  schema spot_grid_bots/orders/cycles, createSpotGridBot/persist/preflight, pause/list/get).
- Patrón a replicar: `convex/triggerArms.ts` (claimArmReconcile/renew/release, fencing por
  reconcileLeaseToken/Until), `convex/triggerEngine.ts` (reconcileStaleArms: lista→claima→makeClients(
  decryptPrivateKey)→reconcilia), `convex/cronHealth.ts` (withCronHealth), `convex/crons.ts`.

## Verifica (CRÍTICO money-path)
1. **Idempotencia y no-duplicación.** ¿El esquema cloid determinista (botId|generation|cycleId|level|side)
   + lookup-before-insert `by_cloid` + leer `getOpenSpotOrders` antes de crear + fallback `orderStatus` por
   CLOID, garantizan que un retry/reinicio NO cree ni envíe dos veces la misma orden? ¿Algún hueco entre el
   insert en DB y el `placeSpotLimit` en HL (crash entre ambos)? ¿Orden correcto (DB primero o HL primero)?
2. **Contrato transaccional cycle/repost.** `closeCycleAndRepost` incrementa cycleId + inserta ciclo + crea
   BUY de reposición en UNA mutation. ¿Evita doble cierre bajo dos reconciles concurrentes? ¿El lease/CAS lo
   cubre? ¿`by_bot_cycle` lookup-before-insert es suficiente sin unicidad nativa?
3. **Partial fills + sub-mínima.** Acumular `filledQty`/`avgFillPx`; no colocar SELL si `filledQty*sellPrice
   < MIN_SPOT_NOTIONAL`, acumular `pendingSellQty`. ¿Bordes? ¿Polvo al detener? ¿SELL pareada por la
   cantidad REAL llenada (no la teórica)?
4. **Profit neto post-rounding.** ¿Verificar el neto tras redondear precio+size y descontar fees buy+sell,
   subiendo el SELL un tick si no cubre, es correcto? ¿Riesgo de loop infinito subiendo ticks? ¿Y si nunca
   cubre (spread/fees) — se rechaza el nivel?
5. **Lease/fencing.** ¿Replicar claim/renew/release de trigger_arms en spot_grid_bots (campos nuevos) cubre
   reconciles concurrentes del cron? ¿Renovar el lease durante los RPC largos?
6. **Batching/backoff por cuenta.** Una ronda de lecturas por cuenta+red. ¿Coherente con rate-limits HL?
7. **Seguridad.** Clave solo se descifra en la action node; nunca en logs (`elog` escalares). Solo LIMIT,
   no withdrawals, solo cloids propios. `stopSpotGridBot` cancela solo lo propio. Mainnet gateado.
8. **Aislamiento.** El motor (node) NO debe contaminar las mutations NON-node de spotGridBots.ts. ¿La
   división action(node)+mutations(non-node) es correcta? ¿`calculateGridLevels` testeable?
9. **Alcance/tests.** ¿La verificación (math/cloid/partial/idempotencia + E2E real) es suficiente para
   money-path? ¿Falta algún caso (cancel parcial, reinicio a mitad de ciclo, bot pausado/stopped durante un
   fill)?
10. **Features diferidas.** ¿De acuerdo en dejar añadir-capital (JAV-100) y retirar-ganancias (JAV-101) y la
    tarjeta/stats (JAV-93) FUERA de JAV-92, con JAV-92 solo registrando los datos (cycles.netProfit)?
