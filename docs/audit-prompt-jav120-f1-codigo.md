# Prompt de auditoría (Codex) — CÓDIGO: JAV-120 Fase 1 (writer `snapshotPoolFees` + mutation)

**RE-AUDITORÍA (r2).** Audita el **código** del commit `302d581` (rama
`elcorreodejaviera/jav-120-fees-24h-real`). Veredicto **GO / NO-GO**. Fase 1 del plan
`docs/plan-fees24h-real.md`. Construye sobre F0 (commit `1260726`, GO en
`docs/audit-jav120-f0-schema-pool-fee-snapshots-codex.md`).

> **Corrige tu NO-GO previo** (`docs/audit-jav120-f1-snapshot-writer-codex.md`, ALTO#1: "safeHeadBlock no
> corresponde al bloque de lectura"). Fix: `rpcCall`/`rpcCallWithFallback`/`fetchUncollectedFeesRaw`/
> `readPositionSnapshotKey` ahora aceptan un **block tag opcional** (default `"latest"` → no cambia callers
> existentes). En `snapshotOnePoolFees` se fija `safeHead = latest − CONFIRMATIONS` PRIMERO y se leen
> `tokensOwed` y `snapshotKey` **en ese mismo `safeHead`** (`blockTag = "0x"+safeHead.toString(16)`), que es
> lo que se guarda en `safeHeadBlock`. Verificá que la consistencia bloque↔valores quedó bien y que ningún
> caller existente cambió de comportamiento. Revisá también si leer en `safeHead` (~latest−20) es seguro en
> los RPC públicos (estado reciente, no archivo).

## Qué cambia (solo backend, aún SIN cron ni UI → inerte salvo que se invoque a mano)
- `convex/pools.ts`: `insertPoolFeeSnapshot` (internalMutation) — inserta un snapshot (`at = Date.now()`) y
  poda inline por antigüedad (`FEE_SNAPSHOT_RETENTION_MS = 10 días`) con el índice `by_pool_at`. Append-only.
- `convex/actions/poolScanner.ts`: `snapshotOnePoolFees` (helper) + `snapshotPoolFees` (internalAction).
  Por pool con `tokenId`: lee vía RPC PÚBLICO `fetchUncollectedFeesRaw` (tokensOwed bruto, collect()
  simulado), `readPositionSnapshotKey` (huella estructural) y `getLatestBlock − CONFIRMATIONS` (safeHead).
  Guarda eso + agregados cacheados (`feesCollectedRaw0/1`, `principalDebt0/1`; `""` si ausentes →
  `aggregatesComplete=false`). Batching `POOL_SCAN_CONCURRENCY` + `Promise.allSettled`, espejo de
  `refreshAllPoolLifetimes` (`:1303`).

## Verifica GO/NO-GO
1. **Neteo diferido correcto** (plan ALTO#1): el writer guarda `tokensOwed` BRUTO + componentes, NO un fee
   ya armado. ¿Bien? ¿El consumidor (F3) tendrá todo para netear `collected + max(owed − debt, 0)`?
2. **No insertar lo no certificable** (plan ALTO#2 / v2 BAJO#1): si `fetchUncollectedFeesRaw` o
   `readPositionSnapshotKey` o `getLatestBlock` fallan → NO inserta (`unavailable`). ¿Correcto que un
   snapshot sin `snapshotKey` no entre? ¿`safeHead<=0` bien tratado?
3. **`aggregatesComplete`**: ¿la lógica (`"" si ausente` → false) es correcta y suficiente para gatear `ok`
   en F3? ¿Algún caso donde `feesCollectedRaw0/1`/`principalDebt0/1` sea `"0"` legítimo vs ausente? (`"0"`
   es presente/completo; `undefined`→`""` es ausente.) ¿Riesgo de confundirlos?
4. **`safeHeadBlock`** (v2 MEDIO#1): se guarda `latest − CONFIRMATIONS[network]` (mismo patrón que
   `refreshOnePoolLifetime:1223-1224` y `backfillPoolLifetime:1342-1344`). ¿Coherente para el `getLogs`
   exacto de F4?
5. **Mutation/poda**: `at = Date.now()` en la mutation (no en la action) — ¿bien para evitar estado de
   tiempo en la action? La poda usa `by_pool_at` con `lt("at", cutoff)` acotado al pool. ¿Append-only sin
   riesgo de duplicar/borrar de más? ¿Date.now() en mutation es aceptable (ya se usa en
   `applyPoolFeeEventsWindow:337`)?
6. **Money-path / efectos**: confirmar que TODO es read-only on-chain (`fetchUncollectedFeesRaw` =
   `eth_call`, simulación, no envía tx) y que la única escritura es la fila en `pool_fee_snapshots` (tabla
   nueva, nadie más la lee aún). ¿Algo toca ejecución/margen/órdenes?
7. **Concurrencia/costo**: batching `POOL_SCAN_CONCURRENCY` correcto; +2 `eth_call`/pool (ownerOf+collect en
   `fetchUncollectedFeesRaw`) +1 (`readPositionSnapshotKey` positions()) +1 (`getLatestBlock`) por pool/run.
   ¿Aceptable? ¿`Promise.allSettled` captura bien los rechazos (cuenta `errored`)?
8. **Filtro de pools**: `targets = pools.filter(p.tokenId && RPC && NFT_MANAGER)` (NO filtra `closed`, igual
   que `refreshAllPoolLifetimes`). ¿Está bien snapshotear pools cerrados, o deberían excluirse?

## Verificación hecha
- `npm run typecheck` → OK.
- **Runtime DIFERIDO**: probar `snapshotPoolFees` en vivo requiere `npx convex deploy` al ÚNICO deployment
  (= prod) de código aún sin GO → se valida tras tu GO + merge (o vía el cron de F2). Señala si te parece
  aceptable diferirlo o si exige otra estrategia (p. ej. deployment dev separado).
