# OBS-3b — Tabla `engine_events` (hitos persistidos del motor)

## En una frase

OBS-3 dejó logs estructurados (`elog`) en el money-path, pero son **efímeros** (solo visibles en el
dashboard de Convex). `engine_events` persiste un **subconjunto de hitos críticos** en una tabla
consultable, histórica y agregable → cimiento del "panel de verdad" (Fase 2 del plan de mejoras:
"último arm y estado", "última reconciliación", "error/kind si blocked").

## Por qué ahora

- OBS-3 (PRs #81/#82/#83) ya instrumentó el motor de extremo a extremo con `elog`. Los call-sites de
  hitos ya están identificados; `engine_events` reutiliza esos MISMOS puntos, persistiendo solo los
  importantes (no todos).
- Habilita los paneles por bot / por arm sin re-derivar estado: una query lee los últimos eventos.

## EL RIESGO CENTRAL (a diseñar con cuidado) — escritura en money-path

`elog` es `console.log`: side-effect-free, **no puede abortar** una transacción. `engine_events` es un
`ctx.db.insert` → en Convex va DENTRO de la transacción de la mutation. Esto implica dos cosas:

1. **Consistencia (a favor):** si la mutation hace rollback, el evento también → nunca queda un evento
   de un efecto que no ocurrió. Esto es DESEABLE y es exactamente el modelo que ya usa `admin_logs`
   (OBS-1, `writeAdminLog` inserta dentro de la mutation admin, con GO de Codex por atomicidad).
2. **Riesgo (en contra):** si el `insert` fallara (schema mismatch, validación), ABORTARÍA la mutation
   de trading. `elog` no podía; esto sí. → La mitigación es de DISEÑO, no de runtime:
   - Helper `recordEngineEvent(ctx, fields)` que SOLO acepta escalares (igual que `elog`) e inserta una
     fila de forma trivialmente segura (sin lógica, sin lecturas, sin objetos).
   - El esquema de la tabla usa `v.optional` en todo lo no esencial → un campo de más nunca rompe.
   - Se persiste un SUBCONJUNTO mínimo de hitos (ver abajo), no cada `elog` → poca superficie.
   - **Decisión a validar por Codex:** ¿transaccional (como `admin_logs`) o desacoplado vía
     `ctx.scheduler.runAfter(0, internal.engineEvents.record, {...})`? Recomendación: **transaccional**,
     por consistencia con el efecto y coherencia con `admin_logs`; el desacople añade complejidad y
     rompe la garantía "no event sin efecto". Codex decide el trade-off.

## Esquema propuesto (`convex/schema.ts`)

```ts
// (OBS-3b) Hitos persistidos del motor money-path. Escalares no sensibles (mismo contrato que elog).
// Inserción transaccional desde recordEngineEvent dentro de las mutations del motor.
engine_events: defineTable({
  scope: v.string(),     // "exec" | "arm" | "rearm" | "coverage" | "hl"
  event: v.string(),     // "transition" | "blocked" | "rearm_outcome" | "emergency_close" | ...
  at: v.number(),        // Date.now()
  botId: v.optional(v.id("bots")),
  armId: v.optional(v.id("trigger_arms")),
  requestId: v.optional(v.id("execution_requests")),
  userId: v.optional(v.id("users")),
  fromStatus: v.optional(v.string()),
  toStatus: v.optional(v.string()),
  reason: v.optional(v.string()),   // enum/categoría (closeReason, gate, kind) — NUNCA string crudo del SDK/error
})
  .index("by_at", ["at"])                  // poda + feed admin global
  .index("by_bot_at", ["botId", "at"])     // panel por bot
  .index("by_arm_at", ["armId", "at"]),    // panel por arm
```

PROHIBIDO en la tabla (igual que `elog`): claves, `tradingAccountAddress`, payloads/respuestas del SDK,
mensajes de error crudos. Solo ids/estados/enums.

## Helper (`convex/engineEvents.ts`)

- `recordEngineEvent(ctx: MutationCtx, e: {scope, event, ...escalares})` → un solo `ctx.db.insert`.
- Cuidado TS2589: si arrastra el grafo `api`, tipar el ctx de forma ligera (`{ db: DatabaseWriter }`)
  como se hizo en `coverageUsage.ts` (ReadCtx). Validar con `npm run typecheck`.
- NO es un módulo HOJA puro como `log.ts` (necesita `ctx.db`), pero no debe importar `internal`/`api`.

## Hitos a persistir (SUBCONJUNTO de los elog — solo lo que alimenta el panel)

NO se persiste cada `elog` (sería ruido y filas de más). Solo los hitos de valor para diagnóstico:

- **arm:** `transition` a estados clave (filled, protected, closed, failed, armed_lower_only) con
  `closeReason`; `submitting_blocked`/`gate_before_order` bloqueado (reason). NO `reserved`/`submitting`
  de cada intento.
- **exec:** `transition` a entry_filled/protected/closed/failed; `gate_before_order` bloqueado.
- **rearm:** `outcome` (outcome/kind) — reusa el punto de `recordRearmOutcome` (PR1).
- **coverage:** `cap_rejected` (sin montos sensibles: pool/plan).
- **hl:** `emergency_close` (cierre de capital real). Opcional: `order_result` rejected/filled.

Regla: una fila por hito, NUNCA dentro de un bucle caliente ni por tick de reconcile.

## Retención / poda (evitar crecimiento ilimitado)

- Cron diario `pruneEngineEvents` que borra filas con `at < now - RETENTION_MS` (p.ej. 30 días), por
  lotes con el índice `by_at`. Envuelto en `withCronHealth` (OBS-2) → su fallo nunca afecta money-path.
- Decisión a validar: retención en días y tamaño de lote.

## Query admin (`convex/engineEvents.ts`)

- `listEngineEvents({ botId?, armId?, limit })` con `requireAdmin` (como `listRecentExecutions`).
  Lee por `by_bot_at`/`by_arm_at`/`by_at` en orden desc. Sin datos sensibles (la tabla ya es segura).

## Verificación

- `npm run typecheck`.
- Confirmar por diff que `recordEngineEvent` NO cambia ninguna condición/gate (solo añade el insert
  junto a los `elog` ya existentes).
- Revisar que ningún campo persistido es sensible.

## Troceo (un PR, es pequeño)

Tabla + helper + call-sites + cron de poda + query admin caben en UN PR (no toca lógica de trading,
solo añade inserts junto a los elog ya auditados). La UI del panel (Fase 2) es un PR aparte que
consume `listEngineEvents` — NO entra aquí.

## Flujo

plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → merge. Money-path-adjacent:
auditoría centrada en "¿el insert puede abortar una mutation de trading?" y "¿algún campo es sensible?".
