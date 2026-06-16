# Prompt para Codex — JAV-75 (Pieza 2 de la épica JAV-73): PLAN

Revisa este PLAN de JAV-75 (Quantum.ia, Convex + React) ANTES de implementar. Pieza 2 de
la épica JAV-73 (planes de cobertura). Dame GO / NO-GO y, si NO-GO, hallazgos
priorizados (P0/P1/P2).

## Contexto
La épica JAV-73 convierte los planes de cobertura (hoy cosméticos) en un sistema real.
JAV-74 (PR #57, ya con GO de Codex) añadió:
- schema `users`: `subscriptionPlan` (opcional, 7 literales) + `suspended` (opcional).
- `convex/subscriptions.ts`: catálogo único `PLANS`/`PLAN_IDS`/`PlanId`, `getPlan(id)`,
  `getMySubscription`, `getSubscriptionForUserInternal`.
JAV-72 (PR #56, GO) añadió el patrón de panel admin `BetaPermissionsPanel`
(`src/components/BotPortal.jsx`) con toggles por usuario y la query paginada
`listUsersWithTradeLive` (admin-only) que devuelve `{ userId, email, name, role,
canTradeLive, canManageBots }`, además de helpers `grantPermission`/`revokePermission`.

JAV-75 NO toca money-path (enforcement = JAV-77). Solo admin asigna datos.

## Alcance EXACTO de JAV-75

1. **Backend** (`convex/subscriptions.ts`), admin-only (`requireAdmin`):
   - `setSubscriptionPlan(userId, plan: PlanId | null)`: valida `plan` contra `PLAN_IDS`
     (o null = quitar plan). Patch `users.subscriptionPlan`. null → setear undefined.
   - `setUserSuspended(userId, suspended: boolean)`: patch `users.suspended`.
2. **Query del panel**: ampliar `listUsersWithTradeLive` (mismo criterio que en JAV-72: no
   renombrar, extender el payload) para devolver también `subscriptionPlan` y `suspended`
   por usuario. (Lee directo del doc `users`, no requiere índice nuevo.)
3. **UI** `BetaPermissionsPanel` (`BotPortal.jsx`): por cada usuario no-admin, añadir:
   - **Selector de plan**: dropdown con los `PLANS` (vía `listPlans`/catálogo) + opción
     "Sin plan". Al cambiar → `setSubscriptionPlan`. Estado "busy" por usuario.
   - **Toggle Suspender/Reactivar**: pill estado + botón → `setUserSuspended`.
   - Admins: mostrar "Acceso total" y ocultar acciones (igual que hoy).

## Invariantes / decisiones a validar
- TODAS las mutations admin-only (`requireAdmin`), igual que grant/revoke de JAV-72.
- Validar `plan` contra `PLAN_IDS` en backend (no confiar en el cliente). Plan inválido →
  error claro.
- No tocar enforcement, sizing, ni límites beta (eso es JAV-77). Asignar plan ≠ permitir
  operar: el armado real lo sigue gateando canManageBots/canTradeLive (JAV-72) y, más
  adelante, el hard-cap (JAV-77).
- Reutilizar el patrón "busy por {userId, acción}" y el manejo de error del panel JAV-72.

## Dependencia de ramas (decisión)
JAV-75 extiende funciones que modifican JAV-72 (#56: panel + listUsersWithTradeLive) y
JAV-74 (#57: schema + subscriptions.ts), ambos PRs abiertos sin mergear.
Propuesta: implementar JAV-75 DESPUÉS de mergear #56 y #57 (rama desde master limpio) para
evitar conflictos en BotPortal.jsx / users.ts / schema.ts. ¿De acuerdo, o prefieres
stackear ramas?

## Preguntas para Codex
1. ¿`setSubscriptionPlan` debería registrar quién/ cuándo (auditoría, p.ej. grantedBy)
   como hacen los permisos, o basta el patch simple en esta fase manual?
2. ¿`null` para "quitar plan" vía `v.union(v.null(), ...)` o un arg opcional? ¿Preferencia?
3. ¿Algún riesgo en exponer `subscriptionPlan`/`suspended` de todos los usuarios en la
   query admin-only (ya es admin-only)?

Verificación prevista: `npm run typecheck` + `vite build`.
```

---

## Veredicto Codex: NO-GO → GO tras 2 ajustes (incorporados al plan final)

- **P1 — Proteger targets admin en backend:** `setSubscriptionPlan` y `setUserSuspended`
  rechazan si `target.role === "admin"` con error claro. No basta ocultar en UI.
- **P1 — `suspended` sin efecto operativo hasta JAV-77:** la UI lo etiqueta
  "Suspensión (pendiente de enforcement — JAV-77)"; el flag solo se guarda, no detiene
  bots ni bloquea armado todavía.
- **P2:** mutations `mutation` público (no internal) + `requireAdmin` de `./helpers`,
  en `convex/subscriptions.ts`.
- **P2:** arg `plan: v.union(v.null(), ...literales)`; `plan === null ? undefined : plan`;
  `getPlan(plan)` como defensa de validación.
- **P2 (diferido):** auditoría quién/cuándo (`subscriptionUpdatedAt/By`, `suspendedAt/By`)
  → nota para JAV-78, no se amplía schema ahora.

Implementación pendiente del merge de #56 (JAV-72) y #57 (JAV-74).
