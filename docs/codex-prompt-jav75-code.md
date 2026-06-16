# Prompt para Codex — JAV-75 revisión de CÓDIGO

Ya diste GO al PLAN de JAV-75 (con 2 P1: proteger targets admin en backend + aclarar que
`suspended` no tiene efecto hasta JAV-77). Esto es la auditoría del CÓDIGO ya escrito
(commit local, aún SIN push). Confirma que los 2 P1 quedaron resueltos y busca
regresiones. GO / NO-GO + hallazgos (P0/P1/P2).

Contexto: Pieza 2 de la épica JAV-73. Admin asigna plan de cobertura + suspende usuarios.
Sin money-path. Construido sobre JAV-72 (panel + listUsersWithTradeLive) y JAV-74
(schema users.subscriptionPlan/suspended + catálogo subscriptions.ts).
Verificación: `npm run typecheck` limpio + `vite build` OK. Codegen regenerado.

## Diff backend

```diff
# convex/subscriptions.ts (añadidos)
+import { internalQuery, mutation, query } from "./_generated/server";
+import type { MutationCtx } from "./_generated/server";
+import type { Id } from "./_generated/dataModel";
+import { requireAdmin } from "./helpers";

+const planArg = v.union(
+  v.null(),
+  v.literal("betatester"), v.literal("starter"), v.literal("growth"),
+  v.literal("pro"), v.literal("prime"), v.literal("vault"), v.literal("institutional"),
+);

+async function loadNonAdminTarget(ctx: MutationCtx, userId: Id<"users">) {
+  const target = await ctx.db.get(userId);
+  if (!target) throw new Error("Usuario no encontrado");
+  if (target.role === "admin") {
+    throw new Error("No se puede modificar la suscripción/suspensión de un admin (acceso total).");
+  }
+  return target;
+}

+export const setSubscriptionPlan = mutation({
+  args: { userId: v.id("users"), plan: planArg },
+  handler: async (ctx, { userId, plan }) => {
+    await requireAdmin(ctx);
+    await loadNonAdminTarget(ctx, userId);
+    if (plan !== null && getPlan(plan) === null) {
+      throw new Error(`Plan inválido: ${plan}`);
+    }
+    await ctx.db.patch(userId, { subscriptionPlan: plan === null ? undefined : plan });
+  },
+});

+export const setUserSuspended = mutation({
+  args: { userId: v.id("users"), suspended: v.boolean() },
+  handler: async (ctx, { userId, suspended }) => {
+    await requireAdmin(ctx);
+    await loadNonAdminTarget(ctx, userId);
+    await ctx.db.patch(userId, { suspended });
+  },
+});

# convex/users.ts — listUsersWithTradeLive ahora incluye plan + suspended en el payload:
+  subscriptionPlan: u.subscriptionPlan ?? null, suspended: u.suspended === true,
```

## Diff frontend (src/components/BotPortal.jsx, BetaPermissionsPanel)
- Nuevas mutations `api.subscriptions.setSubscriptionPlan` / `setUserSuspended` y query
  `api.subscriptions.listPlans`.
- Helper `run(key, fn)` centraliza busy+error; `toggle`/`changePlan`/`toggleSuspended`.
- Por usuario no-admin: dos PermToggle (igual que antes) + `<select>` de plan (opciones
  desde listPlans + "Sin plan") + toggle Suspender/Reactivar (pill rojo/faint).
- Nota visible: "Suspensión: pendiente de enforcement (JAV-77) — hoy solo registra el estado."
- Admins siguen mostrando "Acceso total" sin acciones.

## Verificar uno a uno
1. P1 — ¿`setSubscriptionPlan` y `setUserSuspended` rechazan correctamente target admin
   (loadNonAdminTarget) además de requireAdmin? ¿Algún path que lo salte?
2. P1 — ¿La UI deja claro que `suspended` no tiene efecto operativo aún (label + nota)?
3. `plan === null ? undefined : plan` para "quitar plan": ¿borra bien el campo opcional en
   Convex (patch con undefined)? ¿Preferible un approach distinto?
4. `planArg` duplica los literales del schema/PLAN_IDS. ¿Aceptable (como en schema.ts) o
   propones derivarlo?
5. ¿`changePlan` con value '' → null es claro y sin ambigüedad?
6. Regresión: ¿el payload ampliado de listUsersWithTradeLive rompe algún consumidor? (solo
   lo usa BetaPermissionsPanel).
7. ¿Falta validar algo más (p.ej. no permitir suspender al propio admin que ejecuta)? Ya
   se bloquea cualquier target admin.

Verificación: npm run typecheck (limpio) + vite build (OK).
```
