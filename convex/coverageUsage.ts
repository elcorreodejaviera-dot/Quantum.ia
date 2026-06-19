import type { DatabaseReader } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getPlan } from "./plans";
import { elog } from "./log";

// (JAV-77 fix TS2589) Estos helpers SOLO LEEN (ctx.db.get/query). Tipamos el ctx con el tipo ligero
// `{ db: DatabaseReader }` en vez de `MutationCtx`: este último arrastra runQuery/runMutation/scheduler
// tipados contra todo el grafo generado `api`, y reinstanciarlo en cada call-site (6 handlers de
// triggerArms/executions) reventaba el presupuesto de inferencia → cascada "type instantiation
// excessively deep" en todo el backend. Un MutationCtx encaja estructuralmente con `{ db: ... }`.
type ReadCtx = { db: DatabaseReader };

// (JAV-77) Hard-cap por plan de cobertura — Modelo B: el tope del plan (coverageCapUsd) acota la
// COBERTURA DE POOLS = Σ liquidez de pool (sin buffer) de los pools con compromiso vivo, dedupe por
// pool con max. NO acota el nocional con buffer. Fuente única, importada por triggerArms.reserveArm /
// gates y executions.reserveExecution / gates (sin ciclos: no vive en subscriptions/executions).

// Compromisos NO vivos (no consumen cobertura). Coherente con ARM_TERMINAL y los finales de ejecución.
const ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);
const EXEC_TERMINAL = new Set(["closed", "failed"]);

// (JAV-79) Estados VIVOS por tabla, para consultar SOLO filas vivas por índice `by_user_status` en vez
// de hacer collect() de todo el historial. Se derivan de ALL_STATUSES − TERMINAL (NUNCA a mano):
// - `as const satisfies readonly Doc<...>["status"][]` + el guard de exhaustividad de abajo garantizan
//   que ALL_STATUSES contenga TODOS los estados del schema → si el schema añade uno y no se lista,
//   `npm run typecheck` FALLA (no se puede desplegar el olvido).
// - LIVE = ALL − TERMINAL → un estado nuevo (listado, no marcado terminal) cuenta como vivo por
//   defecto = fail-CLOSED (sobre-conteo bloquea; nunca infra-conteo que dejaría pasar sobre el cap).
type ArmStatus = Doc<"trigger_arms">["status"];
type ExecStatus = Doc<"execution_requests">["status"];

const ARM_ALL_STATUSES = [
  "arming", "submitting", "armed", "disarming", "disarmed", "filled", "protecting",
  "protected", "armed_lower_only", "closed", "failed", "unknown",
] as const satisfies readonly ArmStatus[];
const EXEC_ALL_STATUSES = [
  "pending", "submitting", "entry_filled", "protected", "sl_failed", "closed", "unknown", "failed",
] as const satisfies readonly ExecStatus[];

// Guards de EXHAUSTIVIDAD: si el schema añade un estado no listado arriba, esto NO compila.
type _ArmExhaustive = Exclude<ArmStatus, typeof ARM_ALL_STATUSES[number]> extends never ? true : never;
type _ExecExhaustive = Exclude<ExecStatus, typeof EXEC_ALL_STATUSES[number]> extends never ? true : never;
const _armCheck: _ArmExhaustive = true; void _armCheck;
const _execCheck: _ExecExhaustive = true; void _execCheck;

const ARM_LIVE: readonly ArmStatus[] = ARM_ALL_STATUSES.filter((s) => !ARM_TERMINAL.has(s));
const EXEC_LIVE: readonly ExecStatus[] = EXEC_ALL_STATUSES.filter((s) => !EXEC_TERMINAL.has(s));

