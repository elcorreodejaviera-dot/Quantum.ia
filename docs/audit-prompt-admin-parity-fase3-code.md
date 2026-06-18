# Prompt de auditoría (Codex) — CÓDIGO Fase 3 de JAV-84 (controles por usuario + búsqueda/filtro)

Audita el **código** (working tree, sin commit) de la Fase 3 del plan `docs/plan-admin-parity.md`.
ÚNICO archivo: `src/components/AdminView.jsx` (solo frontend; NO hay cambios de backend). Va apilado sobre
la rama de Fase 2 (#68), de la que reutiliza el mismo archivo.

Cambios:
- **Búsqueda + filtro de usuarios** (cliente, sobre la página ya cargada por `usePaginatedQuery`): input de
  texto (email/nombre) + `<select>` (todos/activos/sin plan/suspendidos). `visibleUsers` filtra y se usa
  tanto en la tabla USUARIOS como en la sección de controles.
- **Sección "CONTROLES POR USUARIO"** + `UserControlRow`: por usuario NO-admin → toggles **Manage**/**Live**
  (`grant/revokeManageBots`, `grant/revokeTradeLive`, args `{ userId }`), `<select>` de **plan**
  (`setSubscriptionPlan`, `{ userId, plan }`; `''` → `null` = quitar plan), botón **suspender/reactivar**
  (`setUserSuspended`, `{ userId, suspended }`). Filas de rol **admin**: informativas, sin controles
  (el backend ya bloquea asignar admin). Estado `busy`/`err` POR FILA; errores no rompen la vista.

Verifica GO/NO-GO:
1. ¿Se llaman las mutations con los args correctos? En especial `setSubscriptionPlan` con `plan: e.target.value
   || null` (¿`''` → `null` quita el plan como espera el validador `planArg`?). El wrapper
   `run((a)=>setPlan(a))({userId, plan})` ¿pasa bien el objeto?
2. ¿Las filas admin quedan correctamente excluidas de controles (defensa en UI), coherente con que el
   backend rechaza admins en setSubscriptionPlan/setUserSuspended y que grant/revoke* no bloquean admin?
3. Filtro/búsqueda SOLO sobre la página cargada (no re-query): ¿aceptable para beta? ¿algún comportamiento
   confuso con "Cargar más" + filtro activo?
4. ¿Robustez UI? `busy` por fila evita doble-submit; `err` por fila no tumba la vista. ¿Race si se cambian
   varios toggles rápido? (las mutations son idempotentes a nivel de permiso/plan).
5. ¿Es 100% frontend reusando mutations ya auditadas (NO money-path, NO nueva lógica de permisos)?
6. ¿Algún `key` de lista, accesibilidad de toggles (button), o fuga de estado entre filas?
