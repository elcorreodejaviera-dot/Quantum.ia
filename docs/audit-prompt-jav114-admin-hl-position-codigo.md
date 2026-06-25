# Prompt de auditoría (Codex) — CÓDIGO: JAV-114 ver posición real de HL en el panel admin

Rama `feat/jav114-admin-hl-position`. Cambio **solo-display / admin / read-only** (no money-path, no
persistencia, no motor). Veredicto **GO / NO-GO**.

## Qué hace

En el panel admin, dentro de cada usuario, mostrar la **posición real de Hyperliquid** (tamaño, entry,
liq, leverage) además del nocional/PnL que ya se mostraban — para que el admin sepa si el hedge cubre el
pool.

- **Backend** (`convex/adminLive.ts`, action `getUserAdminLiveSnapshot`): dentro del loop que ya recorre
  `ch.assetPositions`, se construye `positionByAccountCoin[acctId][coin] = { szi, notional, entryPx, liqPx,
  leverage, upnl }` (HL netea por coin → 1 posición por coin/cuenta). Se agrega al return. Las estructuras
  previas (`coverageByAccountCoin`, `pnlByAccountCoin`) quedan intactas.
- **Frontend** (`src/components/AdminView.jsx`):
  - `UserRow` deriva `hlPosition = live.positionByAccountCoin?.[hlAccountId]?.[coin]` y lo pasa a
    `PositionCard`.
  - `PositionCard` renderiza una fila (reusando las clases existentes `av-pos-foot`/`av-tag`):
    `Posición HL: −2.67 ETH @ 1569.3 · liq 1614.87 · 20×` + `Hedge $4,181 vs Exposición LP $X = Y×`
    (`covRatio = hedgeNotional / live.liquidityUsd`, color verde si `|ratio−1| ≤ 0.25`, ámbar si no —
    misma banda y base que el audit `hedge_vs_exposure` de `src/lib/poolAudit.js`). Fallback
    `Sin posición HL abierta` cuando `live` cargó y no hay posición.

## Verifica GO/NO-GO

1. **Read-only / sin efectos**: ¿el cambio solo lee `clearinghouseState` (ya se leía) y agrega campos al
   snapshot? ¿No toca persistencia, motor, ni el money-path? ¿El gate admin (`getCurrentAdminInternal`)
   sigue protegiendo la action?
2. **Guards numéricos**: `szi/entryPx/liqPx/leverage/upnl` se filtran con `Number.isFinite` y `szi !== 0`;
   `notional` puede ser null. En el front, `covRatio` solo se calcula si `lpExposure > 0`. ¿Algún caso que
   muestre NaN/∞ o rompa el render (posición sin liqPx, leverage cross sin value, etc.)?
3. **Correctitud de la comparación**: ¿`hedgeNotional / liquidityUsd` es la base correcta y CONSISTENTE
   con `poolAudit.hedge_vs_exposure` (mismo numerador/denominador y banda 0.25)? ¿El color refleja bien
   "cubre / no cubre"?
4. **Coherencia de mapeo**: `coin = hlCoin(pos.baseAsset)`; ¿el lookup `positionByAccountCoin[acctId][coin]`
   usa la misma clave que `coverageByAccountCoin`/`pnlByAccountCoin` (mismo coin)? ¿Una cuenta con varios
   bots del mismo coin (ambiguo) muestra algo engañoso, o es aceptable como en el audit?
5. **Reutilización/UI**: ¿reusa `usd`/`fmtPrice` y las clases `av-tag`/`av-pos-foot` como el resto, sin CSS
   nuevo? ¿La firma extra `hlPosition` opcional no rompe el render cuando falta (snapshot viejo en caché)?

Checks: `npx tsc -p convex/tsconfig.json --noEmit` (OK) + `npx vite build` (OK) + ruta de datos validada
contra la cuenta real (szi −2.6715, entry 1569.3, liq 1614.87, lev 20). NO `npm run build`.
