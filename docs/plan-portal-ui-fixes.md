# Plan — Arreglos de UI del portal (JAV-UI)

4 cambios pedidos por el usuario (capturas en escritorio). Rama: `feat/portal-ui-fixes` (base master).

## A — Descuadre de filtros de cadena en móvil
**Síntoma:** la fila `Todas · Ethereum · Arbitrum · Base · Optimism` se sale por la derecha; "Optimism" queda cortado en móvil.
**Dónde:** `src/components/BotPortal.jsx` ~3566 (`.segmented` con `NETWORKS.map`) + `src/styles/bot-portal.css` (`.segmented`).
**Fix:** que `.segmented` no recorte en pantallas estrechas. Opción elegida: **scroll horizontal** sin barra visible:
```css
.segmented { overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.segmented::-webkit-scrollbar { display: none; }
.segmented > button { flex: 0 0 auto; white-space: nowrap; }
```
Alternativa descartada: `flex-wrap: wrap` (apila en 2 filas; el usuario prefiere ver una fila deslizable). Solo CSS, sin tocar lógica.

## B — Precio del gráfico de rango al lado izquierdo
**Síntoma:** la etiqueta `Precio $X` de la línea sale a la derecha; se quiere a la izquierda (junto a min/max que ya están a la izquierda).
**Dónde:** `BotPortal.jsx` 339-344 (`.range-chart-price-line`) + CSS `.range-chart-price-line`.
**Fix:** alinear la etiqueta de la línea de precio a la **izquierda** del bar (mismo lado que `.range-chart-labels`). CSS: `left: 0; right: auto; text-align: left;` y reordenar para que el texto no quede tapado por el bar (z-index + fondo translúcido). Solo CSS/JSX.

## C — Precio de entrada del pool (línea de entrada, automático desde la posición)
**Objetivo:** dibujar en el gráfico una **línea horizontal de "Entrada $X"** = precio al que se abrió el LP, derivado de la posición (no manual).

**Limitación real:** Uniswap V3 `positions(tokenId)` **NO almacena** el precio de entrada. Dos vías:
- **C1 (pragmática, recomendada para v1):** la **primera vez** que `poolScanner` registra/ve la posición (cuando `pool.entryPrice == null` y hay `currentPrice`), guardar `currentPrice` como `entryPrice` y **nunca sobrescribir**. Reusa el `slot0` que ya se lee. Aproximación = "precio cuando el portal vio la posición por primera vez".
- **C2 (exacta, follow-up):** leer el evento `IncreaseLiquidity`/`Mint` del tokenId vía `eth_getLogs` y calcular el precio en el mint desde los `amount0/amount1` o el tick del bloque. Más RPC y más complejo; dejar para una 2ª iteración si C1 no basta.

**Schema (`convex/schema.ts`, tabla `pools`):**
```ts
entryPrice: v.optional(v.number()),
entryPriceAt: v.optional(v.number()),
```
**Backend:** en el cron/registro de `poolScanner` (donde ya se setea `initialLiquidityUsd`/`initialLiquidityAt`), setear `entryPrice` una sola vez (C1). Mutation interna `patchPoolEntryPrice` (idempotente: no pisa si ya existe).
**UI (`BotPortal.jsx` range-chart):** nueva `.range-chart-entry-line` posicionada por `bottom: posEntry%` (misma fórmula que la línea de precio pero con `pool.entryPrice`), etiqueta "Entrada $X" a la izquierda, color distinto (p.ej. ámbar). Ocultar si `entryPrice == null` o fuera de [min,max].

## D — Botón "Eliminar bot" (borra el bot del pool y lo detiene)
**Objetivo:** en la sección Proteger/Trading (`BotActionButton`), un botón para **borrar el bot de ese pool deteniéndolo de forma segura**.
**Dónde:** `BotPortal.jsx` `BotActionButton` (~1936) + backend `convex/bots.ts` (o donde vivan las mutations de bots).
**Backend — mutation `deletePoolBot({ botId })`:**
1. Guard: admin / `canManageBots`.
2. **Parada segura primero:** `requestDisarmAndDeactivateImpl(ctx, botId)` (ya existe en `triggerArms.ts`) → cancela arm/órdenes vivas vía cron, `active=false`.
3. **Borrado seguro:** solo eliminar el registro del bot si `hasNonTerminalArmForBot(ctx, botId) === false` (sin arm vivo). Si hay arm vivo → NO borrar aún: marcar intención (`deletePending`?) y que el cron, tras cancelar y dejar el arm terminal, complete el borrado; o devolver "deteniendo, reintenta en unos segundos". **Nunca borrar un bot con orden/posición viva en HL** (evita huérfanos como en el motor JAV-44).
4. Limpiar referencias (rearm pendiente, etc.) — reutilizar el `clearRearm` de `requestDisarmAndDeactivateImpl`.
**UI:** botón "Eliminar" en `BotActionButton`, admin-only, con `window.confirm`, deshabilitado si el bot tiene arm vivo (mostrar "Deteniendo…"). Color rojo (`var(--red)`).

## E — Modal de configuración no scrollable en móvil
**Síntoma:** al pulsar "Configurar"/"Reconfigurar" desde el móvil, el modal del bot no se abre por completo; el contenido largo se recorta arriba/abajo y no se puede desplazar para ver todos los parámetros.
**Causa:** `.modal-panel` no tiene `max-height` ni `overflow-y`; el overlay (`position: fixed`, centrado) recorta lo que sobresale del viewport sin permitir scroll.
**Fix (solo CSS, `src/styles/bot-portal.css`):** `.modal-panel { max-height: calc(100dvh - 32px); overflow-y: auto; -webkit-overflow-scrolling: touch; }` + `.modal-overlay { padding: 16px; }` (margen para que se vea que hay contenido por encima/debajo). Aplica a TODOS los modales (config bot, scan, test, etc.).

## Orden de implementación sugerido
1. A y B (CSS puro, sin riesgo) → commit.
2. D (mutation + botón) → necesita parada segura (reutiliza helpers del motor).
3. C1 (schema + poolScanner + línea en gráfico).
4. C2 (mint exacto) solo si el usuario quiere precisión mayor.

## Notas de flujo (proyecto)
- Rama `feat/portal-ui-fixes`, push SSH (`GIT_SSH_COMMAND='ssh -F /dev/null'`), gh SIN `GH_TOKEN`.
- Schema/Convex cambian → `node node_modules/convex/bin/main.js deploy` (type-check real) antes de producción.
- Auditoría: el plan y el código los audita el USUARIO (Codex) + CodeRabbit en el PR. NO mergear sin CodeRabbit.
