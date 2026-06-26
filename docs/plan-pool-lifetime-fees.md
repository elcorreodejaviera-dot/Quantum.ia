# Plan técnico — JAV-117: Tiempo de vida del pool + total generado (lifetime fees)

> Estado: **GO limpio de Codex (final) · EN IMPLEMENTACIÓN** (rama `elcorreodejaviera/jav-117-...`). Cierre: `docs/audit-jav117-pool-lifetime-fees-go-final.md`.
> Nota: la sección histórica v2 menciona "índice único" — **superado por v3/§16**: en Convex `by_pool_log` es índice de búsqueda + idempotencia en la mutation.
>
> **Decisiones del usuario (cerradas 2026-06-26):**
> - **A. Back-fill = externo puntual.** Script one-off con RPC de archivo reconstruye el histórico una vez → rellena campos raw + cursor en Convex; luego el cron mantiene incremental con Alchemy Free. Sin coste recurrente.
> - **B. Tiempo de vida = vida total** desde `initialLiquidityAt` (NO se reinicia al reabrir; sin `activeSinceAt`). Se aclara en la UI.
> Issue: JAV-117 · https://linear.app/javier-amaya/issue/JAV-117
> Colateral: JAV-118 (subgraphs muertos).

## 1. Objetivo

En la tarjeta de cada usuario (portal **y** admin) mostrar:

1. **Tiempo de vida del pool** — cuánto lleva vivo desde la apertura de la posición LP.
2. **Total generado en fees a lo largo de toda su vida** — número fiel, no solo lo acumulado desde el último cobro.

## 2. El reto (por qué no es trivial)

`feesUncollectedUsd` (lo único que leemos hoy, vía `collect` callStatic en `fetchUncollectedFeesUsd`, `convex/actions/poolScanner.ts:277-323`) **se resetea a 0 cuando el usuario cobra fees** (`collect`).

```
fees lifetime = Σ(fees ya cobrados) + fees sin cobrar actuales
```

Hoy en el repo **no existe** tracking histórico de fees, ni detección de cobros, ni snapshots (confirmado).

## 3. Por qué eventos on-chain y no atajos

- **Subgraph de la posición** (`collectedFeesToken0/1`): bugueado (devuelve 0 / valores erróneos). Descartado.
- **Subgraph del repo** (`api.thegraph.com/...`): muerto desde 12-jun-2024 → JAV-118.
- **Snapshots/inferencia**: aproximado, no retroactivo, confunde principal con fees. Descartado.
- **Eventos on-chain (elegido)**: fuente de verdad.

## 4. Cálculo de fees lifetime — contabilidad correcta de principal vs fee ⚠️ (ajuste Codex #1)

> **Punto crítico:** `ΣCollect − ΣDecrease` ingenuo **puede contar principal como fee** si hubo `DecreaseLiquidity` cuyo principal todavía no se cobró. `Collect` retira `tokensOwed`, que mezcla principal liberado por `Decrease` + fees devengadas. Hay que **procesar eventos en orden cronológico** llevando una **deuda de principal por token** (`principalDebt`).

Eventos del `NonfungiblePositionManager` (con `tokenId` en `topics[1]`):
- `IncreaseLiquidity(tokenId, liquidity, amount0, amount1)` — aporte de principal (no afecta fees ni deuda de retiro).
- `DecreaseLiquidity(tokenId, liquidity, amount0, amount1)` — **suma** principal pendiente de cobro a `principalDebt`.
- `Collect(tokenId, recipient, amount0, amount1)` — **primero paga deuda de principal**, el excedente es fee cobrada.

### Algoritmo (por token, cantidades raw uint256)
```
principalDebt0 = principalDebt1 = 0
feesCollected0 = feesCollected1 = 0

ordenar eventos por (blockNumber, logIndex) ascendente, dedupe por (txHash, logIndex)
para cada evento:
  if Decrease:
     principalDebt0 += amount0;  principalDebt1 += amount1
  if Collect:
     payP0 = min(amount0, principalDebt0); principalDebt0 -= payP0; feesCollected0 += (amount0 - payP0)
     payP1 = min(amount1, principalDebt1); principalDebt1 -= payP1; feesCollected1 += (amount1 - payP1)

# El uncollected EN VIVO (tokensOwed vía collect callStatic) también incluye
# principal pendiente no cobrado → hay que descontar la deuda restante:
feesUncollected0 = max(0, tokensOwedNow0 - principalDebt0)
feesUncollected1 = max(0, tokensOwedNow1 - principalDebt1)

feesLifetime0 = feesCollected0 + feesUncollected0
feesLifetime1 = feesCollected1 + feesUncollected1
```

