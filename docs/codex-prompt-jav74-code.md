# Prompt para Codex — JAV-74 revisión de CÓDIGO (PR #57)

Ya diste GO al PLAN de JAV-74. Esto es la auditoría del CÓDIGO ya escrito (PR #57).
Confirma que los 3 P2 quedaron resueltos y busca regresiones. Dame GO / NO-GO y, si
NO-GO, hallazgos priorizados (P0/P1/P2).

Contexto: Pieza 1 de la épica JAV-73 (planes de cobertura). Solo datos + lectura, SIN
money-path. 2 archivos: convex/schema.ts (users) y nuevo convex/subscriptions.ts.
typecheck limpio.

## Diff completo

```diff
diff --git a/convex/schema.ts b/convex/schema.ts
@@ users defineTable @@
     role: v.union(v.literal("admin"), v.literal("viewer")),
     walletAddress: v.optional(v.string()),
+    // JAV-73 (planes de cobertura). Plan de suscripción del usuario: define el tope de cobertura
+    // total (catálogo único en convex/subscriptions.ts). Ausente/undefined = sin plan (cap 0: no puede
+    // armar bots reales). Los literales DEBEN coincidir con PLAN_IDS de convex/subscriptions.ts.
+    subscriptionPlan: v.optional(v.union(
+      v.literal("betatester"), v.literal("starter"), v.literal("growth"),
+      v.literal("pro"), v.literal("prime"), v.literal("vault"), v.literal("institutional"))),
+    // El admin puede suspender a un usuario (lo detiene aunque tenga plan). El enforcement (JAV-77)
+    // bloquea el armado si suspended === true.
+    suspended: v.optional(v.boolean()),
   }).index("by_clerk_id", ["clerkId"]),
```

convex/subscriptions.ts (nuevo, completo):

```ts
import { internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

export const PLAN_IDS = [
  "betatester", "starter", "growth", "pro", "prime", "vault", "institutional",
] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type Plan = { id: PlanId; label: string; coverageCapUsd: number; priceUsd: number };

export const PLANS: readonly Plan[] = [
  { id: "betatester",    label: "Betatester",    coverageCapUsd: 5_000,     priceUsd: 0 },
  { id: "starter",       label: "Starter",       coverageCapUsd: 10_000,    priceUsd: 0 },
  { id: "growth",        label: "Growth",        coverageCapUsd: 20_000,    priceUsd: 0 },
  { id: "pro",           label: "Pro",           coverageCapUsd: 50_000,    priceUsd: 0 },
  { id: "prime",         label: "Prime",         coverageCapUsd: 100_000,   priceUsd: 0 },
  { id: "vault",         label: "Vault",         coverageCapUsd: 500_000,   priceUsd: 0 },
  { id: "institutional", label: "Institutional", coverageCapUsd: 1_000_000, priceUsd: 0 },
] as const;

const PLAN_BY_ID: Record<PlanId, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.id, p]),
) as Record<PlanId, Plan>;

export function getPlan(id: string | undefined): Plan | null {
  return id !== undefined && id in PLAN_BY_ID ? PLAN_BY_ID[id as PlanId] : null;
}

export type SubscriptionView = {
  plan: PlanId | null;
  label: string | null;
  coverageCapUsd: number;   // 0 cuando no hay plan
  suspended: boolean;
};

function viewFor(user: { subscriptionPlan?: string; suspended?: boolean }): SubscriptionView {
  const plan = getPlan(user.subscriptionPlan);
  return {
    plan: plan?.id ?? null,
    label: plan?.label ?? null,
    coverageCapUsd: plan?.coverageCapUsd ?? 0,
    suspended: user.suspended === true,
  };
}

export const listPlans = query({
  args: {},
  handler: async () => PLANS.map((p) => ({ ...p })),
});

export const getMySubscription = query({
  args: {},
  handler: async (ctx): Promise<SubscriptionView | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    if (!user) return null;
    return viewFor(user);
  },
});

export const getSubscriptionForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<SubscriptionView | null> => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return viewFor(user);
  },
});
```

## Verificar uno a uno
1. P2 #1 — getMySubscription: autenticado sin plan → { plan:null, coverageCapUsd:0 } y
   null SOLO si no hay sesión/user. ¿Correcto?
2. P2 #2 — PLAN_IDS/PlanId/Plan/PLANS exportados y reutilizables. El union del schema NO
   se deriva de PLAN_IDS (Convex exige v.literal explícitos). ¿Aceptable el comentario
   "DEBEN coincidir" como contrato, o propones una salvaguarda (test/aserción de tipo)?
3. P2 #3 — suspended viaja en getSubscriptionForUserInternal. ¿Correcto?
4. getPlan usa `id in PLAN_BY_ID` con cast — ¿algún riesgo de prototype keys
   (p.ej. "toString")? PLAN_BY_ID viene de Object.fromEntries (objeto plano). ¿Endurecer?
5. listPlans sin auth expone priceUsd (hoy todos 0). ¿OK confirmado?
6. Retrocompat: campos opcionales no rompen usuarios existentes ni getOrCreateUser. ¿Algún
   otro punto que lea users y deba contemplar los campos nuevos?

Verificación: npm run typecheck (limpio).
```
