# Prompt de auditoría Codex — CÓDIGO de Fase 4 PR2 (state machines + reservation, convex-test)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de Fase 4 PR2 para Quantum.ia: tests de los
invariantes que viven DENTRO de mutations (transiciones de estado + suma de margen) con `convex-test`.
El plan ya tiene tu GO. Tests-only: CERO cambios en `convex/` (solo se añade `convex-test` como
devDependency).

Revisa el diff:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/fase4-tests-pr2 -- package.json tests/ docs/
```

Verificación ya hecha: `npm test` → 56 verdes (25 leverage + 11 armErrors + 15 stateMachine + 5
reservation); `npm run typecheck` OK; `npm audit --audit-level=critical` VERDE.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **Registro de módulos seguro (Codex MEDIO#1, CRÍTICO).** `tests/convexHarness.ts`: `import.meta.glob`
   recibe un ARRAY de rutas literales (cierre mutation-safe: executions/triggerArms/triggerRearm/
   coverageUsage/leverage/log/engineEvents/helpers/plans/hlNetwork + `_generated/*.js` que convex-test
   exige para localizar la raíz). Un guard DENYLIST lanza si se cargara cualquier `"use node"`
   (hyperliquid/hlCredentialActions) o action/cron (triggerEngine/adminLive/crons/*Cron/cronHealth).
   ¿Es robusto el regex del denylist? ¿Se cuela algún módulo fuera de alcance?

2. **Tests CONGELAN el contrato, no lo cambian.** Prueban el comportamiento observable de
   `settleExecution`→`applyTransition` y `settleArm` contra una DB simulada. ¿Algún `expect` que fije
   un comportamiento equivocado? Recalcula los casos clave:
   - terminal (closed/failed) → cualquier estado = no-op (FINAL_STATES / ARM_TERMINAL).
   - `protected → sl_failed` = no-op (ALLOWED no lo permite); `protected → closed` = aplica.
   - arm `protected → closed` SIN closeReason = no-op (MEDIO#2); CON closeReason aplica.
   - fencing: token ajeno / lease vencido = no-op.
   - `trades_history` EXACTAMENTE una vez (terminal inserta 1 + historyRecorded; repetir no duplica;
     no-terminal no inserta) — BAJO#4.

3. **Reservation (committedMarginForAccount).** Se invoca vía `t.run((ctx) => committedMarginForAccount(
   ctx, accId))` (test-only, sin wrapper productivo; MEDIO#3). ¿Cubren bien: suma solo estados vivos,
   `marginReserved ?? notional` (exec), `armed_lower_only` cuenta (JAV-85 #1), suma de ambos motores, y
   AISLAMIENTO por cuenta (otra hlAccountId no entra)? ¿Algún estado límite que falte?

4. **Fixtures (BAJO#5).** `tests/fixtures.ts` con helpers de defaults válidos de schema + overrides
   pequeños. ¿Algún fixture mal formado que haga pasar un test por la razón equivocada? ¿Cubren los
   campos requeridos reales (creds con agentAddress/tradingAccountAddress, etc.)?

5. **Cero impacto producción / alcance.** El diff toca SOLO `package.json` (devDep convex-test), `tests/`
   y `docs/`. NADA de `convex/`. Sin spot grid. ¿Confirmado?

NOTA (Codex): los tests NO ejecutan rutas con scheduler/internal action. settleArm se prueba sin el
camino `failed + fromRearm` (que llamaría a rescheduleRearmIfEligible). Si un test futuro tocara
internal.triggerEngine, NO añadirlo a la allowlist (es "use node", fuera de PR2) sin re-auditar.
