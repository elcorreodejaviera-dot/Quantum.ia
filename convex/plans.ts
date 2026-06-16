// (JAV-73/77) Catálogo de planes de cobertura — módulo HOJA (sin funciones Convex ni imports de
// _generated/api) para que el enforcement (coverageUsage.ts) lo importe sin arrastrar el grafo de
// tipos `api` (evita TS2589 "type instantiation excessively deep"). subscriptions.ts lo re-exporta.

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
