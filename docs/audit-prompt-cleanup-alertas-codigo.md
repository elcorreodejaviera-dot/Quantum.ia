# Audit de código — Limpieza backend de alertas (Plan A)

Sos Codex revisando un cambio **solo-backend, de borrado** antes de hacer commit/PR.
Quiero un veredicto **GO / NO-GO** con hallazgos accionables.

## Contexto

El **panel de Alertas del portal** se quitó del frontend (PR #134, mergeado y desplegado a prod
2026-06-27). Tras eso, el backend de alertas quedó **huérfano** (nadie llama esas funciones). Este cambio
limpia ese backend muerto.

## Qué se borra

### `convex/alerts.ts` — ELIMINADO completo (71 líneas)
5 funciones huérfanas, ninguna referenciada tras quitar el frontend:
`listAlerts`, `createAlert`, `deleteAlert`, `recordAlertTrigger`, `listAlertHistory`.

### `convex/schema.ts` — tabla `alerts` ELIMINADA
```diff
-  alerts: defineTable({
-    userId: v.id("users"),
-    alertType: v.union(v.literal("out_of_range"), v.literal("apy_below"), v.literal("price_cross")),
-    pair: v.string(),
-    network: v.optional(v.string()),
-    threshold: v.optional(v.number()),
-    active: v.boolean(),
-    lastTriggeredAt: v.optional(v.number()),
-  })
-    .index("by_userId", ["userId"]),
-
   alert_history: defineTable({   // <-- SE CONSERVA
```
En Convex, quitar una tabla del schema **no falla el deploy**: orfanata los docs existentes (no los borra).
Aceptable: la tabla `alerts` solo tenía suscripciones de usuario del panel ya retirado.

### `convex/_generated/api.d.ts`
Regenerado por `convex codegen`: desaparece el import de `alerts.js`.

## Qué se CONSERVA a propósito
- Tabla **`alert_history`** + su índice `by_user_timestamp`.
- **`emitSpotGridErrorAlert`** (`convex/spotGridBots.ts:97`) + sus 3 callers (`:529, :666, :701`) +
  helpers `redactSecrets` / `SPOT_GRID_ERR_MSG_CAP`. Es la notificación de error del Spot Grid
  (JAV-94 / JAV-122) que escribe en `alert_history` y se consulta en el dashboard de Convex.

## Verificación previa (mapeo de referencias)
- `grep` confirmó que `convex/alerts.ts` solo se referenciaba a sí mismo + el autogenerado `api.d.ts`.
- La tabla `"alerts"` solo se usaba dentro de `alerts.ts` (query/insert/v.id) y su definición en `schema.ts`.
  Sin crons, sin admin, sin otros módulos.
- `alerts.ts` NO estaba en el allowlist de `tests/convexHarness.ts`. Ningún test llama `api.alerts.*`
  (los tests de JAV-94/JAV-122 consultan `alert_history` directo por `ctx.db`, que se conserva).
- `alert_history` se escribía desde 2 lugares: el `recordAlertTrigger` que se borra (parte del panel
  retirado) y `emitSpotGridErrorAlert` que se conserva. El schema de `alert_history` ya tiene
  `alertType: v.string()`, compatible con lo que escribe el Spot Grid.

## Resultado de la verificación local
- `convex codegen` OK; `alerts` ya no aparece en `_generated/api.d.ts`.
- `npm run typecheck` → 0 errores.
- `npm test` → **286/286** tests OK (18 archivos).

## Qué quiero que verifiques
1. ¿Queda algún caller real de las 5 funciones borradas o de la tabla `alerts` que se me haya pasado
   (frontend, crons, http, otros módulos, migraciones)?
2. ¿Es seguro conservar `alert_history` exactamente como está dado que su único escritor restante es
   `emitSpotGridErrorAlert`? ¿Algún campo/índice del schema de `alert_history` quedó dependiendo de algo
   que borré?
3. ¿Riesgo del deploy de Convex al quitar la tabla `alerts` (orfanato de docs) en prod? ¿Algo más limpio?
4. ¿Algún `v.union`/tipo compartido que vivía en `alerts.ts` y se use en otro lado?

Respondé **GO** o **NO-GO** con hallazgos.
