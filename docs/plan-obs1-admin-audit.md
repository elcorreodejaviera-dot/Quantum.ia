# OBS-1 — Auditoría server-side de acciones admin (completar `admin_logs`)

## En una frase

Hoy las acciones admin sensibles (conceder permisos de trading, cambiar plan/tope, suspender,
apagar trading global) NO dejan rastro en el servidor. Solo el frontend reporta `kill_switch`,
de forma no autoritativa ni atómica. OBS-1 = registrar esas acciones DENTRO de cada mutation.

## Problema (verificado en código)

- `admin_logs` (`schema.ts:266`) existe: `{ userId: string, action: string, timestamp: number, meta? }`,
  índice `by_timestamp`. Lo lee el panel admin (`admin.ts:258`, `listActivity`).
- El ÚNICO escritor es `logAdminAction` (`systemConfig.ts:9`), y **solo lo invoca el frontend**
  (`BotPortal.jsx:3681`) para `action:'kill_switch'`. Implicaciones:
  - **No autoritativo:** el cliente decide si registra → un cliente con fallo/manipulado lo omite.
  - **No atómico:** el log va en una mutation separada del `setTradingEnabled` real → pueden divergir.
- Mutations admin sensibles que NO escriben en `admin_logs`:
  - `setTradingEnabled` / `setSimulationMode` (`systemConfig.ts:65,49`) — kill-switch/simulación global.
  - `setSubscriptionPlan` / `setUserSuspended` (`subscriptions.ts:99,115`) — plan/tope y suspensión.
  - `grantTradeLive` / `revokeTradeLive` / `grantManageBots` / `revokeManageBots` (`users.ts:223-238`,
    vía helpers `grantPermission`/`revokePermission`).

→ No hay traza server-side de quién dio permisos de trading real, cambió el tope de cobertura de
alguien, suspendió a un usuario o apagó el trading global. Hueco de auditoría en plataforma con dinero.

## Alcance (NO money-path; additivo — no cambia ninguna decisión de trading)

Registrar en `admin_logs`, DENTRO de cada mutation admin (atómico con el efecto), el `action`, el
admin que la ejecutó y el contexto antes/después. Sin tocar la lógica de trading ni los gates.

## Diseño

### 1. Helper interno reutilizable

En `helpers.ts` (o `systemConfig.ts`), un helper que reciba el `admin` ya resuelto (de `requireAdmin`)
para no duplicar la consulta de auth:

```ts
export async function writeAdminLog(
  ctx: MutationCtx, adminClerkId: string, action: string, meta?: unknown,
) {
  await ctx.db.insert("admin_logs", { userId: adminClerkId, action, timestamp: Date.now(), meta });
}
```

(`userId` = `clerkId` del admin, coherente con el `logAdminAction` actual y su comentario.)

### 2. Instrumentar cada mutation admin

Como `requireAdmin` ya devuelve el doc del admin, capturarlo y loguear con before/after:

| Mutation | action | meta sugerido |
|----------|--------|---------------|
| `setTradingEnabled` | `set_trading_enabled` | `{ enabled, prev }` |
| `setSimulationMode` | `set_simulation_mode` | `{ enabled, prev }` |
| `setSubscriptionPlan` | `set_subscription_plan` | `{ targetUserId, plan, prevPlan }` |
| `setUserSuspended` | `set_user_suspended` | `{ targetUserId, suspended, prev }` |
| `grantPermission`/`revokePermission` | `grant_permission`/`revoke_permission` | `{ targetUserId, permission }` |

`grantPermission`/`revokePermission` son helpers compartidos por las 4 mutations → instrumentar ahí
una vez cubre las 4 (pasando el `permission`). Capturar `prev` ANTES del patch.

### 3. Kill-switch del frontend

`setTradingEnabled` ya quedará logueado server-side (autoritativo). El `logAdminAction({kill_switch})`
del cliente (`BotPortal.jsx:3681`) pasa a ser redundante → se puede eliminar (o dejar como hint de UI,
pero el rastro real ya es el server-side). Decidir en implementación; preferible quitar la llamada
cliente para no duplicar entradas.

### 4. (Opcional) `logAdminAction` público

Mantenerlo por compat, pero ya no es la vía principal. Evaluar si se conserva o se marca deprecated.

## Verificación

- `npm run typecheck`.
- Cada mutation admin, al ejecutarse, inserta exactamente UNA fila en `admin_logs` con el clerkId del
  admin y el `action`/`meta` correctos (prueba manual en el panel admin → "Actividad").
- El panel admin (`listActivity`) muestra las nuevas acciones.

## Riesgos

- Bajo. Solo inserta filas de auditoría dentro de mutations ya admin-only. No cambia gates ni trading.
- Cuidar no loguear datos sensibles en `meta` (no incluir claves/credenciales; solo ids y valores
  de config/plan).

## Flujo

plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → deploy. Prioridad ALTA (seguridad).