### Valoración USD
- Las **cantidades** son exactas; la **valuación** en v1 es a **precio spot actual** (mismo `priceUsd` de `slot0`), stable-side 1:1, reusando lógica de `fetchUncollectedFeesUsd:313-319`.
- USD se calcula **al mostrar/refrescar**, NO se cachea (ajuste Codex #3).

### Topics (firmas a keccak256 en impl)
- `IncreaseLiquidity(uint256,uint128,uint256,uint256)`
- `DecreaseLiquidity(uint256,uint128,uint256,uint256)`
- `Collect(uint256,address,uint256,uint256)`

## 5. Infraestructura RPC (Alchemy) + límite de getLogs ⚠️ (ajuste Codex #2)

- `eth_call` en tiempo real → sigue en RPC públicos (`poolScanner.ts:28-33`).
- `eth_getLogs` → **Alchemy** (env `ALCHEMY_API_KEY`, ya en Convex prod). URL por red cambiando subdominio (`eth-/arb-/opt-/base-mainnet.g.alchemy.com/v2/${KEY}`). Si falta la key → degradar a "—", no romper el scanner.
- Helper nuevo `rpcGetLogs(url, filter)` análogo a `rpcCall` (timeout/rate-limit, `:46-91`).
- Filtro: `address = NFT_MANAGER[network]`, `topics = [sig, tokenIdHex]`, rango de bloques.

> **⚠️ Limitación confirmada por Codex (doc Alchemy):** Alchemy **Free** restringe `eth_getLogs` a **rangos de 10 bloques** (ETH/Base/OP/Arbitrum); PAYG = ilimitado. Afecta back-fill **y** incremental.
>
> **DECISIÓN CERRADA (A) = back-fill externo puntual.** Script one-off (fuera de Convex) con un RPC de archivo que permita `getLogs` de rango amplio (p. ej. archive node dRPC/Ankr), paginando sin presión de producción. Rellena `pool_fee_events` (histórico) + agregados raw + `feesLifetimeCursorBlock` en Convex. Retroactivo completo, sin coste recurrente.
>
> **DECISIÓN CERRADA (ALTO #1) = incremental con Free + presupuesto duro + estado `stale`.** Sin coste. Para que sea viable con el tope de 10 bloques (clave, porque en Arbitrum 10 min ≈ miles de bloques):
> 1. **Señal correcta (ALTO-2 v3) — NO usar `positions().tokensOwed` como "live":** `positions()` devuelve el **checkpoint almacenado** (`tokensOwed` almacenado + `feeGrowthInside{0,1}LastX128`), NO las fees pasivas devengadas. Las fees pasivas reales (uncollected live) solo se ven con **collect callStatic raw**. Por tanto leer ambas cosas:
>    - `positions()`: `liquidity`, `tokensOwed` **almacenado**, `feeGrowthInside{0,1}LastX128`.
>    - `collect` callStatic: `tokensOwed` **live** raw.
> 2. **Avance de cursor SIN getLogs** solo si: NO cambió el snapshot persistido relevante (`liquidity`, `tokensOwed` almacenado, `feeGrowthInside*`) **y** el raw live **no bajó** → no hubo Increase/Decrease/Collect → avanzar `feesLifetimeCursorBlock` a `latest − confirmations` sin pedir logs.
> 3. **getLogs SOLO ante cambio:** si cambia `liquidity` / `tokensOwed` almacenado / `feeGrowthInside*`, **o** baja el raw live → escanear logs del rango pendiente.
> 4. **Acotar el rango:** binary-search del bloque del cambio vía `eth_call positions()` por `blockNumber` (~12 calls), luego `getLogs` fino en chunks de 10. **Fallback (MED v3):** si el RPC no soporta `eth_call` histórico (archive), caer a barrido por chunks de 10 + marcar `stale` mientras avanza.
> 4. **Presupuesto duro:** max requests/bloques por corrida + backlog queue; lo no alcanzado queda `feesLifetimeStatus = "stale"` y se reintenta. La UI muestra "actualizado hace X".
>
> Como los cobros/cambios estructurales son **raros**, en régimen normal el cron casi no pega a Alchemy → Free alcanza. PAYG queda como upgrade si algún día el volumen lo exige.

## 6. Modelo de datos (Convex `schema.ts`) — tabla de eventos + agregados raw (ajustes Codex #3, ALTO-2, MED-3, BAJO-1)

### Tabla nueva `pool_fee_events` (fuente de verdad, dedupe anti-reorg) — ALTO #2
> El schema anterior (solo agregados) **no permite dedupe**: re-escanear una ventana anti-reorg volvería a sumar eventos ya contados → doble conteo de fees/principal en el money-path. Se persiste cada log individual con clave única.

- `poolId: id("pools")`
- `txHash: string`, `logIndex: number`, `blockNumber: number`, `blockHash: string`
- `eventType: "increase" | "decrease" | "collect"`
- `amount0Raw: string`, `amount1Raw: string` (uint256)
- Índice `by_pool_log` = `(poolId, txHash, logIndex)` — **de búsqueda, NO constraint** (ALTO-1 v3: Convex no tiene índices únicos por schema). La unicidad se garantiza en la **mutation** (upsert idempotente, §8), no por el índice.
- Índice `by_pool_block` = `(poolId, blockNumber)` para recomputar/limpiar por reorg.
- **Reorg (ALTO-3 v3):** borrar `> latest − confirmations` **no alcanza** si la ventana re-escaneada empieza antes. Al re-escanear `[fromBlock, toBlock]`: borrar **todos** los eventos del pool con `blockNumber >= fromBlock` (o, mejor, comparar `blockHash` y eliminar los de rama vieja) **antes** de reinsertar la rama canónica que devuelve `getLogs`. Luego recomputar agregados desde la tabla.

### Agregados cacheados en `pools` (derivados de la tabla, para UI barata) — RAW, no USD (#3)
- `feesCollectedRaw0/1: optional(string)` — Σ fees cobradas (excedente sobre principal).
- `principalDebt0/1: optional(string)` — deuda de principal pendiente al cursor (se descuenta del uncollected vivo).
- `feesLifetimeCursorBlock: optional(number)` — último bloque **finalizado** agregado.
- `feesLifetimeCalcAt: optional(number)` — timestamp del último recálculo.
- `feesLifetimeStatus: optional("ok" | "stale" | "no_key" | "error")` — estado explícito (BAJO #1). UI distingue "sin key", "atrasado" y "error", no solo "—".
- `lastTokensOwedRaw0/1: optional(string)` — último `tokensOwed` raw visto (detectar cobro por caída de cantidad, no USD). **Renombrado** desde `lastCollectRaw0/1` (MED #3: el nombre antiguo sugería evento `Collect` cuando es un snapshot de `tokensOwed`).

> USD se deriva al vuelo: `feesLifetimeUsd = valuar(feesCollectedRaw + feesUncollectedRaw, priceUsd spot)`.
> Tiempo de vida = `initialLiquidityAt` (vida total, decisión B); sin schema nuevo.

## 7. Cuándo se calcula / refresca (cache + detección de cobro)

- **Back-fill inicial**: script externo puntual (decisión A) → inserta los eventos históricos en `pool_fee_events` y deja el cursor en un bloque finalizado.
- **Detección de cobro / cambio estructural (ajuste Codex #5 + ALTO #1 + ALTO-2 v3):** comparar entre scans el snapshot persistido de `positions()` (`liquidity`, `tokensOwed` almacenado, `feeGrowthInside{0,1}LastX128`) **y** el `tokensOwed` live raw (collect callStatic) — nunca en USD. Sin cambio en el snapshot persistido y raw live no bajó ⇒ avanzar cursor sin getLogs. Cambio en snapshot persistido o caída del raw live ⇒ re-escaneo incremental acotado para ese pool.
- **Incremental anti-reorg, ahora SIN doble conteo (ajuste Codex #6 + ALTO #2):**
  - `eth_getLogs` desde `fromBlock = cursor − margenReorg` hasta `toBlock = latest − confirmations`.
  - **Limpieza de la ventana re-escaneada (ALTO-3 v3):** antes de reinsertar, borrar los eventos del pool con `blockNumber >= fromBlock` (o por `blockHash` de rama vieja) para no dejar logs huérfanos de un reorg.
  - Cada log se **upserta** en `pool_fee_events`: la mutation busca por `(poolId, txHash, logIndex)` y **no inserta si ya existe** (ALTO-1 v3: no hay índice único real en Convex) + **dedupe en memoria por lote**.
  - Recalcular agregados raw del pool **desde la tabla** (no sumando sobre el agregado anterior).
  - Avanzar `feesLifetimeCursorBlock` solo hasta `latest − confirmations` (confirmations por red; L2s reorganizan).
- **En pantalla:** `feesLifetime ≈ feesCollectedRaw (cache) + feesUncollected vivo`, valuado a spot.

## 8. Backend (Convex)

- `convex/actions/poolScanner.ts`:
  - `rpcGetLogs(url, filter)` — nuevo (Alchemy, con paginación por rango).
  - **Wrapper raw del helper de fees (MED #1):** hoy `fetchUncollectedFeesUsd` (`:277-323`) devuelve solo USD; el plan necesita `tokensOwed` raw para descontar `principalDebt`. Cambiar/envolver para devolver `{ amount0Raw, amount1Raw, feesUsd? }` **manteniendo compat** con los consumidores actuales de `feesUncollectedUsd` (portal/admin no deben romperse).
  - `fetchCollectedFeesLifetime({ tokenId, network, fromBlock, toBlock })` — getLogs de los 3 eventos, **inserta en `pool_fee_events`** (idempotente), recalcula agregados desde la tabla aplicando §4 (principalDebt en orden), devuelve `{ feesCollectedRaw0/1, principalDebt0/1, cursorBlock }`.
  - Descontar `principalDebt` del `tokensOwed` vivo al componer el total.
  - URLs Alchemy por red + guard si falta key (status `no_key`) + manejo de límite de rango (paginar/avanzar) + status `stale`/`error`.
- `convex/pools.ts`: mutations para **upsert** de eventos (buscar por `(poolId, txHash, logIndex)` y no insertar si existe; dedupe en memoria por lote — ALTO-1 v3), borrado de la ventana re-escaneada (`blockNumber >= fromBlock` / por `blockHash` — ALTO-3 v3), y persistir agregados raw + cursor + status (recomputados desde la tabla).
- `convex/crons.ts`: cron de refresco (patrón `checkAllPoolClosures`, concurrencia 5) **con presupuesto duro** (ver §5/§13.A): max bloques por corrida, max requests por posición, backlog queue, marcar `stale` lo no alcanzado.
- Exponer en queries UI (**la UI consume cache, NUNCA dispara getLogs histórico** — MED #2):
  - Portal: `listPools` (`pools.ts:6-18`) → ya devuelve la fila `pools` (incluye los campos nuevos).
  - Admin: `getUserDetail` (`admin.ts:181-190`) arma el objeto `pool` a mano y **hoy no incluye `initialLiquidityAt` ni lifetime** → añadirlos. `getUserAdminLiveSnapshot` (`adminLive.ts:70-98`) devuelve uncollected vivo pero no lifetime → añadir agregado cacheado + `feesLifetimeStatus`.

## 9. Frontend (UI)

### Portal — `PoolCard` (`src/components/BotPortal.jsx:312-680`)
- **Tiempo de vida**: duración + fecha (`formatLifetime`). Es vida total (decisión B).
- **Total generado**: `feesLifetimeUsd` (tooltip: "fees cobrados + sin cobrar; valuado a precio actual").
- **Estado explícito (BAJO #1):** según `feesLifetimeStatus` → `ok` (muestra valor), `stale` (valor + "actualizado hace X / puede estar atrasado"), `no_key`/`error` ("—" o aviso). No ocultar que el número puede estar desactualizado.
- Junto al bloque de métricas de fees (`:473-488`).

### Admin — `PositionCard` / `UserRow` (`src/components/AdminView.jsx:103-291`)
- Mismos dos datos por posición.

### Helpers
- `formatLifetime(ms)`, `formatDateShort(ms)` compartidos.

## 10. Tiempo de vida — semántica tras cierre+reapertura ⚠️ (ajuste Codex #4)

> **DECISIÓN CERRADA (B) = vida total.** Usar `initialLiquidityAt` tal cual; **no** se reinicia al reabrir, **no** se añade `activeSinceAt`. Sin cambios de backend para esto. En la UI se aclara que es "vida total" (desde la primera captura).

Fallback si falta `initialLiquidityAt`: `_creationTime`.

## 11. Orden de implementación sugerido

1. Schema: campos raw + cursor (sin `activeSinceAt` — decisión B = vida total).
2. Backend: `rpcGetLogs` + `fetchCollectedFeesLifetime` (algoritmo principalDebt) + URLs Alchemy + guard + paginación.
3. Mutation persistencia + cron refresco incremental con Free (detección por raw, anti-reorg, dedupe).
4. Exponer campos en queries portal/admin.
5. UI portal (`PoolCard`) — tiempo de vida (vida total) + total generado.
6. UI admin (`PositionCard`/`UserRow`).
7. **Script de back-fill externo puntual** (decisión A): paginar getLogs en archive RPC y rellenar raw + cursor en Convex.
8. (Aparte) JAV-118 subgraphs.

## 12. Riesgos

- getLogs Free limitado → §5 / §13.A.
- Valuación a spot ≠ USD real al momento del cobro (cantidad sí exacta; aceptado v1).
- Reorgs L2 → margen de confirmaciones + dedupe (§7).
- Cuota Alchemy a escala → cache de raw + incremental; PAYG/plan solo si escala real.

## 13. Decisiones del usuario (CERRADAS 2026-06-26)

**A. Back-fill = externo puntual.** Script one-off con RPC de archivo reconstruye el histórico una vez (paginando getLogs sin presión de prod) → rellena raw + cursor en Convex; luego incremental con Alchemy Free. Retroactivo completo, sin coste recurrente.

**B. Tiempo de vida = vida total** desde `initialLiquidityAt` (no se reinicia al reabrir, sin `activeSinceAt`). Se aclara en la UI.

**C. Incremental (reauditoría, ALTO #1) = Free + presupuesto duro + `stale`.** Viable gracias a: avance de cursor sin getLogs cuando el scan barato no detecta cambio estructural; getLogs solo ante cobro/cambio (raro); rango acotado por binary-search; backlog + estado `stale` visible. PAYG queda como upgrade futuro. Detalle en §5.

## 14. Feedback de Codex incorporado (v1)

1. ✅ Contabilidad principal/fee con `principalDebt` en orden cronológico + descuento del uncollected vivo (§4).
2. ⚠️ Límite getLogs Free → decisión §13.A (§5).
3. ✅ Cachear cantidades raw + cursor, USD al vuelo (§6).
4. ⚠️ `initialLiquidityAt` no se reinicia → decisión §13.B (§10).
5. ✅ Detección de cobro por raw/eventos, no USD (§7).
6. ✅ Incremental con margen anti-reorg + dedupe por txHash+logIndex + confirmations (§7).
- ✅ Subgraphs → issue aparte JAV-118.

## 15. Reauditoría Codex (v2) incorporada — `docs/audit-jav117-pool-lifetime-fees-reaudit.md`

**ALTO**
1. ✅ Incremental con Free acotado matemáticamente → decisión C (§5/§13.C): avance de cursor sin getLogs, getLogs solo ante cambio, binary-search, presupuesto + `stale`.
2. ✅ Dedupe anti-reorg real → tabla `pool_fee_events` con índice único `(poolId, txHash, logIndex)`; agregados recomputados desde la tabla, no sumados (§6/§7).

**MEDIO**
1. ✅ Helper de fees devuelve raw → wrapper `{ amount0Raw, amount1Raw, feesUsd? }` manteniendo compat con `feesUncollectedUsd` (§8).
2. ✅ Admin serializa campos nuevos → `initialLiquidityAt` + lifetime en `getUserDetail`/`getUserAdminLiveSnapshot`; UI consume cache, no dispara históricas (§8).
3. ✅ Renombrar `lastCollectRaw0/1` → `lastTokensOwedRaw0/1` (§6).

**BAJO**
1. ✅ Estado `stale` explícito (`feesLifetimeStatus`: ok/stale/no_key/error) en schema y UI (§6/§9).
2. ✅ Subgraphs fuera de JAV-117 → JAV-118.

## 16. Reauditoría Codex (v3) incorporada

1. ✅ **Convex sin índices únicos reales:** `by_pool_log` es índice de **búsqueda**; la idempotencia se hace en la mutation (query por `(poolId, txHash, logIndex)` + dedupe por lote), no por constraint (§6/§8).
2. ✅ **Señal "sin getLogs" corregida:** `positions().tokensOwed` es checkpoint almacenado, no fees pasivas. Usar `positions()` (liquidity, tokensOwed almacenado, `feeGrowthInside*`) **+** collect callStatic raw (live). Avanzar cursor solo si snapshot persistido sin cambios y raw live no bajó (§5/§7).
3. ✅ **Anti-reorg completo:** re-escanear `cursor − margenReorg` y borrar/recalcular la ventana `blockNumber >= fromBlock` (o por `blockHash`), no solo `> latest − confirmations`; recomputar desde tabla (§6/§7).
- ✅ **(MED)** binary-search histórico con fallback a chunks de 10 + `stale` si el RPC no soporta `eth_call` histórico (§5).

→ Codex: **GO limpio** con estos cambios aplicados.
