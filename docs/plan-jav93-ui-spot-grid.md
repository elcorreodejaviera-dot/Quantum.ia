# Plan JAV-93 — UI Spot Grid + tarjeta para compartir + stats (QSG PR4)

## Context
Sub-4 de la épica **JAV-89** (Quantum Spot Grid Live). PR1/PR2/PR3 (connector, schema+backend, motor)
ya están hechos; **falta la PANTALLA**: hoy se puede crear/operar un grid solo por `npx convex run`. Esta
PR da la UI (tab nuevo) para **crear, ver y compartir** un Spot Grid, estilo BingX pero Quantum. Incluye
lo que pidió el usuario (2026-06-20): **tarjeta para compartir** (estilo screenshot BingX: pair · Spot Grid
Infinity · Ganancias totales · Duración Xd Yh Zm · Órdenes emparejadas N), **stats** (días de creado, nº de
arbitrajes/ciclos, ganancia total). Mayormente **frontend** + **una query read-only** de stats.
Depende de JAV-92 (motor; `stopSpotGridBot`) → ramificar de master **tras** mergear #99 (o rebasar).

## 1. Backend — query read-only de detalle/stats (`convex/spotGridBots.ts`, NON-node)
- **`getSpotGridDetail(botId)`** (query, scoped por `getUserOrNull` + ownership): devuelve el bot +
  - **stats**: `cyclesCount` (count `spot_grid_cycles` by_bot), `totalNetProfit` (Σ `cycles.netProfit`),
    `createdAt` (para "días/duración"), `lastReconciledAt`, `status`, `errorMessage`.
  - **órdenes**: BUY/SELL abiertas (`by_bot_status` open/submitting/partially_filled) con price/qty/side.
  - **ciclos recientes** (últimos N de `spot_grid_cycles` by_bot_cycle desc): netProfit/closedAt.
  Solo escalares; nunca expone claves. Acotar con `.take()` (cap por bot, igual que admin SCAN_CAP).
- `listSpotGridBots` (ya existe, JAV-91) para la lista. Si hace falta, enriquecer con `cyclesCount`/
  `totalNetProfit` por bot (cuidando el coste; cap).

## 2. UI — `src/components/SpotGridView.jsx` (nuevo)
Reusa el design system y componentes existentes (NO recrear): `HLAccountSelect`, `.config-field`,
`.segmented`, `.modal-panel`, `.panel`, `.metric`, `.mini-btn`, `usd()`. Hooks: `useHyperliquidAllMids`
(precio live), `useHyperliquidSpotState(address)` (balance spot de la cuenta).
- **Crear grid**: selector par (allowlist **BTC/ETH**), precio live, `HLAccountSelect` (cuenta dedicada),
  inputs `minPrice` / `gridProfit%` (0.5–10) / `inversión`; avanzados colapsados (`orderSize`, `gridCount`,
  `feeRate`). Botón **Crear** → **modal de confirmación LIVE NO salteable**: *"Esto creará órdenes reales en
  Hyperliquid Spot con tu API wallet trade-only"* + aviso de riesgo (downtrend / underperform en bull). Al
  confirmar → `useAction(api.spotGridActions.createSpotGridBot)` con `confirm:true` + `expectedNetwork`.
- **Vista bot activo** (`getSpotGridDetail`): estado (running/paused/stopped/error + errorMessage), profit
  cerrado (`totalNetProfit`), nº arbitrajes (`cyclesCount`), días de creado, BUY/SELL abiertas, ciclos
  recientes. Botones **Pause** (`api.spotGridBots.pauseSpotGridBot`) y **Stop**
  (`useAction(api.spotGridActions.stopSpotGridBot)` con `expectedNetwork`; confirmación: cancela órdenes
  reales). Mensaje claro: **pausar NO cancela las órdenes vivas; detener sí** (Codex BAJO PR3).
- **Tarjeta para compartir — `SpotGridShareCard`** (estilo BingX del screenshot): branding Quantum, par +
  "Spot Grid Infinity", **Ganancias totales** (`totalNetProfit`, verde), **Duración** `Xd Yh Zm`
  (`now-createdAt`), **Órdenes emparejadas** (`cyclesCount`). Botón "Compartir" → render a imagen
  descargable (canvas/`html-to-image` si ya está, o composición CSS + screenshot manual). Sin datos
  sensibles (ni cuenta, ni claves).

## 3. Routing + nav
- `src/App.jsx`: `<Route path="/spot-grid" element={<ProtectedRoute><SpotGridView/></ProtectedRoute>} />`.
- `src/components/BotPortal.jsx:~3975`: junto al link `Admin`, añadir `<Link to="/spot-grid">Spot Grid</Link>`
  (visible a logueados; la creación la gatea el backend por `canManageBots`+`canTradeLive`).

## Reuso (NO duplicar)
`HLAccountSelect`, hooks de `src/hooks/useHyperliquid.js` (`useHyperliquidAllMids`, `useHyperliquidSpotState`,
`useHLAccountsBalances`), clases de `src/styles/bot-portal.css`, patrón de tab/ruta de AdminView (JAV-80),
`hlCoin`/`usd` helpers. Backend: `createSpotGridBot`/`pauseSpotGridBot`/`stopSpotGridBot`/`listSpotGridBots`
ya existen; solo se añade `getSpotGridDetail`.

## Invariantes / seguridad
Confirmación LIVE **no salteable** antes de crear (el flag viaja al backend, que re-valida — PR2). No se
exponen claves ni la cuenta en la tarjeta de compartir. La UI no asume nada: todos los guards (permisos,
red, gate mainnet, exclusividad) los hace el backend. Stop/pause con confirmación.

## Verificación
- `npm run typecheck` OK · `npx vite build` OK (a outDir temporal; `dist` local tiene archivos root).
- `getSpotGridDetail`: convex-test de ownership (otro usuario → null) + stats correctos (Σ netProfit, nº
  ciclos) sobre filas sembradas.
- Responsive; confirmación LIVE no salteable; "pausar no cancela / detener sí" claro en la UI.
- Validación visual real: crear un grid pequeño desde la UI en HL (mainnet gateado), ver órdenes/stats/
  tarjeta. Flujo: plan → GO Codex → implementar → GO Codex código → PR → CodeRabbit → merge → deploy.

## Fuera de alcance (otras subtareas)
Añadir capital (JAV-100) y retirar ganancias (JAV-101) → botones/flujos money-path aparte. Hardening
(JAV-94). Esta PR solo lee/crea/pausa/detiene y muestra/compatible.
