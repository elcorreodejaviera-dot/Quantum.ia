# Prompt de auditoría (Codex) — Plan Fase 4 JAV-84 (Revert en la card)

Audita el **PLAN** `docs/plan-admin-fase4-revert.md`: exponer datos de Revert Finance Lend en la position
card del panel Admin, reutilizando lo que `fetchPositionLiquidity` ya devuelve (vía `getUserAdminLiveSnapshot`
en `convex/adminLive.ts`, read-only). Frontend en `src/components/AdminView.jsx`.

Hecho clave: `leverageRevert` NO es un multiplicador — es **LTV%** (`poolScanner.ts:611`:
`LTV = debt/fullValue ×100`). Hay además `healthFactor` (collateral/debt) y `borrowHealth` ((hf−1)×100, [0,100]).
Si el NFT no está en `REVERT_VAULT` → 0 → "Sin apalancar (LP spot)".

Responde GO/NO-GO con hallazgos:
1. ¿La etiqueta propuesta es honesta y no engaña? `lev = 1/(1−LTV/100)` derivado del LTV: ¿correcto
   matemáticamente y bien guardado (0<LTV<100; LTV≥100/no finito → omitir ×)? ¿O mejor mostrar SOLO LTV%
   sin derivar el ×?
2. ¿`healthFactor`/`borrowHealth` se interpretan bien (salud del préstamo)? ¿Umbrales de color razonables?
3. ¿Distingue correctamente "no en vault" (todo 0 → Sin apalancar) de "en vault con LTV 0"? ¿Puede un LP
   apalancado real dar LTV 0 legítimo y confundirse con "sin apalancar"?
4. ¿Es estrictamente read-only y reutiliza la llamada existente (sin nueva red, sin money-path)?
5. ¿Algún borde de unidades/redondeo (LTV ya viene ×10/round; healthFactor ×100/round) que haya que tener
   en cuenta al formatear?
6. ¿Conviene mostrar también `amountToRepay`/`liquidationThreshold`/`availableToBorrow` (también disponibles)
   o mantenerlo mínimo (LTV/lev/salud) en esta fase?
