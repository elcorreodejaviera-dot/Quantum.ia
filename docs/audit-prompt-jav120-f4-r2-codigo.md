# Prompt de auditoría (Codex) — CÓDIGO: JAV-120 Fase 4 r2 (deuda base al safeHead exacto)

Re-auditá la Fase 4 en el HEAD `bd4496e` (rama `elcorreodejaviera/jav-120-fees-24h-real`). Veredicto
**GO / NO-GO**. Esta r2 responde a tu NO-GO sobre `148206e`. Sé igual de escéptico: es la parte más delicada
(getLogs en RPC público + contabilidad principal/fee).

## Tu NO-GO (sobre 148206e) y cómo se resolvió (2 commits)

Tu hallazgo: `aggregatesComplete=true` solo probaba que los campos `principalDebt*Raw` existían, no que la
deuda base estuviera sincronizada hasta `refSnap.safeHeadBlock`. Como el cron lifetime y el cron de snapshots
son independientes, podía guardarse un snapshot con deuda desfasada y certificar `ok`.

- **`bda6470`** ("gate fee snapshots by lifetime coverage"): el writer ya NO certifica por presencia de campos.
  Añade `aggregatesSafeThroughBlock` (nuevo campo opcional del snapshot) y solo lo setea si
  `feesLifetimeBackfilledAt != null && feesLifetimeCursorBlock >= safeHead`. `reconcileWindowFees` exige
  `aggregatesSafeThroughBlock >= refSnap.safeHeadBlock`. Esto bloquea el caso **cursor < safeHead** (deuda vieja).

- **`bd4496e`** (esta r2): ese gate, por sí solo, ADMITÍA el caso **espejo** `cursor > safeHead`. El cache
  lifetime (`pool.principalDebt*`) vale a la altura `cursorBlock`. Si `cursor > safeHead` y hubo un
  Decrease/Collect en `(safeHead, cursorBlock]`, ese evento YA está horneado en `principalDebt` **y** cae
  dentro de la ventana de replay de F4 `[safeHead+1, now]` → **doble conteo** de deuda + atribución
  principal/fee del Collect corrida. Fix: cuando el backfill cubre el safeHead, el writer recomputa
  `collected/principalDebt` a la altura **EXACTA** `safeHead` desde `pool_fee_events` (fuente de verdad), en
  vez de leer el cache. El snapshot queda auto-consistente: `debtRef` alineado con `owedRef` (ambos a safeHead)
  y con el inicio de la ventana de replay.

## Qué cambia en r2 (`bd4496e`)

- `convex/pools.ts`: nueva `internalQuery getPoolAggregatesAtBlockInternal({poolId, throughBlock})` →
  `computeLifetimeAggregates(eventos con blockNumber<=throughBlock)`; `null` si algún raw es inválido.
- `convex/actions/poolScanner.ts` (`snapshotOnePoolFees`): si `backfilledAt != null && cursorBlock >= safeHead`,
  llama a la query y usa `collected/principalDebt` a `safeHead`; setea `aggregatesSafeThroughBlock = safeHead`.
  Si la query devuelve `null` o no hay cobertura → no certifica (`aggregatesComplete=false` → F4 cae a `partial`).

## Verificá GO/NO-GO

1. **Auto-consistencia del snapshot certificado**: ¿`principalDebt*Raw` del snapshot es ahora EXACTAMENTE la
   deuda a `safeHeadBlock` (no a `cursorBlock`)? ¿`getPoolAggregatesAtBlockInternal` con `blockNumber<=safeHead`
   reproduce `computeLifetimeAggregates` restringido a esa altura sin huecos? ¿El índice `by_pool_block` con
   `.eq(poolId).lte(blockNumber, throughBlock)` trae todos los eventos ≤ safeHead?
2. **Cobertura sin huecos**: ¿`backfilledAt != null && cursorBlock >= safeHead` garantiza que `pool_fee_events`
   cubre `[inception, safeHead]` completo? ¿Puede haber un hueco interno (ventana borrada por reorg sin
   reinsertar) que haga subcontar la deuda pese a `cursorBlock >= safeHead`?
3. **Persiste el doble conteo en algún camino?**: con la deuda ya a `safeHead`, ¿el replay desde `safeHead+1`
   procesa cada evento de la ventana exactamente una vez? ¿Algún evento en `(safeHead, cursorBlock]` que aún
   se cuente dos veces por otro lado?
4. **Atomicidad de la lectura**: el writer lee `pool.principalDebt*`, `feesLifetimeCursorBlock`, `backfilledAt`
   del mismo doc, pero ahora la deuda usada viene de la query (no del doc). ¿Hay TOCTOU entre el `cursorBlock`
   leído del doc y los eventos que ve la query (otra mutation lifetime entremedio)? ¿Importa para la correctitud?
5. **Costo**: la query hace `.collect()` de todos los eventos ≤ safeHead por pool por hora. ¿Aceptable (mismo
   orden que el recompute lifetime en `applyPoolFeeEventsWindow`)? ¿Riesgo en pools con muchos eventos?
6. **Regresiones F0–F3/F5**: el cambio toca solo el writer + una query nueva. ¿Algún efecto en el camino
   `snapshotKey` igual, en `getPoolFees24h`, o en el schema (`aggregatesSafeThroughBlock` ya existía desde bda6470)?
7. **Money-path**: read-only (query a DB + eth_call/getLogs). Confirmar que no hay escrituras nuevas salvo el
   insert del snapshot.

## Verificación hecha
- `npm run typecheck` OK · `npm test` 265/265.
- Runtime DIFERIDO: requiere ≥24h de snapshots + una posición con collect en la ventana; se valida tras merge.
  Caso clave a observar en prod: snapshot con `cursorBlock > safeHead` y un Collect/Decrease en el medio.
