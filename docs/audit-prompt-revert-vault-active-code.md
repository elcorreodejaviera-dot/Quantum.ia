# Prompt de auditoría (Codex) — CÓDIGO `revertVaultActive` + `revertLoanKnown`

Audita el **código** (working tree, sin commit) según `docs/plan-revert-vault-active.md` (plan con GO).
Archivos: `convex/actions/poolScanner.ts`, `convex/adminLive.ts`, `src/components/AdminView.jsx`.

Cambios:
- `poolScanner.ts` `fetchPositionLiquidity`: `let revertVaultActive=false, revertLoanKnown=false;`.
  `revertVaultActive=true` dentro de `if (owner === vaultAddr.toLowerCase())`. `revertLoanKnown=true` tras
  `if (loanRaw.length >= 64*3)` (loanInfo decodificado OK, antes del `if (debt>0n...)` → true aunque debt=0).
  Ambos añadidos al return. NO se cambió ningún valor/flujo existente ni `fetchPositionNotionalStrict`.
- `adminLive.ts`: passthrough `revertVaultActive`/`revertLoanKnown` en `positions[botId]` (default false; solo
  se setean si entró al bloque de `fetchPositionLiquidity`, es decir currentPrice>0).
- `AdminView.jsx` `PositionCard`: 5 estados:
  1. `ltv>0` → "⚡ Revert · {lev}× · LTV% · salud%".
  2. `vaultActive && !loanKnown` → "En Revert · deuda: —".
  3. `ltv===0 && vaultActive && loanKnown` → "En Revert · sin deuda".
  4. `ltv===0 && !vaultActive` → "Sin apalancar (LP spot)".
  5. resto (`ltv==null`) → "Revert: —".

Responde GO/NO-GO:
1. ¿`revertLoanKnown=true` está colocado SOLO tras decodificar loanInfo con éxito y es `true` aunque debt=0?
   ¿Queda `false` si loanInfo revierte/viene corto/falla (catch)?
2. ¿Los 5 estados de la card cubren todo sin ambigüedad ni solapamiento? ¿El orden de los `else if` es correcto
   (deuda desconocida ANTES que "sin deuda")?
3. ¿`revertVaultActive`/`revertLoanKnown` default false en adminLive cuando currentPrice≤0 (no se llamó a
   fetchPositionLiquidity) → la card cae en "Sin apalancar"? ¿es aceptable o debería ser "Revert: —"?
   (nota: con currentPrice≤0 tampoco hay liquidez; revisar coherencia con el resto de la card).
4. ¿Se preserva intacto el cálculo Revert existente (debt/LTV/healthFactor) y NO se toca money-path?
5. ¿Algún borde de decodificación (loanRaw corto pero ≥64*3, valores basura) que marque loanKnown=true con
   datos no fiables?
