# Sesión 2026-06-22 — Flotante a mercado (JAV-104), cifras demo del portal (JAV-105) y deploy

Resumen de la sesión: comparación BingX vs Quantum del Spot Grid, dos bugs encontrados y arreglados
(mergeados a `master`), y aclaración de cómo se despliega producción.

---

## 1. Comparación BingX vs Quantum (origen de todo)

Comparativa real con el mismo capital ($1.000, BTC, ~9.5h) entre el **Spot Grid Infinity de BingX** y el
**Spot Grid de Quantum**:

| Métrica | BingX (USDT) | Quantum (USDC) |
|---|---|---|
| Arbitrajes cerrados | 2 | 3 |
| **Realizado** | +0.0294 | **+$0.34** |
| Flotante | ~+8.58 | +$0.06 ⚠️ |
| Total | +8.6115 (+0.86%) | +$0.40 |

**Conclusiones:**
- En **arbitraje realizado** (el trabajo real del grid) Quantum va **muy por delante** de BingX.
- El **+8.61 de BingX es ~99.7% flotante**: están largos en 0.0111 BTC sembrado que se revalorizó. No es
  habilidad del grid, es exposición direccional. Su "APY 838%" está inflado por eso.
- El flotante de Quantum ($0.06 "precio desactualizado") estaba **mal calculado** → **JAV-104**.

---

## 2. JAV-104 — Flotante marcado a mercado con precio vivo

**Estado:** ✅ Mergeado en `master` (PR #107, squash). CodeRabbit pass. GO de Codex (plan y código).

### Bug
El flotante de la tarjeta del Spot Grid no marcaba a mercado:
- `getSpotGridDetail` usaba `refPrice = bot.currentPrice`, que es el **precio de CREACIÓN/ancla**
  (`schema.ts`), nunca actualizado al precio vivo (el motor solo leía `getSpotPrice` en la colocación
  inicial). Como el inventario se compra cerca del ancla, `floatingPnl = (ancla − heldAvgCost)·heldQty ≈ 0`
  siempre.
- `priceStale` colgaba de `lastReconciledAt`, que solo sube cuando hay fills nuevos → "precio
  desactualizado" en grids sanos sin operaciones recientes.

### Fix (4 archivos)
- **`convex/schema.ts`** — `lastPrice?`/`lastPriceAt?` (opcionales, legacy-safe). `currentPrice` intacto
  como ancla → no rompe "prometido==colocado" de JAV-101.
- **`convex/spotGridBots.ts`** — mutation `setSpotGridLastPrice` (bajo lease, `Number.isFinite` + `>0`);
  query contable `refPrice = bot.lastPrice ?? bot.currentPrice`, `priceStale` por `lastPriceAt`.
- **`convex/spotGridEngine.ts`** — `reconcileOneBot`: 1 lectura `getSpotPrice` por bot/ronda que persiste
  el precio vivo (try/catch, no aborta); la colocación inicial legacy **reusa** ese `livePrice` (sin doble
  lectura).
- **`tests/spotGridBots.test.ts`** — test contable: flotante usa `lastPrice` (no el ancla), fallback
  legacy, y `priceStale` por `lastPriceAt` fresco/ausente/viejo.

### Notas de revisión
- Codex GO con BAJO 1 (defensa `Number.isFinite`) → aplicado.
- Comportamiento en pausa: grids `paused` se reconcilian (running+paused), refrescan precio → **no** quedan
  stale; solo `stopped` deja de refrescar (deseable).
- CodeRabbit: 2 nits, ambos sobre el **doc del plan** (no el código), corregidos después.

Plan: `docs/plan-jav104-flotante-mark-to-market.md`.

---

## 3. JAV-105 — Portal: no mostrar cifras DEMO al entrar

**Estado:** ✅ Mergeado en `master` (PR #108, squash). Build verde. GO de Codex sobre el plan.

### Bug (captura QA `bug_al_entrar.jpg`)
Al entrar al portal (Liquidity Hedge) con un usuario con pool real, las tarjetas mostraban unos segundos
cifras demo (`Liquidez $33,680`, `APY 58.4%`, `Fees $58`) y luego cargaban las reales.

### Causa
`src/components/BotPortal.jsx` tenía una tabla `POOLS` demo hardcodeada que se mezclaba en el `useMemo`
de `pools` como fallback mientras `positionData` (lectura LP on-chain) llegaba async.

### Fix (`src/components/BotPortal.jsx`)
- Eliminada la tabla `POOLS` y su uso como `mock`.
- Financieros (`liquidity`/`apr`/`fees`) arrancan en **0** y los sobreescribe la lectura on-chain real
  cuando llega (decisión del usuario: **0 → real**, sin cifras inventadas).
- `apy: p.apy ?? null` (no `0`) → las alertas `apy_below` (filtran `p.apy != null`) **ignoran** pools sin
  APY real → evita falso positivo transitorio; las vistas lo pintan como 0 vía `?? 0` (**Codex MEDIO**).
- Limpiados comentarios obsoletos que decían "mock" (**Codex BAJO**).

Plan: `docs/plan-jav105-portal-cifras-demo.md`.

---

## 4. Deploy a producción (aprendizaje clave)

**Producción (portal-quantum.com) se despliega SOLA vía Railway al hacer push/merge a `master`.**

- `railway.json`: `buildCommand: "npm run build"` (= `typecheck && vite build && convex deploy`),
  `startCommand: "npm start"` (server.js sirve `dist/`), builder NIXPACKS.
- Railway usa **sus** variables de entorno de **producción** (`CONVEX_DEPLOY_KEY` prod + `VITE_CONVEX_URL`
  prod) → despliega Convex a prod y compila el front apuntando a prod.

⚠️ **NO correr `npm run build` en local para deployar.** El `.env.local` del repo es **dev**
(`CONVEX_DEPLOYMENT=dev:strong-sandpiper-848`) → un build local despliega al Convex de **dev** y deja un
`dist` local apuntando a dev; **no toca producción**.

- Bloqueante histórico: `dist/assets` quedó propiedad de `root` (build con sudo) → `vite build` local
  falla con EACCES. Esquivable sin sudo con `mv dist dist_root_old` (renombrar solo necesita permiso en el
  directorio padre).

---

## 5. Estado final

- `master` al día: JAV-104 (#107) + JAV-105 (#108) mergeados y desplegados por Railway.
- typecheck limpio · 189 tests verdes · `vite build` OK.
- Limpieza hecha previa: borrados los `.jpg` de QA y `docs/audit-prompt-jav101-coderabbit-fixes.md`.
- Pendientes menores: `dist_root_old/` (borrar con sudo), `bug_al_entrar.jpg` sin trackear, y un
  `stash@{0}` viejo del 2026-06-20 (única copia de skills/docs/scripts útiles — NO borrar sin revisar).
