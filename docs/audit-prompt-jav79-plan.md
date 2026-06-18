# Prompt de auditoría Codex — JAV-79 PLAN (optimizar consumedCoverageByPool, MONEY-PATH)

Eres un auditor senior de código money-path. Audita el **PLAN** `docs/plan-jav79-coverage-optim.md`
(aún NO hay código). Contexto: Quantum.ia, portal de bots de cobertura sobre Hyperliquid; el motor
mueve capital real (mainnet beta). Este cambio toca el cálculo que decide si una nueva reserva/orden
cabe dentro del tope de cobertura del plan del usuario → correctitud = dinero.

**Problema:** `convex/coverageUsage.ts:consumedCoverageByPool` (líneas 26-63) hace `collect()` de
TODAS las filas de `trigger_arms` y `execution_requests` del usuario (índice `by_user_created`,
solo `userId`), incluidas terminales, y filtra los terminales EN MEMORIA. Corre en el path crítico
de `reserveArm`/`reserveExecution` y en los gates de envío (`coverageAdmissible`), 6 call-sites +
lectura admin (`admin.ts:168`). Con historial grande → latencia y abortos OCC.

**Tesis del plan (Opción A, recomendada):** añadir índice compuesto `by_user_status`
(`["userId","status"]`) en ambas tablas y, en `consumedCoverageByPool`, sustituir el `collect()`
de historial por un bucle sobre los ESTADOS VIVOS, consultando cada uno por índice y acumulando en
el mismo `Map<poolId, hedgeMax>`. El resultado debe ser IDÉNTICO al actual (mismas filas, misma
agregación max, mismos throws `[blocked_config]`); solo cambia CÓMO se obtienen. `status` sigue
siendo la única fuente de verdad → cero estado derivado que mantener (a diferencia de las opciones
B flag booleano / C snapshot, descartadas por riesgo de drift money-path).

**Estados (del schema):**
- `trigger_arms` (12): terminales `disarmed/closed/failed` → 9 vivos.
- `execution_requests` (8): terminales `closed/failed` → 6 vivos.

Archivos clave: `convex/coverageUsage.ts` (`consumedCoverageByPool`, `assertWithinPlanCoverage`,
`coverageAdmissible`, sets `ARM_TERMINAL`/`EXEC_TERMINAL`), `convex/schema.ts` (defs + índices de
`trigger_arms`/`execution_requests`), call-sites en `convex/triggerArms.ts` (250/357/394),
`convex/executions.ts` (177/304/453), `convex/admin.ts` (168).

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Presiona especialmente:

1. **Equivalencia EXACTA de resultado:** ¿el algoritmo nuevo (unión de queries por estado vivo)
   produce el MISMO `Map` que el actual (collect + filtro) para TODO caso? ¿Algún estado vivo que
   el plan omita de `ARM_LIVE`/`EXEC_LIVE`? ¿`unknown` (vivo en ambas) entra correctamente? ¿Riesgo
   de contar de menos (lado peligroso: dejaría pasar reservas por encima del tope)?

2. **Estado nuevo sin clasificar:** la salvaguarda propuesta es derivar `LIVE = ALL − TERMINAL` para
   que un estado futuro caiga por defecto en "vivo" (fail-closed). ¿Es implementable de forma robusta
   en Convex sin enumerar a mano? Con índice por estado, un estado vivo NO listado NO se leería →
   ¿cómo garantizar que `LIVE` siempre cubra todos los no-terminales? ¿Conviene en su lugar un test/
   assert que falle si `LIVE ∪ TERMINAL ≠` el set del schema?

3. **Coste de N queries:** 9 + 6 = 15 lecturas indexadas por llamada, y `consumedCoverageByPool` se
   invoca en cada reserva y en cada gate de envío. ¿Es realmente mejor que el `collect()` único en
   términos de bytes leídos / contención OCC en una mutation? ¿Hay un punto en que 15 queries pequeñas
   sean peores que 1 grande? ¿El índice `by_user_status` reduce el conflicto de escritura OCC o lo
   agrava (más rangos de índice tocados)?

4. **Consistencia transaccional:** dentro de una mutation, las 15 queries ven un snapshot consistente
   (igual que el collect). Confírmalo. ¿Algún riesgo de leer una fila a mitad de transición entre dos
   queries por-estado (doble conteo o cero conteo de la misma fila)? ¿Importa, dado que es la misma
   transacción?

5. **Idempotencia del gate (max por pool):** hoy `assertWithinPlanCoverage` hace
   `post.set(key, max(existente, hedge))` para no doble-contar en el gate de envío (la fila ya está
   viva y contada). Con el nuevo conteo, ¿se preserva exactamente esa semántica idempotente?

6. **Índices/migración:** ¿añadir `by_user_status` es seguro (backfill automático, sin migración de
   datos)? ¿Choca con índices existentes (`by_user_created`, `by_bot_status`, `by_status_updated`,
   `by_status_created`)? ¿Conviene reusar alguno en vez de crear uno nuevo?

7. **Alcance / CLAUDE.md:** ¿el plan respeta "no mezclar refactor amplio con lógica de trading" y
   toca solo lo necesario (coverageUsage.ts + 2 índices)? ¿Prioridad correcta (Low, diferible)?

Cita líneas del plan. Si NO-GO, lista EXACTAMENTE qué cambiar para el GO.
