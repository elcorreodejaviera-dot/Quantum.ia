# Prompt de auditoría Codex — CÓDIGO de OBS-3b (`engine_events`)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de OBS-3b para Quantum.ia (portal de bots sobre
Hyperliquid, capital real). El plan ya tiene tu GO. Persiste un subconjunto de hitos del motor en la
tabla nueva `engine_events` para el panel admin. SOLO observación: sin cambiar ninguna decisión.

Revisa el diff (rama basada en `master`):

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/obs3b-engine-events -- convex/
```

Verificación ya hecha: `npm run typecheck` EXIT 0. Diff: 73 inserciones, 0 eliminaciones + `engineEvents.ts` nuevo.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Decisiones de implementación
tomadas (confírmalas o recházalas):

## Decisiones a validar

1. **`recordEngineEvent` es BEST-EFFORT (try/catch), no transaccional-estricto (CRÍTICO).** El plan
   barajaba transaccional puro (como `admin_logs`). Implementé el insert envuelto en try/catch dentro de
   la mutation: sigue DENTRO de la transacción (si la mutation hace rollback, el evento también → no hay
   evento sin efecto), pero un fallo INESPERADO del insert NO puede abortar la mutation de trading. La
   asimetría lo justifica (perder un evento = 0 coste; abortar un trade = mucho). ¿Apruebas, o prefieres
   transaccional-estricto sin catch (que admin_logs usa)? ¿El catch puede enmascarar un bug de schema
   que typecheck no atrape?

2. **¿Puede `engine_events` abortar una mutation de trading? (CRÍTICO).** Esquema: todos los campos
   opcionales salvo scope/event/at; ids tipados `v.id(...)`. Helper sin lecturas ni lógica (solo
   `ctx.db.insert`). ¿Algún modo de fallo del insert que escape al try/catch y aborte? ¿Algún `v.id`
   debería ser `v.string` para no acoplar la validación a la existencia del doc?

3. **Sin secretos (CRÍTICO, campo por campo).** Recorre los 6 call-sites + el internalMutation `record`.
   Solo deben aparecer: ids (botId/armId/requestId/userId), `fromStatus`/`toStatus` (enums de estado),
   `reason` (closeReason/outcome/kind/`coin:flat` — categorías/símbolos). En `emergency_close`,
   `reason` lleva el símbolo del activo (`BTC`), NO sensible. Confirma que NADA lleva claves, direcciones,
   payloads del SDK ni strings de error crudos. (En `exec transition` deliberadamente NO se persiste
   `args.error`, igual que en el log de OBS-3.)

4. **Cero cambio de control de flujo.** Cada `recordEngineEvent` va DESPUÉS del `ctx.db.patch` de la
   transición y del `elog` ya existente. 0 líneas eliminadas. ¿Algún `await` reordenó algo o cambió la
   atomicidad/fencing? Mira `applyTransition` (executions), `settleArm`/`closeArmAndScheduleRearm`/
   `transitionToArmedLowerOnly` (arms), `recordRearmOutcome` (rearm).

5. **`emergency_close` desde un ACTION (hyperliquid.ts).** Es el único hito en un action (no mutation):
   persiste vía `ctx.runMutation(internal.engineEvents.record, …)` envuelto en try/catch → su fallo
   nunca afecta el cierre de capital real. ¿Correcto? ¿La llamada añade latencia donde importe? (Va
   DESPUÉS del aplanado y la re-lectura, no en la ruta de envío.)

6. **Subconjunto de hitos.** Se persisten transiciones exec/arm + rearm_outcome + emergency_close. Los
   bloqueos de gate NO se persisten por separado porque, cuando terminalizan, ya fluyen como transición
   a `failed` (persistida). `cap_rejected` (coverageUsage, ctx ReadCtx no-writer) NO se persiste, y los
   `reserved`/`submitting` de cada intento tampoco (ruido). ¿De acuerdo con el corte?

7. **Poda + índices.** Cron diario `prune engine events` → `pruneEngineEvents` (lotes de 500 con
   `by_at`, retención 30d), envuelto en `withCronHealth` (OBS-2). Índices `by_at`/`by_bot_at`/
   `by_arm_at`. `listEngineEvents` (admin) usa esos índices en orden desc. ¿Riesgo en la poda (borrado
   masivo, competencia con escrituras)? ¿`take(500)` por ejecución drena el backlog a 1/día?

## Nota
La UI del panel (Fase 2) que consume `listEngineEvents` es un PR aparte — NO entra aquí.
