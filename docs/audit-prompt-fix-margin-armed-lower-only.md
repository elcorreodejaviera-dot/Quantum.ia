# Prompt de auditoría (Codex) — FIX margen `armed_lower_only` (JAV-85 #1, money-path)

Audita el PLAN `docs/plan-fix-margin-armed-lower-only.md`. Es un fix money-path: incluir `armed_lower_only`
en `ARM_OPEN_MARGIN_STATES` (convex/executions.ts) para que `committedMarginForAccount` cuente el margen de
arms en ese estado (hoy lo ignora → posible over-commit de colateral).

Contexto verificado: `transitionToArmedLowerOnly` (triggerArms.ts:439) no modifica reservedNotional/marginReserved;
`reduceArmReservation` solo corre si `armMode !== "reentry_coexist"` (triggerEngine.ts:528); schema.ts:372
describe armed_lower_only como cobertura inferior viva (entry_lower armada).

Responde GO/NO-GO con hallazgos:
1. ¿Es correcto que `armed_lower_only` mantiene `marginReserved` vivo en TODOS los caminos que llegan a ese
   estado (no solo reentry_coexist)? ¿Hay algún camino donde la reserva ya se liberó/redujo y contarla sería
   un SOBRE-conteo? (revisar reduceArmReservation, settleArm, closeArmLowerOnlyExpired).
2. ¿Añadir el estado solo puede AUMENTAR el margen comprometido (gate más conservador), nunca permitir más?
3. ¿Algún OTRO set/consumidor debería incluir armed_lower_only también (p.ej. dailyNotionalUsed, kill-switch,
   listados de arms "vivos", revocación de cuenta HL, borrado de bot)? ¿O margen es el único afectado?
4. Paso 2 (exportar OPEN_MARGIN_STATES/ARM_OPEN_MARGIN_STATES y que admin.ts las importe): ¿importar un
   `const Set` desde executions.ts a admin.ts arrastra algo del money-path o es seguro? ¿Recomendado para
   evitar la divergencia futura, o mejor mantener separado?
5. ¿`closeArmLowerOnlyExpired` (terminaliza armed_lower_only) libera la reserva correctamente al cerrar, de
   modo que tras el fix no quede margen contado de más cuando expira?
6. ¿El fix es coherente con que admin.ts (ARM_OPEN) ya incluye armed_lower_only?
