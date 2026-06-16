import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getPlan } from "./subscriptions";

// (JAV-77) Hard-cap por plan de cobertura — Modelo B: el tope del plan (coverageCapUsd) acota la
// COBERTURA DE POOLS = Σ liquidez de pool (sin buffer) de los pools con compromiso vivo, dedupe por
// pool con max. NO acota el nocional con buffer. Fuente única, importada por triggerArms.reserveArm /
// gates y executions.reserveExecution / gates (sin ciclos: no vive en subscriptions/executions).

// Compromisos NO vivos (no consumen cobertura). Coherente con ARM_TERMINAL y los finales de ejecución.
const ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);
const EXEC_TERMINAL = new Set(["closed", "failed"]);

// Cobertura consumida por pool sobre TODOS los compromisos vivos del usuario (arms IL + ejecuciones
// legacy). Por pool se toma el MÁXIMO hedgeNotionalUsd (un pool cuenta una vez; lecturas distintas del
// mismo LP varían levemente → max es fail-closed). LANZA [blocked_config] si una fila viva no tiene
// hedgeNotionalUsd/poolId fiables: SIN estimaciones en money-path → bloquea toda nueva reserva del
// usuario hasta backfill/drain (plan §6).
export async function consumedCoverageByPool(
  ctx: MutationCtx, userId: Id<"users">,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  const arms = await ctx.db
    .query("trigger_arms")
    .withIndex("by_user_created", (q) => q.eq("userId", userId))
    .collect();
  for (const a of arms) {
    if (ARM_TERMINAL.has(a.status)) continue;
    const h = a.hedgeNotionalUsd;
    if (!(typeof h === "number" && Number.isFinite(h) && h > 0)) {
      throw new Error("[blocked_config] Cobertura no cuantificable: arm vivo sin hedgeNotionalUsd (requiere backfill/drain).");
    }
    const key = a.poolId as string;
    map.set(key, Math.max(map.get(key) ?? 0, h));
  }

  const execs = await ctx.db
    .query("execution_requests")
    .withIndex("by_user_created", (q) => q.eq("userId", userId))
    .collect();
  for (const r of execs) {
    if (EXEC_TERMINAL.has(r.status)) continue;
    const h = r.hedgeNotionalUsd;
    if (!(typeof h === "number" && Number.isFinite(h) && h > 0)) {
      throw new Error("[blocked_config] Cobertura no cuantificable: ejecución viva sin hedgeNotionalUsd (requiere backfill/drain).");
    }
    if (!r.poolId) {
      throw new Error("[blocked_config] Cobertura no cuantificable: ejecución viva sin poolId (requiere backfill/drain).");
    }
    const key = r.poolId as string;
    map.set(key, Math.max(map.get(key) ?? 0, h));
  }

  return map;
}

// Regla de admisión del cap (LANZA fail-closed): sin plan / suspendido / total POST-operación > cap.
// Sirve para la RESERVA (la fila aún no existe → se añade el aporte) y para los gates de ENVÍO (la fila
// ya está viva y contada → max(existente, hedge) es idempotente, no doble cuenta). Pasar el poolId +
// hedgeNotionalUsd del compromiso. Throws [blocked_config]/[blocked_margin] (prefijos para triggerRearm).
export async function assertWithinPlanCoverage(
  ctx: MutationCtx, userId: Id<"users">, poolId: Id<"pools">, hedge: number,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("[blocked_config] Usuario no encontrado.");
  if (user.suspended === true) throw new Error("[blocked_config] Cuenta suspendida: armado bloqueado.");
  const plan = getPlan(user.subscriptionPlan);
  if (plan === null) throw new Error("[blocked_config] Sin plan de cobertura asignado: armado bloqueado.");
  if (!(typeof hedge === "number" && Number.isFinite(hedge) && hedge > 0)) {
    throw new Error("[blocked_config] Cobertura del compromiso no cuantificable.");
  }
  const byPool = await consumedCoverageByPool(ctx, userId);
  const key = poolId as string;
  const post = new Map(byPool);
  post.set(key, Math.max(post.get(key) ?? 0, hedge));
  let total = 0;
  for (const v of post.values()) total += v;
  if (total > plan.coverageCapUsd) {
    throw new Error(
      `[blocked_margin] Supera el tope de cobertura del plan: ${total.toFixed(2)} > ${plan.coverageCapUsd} (${plan.label}).`);
  }
}

// Variante NO-lanzante para los gates de ENVÍO (markSubmitting/gateBeforeOrder/markArmSubmitting/
// gateArmBeforeOrder): cualquier excepción (cap, sin plan, suspendido, fila no cuantificable) → false
// = bloquear/terminalizar. Mantiene fail-closed sin propagar el throw fuera del gate.
export async function coverageAdmissible(
  ctx: MutationCtx, userId: Id<"users">, poolId: Id<"pools"> | undefined, hedge: number | undefined,
): Promise<boolean> {
  if (!poolId || hedge === undefined) return false;   // fila in-flight sin datos fiables → fail-closed
  try {
    await assertWithinPlanCoverage(ctx, userId, poolId, hedge);
    return true;
  } catch {
    return false;
  }
}
