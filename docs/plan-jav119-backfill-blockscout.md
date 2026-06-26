# Plan v2 — JAV-119: Back-fill lifetime fees GRATIS vía Blockscout

> Sucesor del plan original (`plan-jav119-backfill-gratis.md`). La v1 se mergeó (PR #128, commit `6ac8c9c`) pero **falló en verificación operativa**: la premisa "RPC público de archivo gratis para `eth_getLogs`" ya no es alcanzable. Este plan reemplaza la capa de proveedor de logs. Rama: `elcorreodejaviera/jav-119-backfill-lifetime-gratis`. **Pendiente GO de Codex (plan + código) antes de push.**

---

## 1. Por qué falló la v1 (evidencia 2026-06-26, verificado en prod y contra proveedores reales)

`backfillAllPoolLifetimes` corrido en prod → los 3 pools reales (Base ×2, Arbitrum ×1) fallan con `getLogs falló (transporte)`. **No corrompe datos** (el código no muta ante error de transporte). Causa raíz: **ningún RPC gratis sirve `eth_getLogs` de archivo de rango amplio** en Base/Arbitrum.

| Proveedor (sin key) | Resultado en `eth_getLogs` Base/Arbitrum |
|---|---|
| `eth.drpc.org` / `*.drpc.org` | HTTP 400 *"Can't route your request to suitable provider"* |
| `*.publicnode.com` | HTTP 403 *"Archive requests require a personal token"* |
| `rpc.ankr.com` | requiere API key |
| `1rpc.io` | *"method not available"* |
| `eth.llamarpc.com` | HTTP 521 |
| **Blast** `*.public.blastapi.io` | responde, pero **cap de 10 bloques** por llamada |
| **Alchemy Free** (key del usuario) | confirmado: *"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Upgrade to PAYG"* — el filtro por `tokenId` **NO** se salta el cap |

Con Base en ~48M bloques (Arbitrum ~478M, ~253 ms/bloque) y un cap de 10 bloques/llamada, barrer desde el origen es **inviable** (presupuesto 2000 cubre ~20k bloques). La v1 usaba `LOGS_RPC` públicos → gateados.

### Vías descartadas
- **Alchemy PAYG**: funcionaría (sin cap; solo límite de 10k resultados, inalcanzable filtrando por tokenId) pero **tiene costo** → descartado por requisito del usuario ("tiene que ser gratis").
- **`alchemy_getAssetTransfers`** (acotar por mint/owner): opera por **direcciones**, no por `tokenId`. Probado: aísla bien cuando el owner tiene pocas posiciones (pools de Base, owner `0xb5a7…`), pero **NO puede atribuir** los eventos de un `tokenId` cuando el owner es **custodial/compartido** (pool de Arbitrum, owner `0x74e6…` con 1000+ transfers). Filtrar por `(pool, owner)` o `(manager, owner)` tampoco aísla (en Uniswap V3 los tokens fluyen por el NFT manager compartido). → no garantiza histórico completo.
- **Etherscan V2 multichain (free)**: *"Free API access is not supported for this chain"* en Base/Arbitrum → requiere plan pago.

---

## 2. Solución elegida: Blockscout (gratis, sin key, por `tokenId`)

Los exploradores **Blockscout** (open-source) de Base y Arbitrum exponen un `getLogs` **indexado**, gratis y sin API key, que **filtra por `topic1` (`tokenId`)**. Al filtrar por tokenId resuelve el caso custodial que `getAssetTransfers` no podía.

| Red | Base URL Blockscout |
|---|---|
| Base | `https://base.blockscout.com/api` |
| Arbitrum | `https://arbitrum.blockscout.com/api` |
| (Ethereum) | `https://eth.blockscout.com/api` |
| (Optimism) | `https://optimism.blockscout.com/api` |

### Evidencia de viabilidad (probado 2026-06-26)
- Base tokenId `5348492`: devuelve el `IncreaseLiquidity` del mint (bloque `47387686`) en ventanas de 1.4M y 3.4M bloques. `status:"1"`, `message:"OK"`.
- **Arbitrum tokenId `5562243` (owner CUSTODIAL)**: devuelve **2 eventos** (mint `477305099` + `477306836`) filtrando por tokenId → **caso custodial resuelto**.
- Limitación observada: ventanas muy grandes (rango total) hacen **timeout** (HTTP 000), de forma variable. → se maneja con range-halving (timeout ⇒ partir ventana), patrón que **ya existe** en el código.

---

## 3. Diseño (todo en `convex/actions/poolScanner.ts`)

> **Revisión tras NO-GO de Codex (3 ajustes, validados empíricamente sin key 2026-06-26).** Cambios respecto al borrador: (1) origen por **evento Transfer mint en Blockscout** (no `ownerOf`); (2) **gate de indexación** antes de certificar; (3) **`blockHash` rellenado aparte** (la API legacy no lo trae).

Combina tres piezas para minimizar llamadas y certificar histórico legítimamente:

### 3.1 Origen real por evento `Transfer` mint en Blockscout (ajuste 1 de Codex)
- ❌ Descartado el binary-search de `ownerOf`: el `eth_call` histórico requiere estado **archive** (no confiable/gratis en RPC públicos) y **revierte para posiciones quemadas** → rompe la búsqueda.
- ✅ Nuevo `findMintBlock(network, tokenId)`: consulta Blockscout `getLogs` por el **evento `Transfer` ERC721** (`topic0 = 0xddf252ad…`, `topic3 = tokenId`, `topic0_3_opr=and`) y toma el log con `from == 0x0` → **bloque de mint on-chain real**, desde el índice, en 1-2 llamadas. **Validado**: tokenId Base `5348492` → mint `47387686` desde `0x0`. Funciona aunque la posición se haya quemado después (el `Transfer` mint histórico siempre existe en el índice).
- Como ningún evento `Increase/Decrease/Collect` puede existir antes del mint, **arrancar el escaneo en `mintBlock` certifica histórico completo** (lo que Codex exigía con `start===0`, pero acotado, barato y verificable).
- Fallback: si no se halla el `Transfer` mint (red sin Blockscout, índice incompleto en ese rango), `start = 0` + range-halving, o `ok:false` sin mutar.

### 3.2 Proveedor de logs = Blockscout REST (ajuste 3 de Codex: sin `blockHash`)
- `LOGS_RPC` pasa a mapear los **base URLs de Blockscout** por red (arriba).
- Nuevo `rawGetLogsBlockscout(baseUrl, address, tokenIdTopic, topic0List, fromBlock, toBlock)`:
  - GET `…/api?module=logs&action=getLogs&fromBlock=&toBlock=&address=&topic0=&topic1=<tokenId>&topic0_1_opr=and`.
  - **Tres tipos de evento** (`INCREASE`/`DECREASE`/`COLLECT`): **camino primario** = filtrar **solo por `topic1=tokenId`** (1 llamada/ventana) y **descartar `topic0` localmente** quedándose con los 3 sig conocidos. **Fallback** (si Blockscout exige `topic0` o el filtro topic1-solo no rinde): 3 llamadas/ventana, una por `topic0` con `topic0_1_opr=and`.
  - **`blockHash` NO viene en la API legacy** (confirmado: campos = `address, blockNumber, data, gasPrice, gasUsed, logIndex, timeStamp, topics, transactionHash, transactionIndex`). El schema lo exige (`schema.ts:111`, anti-reorg). Solución: **rellenar `blockHash` por bloque distinto** vía `eth_getBlockByNumber` en los RPC públicos (`RPC[network]`, sin key) — pocos bloques con eventos ⇒ pocas llamadas. Cada `RpcLog` se mapea con su `blockHash` real antes de `decodePoolFeeLog`. Si algún `blockHash` no se resuelve ⇒ **logs incompletos** ⇒ NO certificar/NO mutar (ver §4). (Alternativa: Blockscout v2 con `block_hash`; se evalúa en impl.)
  - Parseo de respuesta:
    - `status:"1"` ⇒ `result[]` (hex en `blockNumber`/`logIndex`) → `RpcLog`.
    - `status:"0"` ⇒ **vacío SOLO si `message === "No records found"`**; **cualquier otro `status:"0"` es ERROR** (no mutar, propagar).
    - **HTTP no-OK** NO mapea siempre a `GetLogsRangeTooLargeError`: `429/403/401`/deprecación ⇒ **abortar o backoff** (no halving); `AbortError`/timeout ⇒ `GetLogsRangeTooLargeError` (sí halving).
  - Paginación: `offset` (máx 1000/página). Filtrado por tokenId hay <1000 eventos ⇒ 1 página; loopear `page` si `len(result)===offset`. Paginación **debe completar**: si se trunca ⇒ logs incompletos ⇒ no certificar/no mutar.

### 3.3 Gate de indexación: índice incompleto = NO mutar (ajuste 2 de Codex)
- Blockscout puede estar **reindexando**: aplicar eventos sobre un índice incompleto daría totales erróneos. **Validado el riesgo**: al 2026-06-26 Base estaba en `indexed_blocks_ratio: "0.99"` (`finished_indexing_blocks: false`), Arbitrum en `"1"`.
- Nuevo `blockscoutFullyIndexed(network)`: GET `…/api/v2/main-page/indexing-status`; "completo" ⟺ `finished_indexing_blocks === true` (equiv. `indexed_blocks_ratio === "1"`).
- **Si NO está completo: NO se llama `applyPoolFeeEventsWindow`.** No se tocan `pool_fee_events`, agregados, `cursor` ni `backfilledAt`. Se retorna `ok:false` con `reason:"blockscout_indexing_incomplete"`; a lo sumo un **patch de metadata** `status:"stale"` (solo el campo de estado, sin tocar datos). Reintentar el botón cuando Blockscout termine de indexar.

### 3.3 Range-halving y budget (reusados, sin cambios de fondo)
- `getLogsAdaptive` recorre `[mintBlock, safeHead]`; en timeout parte la ventana. Pocas ventanas porque arranca en el mint (ej. Arb pool: ~0.7M bloques ⇒ 1 ventana).
- `BACKFILL_CALL_BUDGET` (2000) intacto; cobertura parcial ⇒ NO mutar (igual que v1).
- Subir `RPC_TIMEOUT_MS` para Blockscout si hace falta (es más lento que un RPC; one-off).

---

## 4. Invariantes preservados (de JAV-117 / v1)
- **Atomicidad/anti-reorg**: sigue vía `applyPoolFeeEventsWindow` (borra `[start,safeHead]` + inserta + recompute en una transacción).
- **No mutar ante fallo**: transporte fallido o cobertura PARCIAL ⇒ no se toca la tabla; `ok:false`.
- **Mutar SOLO si TODO se cumple** (Codex): `applyPoolFeeEventsWindow` (insertar eventos + recomputar agregados + avanzar cursor + `backfilledAt`) se ejecuta **únicamente cuando**: (a) **mint verificado** (Transfer from `0x0`), (b) **logs completos** (sin error/truncado de Blockscout), (c) **`blockHash` completo** (resuelto para todos los bloques), (d) **paginación completa**, y (e) **Blockscout fully indexed** (§3.3). Si falta cualquiera ⇒ **NO mutar** (cache previo intacto), `ok:false` con razón; a lo sumo patch de metadata `status:"stale"`.
- Eventos previos a `start` se conservan (la mutación solo borra dentro de la ventana y recomputa desde la tabla completa).

## 5. Cambios acotados
- `LOGS_RPC`: → endpoints Blockscout por red.
- `rawGetLogs` → `rawGetLogsBlockscout` (request REST `module=logs` + parseo Etherscan-compatible + "No records found"=vacío + **relleno de `blockHash` por bloque distinto** vía `eth_getBlockByNumber`).
- `findMintBlock(network, tokenId)` por **evento `Transfer` mint en Blockscout** (`topic3=tokenId`, `from==0x0`).
- `blockscoutFullyIndexed(network)` (gate de §3.3).
- `backfillPoolLifetime`: `start = findMintBlock(...) ?? 0`; certifica solo si mint real + índice completo; mantiene `rpcUrl` opcional como override manual.
- `getLogsAdaptive`/`getLogsRangeMulti`: sin cambios de lógica (adaptar el tipo de proveedor a "baseUrl Blockscout").

## 6. Riesgos / mitigaciones
- **Índice incompleto/atrasado** (Codex #2) → gate `blockscoutFullyIndexed` ⇒ `stale` en vez de `ok` (validado: Base 0.99 hoy). Reintentar cuando termine de indexar.
- **`blockHash` ausente en API legacy** (Codex #3) → relleno por `eth_getBlockByNumber` por bloque distinto (pocos; sin key). Mantiene el invariante anti-reorg del schema.
- **Origen para posición quemada** (Codex #1) → resuelto: el `Transfer` mint histórico siempre está en el índice (no depende de `ownerOf` en head).
- **Blockscout lento/variable** (timeouts en ventanas grandes) → range-halving + timeout alto; one-off.
- **Rate-limit Blockscout** (sin key) → back-fill secuencial por pool + pocos calls al arrancar en el mint; si pega límite, añadir backoff.
- **Cobertura de redes** → confirmado Base y Arbitrum. Ethereum/Optimism mapeados por completitud; validar si surgen pools.
- **Fiabilidad de Blockscout como fuente única** → el gate de indexación + `stale` evita certificar dudoso; opcional cross-check de conteo contra el cron incremental (Alchemy) en un futuro.

## 7. Verificación previa a push
- `npm run typecheck` OK · `npm test` (suite completa) OK · build OK.
- Tests de parseo del adaptador Blockscout: `status:"1"` con logs, `"No records found"`, relleno de `blockHash`, paginación.
- Prueba funcional en **dev** apuntando a Blockscout: correr `backfillAllPoolLifetimes`; verificar que los pools con índice completo (p. ej. Arbitrum) quedan `ok` con `totalEvents > 0` y "Total generado" poblado (incluido el **custodial**), y que con índice incompleto (Base hoy, 0.99) **no se muta nada** (`ok:false`, `reason:"blockscout_indexing_incomplete"`, sin tocar eventos/cursor/backfilledAt).
- GO de Codex sobre plan + código antes de push/PR.
