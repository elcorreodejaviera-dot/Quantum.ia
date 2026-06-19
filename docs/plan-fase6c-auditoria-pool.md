# Fase 6-C — Modo auditoría de pool (admin, read-only)

## En una frase

Una vista admin que, por bot/pool, cruza lo que DEBERÍA estar pasando (config del bot/arm + bordes del
pool) con lo que REALMENTE hay (exposición LP on-chain + hedge real en HL) y reporta **inconsistencias**
con un veredicto ✅/⚠️. Diagnóstico puro: read-only, sin tocar money-path.

## Fuentes de datos (corregido tras auditoría Codex — ALTO)

**`listMyActiveArms` NO sirve aquí**: es del usuario AUTENTICADO, no del usuario que el admin audita.
Y `admin.getUserDetail` hoy solo expone `armStatus`, no triggers/bordes/órdenes. Por tanto 6-C necesita:

1. **`adminLive.getUserAdminLiveSnapshot`** (`adminLive.ts:40`) — datos EN VIVO (ya leídos, sin RPC nuevo):
   por bot/pool `liquidityUsd`/`currentPrice`/`inRange`; por cuenta+coin `coverageByAccountCoin`
   (nocional real del hedge), `collateralUsd`. **OJO (Codex MEDIO#3):** `getUserLiveTargetsInternal`
   FILTRA `!closed && tokenId!=null` → los pools cerrados o sin tokenId NO aparecen en el snapshot.
2. **UNA query admin read-only NUEVA** `admin.getUserPoolAuditData(userId)` (requireAdmin, solo DB, sin
   RPC) que devuelva los hechos de DB que faltan: por bot → pool (min/max/closed/tokenId/network),
   bot (active/hlAccountId/baseAsset), y los **arms** del bot (incluidos terminales recientes) con sus
   **trigger_orders** (role/observedStatus/triggerPx/oid). Esto habilita `triggers_vs_edges`,
   `orphan_orders`, `pool_closed_with_live_arm`, y los checks de red/config. Read-only, sin secretos.

→ 6-C = (1) snapshot live ya existente + (2) una query admin DB-only nueva + la capa de checks puros.
NO añade lecturas RPC nuevas (la exposición/hedge salen del snapshot que ya se calcula).

## Diseño

### Helpers PUROS `src/lib/poolAudit.js` → `auditPool(input) → Finding[]`
Funciones puras (sin React, testeables) que reciben un `input` ya resuelto (mezcla DB-query + live):
```
{ pool: {minRange,maxRange,closed,tokenId,network,pair},     // de la query admin DB
  bot:  {active, hlAccountId, baseAsset, network?},          // de la query admin DB
  arms: [{ status, network, triggerPx, lowerEdge, upperEdge,
           orders:[{role,observedStatus,triggerPx}] }],      // TODOS los arms recientes (DB), no solo el vivo
  live: {liquidityUsd, inRange, coverageUsd, present} }       // del snapshot; present=false si el pool no estaba
```
Devuelven `Finding[]` = `{ level: 'ok'|'warn'|'unknown', code, msg }`. `unknown` cuando falta el dato
(NUNCA un falso ✅/⚠️). Constantes de tolerancia EXPLÍCITAS y documentadas (Codex BAJO#6):
`HEDGE_BAND = 0.25` (±25%, warning operativo), `EDGE_DRIFT_PCT = 0.005` (0.5% relativo, no igualdad).

Checks y su FUENTE:
1. **`pool_closed_with_live_arm`** (DB-only) — `pool.closed && hay arm no-terminal` → ⚠️. (No usar el
   snapshot: omite pools cerrados — Codex MEDIO#3.)
2. **`account_unlinked`** (DB) — `bot.active && !bot.hlAccountId` → ⚠️.
3. **`pool_no_tokenid`** (DB, Codex MEDIO#4) — `bot.active && pool.tokenId == null` → ⚠️ «Pool sin
   tokenId: el motor no puede cuantificar la cobertura».
4. **`arm_network_mismatch`** (DB, Codex MEDIO#4) — `arm.network !== pool.network` → ⚠️.
5. **`base_asset_unmappable`** (DB, Codex MEDIO#4/#5) — `bot.active && !hlCoin(bot.baseAsset)` → ⚠️.
6. **`triggers_vs_edges`** (DB) — `arm.lowerEdge`/`upperEdge` vs `pool.minRange`/`maxRange` con
   `EDGE_DRIFT_PCT` (relativo) → drift ⚠️ «armado con bordes distintos al pool actual».
7. **`orphan_orders`** (DB) — orden `observedStatus==='open'` en un arm terminal/ausente → ⚠️.
8. **`hedge_vs_exposure`** (live) — `live.coverageUsd` vs `live.liquidityUsd` fuera de `HEDGE_BAND` →
   ⚠️ «Hedge {menor|mayor} que la exposición». Si `!live.present` o algún dato falta → `unknown`.
9. **`uncovered_in_range`** (live+DB) — `live.inRange && bot.active && (sin arm vivo)` → ⚠️.

**Mapeo coverageUsd por bot (Codex MEDIO#5):** `coverageByAccountCoin[bot.hlAccountId][hlCoin(bot.baseAsset)]`
usando el normalizador `hlCoin` (WETH→ETH, WBTC→BTC) que AdminView ya usa — NO `baseAsset` crudo. Si hay
MÁS de un bot con la misma cuenta+coin (legacy), el hedge agregado NO es atribuible per-bot → ese check
sale `unknown` («cobertura agregada, no atribuible a un bot»), no un ✅/⚠️ falso.

Veredicto del pool = ⚠️ si algún `warn`; `unknown` si faltan datos clave; ✅ solo si todo verificable y ok.

### Backend nuevo: `admin.getUserPoolAuditData(userId)` (query, requireAdmin, DB-only)
Devuelve por bot del usuario auditado: pool (min/max/closed/tokenId/network/pair), bot (active/
hlAccountId/baseAsset), y sus arms recientes (status/network/triggers/bordes) con sus trigger_orders
(role/observedStatus/triggerPx). Solo lectura de DB, sin RPC, sin secretos (ids/estados/números).

### Vista admin (`AdminView.jsx`)
Sección «AUDITORÍA DE POOLS» (admin-gated): por pool/bot, badge ✅/⚠️/«sin datos» + lista de findings.
Consume `getUserPoolAuditData` (DB) + `getUserAdminLiveSnapshot` (live) y pasa el `input` a `auditPool`.

## Verificación
- `npm run typecheck` + `npx vite build` + `tests/poolAudit.test.ts` (puro, congela cada check ok/warn/
  unknown por escenario, incl. ambigüedad de mapeo y datos faltantes).
- En navegador: un pool coherente → ✅; uno con drift/huérfana/red-mismatch → ⚠️ con el mensaje correcto;
  uno sin live → «sin datos».

## Decisiones cerradas (post-auditoría Codex)
- **Fuente de datos** (ALTO#1/#2): se AÑADE la query admin DB-only `getUserPoolAuditData`; los checks
  triggers/orphan/closed/red/config salen de ahí (no del snapshot, que omite pools cerrados/sin tokenId).
- **Sin RPC nuevos**: la exposición/hedge se reusan del snapshot existente.
- **Normalización** (MEDIO#5): `hlCoin(bot.baseAsset)`; duplicados cuenta+coin → `unknown`.
- **Red/config** (MEDIO#4): checks `arm_network_mismatch`/`pool_no_tokenid`/`base_asset_unmappable`.
- **Tolerancias** (BAJO#6): `HEDGE_BAND=0.25`, `EDGE_DRIFT_PCT=0.005`; `unknown` si falta el dato.

## Fuera de alcance (posterior)
- Auditar pools de OTROS usuarios en bloque (este PR: por usuario, como el panel admin actual).
- Cualquier acción correctiva (esto solo REPORTA; no arma/cierra nada).

## Flujo
plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → merge. Riesgo: BAJO-MEDIO
(admin read-only; el cuidado va en la corrección de los checks → puros y testeados).
