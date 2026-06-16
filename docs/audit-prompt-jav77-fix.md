# Prompt de auditoría Codex — JAV-77 FIX (cascada TS2589 + limpieza), MONEY-PATH

Eres un auditor senior de código money-path. Contexto: Quantum.ia, portal de bots de cobertura sobre
Hyperliquid; el motor coloca triggers nativos y mueve capital real (mainnet beta). El commit anterior
`1354cc2` (JAV-77, hard-cap por plan, Modelo B) **ya pasó tu auditoría de plan (GO rev.4)** y la
auditoría de su LÓGICA de enforcement no es objeto de este pase. **NO re-audites la semántica del
hard-cap.** Audita ÚNICAMENTE el commit de arreglo `7cd3a46`, que es un **compile-fix + limpieza**, no
lógica money-path nueva.

Diff a auditar: `docs/audit-jav77-fix.diff` (salida de `git show 7cd3a46`).

## Qué hace el commit `7cd3a46`

`1354cc2` rompía `npm run typecheck` con **281 errores TS2589** ("type instantiation is excessively
deep") en cascada por todo el backend Convex. Causa raíz diagnosticada por bisect: `1354cc2` añadió
`ctx.runAction(internal.actions.poolScanner.fetchPositionNotionalStrict, …)` dentro de la action
`executePerpMarketOrder` (hyperliquid.ts), cuyo handler NO tenía anotación de retorno → el tipo de
retorno inferido cruzó el límite de profundidad-100 del grafo `internal`/`api` y reventó de forma
difusa (errores en migrations.ts, seed.ts, etc., archivos que ni tocan el cambio).

Cambios del commit (todos pretenden ser **behavior-preserving**):

1. **Anotaciones `: Promise<any>`** en los handlers que encadenan llamadas `internal.*` (patrón ya
   usado en `triggerEngine.armPoolBotEntry`/`armBotInternal`):
   - hyperliquid.ts: `executePerpMarketOrder`, `reconcileExecution`.
   - executions.ts: `reserveExecution`, `markSubmitting`, `gateBeforeOrder`.
   - triggerArms.ts: `reserveArm`, `markArmSubmitting`, `gateArmBeforeOrder`.
2. **coverageUsage.ts**: el `ctx` de los 3 helpers (solo-lectura) pasa de `MutationCtx` a un tipo
   estructural `ReadCtx = { db: DatabaseReader }` (para no arrastrar `runQuery/runMutation/api`).
3. **plans.ts** (NUEVO módulo HOJA): catálogo `PLAN_IDS`/`PLANS`/`getPlan`/tipos `PlanId`/`Plan`
   movido literalmente desde subscriptions.ts. `subscriptions.ts` lo importa y lo **re-exporta**
   (`export { PLAN_IDS, PLANS, getPlan }; export type { PlanId, Plan }`). coverageUsage.ts ahora
   importa `getPlan` de `./plans`.
4. **BotPortal.jsx**: elimina el componente `ExecutionLimitsPanel` y su uso (límites beta $500/$2k ya
   retirados del backend en `1354cc2`).
5. `convex/_generated/api.d.ts` regenerado (registra `plans`/`coverageUsage`, quita `executionLimits`).

Verificado por mí: `npm run typecheck` 0 errores; `vite build` OK; sin referencias colgantes a
`ExecutionLimitsPanel`/`getExecutionLimits`/`setMaxNotionalPerOrder`/`setMaxNotionalPerUserDaily`.

## Responde GO / NO-GO con hallazgos numerados (ALTO/MEDIO/BAJO). Presiona en:

1. **`Promise<any>` y seguridad**: ¿la anotación oculta algún error real del CUERPO de esos handlers?
   (TS sigue chequeando el cuerpo, solo deja de inferir el retorno). ¿Algún CALLER de estos 8
   handlers dependía del tipo de retorno inferido para una comprobación de tipo que ahora se pierde
   (p.ej. el consumidor de `reserveExecution.appliedLeverage`, `gate*` que devuelven flags)? Enumera
   los call-sites y si alguno se vuelve `any` de forma peligrosa en money-path.
2. **Equivalencia del catálogo (plans.ts)**: ¿`PLANS`/`getPlan`/`PLAN_IDS` y los tipos son IDÉNTICOS
   a los que había en subscriptions.ts (mismos ids, `coverageCapUsd`, `priceUsd`, orden, semántica de
   `getPlan` con `hasOwnProperty`)? ¿El re-export rompe algún importador existente de
   `./subscriptions`? ¿`schema.ts` (`users.subscriptionPlan` union) sigue coherente con `PLAN_IDS`?
3. **`ReadCtx` en coverageUsage**: ¿pasar `MutationCtx` donde se espera `{ db: DatabaseReader }`
   compila por compatibilidad estructural y NO cambia comportamiento? ¿`DatabaseReader` da acceso a
   todo lo que usan los 3 helpers (`ctx.db.get`, `ctx.db.query(...).withIndex(...).collect()`)? ¿Se
   pierde alguna garantía al no usar el ctx de escritura (los helpers no escriben, confírmalo)?
4. **Eliminar `ExecutionLimitsPanel`**: ¿queda código muerto, import sin usar, o se perdió alguna
   funcionalidad admin que NO esté ya cubierta por el hard-cap por plan? ¿El AdminPanel sigue
   renderizando bien sin ese bloque?
5. **El fix NO tocó lógica de enforcement**: confirma que el diff NO altera ninguna validación de
   cap/plan/margen/gates más allá de la anotación de tipo (las líneas de lógica deben ser idénticas
   salvo la firma `=> {` → `): Promise<any> => {`).
6. **¿Anotación insuficiente o de más?**: ¿hay otros handlers que encadenan `internal.*` y siguen sin
   anotar (riesgo de re-romper TS2589 al siguiente cambio)? ¿O alguna anotación `Promise<any>` es
   innecesaria? (`npm run typecheck` da 0; el objetivo es robustez futura, no solo pasar hoy).
7. **codegen / api.d.ts**: ¿el `api.d.ts` commiteado coincide con lo que produce `convex codegen`
   (no quedó desincronizado)?

Cita líneas del diff. Si NO-GO, lista EXACTAMENTE qué cambiar. Tras el GO: merge → `node
node_modules/convex/bin/main.js deploy` (type-check real) → verificar `HL_NETWORK=mainnet`.
