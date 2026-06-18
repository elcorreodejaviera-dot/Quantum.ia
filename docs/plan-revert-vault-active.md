# Plan — `revertVaultActive`: distinguir "en Revert sin deuda" de "LP spot" (mejora JAV-84)

## Contexto / problema
Hoy la card usa `revertLtv` (= `leverageRevert` = LTV%):
- `>0` → apalancado en Revert · "×".
- `===0` → "Sin apalancar (LP spot)".
- `null` → "Revert: —" (desconocido).

Pero `revertLtv===0` MEZCLA dos casos reales distintos (hallazgo no bloqueante de Codex en Fase 4):
1. La posición NO está en el vault de Revert (LP normal) → "LP spot" correcto.
2. La posición SÍ está en el vault de Revert pero SIN deuda (apalancamiento 0) → debería decir
   "En Revert · sin deuda", no "LP spot".

`fetchPositionLiquidity` (poolScanner) ya sabe la diferencia: comprueba `ownerOf(tokenId) === REVERT_VAULT[network]`.
Solo que no lo expone.

## Cambio (mínimo, aditivo, read-only)
DOS booleanos (Codex ronda 1): `revertVaultActive` (NFT pertenece al vault) Y `revertLoanKnown` (loanInfo se
decodificó con éxito). Necesarios para NO confundir "deuda 0 confirmada" con "deuda desconocida (loanInfo falló)".
1. `convex/actions/poolScanner.ts` → `fetchPositionLiquidity`: añadir `let revertVaultActive = false;` y
   `let revertLoanKnown = false;` junto a los campos Revert.
   - `revertVaultActive = true` **dentro** del `if (owner === vaultAddr.toLowerCase())` (confirmado en vault).
   - `revertLoanKnown = true` **solo tras decodificar `loanInfo` con éxito** (dentro del
     `if (loanRaw.length >= 64 * 3)`, una vez extraídos debt/fullValue/collateral) — `true` aunque debt=0
     (deuda CONOCIDA = 0); queda `false` si `loanInfo` revierte / viene corto / falla.
   - Añadir ambos al objeto de retorno. NO se toca otra lógica ni los valores existentes (debt/LTV/healthFactor).
   - Edge: `ownerOf` falla / sin `vaultAddr` → `revertVaultActive=false`. En vault pero `loanInfo` falla →
     `revertVaultActive=true`, `revertLoanKnown=false`.
   - **NO se toca `fetchPositionNotionalStrict`** (lectura del motor); solo el path de display.
2. `convex/adminLive.ts`: passthrough de `revertVaultActive` y `revertLoanKnown` en `positions[botId]`
   (junto a revertLtv/healthFactor/borrowHealth).
3. `src/components/AdminView.jsx` → `PositionCard`, etiqueta Revert con 5 estados (Codex ronda 1):
   - `revertLtv > 0` → "⚡ Revert · {lev}× · LTV% · salud%" (apalancado).
   - `revertLtv === 0 && revertVaultActive && revertLoanKnown` → **"En Revert · sin deuda"**.
   - `revertVaultActive && !revertLoanKnown` → **"En Revert · deuda: —"** (en vault, deuda desconocida).
   - `revertLtv === 0 && !revertVaultActive` → "Sin apalancar (LP spot)".
   - `revertLtv == null` → "Revert: —" (lectura desconocida).

## Verificación
- `npm run typecheck` + `npx vite build`.
- Posición del admin (LP normal) → `revertVaultActive=false` → "Sin apalancar (LP spot)" (sin cambio visible).
- Lógica: confirmar que `revertVaultActive` solo es `true` cuando `ownerOf===vault` se leyó con éxito.
- Money-path intacto: no cambia `fetchPositionNotionalStrict` ni la lógica de reserva/arming; `fetchPositionLiquidity`
  solo AÑADE un campo booleano al retorno (no altera los existentes).

## Flujo
Plan → Codex audita el plan → GO → implementar → Codex audita código → GO → PR → merge con Codex
(CodeRabbit sin créditos) → deploy Convex + Railway. Sin tests simulados.
