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
// (JAV-107) Arms del bot de defensa spot. `manual_intervention` NO es terminal → cuenta como vivo
// (fail-closed: la cobertura/margen sigue comprometido hasta que el usuario resuelva el drift).
type SpotDefenseArmStatus = Doc<"spot_defense_arms">["status"];

const ARM_ALL_STATUSES = [
  "arming", "submitting", "armed", "disarming", "disarmed", "filled", "protecting",
  "protected", "armed_lower_only", "closed", "failed", "unknown",
] as const satisfies readonly ArmStatus[];
const EXEC_ALL_STATUSES = [
  "pending", "submitting", "entry_filled", "protected", "sl_failed", "closed", "unknown", "failed",
] as const satisfies readonly ExecStatus[];
const SPOT_DEFENSE_ALL_STATUSES = [
  "arming", "submitting", "armed", "disarming", "disarmed", "filled", "protecting",
  "protected", "closed", "failed", "unknown", "manual_intervention",
] as const satisfies readonly SpotDefenseArmStatus[];

// Guards de EXHAUSTIVIDAD: si el schema añade un estado no listado arriba, esto NO compila.
type _ArmExhaustive = Exclude<ArmStatus, typeof ARM_ALL_STATUSES[number]> extends never ? true : never;
type _ExecExhaustive = Exclude<ExecStatus, typeof EXEC_ALL_STATUSES[number]> extends never ? true : never;
type _SdExhaustive = Exclude<SpotDefenseArmStatus, typeof SPOT_DEFENSE_ALL_STATUSES[number]> extends never ? true : never;
const _armCheck: _ArmExhaustive = true; void _armCheck;
const _execCheck: _ExecExhaustive = true; void _execCheck;
const _sdCheck: _SdExhaustive = true; void _sdCheck;

const ARM_LIVE: readonly ArmStatus[] = ARM_ALL_STATUSES.filter((s) => !ARM_TERMINAL.has(s));
const EXEC_LIVE: readonly ExecStatus[] = EXEC_ALL_STATUSES.filter((s) => !EXEC_TERMINAL.has(s));
const SPOT_DEFENSE_LIVE: readonly SpotDefenseArmStatus[] =
  SPOT_DEFENSE_ALL_STATUSES.filter((s) => !ARM_TERMINAL.has(s));

// Cobertura consumida por pool sobre TODOS los compromisos vivos del usuario (arms IL + ejecuciones
// legacy). Por pool se toma el MÁXIMO hedgeNotionalUsd (un pool cuenta una vez; lecturas distintas del
// mismo LP varían levemente → max es fail-closed). LANZA [blocked_config] si una fila viva no tiene
// hedgeNotionalUsd/poolId fiables: SIN estimaciones en money-path → bloquea toda nueva reserva del
// usuario hasta backfill/drain (plan §6).
// (JAV-107) Claves namespaced del consumo: la cobertura de pool se DEDUPLICA por pool
// (`pool:<poolId>`, arms IL + ejecuciones legacy del mismo pool cuentan una vez con max); la defensa
// spot NO tiene pool → clave propia `spot-defense:<botId>` (un bot = un compromiso, sin dedupe con
// pools ni entre sí). Así no hay colisión ni doble-conteo entre los dos motores.
export function poolCoverageKey(poolId: Id<"pools">): string { return `pool:${poolId}`; }
export function spotDefenseCoverageKey(botId: Id<"spot_defense_bots">): string { return `spot-defense:${botId}`; }

export async function consumedCoverageByKey(
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
      const key = poolCoverageKey(a.poolId);
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
      const key = poolCoverageKey(r.poolId);
      map.set(key, Math.max(map.get(key) ?? 0, h));
    }
  }

  // (JAV-107) Defensa spot: el nocional efectivo reservado (effectiveNotionalUsd) es la unidad de
  // cobertura del plan. Un arm vivo sin ese dato fiable → fail-closed (bloquea nuevas reservas).
  for (const st of SPOT_DEFENSE_LIVE) {
    const arms = await ctx.db
      .query("spot_defense_arms")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", st))
      .collect();
    for (const a of arms) {
      const h = a.effectiveNotionalUsd;
      if (!(typeof h === "number" && Number.isFinite(h) && h > 0)) {
        throw new Error("[blocked_config] Cobertura no cuantificable: defensa spot viva sin effectiveNotionalUsd (requiere backfill/drain).");
      }
      const key = spotDefenseCoverageKey(a.botId);
      map.set(key, Math.max(map.get(key) ?? 0, h));
    }
  }

  return map;
}

