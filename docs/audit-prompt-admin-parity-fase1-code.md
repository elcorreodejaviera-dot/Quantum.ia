# Prompt de auditoría (Codex) — CÓDIGO Fase 1 de JAV-84

Audita el **código** (working tree, sin commit) de la Fase 1 del plan `docs/plan-admin-parity.md`
(panel Admin: paridad mockup + fix del TVL). Diff en `convex/admin.ts` y `src/components/AdminView.jsx`.

Objetivo de la fase: arreglar el dato y el formato SIN red nueva. Cambios:
- `admin.ts getSystemStats`: KPI ahora `monitoredInitialUsd` = Σ `pool.initialLiquidityUsd` de pools con
  bot activo (dedupe por pool), `unknownLiquidityCount` (nulls no sumados como 0), `volume24hDelta`
  (% vs 24h previas), `network = hlNetwork()` defensivo. Se ELIMINÓ `tvlPools` (usaba pool.tvl ≈ pool entero).
- `admin.ts listUsersOverview`: añade `monitoredInitialUsd` + `unknownLiquidityCount` por usuario.
- `admin.ts getUserDetail`: pool añade `feeTier`, `initialLiquidityUsd`.
- `AdminView.jsx`: `usd()` con millones; `usdWithUnknown`; columna "$ monit." (antes "HL", HL pasa a badge
  junto al nombre); KPI "TVL en pools (LP)"; pill de red; position card con "Liquidez LP (inicial)",
  "Cobertura (cap)", feeTier en subtítulo, enlace "↗ ver" (Uniswap por tokenId+cadena).

Verifica GO/NO-GO con hallazgos:
1. ¿La métrica de monitoreado es coherente (initialLiquidityUsd, NO tvl, NO hedgeNotionalUsd) y el dedupe
   por pool correcto? ¿`unknownLiquidityCount` señaliza bien lo incompleto sin inflar/desinflar?
2. ¿`getSystemStats` sigue acotado por `SCAN_CAP`? El nuevo `ctx.db.get(poolId)` por bot activo: ¿coste
   aceptable? ¿algún N+1 peligroso o falta de tope?
3. ¿`hlNetwork()` envuelto en try/catch evita romper la query si `HL_NETWORK` faltara? ¿bien?
4. `volume24hDelta`: ventana previa `[since-1d, since)` correcta, `/0` evitado (null), `take(SCAN_CAP)`.
5. Front: ¿`usd()` con M/k correcto en bordes (999, 1000, 100k, 1M, 100M, negativos)? ¿`feeTierPct`
   (5→"0.05%", 30→"0.3%") correcto? ¿`poolLink` no genera URLs inválidas (tokenId null, red desconocida)?
6. ¿La grilla de la tabla (6 columnas) sigue cuadrando tras cambiar "HL" por "$ monit."? (CSS `.av-uhead/.av-main`).
7. ¿Algún riesgo de excepción no capturada que deje la vista en blanco (lección del routing)?
8. ¿Se respeta que esto es solo lectura/cache (NO money-path, NO red en queries)?

Contexto: queries Convex no hacen red; el dato vivo (Liquidez LP actual, fees s/cobrar, PnL, colateral) es
Fase 2 (acción agregada), no esta fase.
