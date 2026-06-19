# Prompt de auditoría Codex — OBSERVABILIDAD (3 planes a la vez): OBS-1, OBS-2, OBS-3

Eres un auditor senior. Audita TRES planes de observabilidad (aún sin código) para Quantum.ia,
portal de bots de cobertura sobre Hyperliquid con capital real (mainnet beta). Los tres son
**additivos / NO money-path-logic** (solo observan), pero OBS-3 toca archivos money-path al
instrumentar, así que vigila que NINGUNO cambie una decisión de trading.

Planes a auditar:
- `docs/plan-obs1-admin-audit.md` — auditoría server-side de acciones admin (completar `admin_logs`).
- `docs/plan-obs2-cron-health.md` — health/heartbeat de los 6 crons (tabla `cron_health` + wrapper).
- `docs/plan-obs3-engine-logging.md` — logging estructurado en el money-path (helper `elog`).

Contexto verificado en código:
- `admin_logs` (`schema.ts:266`) lo escribe SOLO `logAdminAction` (`systemConfig.ts:9`), invocado
  ÚNICAMENTE por el frontend (`BotPortal.jsx:3681`) para `kill_switch`. Las mutations admin
  sensibles (`setTradingEnabled`/`setSimulationMode` en systemConfig.ts:65,49;
  `setSubscriptionPlan`/`setUserSuspended` en subscriptions.ts:99,115; grant/revoke en users.ts via
  `grantPermission`/`revokePermission`) NO registran nada server-side.
- 6 crons (`crons.ts`), 3 de ellos money-path a 1/min (`reconcileStaleExecutions`,
  `reconcileStaleArms`, `processRearms`); ninguno registra last-run/error.
- ~6 `console.*` en todo el motor (triggerEngine 4, executionsCron 1, hlCredentialActions 1).

Responde, **para cada plan por separado**, **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO),
y al final un veredicto de orden de implementación. Presiona en:

## OBS-1 (admin audit)
1. **Atomicidad:** ¿registrar dentro de la misma mutation garantiza que el log y el efecto se
   confirman juntos (Convex transaccional)? ¿Algún camino donde la acción ocurra y el log no, o
   viceversa?
2. **`grantPermission`/`revokePermission` compartidos:** instrumentar ahí cubre las 4 mutations.
   ¿Se captura `prev` ANTES del patch? ¿`permission` y `targetUserId` quedan bien en `meta`?
3. **Datos sensibles en `meta`:** ¿el plan evita loguear claves/credenciales/PII? ¿`userId` =
   clerkId del admin es coherente con el esquema actual (`admin_logs.userId: v.string()`)?
4. **Kill-switch cliente:** quitar la llamada `logAdminAction({kill_switch})` del front y confiar en
   el log server-side de `setTradingEnabled` — ¿se pierde algún matiz (p.ej. distinguir kill-switch
   de un toggle normal)? ¿Conviene un `action` distinto o un campo en `meta`?

## OBS-2 (cron health)
5. **No tragar errores:** el wrapper registra el error y RE-LANZA. ¿El plan lo deja explícito en los
   6 crons? ¿Algún cron donde envolver cambie el comportamiento de reintento/scheduling de Convex?
6. **Actions vs mutations:** registrar vía `ctx.runMutation(internal.cronHealth.*)` desde actions y
   directo desde mutations. ¿Correcto? ¿Las escrituras de health compiten/contienden con el cuerpo
   del cron (OCC) en la misma tabla money-path? (Son tablas distintas → no debería.)
7. **Helper `withCronHealth`:** ¿es viable un único wrapper sin romper los tipos de cada
   internal action/mutation? ¿O hay que instrumentar a mano por las firmas?
8. **Semántica "atrasado":** `lastSuccessAt > 2× intervalo` como ⚠️ — ¿razonable? ¿`consecutiveFailures`
   se resetea SOLO en éxito?

## OBS-3 (engine logging)
9. **Riesgo de cambio de lógica (CRÍTICO):** instrumentar executions/hyperliquid/triggerEngine/
   triggerArms/triggerRearm/coverageUsage — ¿el plan garantiza que `elog` NUNCA altera control de
   flujo (no en condiciones, no en short-circuits, no captura/descarta excepciones)?
10. **Secretos en logs:** ¿el plan prohíbe explícitamente loguear claves privadas, ciphertext,
    credenciales? ¿Algún campo propuesto (cloid, ids, leverage) es sensible?
11. **Volumen:** una línea por transición, no por iteración de bucle. ¿El plan acota el volumen en
    los crons que escanean muchas filas?
12. **Alcance/troceo:** ¿conviene partir OBS-3 por módulo para PRs pequeños? ¿La tabla opcional
    `engine_events` debe quedar fuera de la fase 1?

## Transversal
13. **CLAUDE.md:** "No mezclar refactor amplio con lógica de trading" y la descomposición preferida
    (análisis → UI → tests → backend safety → feature). ¿Los tres planes respetan no mezclar
    observabilidad con cambios de trading? ¿El orden 1→2→3 es el correcto por valor/riesgo?
14. **Alcance mínimo:** ¿algún plan se excede (sobre-ingeniería)? ¿Algo que recortar para la v1?

Cita líneas de cada plan. Para cada uno: si NO-GO, lista EXACTAMENTE qué cambiar para el GO.
