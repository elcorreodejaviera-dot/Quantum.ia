# Plan — Fase 4 JAV-84: exponer Revert.finance en la position card del panel Admin

## Contexto
La position card muestra hoy `Revert: no expuesto aún`. El dato YA llega: `getUserAdminLiveSnapshot`
(adminLive.ts) llama a `fetchPositionLiquidity`, que devuelve campos de **Revert Finance Lend** cuando el
NFT de la posición es propiedad del vault de Revert (`REVERT_VAULT[network]`):
- `leverageRevert` — **OJO: es LTV%** (loan-to-value), NO un multiplicador. Código fuente
  (`poolScanner.ts:611`): `LTV = debt/fullValue` ×100. Ej: debt 500 / fullValue 1000 → `leverageRevert = 50` (=50%).
- `healthFactor` — `collateral/debt` (ej. 2.0).
- `borrowHealth` — `(hf−1)×100` acotado [0,100] (margen de salud %).
- Si el NFT NO está en el vault (LP normal, como el bot actual del admin) → todos 0 → "Sin apalancar (LP spot)".

## Decisión de etiquetado (clave — Codex la validó como bloqueante en su día)
`leverageRevert` es LTV, no "×". Para no engañar:
- **Recomendado:** mostrar **"⚡ Revert · {lev}× · LTV {ltv}% · salud {borrowHealth}%"**, donde el
  multiplicador honesto es `lev = 1/(1 − LTV/100)` (LTV 50%→2.0×, 67%→3.0×), **guardado**: solo si
  `0 < LTV < 100` (si LTV≥100 o no finito → omitir el ×, mostrar solo LTV%).
- Si `leverageRevert` (LTV) es 0 / ausente → **"Sin apalancar (LP spot)"** (como el mockup).
- `healthFactor`/`borrowHealth` como indicador de salud (color: verde si salud alta, ámbar/rojo si baja).

(Alternativa más conservadora si Codex prefiere: NO derivar el ×, mostrar solo "Revert · LTV {ltv}% ·
salud {borrowHealth}%". Decidir en la auditoría.)

## Cambios
- `convex/adminLive.ts`: en el bucle de posiciones, además de `liquidityUsd`/`feesUncollectedUsd`, extraer
  de la MISMA llamada a `fetchPositionLiquidity`: `revertLtv` (= `leverageRevert`), `healthFactor`,
  `borrowHealth`. Añadirlos a `positions[botId]`. (No hay nueva llamada de red — ya se llama.)
- `src/components/AdminView.jsx` (`PositionCard`): sustituir la etiqueta fija por:
  - `revertLtv > 0` → "⚡ Revert · {lev}× · LTV {ltv}% · salud {borrowHealth}%" (lev guardado).
  - en otro caso → "Sin apalancar (LP spot)".
  - Mientras `liveLoading` y sin dato aún → "Revert: …" (placeholder de carga).
- Sin cambios de schema, sin backend nuevo, **read-only, NO money-path**.

## Verificación
- `npm run typecheck` + `npx vite build`.
- Para el admin actual (LP no apalancado) → "Sin apalancar (LP spot)".
- Bordes: LTV null/0 → sin apalancar; LTV≥100 o no finito → sin × (solo LTV%); healthFactor 0 → no mostrar HF.

## Flujo
Plan → Codex audita el plan → GO → implementar → Codex audita código → GO → PR → merge con Codex
(CodeRabbit sin créditos) → deploy Convex + Railway. Sin tests simulados.
