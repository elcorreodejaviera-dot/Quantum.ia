# Prompt de auditoría (Codex) — CÓDIGO: JAV-115 colateral spot (unified) en el panel admin

Rama `feat/jav115-admin-spot-collateral`. Cambio **solo-display / admin / read-only** (no money-path, no
persistencia, no motor). Veredicto **GO / NO-GO**.

## Qué hace

El panel admin mostraba "colateral $X" usando solo `marginSummary.accountValue` (perp). En **modo unified**
el USDC de **spot** también respalda el hedge (ya lo maneja el portal — `parseHLAccount` en
`src/hooks/useHyperliquid.js:382-389` expone `spotUsdcFree = Σ(total − hold)` de balances USDC). Sin esto,
un usuario con $0 perp y $545 spot se ve como "colateral $0" → engañoso.

- **Backend** (`convex/adminLive.ts`): nuevo `fetchSpotUsdcFree(address)` (POST `spotClearinghouseState`,
  mismo patrón/timeout/AbortController que `fetchClearinghouse`; `free = Σ(parseFloat(total) −
  parseFloat(hold))` sobre balances `coin === "USDC"`; `null` si falla). En el loop de `hlAccounts` se
  llama una vez por cuenta y se agrega `spotUsdcFree` al objeto pusheado (en la rama OK y en la de fallo
  de perp). `coverageByAccountCoin`/`pnlByAccountCoin`/`positionByAccountCoin` intactos.
- **Frontend** (`src/components/AdminView.jsx`): el tag "Cuenta HL … · colateral {usd(collateralUsd)}"
  pasa a "colateral {usd} perp · {usd(spotUsdcFree)} spot" (spot en verde, **solo si `> 0`**). NO se suman
  (mismo criterio que el portal: la disponibilidad real con haircuts la valida el backend al operar).

## Verifica GO/NO-GO

1. **Read-only / sin efectos**: ¿solo agrega una lectura `spotClearinghouseState` (pública) y un campo al
   snapshot? ¿No toca persistencia, motor ni money-path? ¿El gate admin sigue intacto?
2. **Cálculo correcto del spot libre**: ¿`Σ(total − hold)` sobre balances USDC reproduce fielmente el
   `spotUsdcFree` del portal (`useHyperliquid.js:382-389`)? ¿Maneja balances ausentes/strings/NaN sin
   romper (devuelve null o número finito)?
3. **No sumar perp+spot**: ¿es correcto exponerlos SEPARADOS (perp vs spot) y no como un total, dado que
   los haircuts del modo unified los valida el backend al operar? ¿El texto evita implicar que se suman?
4. **Robustez de fallos**: si `spotClearinghouseState` falla → `spotUsdcFree = null` → el front no renderiza
   el fragmento spot (gate `!= null && > 0`). Si el perp falla (rama `!ch`), ¿igual se incluye el spot? ¿Y
   no rompe el render?
5. **Reutilización/consistencia**: ¿reusa `usd()` y las clases existentes? ¿La latencia extra (1 fetch más
   por cuenta, secuencial) es aceptable para el panel admin bajo demanda?

Checks: `npx tsc -p convex/tsconfig.json --noEmit` (OK) + `npx vite build` (OK) + spot validado contra la
cuenta real (benjamin: $545.23 USDC spot, $0 perp). NO `npm run build`.
