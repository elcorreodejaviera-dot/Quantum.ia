# Plan — FIX money-path: contar `armed_lower_only` en el margen comprometido (JAV-85 #1)

## Problema (riesgo real de margen)
`convex/executions.ts` define `ARM_OPEN_MARGIN_STATES` (estados de trigger_arms que mantienen margen
comprometido). NO incluye **`armed_lower_only`**:
```
const ARM_OPEN_MARGIN_STATES = new Set([
  "arming","submitting","armed","disarming","filled","protecting","protected","unknown",
]);   // ← falta armed_lower_only
```
`committedMarginForAccount` (executions.ts:66) suma `marginReserved` de los arms en ese set y es el que usa
el gate de reserva (`reserveArm`/`reserveExecution`) para no sobre-asignar colateral.

`armed_lower_only` SÍ mantiene reserva viva (verificado):
- `transitionToArmedLowerOnly` (triggerArms.ts:439) cambia el status pero **NO toca** `reservedNotional`/`marginReserved`.
- En modo `reentry_coexist` la reserva **NO se reduce** (triggerEngine.ts:528 reduce solo si `armMode !== "reentry_coexist"`).
- schema.ts:372: en `armed_lower_only` la cobertura inferior (entry_lower) sigue armada → si perfora, llena un short que necesita ese margen.

→ Un arm en `armed_lower_only` tiene margen reservado que `committedMarginForAccount` **ignora** →
**infra-cuenta el margen comprometido → otra reserva puede asignar el mismo colateral (over-commit / doble gasto).**
Viola CLAUDE.md: "Margin accounting must include both legacy executions and trigger arms."

PRE-EXISTENTE (JAV-61). Lo destapó el `admin.ts` de hoy, cuya copia `ARM_OPEN` SÍ incluye `armed_lower_only`
(más correcta que el canónico).

## Fix
1. Añadir `"armed_lower_only"` a `ARM_OPEN_MARGIN_STATES` en `convex/executions.ts`.
2. (Recomendado, contra futura divergencia — finding #7) **Exportar** `OPEN_MARGIN_STATES` y
   `ARM_OPEN_MARGIN_STATES` desde `executions.ts` (son `const Set`, NO lógica money-path) e **importarlas en
   `admin.ts`** reemplazando las copias `EXEC_OPEN`/`ARM_OPEN`. Así el panel y el gate usan la MISMA fuente.
   - El comentario actual de admin.ts dice "para no importar del money-path"; importar un `Set` constante no
     arrastra lógica → seguro. Si Codex prefiere mantener separado, dejar solo el paso 1.

## Verificación / por qué es seguro
- Cada arm aporta su `marginReserved` UNA vez; añadir el estado solo **incluye** arms antes excluidos →
  el margen comprometido solo puede SUBIR (gate más conservador). Nunca permite asignar MÁS. Sin doble conteo.
- `npm run typecheck`. Revisar que no rompa ningún test/flujo (no hay tests). Confirmar que `dailyNotionalUsed`
  u otros sets hermanos NO necesiten el mismo cambio (esto es solo de MARGEN; el límite diario es por notional
  de fills, no por estado abierto — Codex que lo confirme).
- Efecto en producción: cuentas con un arm en `armed_lower_only` verán MÁS margen comprometido (correcto);
  podría bloquear una nueva reserva que antes (erróneamente) pasaba — comportamiento deseado.

## Alcance / qué NO se toca
- No se cambia la máquina de estados ni la lógica de arming/rearm/OCO. Solo el SET de estados que cuentan margen.
- No se toca el front salvo (si se hace el paso 2) las importaciones de admin.ts.

## Flujo
Plan → **Codex audita el plan** (money-path) → GO → implementar → **Codex audita código** → GO → PR →
**CodeRabbit** (ya con créditos) → merge → `convex deploy`. Sin tests simulados.
