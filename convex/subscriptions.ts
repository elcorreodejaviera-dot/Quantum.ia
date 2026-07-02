import { internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireAdmin, writeAdminLog, getUserOrNull } from "./helpers";
import { consumedCoverageByKey } from "./coverageUsage";

// --- Planes de cobertura (JAV-73) — FUENTE ÚNICA de verdad ---
//
// El tope de cobertura (coverageCapUsd) limita la COBERTURA DE POOLS del usuario (Modelo B): la suma
// de `hedgeNotionalUsd` (= liquidez_pool cruda, SIN buffer) de los pools DISTINTOS que cubre con bots
// activos. NO acota el nocional con buffer (`totalNotional` puede llegar a ~2× la liquidez del pool con
// buffer 100%). El enforcement (JAV-77, `coverageUsage.ts`) bloquea armar/ejecutar si la cobertura de
// pools supera este tope. La UI (JAV-76) lee este mismo catálogo, no uno hardcodeado. `priceUsd` queda
// registrado para el cobro vía Stripe (JAV-78); Betatester es gratis.

// El catálogo de planes (PLAN_IDS/PLANS/getPlan) vive en el módulo HOJA `plans.ts` (sin funciones
// Convex) para que el enforcement lo importe sin arrastrar el grafo `api` (TS2589). Se importa para uso
// interno y se re-exporta para no romper importadores existentes.
import { PLAN_IDS, PLANS, getPlan, type PlanId, type Plan } from "./plans";
export { PLAN_IDS, PLANS, getPlan };
export type { PlanId, Plan };

// Vista normalizada de la suscripción de un usuario para la UI / el enforcement.
// IMPORTANTE (Codex P2): "usuario autenticado SIN plan" NO es null — es { plan: null, cap: 0 }.
// El null solo lo devuelve getMySubscription cuando no hay sesión / no existe el user. Así la UI y
// JAV-77 distinguen "no autenticado" de "sin plan asignado". coverageCapUsd 0 es fail-closed: aguas
// abajo NUNCA debe interpretarse como "ilimitado".
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

// Catálogo de planes para la UI (no requiere auth — son datos públicos de producto).
export const listPlans = query({
  args: {},
  handler: async () => PLANS.map((p) => ({ ...p })),
});

// (JAV-180 / P5) Uso de cobertura REAL server-side, la MISMA verdad que el enforcement
// (consumedCoverageByKey + cap del plan). SubscriptionBar lo consume en vez de estimar en cliente
// deduplicando por poolId (que ignoraba la clave `trading:<botId>` y mostraba headroom mientras el
// server bloqueaba). `quantifiable:false` cuando una fila viva no es cuantificable
// (assertWithinPlanCoverageForKey lanza [blocked_config]) ⇒ la barra muestra "revisión requerida",
// NUNCA un 0 engañoso. Admin = acceso total (cap Infinity, sin bloqueo).
export const getMyCoverageUsage = query({
  args: {},
  handler: async (ctx): Promise<{
    total: number; cap: number; quantifiable: boolean;
    byKey: { key: string; usd: number }[]; suspended: boolean; hasPlan: boolean; isAdmin: boolean;
  } | null> => {
    const user = await getUserOrNull(ctx);
    if (!user) return null;
    if (user.role === "admin") {
      return { total: 0, cap: Infinity, quantifiable: true, byKey: [], suspended: false, hasPlan: true, isAdmin: true };
    }
    const suspended = user.suspended === true;
    const plan = getPlan(user.subscriptionPlan);
    const cap = plan?.coverageCapUsd ?? 0;
    try {
      const map = await consumedCoverageByKey(ctx, user._id);
      const byKey = [...map.entries()].map(([key, usd]) => ({ key, usd }));
      const total = byKey.reduce((s, e) => s + e.usd, 0);
      return { total, cap, quantifiable: true, byKey, suspended, hasPlan: plan !== null, isAdmin: false };
    } catch (e) {
      // (JAV-180-C1) SOLO el [blocked_config] de una fila viva no cuantificable (requiere backfill/
      // drain) se degrada a quantifiable:false — la barra lo muestra explícito. Cualquier OTRO error
      // (regresión de query/schema/índice) se PROPAGA: taparlo como "revisión requerida" ocultaría
      // un bug real de cobertura.
      const msg = String((e as Error)?.message ?? e);
      if (!/\[blocked_config\]/.test(msg)) throw e;
      return { total: 0, cap, quantifiable: false, byKey: [], suspended, hasPlan: plan !== null, isAdmin: false };
    }
  },
});

