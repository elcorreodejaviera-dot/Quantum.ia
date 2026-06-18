# Prompt de auditoría (Codex) — Plan `revertVaultActive` (mejora JAV-84)

Audita el PLAN `docs/plan-revert-vault-active.md`: exponer un booleano `revertVaultActive` desde
`fetchPositionLiquidity` (poolScanner) para que la card distinga "en Revert sin deuda" (LTV 0 pero en vault)
de "LP spot" (no en vault). Cambio aditivo read-only; toca `convex/actions/poolScanner.ts` (display path,
NO `fetchPositionNotionalStrict`), `convex/adminLive.ts` (passthrough) y `src/components/AdminView.jsx` (etiqueta).

Ronda 1 → NO-GO: faltaba distinguir "deuda 0 confirmada" de "deuda desconocida". Corregido: ahora DOS
booleanos — `revertVaultActive` (owner===vault) y `revertLoanKnown` (`loanInfo` decodificado con éxito,
true aunque debt=0). 5 estados en la card. Re-auditar:
1. ¿`revertLoanKnown=true` colocado SOLO tras decodificar `loanInfo` con éxito (dentro de
   `if (loanRaw.length >= 64*3)`), y `true` aunque debt=0? ¿`false` si revierte/corto/falla?
2. ¿Es seguro añadir ambos booleanos sin alterar ningún valor/flujo existente (debt/LTV/healthFactor/liquidez/fees)?
3. ¿Los 5 estados de la card quedan sin ambigüedad? (LTV>0 / LTV0+vault+loanKnown / vault+!loanKnown /
   LTV0+!vault / LTV null).
4. ¿`revertVaultActive=false` ante `ownerOf` fallido / sin `vaultAddr` es correcto (no afirmar vault)?
5. ¿Se respeta NO money-path (no se toca `fetchPositionNotionalStrict` ni reserva/arming)?
6. ¿Algún caso en que `ownerOf`===vault pero la posición no esté realmente gestionada (NFT en tránsito) y
   "En Revert · sin deuda"/"deuda: —" sea engañoso?