// Alias histórico: el detalle admin suma `.values()` (las claves le dan igual). Mantiene la firma para
// no tocar call-sites; ahora incluye también la defensa spot en el total del usuario.
export const consumedCoverageByPool = consumedCoverageByKey;

// Regla de admisión del cap (LANZA fail-closed): sin plan / suspendido / total POST-operación > cap.
// Sirve para la RESERVA (la fila aún no existe → se añade el aporte) y para los gates de ENVÍO (la fila
// ya está viva y contada → max(existente, hedge) es idempotente, no doble cuenta). Pasar el poolId +
// hedgeNotionalUsd del compromiso. Throws [blocked_config]/[blocked_margin] (prefijos para triggerRearm).
// (JAV-107) Núcleo genérico: valida por CLAVE namespaced (pool:<id> o spot-defense:<id>). Pool y
// defensa spot delegan aquí. Mismo comportamiento que antes para pools (key = `pool:<poolId>`).
export async function assertWithinPlanCoverageForKey(
  ctx: ReadCtx, userId: Id<"users">, key: string, hedge: number,
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
  const byKey = await consumedCoverageByKey(ctx, userId);
  const post = new Map(byKey);
  post.set(key, Math.max(post.get(key) ?? 0, hedge));
  let total = 0;
  for (const v of post.values()) total += v;
  if (total > plan.coverageCapUsd) {
    // (OBS-3) Rechazo por cap de plan. Solo escalares no sensibles (clave/total/cap/plan); NADA de cuenta.
    elog("coverage", "cap_rejected", {
      key, total: Number(total.toFixed(2)), cap: plan.coverageCapUsd, plan: plan.label,
    });
    throw new Error(
      `[blocked_margin] Supera el tope de cobertura del plan: ${total.toFixed(2)} > ${plan.coverageCapUsd} (${plan.label}).`);
  }
}

export async function assertWithinPlanCoverage(
  ctx: ReadCtx, userId: Id<"users">, poolId: Id<"pools">, hedge: number,
): Promise<void> {
  await assertWithinPlanCoverageForKey(ctx, userId, poolCoverageKey(poolId), hedge);
}

// (JAV-107) Cap RESTANTE para una clave — usado por el sizing capado de la defensa spot (cobertura
// parcial): cuánto nocional más admite el plan SIN contar lo ya consumido por ESA misma clave
// (re-reserva idempotente). `Infinity` = admin (sin tope). `0` = suspendido / sin plan (bloquea).
export async function remainingCoverageForKey(
  ctx: ReadCtx, userId: Id<"users">, key: string,
): Promise<number> {
  const user = await ctx.db.get(userId);
  if (!user) return 0;
  if (user.role === "admin") return Infinity;
  if (user.suspended === true) return 0;
  const plan = getPlan(user.subscriptionPlan);
  if (plan === null) return 0;
  const byKey = await consumedCoverageByKey(ctx, userId);
  let othersTotal = 0;
  for (const [k, v] of byKey) { if (k !== key) othersTotal += v; }
  return Math.max(0, plan.coverageCapUsd - othersTotal);
}

// Variante NO-lanzante para los gates de ENVÍO (markSubmitting/gateBeforeOrder/markArmSubmitting/
// gateArmBeforeOrder): cualquier excepción (cap, sin plan, suspendido, fila no cuantificable) → false
// = bloquear/terminalizar. Mantiene fail-closed sin propagar el throw fuera del gate.
export async function coverageAdmissibleForKey(
  ctx: ReadCtx, userId: Id<"users">, key: string | undefined, hedge: number | undefined,
): Promise<boolean> {
  if (!key || hedge === undefined) return false;   // fila in-flight sin datos fiables → fail-closed
  try {
    await assertWithinPlanCoverageForKey(ctx, userId, key, hedge);
    return true;
  } catch {
    return false;
  }
}

export async function coverageAdmissible(
  ctx: ReadCtx, userId: Id<"users">, poolId: Id<"pools"> | undefined, hedge: number | undefined,
): Promise<boolean> {
  return coverageAdmissibleForKey(ctx, userId, poolId ? poolCoverageKey(poolId) : undefined, hedge);
}
