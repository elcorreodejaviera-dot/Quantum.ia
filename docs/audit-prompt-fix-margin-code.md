# Prompt de auditoría (Codex) — CÓDIGO fix margen armed_lower_only (JAV-85 #1)

Audita el código (working tree, sin commit). Cambio MÍNIMO money-path en `convex/executions.ts`: se añade
`"armed_lower_only"` a `ARM_OPEN_MARGIN_STATES` (el set que usa `committedMarginForAccount` para contar margen
comprometido de trigger_arms). Plan con GO en `docs/plan-fix-margin-armed-lower-only.md`.

Diff: solo `convex/executions.ts` (1 línea en el Set + comentario). NO se tocó nada más.

Verifica GO/NO-GO:
1. ¿El literal quedó bien añadido y `committedMarginForAccount` ahora cuenta `marginReserved` de arms en
   armed_lower_only (que mantienen reserva viva)?
2. ¿Solo puede AUMENTAR el margen comprometido (más conservador), sin doble conteo ni sobre-conteo?
3. ¿Confirmas que NINGÚN camino llega a armed_lower_only con la reserva ya liberada/reducida (lo que haría
   sobre-contar)? (reentry_coexist no reduce; transitionToArmedLowerOnly no libera; closeArmLowerOnlyExpired
   terminaliza a closed/failed que NO está en el set).
4. ¿Queda coherente con admin.ts (que ya incluía armed_lower_only en su copia ARM_OPEN)?