// Cobertura consumida por pool sobre TODOS los compromisos vivos del usuario (arms IL + ejecuciones
// legacy). Por pool se toma el MÁXIMO hedgeNotionalUsd (un pool cuenta una vez; lecturas distintas del
// mismo LP varían levemente → max es fail-closed). LANZA [blocked_config] si una fila viva no tiene
// hedgeNotionalUsd/poolId fiables: SIN estimaciones en money-path → bloquea toda nueva reserva del
// usuario hasta backfill/drain (plan §6).
export async function consumedCoverageByPool(
  ctx: ReadCtx, userId: Id<"users">,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  // (JAV-79) Solo filas VIVAS, por índice `by_user_status` (nº de queries constante = |LIVE|,
  // independiente del tamaño del historial). El conjunto de filas consideradas es idéntico al del
  // antiguo collect()+filtro (todas las no-terminales) → mismo Map, misma agregación max por pool.
  for (const st of ARM_LIVE) {
    const arms = await ctx.db
      .query("trigger_arms")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", st))
      .collect();
    for (const a of arms) {
      const h = a.hedgeNotionalUsd;
      if (!(typeof h === "number" && Number.isFinite(h) && h > 0)) {
        throw new Error("[blocked_config] Cobertura no cuantificable: arm vivo sin hedgeNotionalUsd (requiere backfill/drain).");
      }
      const key = a.poolId as string;
      map.set(key, Math.max(map.get(key) ?? 0, h));
    }
  }

  for (const st of EXEC_LIVE) {
    const execs = await ctx.db
      .query("execution_requests")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", st))
      .collect();
    for (const r of execs) {
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
  }

  return map;
}

// Regla de admisión del cap (LANZA fail-closed): sin plan / suspendido / total POST-operación > cap.
// Sirve para la RESERVA (la fila aún no existe → se añade el aporte) y para los gates de ENVÍO (la fila
// ya está viva y contada → max(existente, hedge) es idempotente, no doble cuenta). Pasar el poolId +
// hedgeNotionalUsd del compromiso. Throws [blocked_config]/[blocked_margin] (prefijos para triggerRearm).
export async function assertWithinPlanCoverage(
  ctx: ReadCtx, userId: Id<"users">, poolId: Id<"pools">, hedge: number,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("[blocked_config] Usuario no encontrado.");
  // Admin = ACCESO TOTAL, sin tope de cobertura. Espeja la promesa de la UI ("Acceso total (admin)")
  // y el bypass de admin de assertLiveAdmissible. Necesario porque a un admin NO se le puede asignar
  // plan (setSubscriptionPlan/loadNonAdminTarget lo rechazan) ni suspender → sin este bypass, todo
  // admin sin plan quedaría bloqueado por [blocked_config] al armar/ejecutar.
  if (user.role === "admin") return;
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
    // (OBS-3) Rechazo por cap de plan. Solo escalares no sensibles (pool/total/cap/plan); NADA de cuenta/claves.
    elog("coverage", "cap_rejected", {
      poolId: key, total: Number(total.toFixed(2)), cap: plan.coverageCapUsd, plan: plan.label,
    });
    throw new Error(
      `[blocked_margin] Supera el tope de cobertura del plan: ${total.toFixed(2)} > ${plan.coverageCapUsd} (${plan.label}).`);
  }
}

// Variante NO-lanzante para los gates de ENVÍO (markSubmitting/gateBeforeOrder/markArmSubmitting/
// gateArmBeforeOrder): cualquier excepción (cap, sin plan, suspendido, fila no cuantificable) → false
// = bloquear/terminalizar. Mantiene fail-closed sin propagar el throw fuera del gate.
export async function coverageAdmissible(
  ctx: ReadCtx, userId: Id<"users">, poolId: Id<"pools"> | undefined, hedge: number | undefined,
): Promise<boolean> {
  if (!poolId || hedge === undefined) return false;   // fila in-flight sin datos fiables → fail-closed
  try {
    await assertWithinPlanCoverage(ctx, userId, poolId, hedge);
    return true;
  } catch {
    return false;
  }
}