// Suscripción del usuario AUTENTICADO (para SubscriptionBar, JAV-76). Null SOLO si no hay sesión o
// no existe el user; un usuario logueado sin plan devuelve { plan: null, coverageCapUsd: 0 }.
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

// Suscripción de un usuario CONCRETO (por id), para el enforcement sin identidad (auto-rearm del
// cron, JAV-77). Incluye `suspended` desde ya (Codex P2). Null si el usuario no existe.
export const getSubscriptionForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<SubscriptionView | null> => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return viewFor(user);
  },
});

// --- Asignación admin (JAV-75) — manual; Stripe la automatizará en JAV-78 ---
// Validator de plan: literales del catálogo + null (= quitar plan). Debe reflejar PLAN_IDS.
const planArg = v.union(
  v.null(),
  v.literal("betatester"), v.literal("starter"), v.literal("growth"),
  v.literal("pro"), v.literal("prime"), v.literal("vault"), v.literal("institutional"),
);

// (Codex P1) Rechaza modificar a un admin: el admin tiene bypass total (su acceso no depende de un
// plan ni de un flag de suspensión), así que asignarle plan/suspensión no tiene sentido y podría
// crear estados confusos. No basta ocultarlo en la UI — se protege en el backend.
async function loadNonAdminTarget(ctx: MutationCtx, userId: Id<"users">) {
  const target = await ctx.db.get(userId);
  if (!target) throw new Error("Usuario no encontrado");
  if (target.role === "admin") {
    throw new Error("No se puede modificar la suscripción/suspensión de un admin (acceso total).");
  }
  return target;
}

// Asigna (o quita, con null) el plan de cobertura de un usuario. Admin-only.
export const setSubscriptionPlan = mutation({
  args: { userId: v.id("users"), plan: planArg },
  handler: async (ctx, { userId, plan }) => {
    const admin = await requireAdmin(ctx);
    const target = await loadNonAdminTarget(ctx, userId);
    const prevPlan = target.subscriptionPlan ?? null;
    // Defensa extra: si viene un plan no-null, debe existir en el catálogo (getPlan).
    if (plan !== null && getPlan(plan) === null) {
      throw new Error(`Plan inválido: ${plan}`);
    }
    await ctx.db.patch(userId, { subscriptionPlan: plan === null ? undefined : plan });
    await writeAdminLog(ctx, admin.clerkId, "set_subscription_plan", { targetUserId: userId, plan, prevPlan });
  },
});

// Suspende o reactiva a un usuario. Admin-only.
// NOTA: en JAV-75 esto SOLO guarda el flag; el efecto operativo (bloquear armado / detener bots)
// llega con el enforcement de JAV-77. La UI lo etiqueta "pendiente de enforcement" para no engañar.
export const setUserSuspended = mutation({
  args: { userId: v.id("users"), suspended: v.boolean() },
  handler: async (ctx, { userId, suspended }) => {
    const admin = await requireAdmin(ctx);
    const target = await loadNonAdminTarget(ctx, userId);
    const prev = target.suspended ?? false;
    await ctx.db.patch(userId, { suspended });
    await writeAdminLog(ctx, admin.clerkId, "set_user_suspended", { targetUserId: userId, suspended, prev });
  },
});
