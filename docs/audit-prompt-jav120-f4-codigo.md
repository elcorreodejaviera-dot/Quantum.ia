# Prompt de auditoría (Codex) — CÓDIGO: JAV-120 Fase 4 (reconciliación de fees con eventos)

Audita el **código** del commit `148206e` (rama `elcorreodejaviera/jav-120-fees-24h-real`). Veredicto
**GO / NO-GO**. Fase 4 del plan `docs/plan-fees24h-real.md`, sobre F0–F3+F5 (todas con GO). Es la parte más
delicada (getLogs en RPC público + contabilidad principal/fee); sé muy escéptico.

## Qué cambia (`convex/actions/poolScanner.ts`)
Cuando la posición cambió en la ventana (`nowSnap.snapshotKey !== refSnap.snapshotKey`), `getPoolFees24h`
ya NO devuelve `partial` directo: llama a `reconcileWindowFees` para certificar `ok` con los eventos
on-chain de la ventana. El caso `snapshotKey` igual queda como estaba (delta de cobrable). Nuevo helper:

`reconcileWindowFees(rpcs, nft, tokenId, refSnap, nowSnap)`:
1. Exige `refSnap.aggregatesComplete` (deuda de principal base conocida). Si no → `null` (→ `partial`).
2. getLogs de `[refSnap.safeHeadBlock+1, nowSnap.safeHeadBlock]` por **RPC público** vía
   `getLogsRangeMulti` (filtra topic0 ∈ {Increase,Decrease,Collect} + topic1=tokenId) envuelto en
   `getLogsAdaptive` (range-halving, budget `FEE24H_GETLOGS_BUDGET=2000`).
3. Transporte/proveedor falla → `null`. `!scan.complete` (budget agotado) → `null`. Decode ESTRICTO: si
   algún log no decodifica → `null`. 0 eventos pese a key cambiada → `null`.
4. Replica `computeLifetimeAggregates` (pools.ts:244-271) PARTIENDO de `debtRef = refSnap.principalDebt`:
   Decrease suma deuda; Collect paga deuda primero, excedente = ΔfeesCollected; Increase no afecta.
5. `fee_i = ΔfeesCollected_i + max(owed_now_i − debt_now_i, 0) − max(owed_ref_i − debt_ref_i, 0)`.
6. `fee<0` → `null`. Si no, devuelve `{fee0, fee1}` → el caller valúa y certifica `ok`.

## Verifica GO/NO-GO
1. **Corrección financiera del replay**: ¿`fee_window = Δcollected + uncoll_now − uncoll_ref` es
   exactamente `feesAccum(now) − feesAccum(ref)` con `feesAccum = collected + max(owed−debt,0)`? Verificá que
   `collected(ref)` cancela y que `debt_now` resulta de replicar desde `debt_ref`. ¿La atribución
   principal/fee del Collect (paga deuda primero) coincide con `computeLifetimeAggregates`?
2. **owed live vs stored**: `owedRef/owedNow` son el cobrable SIMULADO (collect()) guardado en el snapshot
   (incluye principal de Decrease no cobrado). ¿Es coherente usarlo como `O(t)` junto a `debt` para
   `max(O−debt,0)=uncollected fees`? ¿Algún doble conteo entre `owed` y los Collect del window?
3. **Completitud / no subcontar**: ¿`!scan.complete`, decode estricto, y `0 eventos con key cambiada`
   cubren bien los modos de pérdida de logs? ¿`getLogsRangeMulti` filtra realmente por los 3 topics +
   tokenId (no trae eventos de otras posiciones)? ¿Reorg: `safeHeadBlock` (finalizado) hace el rango
   estable?
4. **Rango de bloques**: `[refSnap.safeHeadBlock+1, nowSnap.safeHeadBlock]` — ¿exacto y sin huecos ni
   solapes respecto de los valores `owed` (leídos en esos mismos safeHeads en F1)? ¿`to<from` bien tratado?
5. **Dependencia de agregados**: certifica `ok` SOLO si `refSnap.aggregatesComplete`. ¿Correcto degradar a
   `partial` (no inventar) cuando faltan? ¿Hay forma de que `aggregatesComplete=true` pero `principalDebt`
   esté desactualizado y dé un resultado erróneo?
6. **Presupuesto/seguridad RPC**: budget 2000, range-halving. ¿Riesgo de runaway o de costo excesivo en
   ventanas de 24h con muchos bloques (Arbitrum)? ¿`getLogsAdaptive` aborta bien si un solo bloque es
   rechazado por algo que no es rango?
7. **Money-path / efectos**: read-only (getLogs + eth_call); ninguna escritura. Confirmar.
8. **Edge cases**: position con solo Increase en la ventana (sin fee real) → ¿`fee=owed_now−owed_ref`
   correcto? Multiple Collect/Decrease intercalados → ¿orden por (blockNumber, logIndex) correcto?

## Verificación hecha
- `npm run typecheck` OK · `npm test` 265/265 · `npx vite build` OK (F5).
- Runtime DIFERIDO: requiere ≥24h de snapshots + una posición con collect en la ventana; se valida tras
  merge. (El harness excluye actions, así que no hay test unitario de la action.)
