import { internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireAdmin } from "./helpers";

// --- Planes de cobertura (JAV-73) — FUENTE ÚNICA de verdad ---
//
// El tope de cobertura (coverageCapUsd) limita el nocional TOTAL de cobertura del usuario: la suma
// de `totalNotional` (= liquidez_pool × (1 + bufferPct/100)) de todos sus bots activos. El enforcement
// (JAV-77) bloquea armar un bot que haga superar este tope. La UI (JAV-76) lee este mismo catálogo, no
// uno hardcodeado. `priceUsd` queda registrado para el cobro vía Stripe (JAV-78); Betatester es gratis.

// Identificadores de plan reutilizables (schema, queries y enforcement comparten estos literales).
// El union de `users.subscriptionPlan` en schema.ts DEBE reflejar esta misma lista.
export const PLAN_IDS = [
  "betatester", "starter", "growth", "pro", "prime", "vault", "institutional",
] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type Plan = { id: PlanId; label: string; coverageCapUsd: number; priceUsd: number };

// Orden ascendente por tope (lo respeta la UI para mostrar la escalera de planes).
// NOTA: priceUsd es PLACEHOLDER (0 = precio aún sin definir, no "gratis") salvo Betatester, que SÍ es
// gratis por diseño. Definir los precios reales antes de mostrarlos en UI (JAV-76) / cobrar (JAV-78).
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

// Devuelve el plan por id, o null si no es un plan válido (incluye undefined = sin plan).
// hasOwnProperty (no `in`) para no aceptar claves del prototipo ("toString", "constructor"…).
// Object.hasOwn requeriría lib es2022; el tsconfig de Convex es anterior, así que usamos .call.
export function getPlan(id: string | undefined): Plan | null {
  return id !== undefined && Object.prototype.hasOwnProperty.call(PLAN_BY_ID, id)
    ? PLAN_BY_ID[id as PlanId] : null;
}

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
    await requireAdmin(ctx);
    await loadNonAdminTarget(ctx, userId);
    // Defensa extra: si viene un plan no-null, debe existir en el catálogo (getPlan).
    if (plan !== null && getPlan(plan) === null) {
      throw new Error(`Plan inválido: ${plan}`);
    }
    await ctx.db.patch(userId, { subscriptionPlan: plan === null ? undefined : plan });
  },
});

// Suspende o reactiva a un usuario. Admin-only.
// NOTA: en JAV-75 esto SOLO guarda el flag; el efecto operativo (bloquear armado / detener bots)
// llega con el enforcement de JAV-77. La UI lo etiqueta "pendiente de enforcement" para no engañar.
export const setUserSuspended = mutation({
  args: { userId: v.id("users"), suspended: v.boolean() },
  handler: async (ctx, { userId, suspended }) => {
    await requireAdmin(ctx);
    await loadNonAdminTarget(ctx, userId);
    await ctx.db.patch(userId, { suspended });
  },
});
