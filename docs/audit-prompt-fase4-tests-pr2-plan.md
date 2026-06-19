# Prompt de auditoría Codex — PLAN de Fase 4 PR2 (RE-GO tras NO-GO)

Eres un auditor senior. En tu auditoría anterior diste **NO-GO** con 3 MEDIO + 2 BAJO. El plan fue
REVISADO para cerrarlos. Verifica que cada uno quedó resuelto y emite GO/NO-GO.

Cierres aplicados (confírmalos contra el plan):
- **MEDIO#1 (glob frágil):** registro de módulos con EXCLUDES explícitos (regex que descarta
  hyperliquid/hlCredentialActions/triggerEngine/adminLive/crons/*Cron y `/actions/`); cierre
  mutation-safe enumerado. Ver §Tooling.
- **MEDIO#2 (closeReason):** cierres válidos de arm SIEMPRE con `closeReason`; test negativo explícito
  `protected → closed` sin `closeReason` = no-op. Ver §2.
- **MEDIO#3 (invocar committedMargin):** vía test-only `t.run((ctx) => committedMarginForAccount(ctx,
  accId))`, sin wrapper productivo. Ver §3.
- **BAJO#4 (trades_history exacto):** conteo antes/después; terminal inserta 1, repetir no duplica, no
  terminal no inserta. Ver §1.
- **BAJO#5 (fixtures):** `tests/fixtures.ts` con helpers de sembrado. Ver §Fixtures.
- **Extra:** caso de aislamiento por cuenta (otra `hlAccountId` no entra en la suma).

Auditas un PLAN (no hay código aún). Tests-only, sin tocar lógica de producción.

Lee el plan y el contexto:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
sed -n '1,200p' $R/docs/plan-fase4-tests-pr2.md
git -C $R show HEAD:convex/executions.ts | sed -n '42,110p'    # ALLOWED, FINAL_STATES, committedMargin
git -C $R show HEAD:convex/executions.ts | sed -n '335,376p'   # applyTransition + settleExecution
git -C $R show HEAD:convex/triggerArms.ts | sed -n '72,96p'    # ALLOWED_ARM, ARM_TERMINAL
```

Responde **GO / NO-GO del plan** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **¿convex-test es el camino correcto, o hay algo más simple?** El plan evita exportar
   `ALLOWED`/`ALLOWED_ARM` (tu recomendación en PR1) y prueba el comportamiento observable de las
   mutations contra una DB simulada. ¿De acuerdo? ¿O para las transiciones bastaría exportar SOLO los
   mapas (datos puros) y testearlos sin DB, aceptando esa mínima ampliación de superficie?

2. **Cobertura de invariantes de seguridad.** ¿Cubre lo crítico? terminal no resucita (FINAL_STATES /
   ARM_TERMINAL), `protected` no degrada a `sl_failed`, transición inválida = no-op, cuarentena N6 y
   fencing por token en `settleArm`. ¿Falta algún invariante peligroso (p.ej. que `applyTransition`
   registre `trades_history` EXACTAMENTE una vez por `historyRecorded`)?

3. **Riesgos de convex-test.** (a) entorno: puede requerir `edge-runtime`; el plan propone aislar por
   archivo para no romper los tests puros de PR1 (env node). (b) `import.meta.glob` debe EXCLUIR los
   módulos `"use node"` (hyperliquid.ts) que convex-test no carga. ¿Correcto el enfoque? ¿Algún otro
   módulo problemático (crons, actions)?

4. **Sembrado de fixtures.** Las filas (`execution_requests`/`trigger_arms`) deben cumplir el schema.
   ¿Riesgo de que un fixture mal formado haga pasar un test por la razón equivocada? ¿Conviene un helper
   de fixtures mínimo y explícito?

5. **Margen (committedMarginForAccount).** ¿Los casos cubren `marginReserved ?? notional` /
   `?? reservedNotional`, el invariante JAV-85 #1 (`armed_lower_only` cuenta), y la suma de ambos
   motores sin doble conteo? ¿Algún estado límite?

6. **Alcance/valor.** ¿Merece la pena la fricción de introducir convex-test ahora, o es mejor un PR2
   más pequeño (solo committedMarginForAccount, que ya está exportada) y dejar las state machines para
   después? Recomienda.
