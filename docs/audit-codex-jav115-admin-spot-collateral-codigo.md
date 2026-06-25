# Auditoria Codex - JAV-115 colateral spot en panel admin

Fecha: 2026-06-25

## Alcance auditado

- Rama: `feat/jav115-admin-spot-collateral`
- Commit auditado: `d294da8 feat(jav115): admin muestra el colateral de spot (USDC) en modo unified`
- Base local: `master` / `origin/master` en `63bc045`
- Archivos de codigo:
  - `convex/adminLive.ts`
  - `src/components/AdminView.jsx`
  - Referencia comparativa: `src/hooks/useHyperliquid.js`
- Prompt de auditoria:
  - `docs/audit-prompt-jav115-admin-spot-collateral-codigo.md`

Cambio auditado: display admin/read-only para mostrar USDC spot libre (`spotUsdcFree`) separado del colateral perp (`marginSummary.accountValue`) en el tag de cuenta HL.

Referencia externa revisada: documentacion oficial de Hyperliquid, Info endpoint / Spot. El endpoint `spotClearinghouseState` devuelve balances spot y, en unified account o portfolio margin, es fuente de verdad para balances del trading account entre spot y perps:
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot

## Bloqueante

No se encontraron hallazgos bloqueantes.

## Alto

No se encontraron hallazgos altos.

## Medio

No se encontraron hallazgos medios.

## Bajo

### B1 - Fallo de lectura spot se oculta igual que spot cero

Evidencia:

- `convex/adminLive.ts:43-64` devuelve `null` si `spotClearinghouseState` falla.
- `src/components/AdminView.jsx:169-170` solo renderiza el fragmento spot si `spotUsdcFree != null && spotUsdcFree > 0`.

Impacto:

- Bajo y esperado por el prompt: si falla solo la lectura spot, el admin ve solo `colateral X perp` sin indicador de que spot no estuvo disponible.
- No rompe render ni money-path. El backend operativo sigue validando disponibilidad real al operar.

Recomendacion:

- Aceptable para este cambio. Como mejora futura, si el panel quiere distinguir "0 spot" de "spot no disponible", exponer un flag parcial especifico para spot.

### B2 - Latencia del snapshot HL puede duplicarse por cuenta en peor caso

Evidencia:

- `convex/adminLive.ts:127-130` llama `fetchClearinghouse` y luego `fetchSpotUsdcFree` de forma secuencial por cuenta.
- Cada fetch tiene timeout de 10s (`convex/adminLive.ts:15`, `17-34`, `43-64`).
- `getUserLiveTargetsInternal` limita las posiciones/cuentas visibles, pero el fan-out sigue siendo secuencial.

Impacto:

- Bajo: es panel admin bajo demanda, read-only, y el fan-out ya esta acotado.
- En degradacion de HL, el snapshot puede tardar mas que antes.

Recomendacion:

- Aceptable. Si se vuelve molesto, paralelizar por cuenta con `Promise.all([fetchClearinghouse, fetchSpotUsdcFree])` conservando los mismos fallbacks.

## Verificaciones especificas del prompt

### 1. Read-only / sin efectos

Resultado: OK.

Evidencia:

- `convex/adminLive.ts:66-70` mantiene el gate admin con `internal.users.getCurrentAdminInternal`.
- El cambio agrega una lectura publica a Info API (`spotClearinghouseState`) en `convex/adminLive.ts:47-52`.
- No se agregan mutations, escrituras DB, exchange client, firmas, cambios de motor ni persistencia.
- El diff de codigo se limita a `convex/adminLive.ts` y `src/components/AdminView.jsx`.

### 2. Calculo correcto del spot libre

Resultado: OK.

Evidencia:

- Backend nuevo: `convex/adminLive.ts:55-58` filtra balances `coin === "USDC"` y suma `parseFloat(total) - parseFloat(hold)`.
- Portal existente: `src/hooks/useHyperliquid.js:382-389` calcula `spotUsdcFree` con la misma formula sobre `spotData.balances`.
- La documentacion oficial de HL muestra `spotClearinghouseState` con balances que incluyen `coin`, `total` y `hold`.
- Si la respuesta falla o la suma queda no finita, el backend devuelve `null` (`convex/adminLive.ts:53`, `58-60`).

### 3. No sumar perp + spot

Resultado: OK.

Evidencia:

- Backend solo agrega `spotUsdcFree`; no altera `collateralUsd`.
- Frontend muestra `colateral {usd(collateralUsd)} perp · {usd(spotUsdcFree)} spot` en `src/components/AdminView.jsx:169-170`.
- No hay suma ni nuevo total visual. Esto evita sugerir disponibilidad sin haircuts; el backend operativo sigue siendo la autoridad.

### 4. Robustez de fallos

Resultado: OK.

Evidencia:

- Si spot falla, `spotUsdcFree = null` y el frontend no renderiza el fragmento spot.
- Si perp falla (`!ch`), el backend igualmente ya calculo `spotUsdcFree` antes del branch y lo incluye en `hlAccounts.push` (`convex/adminLive.ts:127-134`).
- El render usa `usd(null)` para perp y no rompe: `src/components/AdminView.jsx:11-17`, `169-170`.

### 5. Reutilizacion / consistencia UI

Resultado: OK.

Evidencia:

- Reusa `usd()` y clases existentes `av-tag` / `av-pos-pnl`.
- No agrega CSS nuevo.
- La lectura extra es una llamada publica por cuenta HL visible, en snapshot admin bajo demanda y con timeout/fallback.

## Pruebas y comandos revisados

- `git diff --stat master..HEAD`
- `git diff master..HEAD -- convex/adminLive.ts src/components/AdminView.jsx src/hooks/useHyperliquid.js`
- `rg -n "spotUsdcFree|spotClearinghouseState|parseHLAccount|marginSummary|Cuenta HL|colateral|collateralUsd" convex/adminLive.ts src/components/AdminView.jsx src/hooks/useHyperliquid.js -S`
- `git diff --check master..HEAD` - OK
- `npx tsc -p convex/tsconfig.json --noEmit` - OK
- `npx vite build --outDir /tmp/quantum-jav115-audit-build --emptyOutDir` - OK
  - Warnings no bloqueantes: anotaciones PURE de dependencias `ox` y chunk JS > 500 kB.
- `npx vitest run` - OK: 17 archivos, 265 tests

No se ejecuto `npm run build` porque incluye deploy de Convex.

## Veredicto final

GO.

El cambio es admin/read-only, no toca money-path, motor ni persistencia. El calculo de USDC spot libre replica el hook del portal, conserva perp y spot separados, y mantiene fallbacks seguros. Solo quedan observaciones bajas de UX/latencia ante fallos de lectura spot.
