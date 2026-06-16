# Prompt de auditoría Codex — JAV-77 PLAN (Enforcement hard-cap, MONEY-PATH)

Eres un auditor senior de código money-path. Audita el **PLAN**
`docs/plan-jav77-enforcement-hardcap.md` (aún NO hay código). Contexto: Quantum.ia, portal de bots de
cobertura sobre Hyperliquid; el motor coloca triggers nativos y mueve capital real (mainnet beta).
JAV-77 introduce un **hard-cap por plan de suscripción** y elimina los límites beta $500/$2.000.

**Semántica acordada (Modelo B):** el cap (`coverageCapUsd`) limita la COBERTURA DE POOLS
(`Σ hedgeNotionalUsd` = liquidez LP sin buffer, dedupe por pool), NO el nocional con buffer.

Archivos clave existentes: `convex/triggerArms.ts` (`reserveArm`, OCC, gates de margen/daily
líneas ~215-238), `convex/triggerEngine.ts` (`armBotInternal`, sizing líneas ~224-225),
`convex/executions.ts` (`reserveExecution`, `committedMarginForAccount`, `dailyNotionalUsed`),
`convex/subscriptions.ts` (`getSubscriptionForUserInternal`, catálogo `PLANS`),
`convex/executionLimits.ts` (límites beta), `convex/triggerRearm.ts` (auto-rearm, leases/fencing).

**rev.3** incorpora ya tus hallazgos: D1/D4 cerradas; fórmula POST-operación por pool con `max` y
`poolId` en `execution_requests`; hedge legacy vía `fetchPositionNotionalStrict`; **SIN fallback
estimado** (el helper LANZA fail-closed ante filas vivas sin `hedgeNotionalUsd`/`poolId`);
revalidación in-flight en `markArmSubmitting`/`markSubmitting` + drain/backfill pre-deploy (§6); helper
en `convex/coverageUsage.ts`.
**rev.4** añade: revalidar la Regla de admisión también en el GATE FINAL `gateArmBeforeOrder`/
`gateBeforeOrder` (ventana `updateLeverage`→`exchange.order`); y terminalización EXPLÍCITA del in-flight
bloqueado (arm/ejecución → `failed`, libera margen/cap, sin reintento ciego del auto-rearm).
Re-audita el plan rev.4: ¿GO para implementar código?

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Presiona especialmente:

1. **Fail-closed**: ¿algún camino arma SIN validar plan/suspensión/cap? (manual, auto-rearm del cron,
   doble-fill OCO, reentry_coexist). ¿El gate está DENTRO de la misma transacción OCC que crea la
   generación (no en una action previa que pueda quedar desfasada)?
2. **Atomicidad/carreras**: dos armados concurrentes del mismo usuario podrían cada uno leer
   `consumido` sin ver al otro y superar el cap juntos. ¿La OCC de Convex (lecturas registradas)
   aborta uno? ¿Hay que leer los arms vivos dentro de la mutation para que cuente como conflicto?
3. **Dedupe por pool (Modelo B)**: ¿la fórmula `consumidoOtros + aporte` cuenta bien cuando el mismo
   pool tiene varios bots/compromisos? ¿Y al re-armar el mismo bot (su arm previo terminal)? ¿Riesgo
   de doble conteo o de hueco que permita exceder?
4. **D1 (legacy `reserveExecution`)**: ¿es seguro dejar el path legacy sin cap en este PR? Si un
   usuario tiene ejecuciones manuales vivas, ¿se escapan del tope? Recomienda incluir o no.
5. **D2 (fallback `hedgeNotionalUsd ?? reservedNotional`)**: ¿es realmente conservador (bloquea de
   más, nunca de menos)? ¿`reservedNotional` (con buffer y 2× en OCO) sobre-cuenta tanto que rompe
   armados legítimos? ¿Mejor backfill/migración?
6. **Eliminar $500/$2k**: ¿qué se rompe? Enumera TODAS las referencias a `getLimit`/`LIMIT_DEFAULTS`/
   `maxNotionalPerOrder`/`maxNotionalPerUserDaily` (backend + AdminPanel UI) y si quitarlas deja
   código muerto o type-errors. ¿Algún invariante de seguridad dependía del límite por orden?
7. **suspended en auto-rearm**: ¿el bloqueo se mapea al `[kind]` correcto en `triggerRearm.ts` para
   no reintentar para siempre ni perder el trabajo durable?
8. **Fuente única**: ¿se respeta que `totalNotional`/sizing no se duplica y que `hedgeNotionalUsd` es
   la única unidad de cobertura?
9. **Schema**: `trigger_arms.hedgeNotionalUsd` opcional legacy-safe; ¿afecta a arms vivos en prod?

Cita líneas del plan. Si NO-GO, lista EXACTAMENTE qué cambiar.
