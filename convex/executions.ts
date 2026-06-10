import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getLimit } from "./executionLimits";
import { hasPermission, requireAdmin } from "./helpers";

// Lease anti-carrera: la reconciliación no toca pending/submitting con updatedAt más reciente.
export const LEASE_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Revalidación autoritativa de la admisión: master switch global + permiso canTradeLive (bypass
// admin) + estado del bot (ownership, activo, real, misma cuenta). Si algo cambió durante la
// action (revocación, kill switch, pausa, vuelta a simulación, cambio de cuenta) → no admisible.
async function assertLiveAdmissible(
  ctx: QueryCtx | MutationCtx, userId: Id<"users">, botId: Id<"bots">, hlAccountId: Id<"hl_api_credentials">,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  if (!user) return false;
  const [trading, sim] = await Promise.all([
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "tradingEnabled")).first(),
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "simulationMode")).first(),
  ]);
  if (trading?.value !== true || sim?.value !== false) return false;
  if (!(await hasPermission(ctx, user, "canTradeLive"))) return false;
  const bot = await ctx.db.get(botId);
  if (!bot || bot.userId !== userId || !bot.active || bot.simulationMode) return false;
  if (bot.hlAccountId !== hlAccountId) return false;   // la cuenta no cambió bajo la solicitud
  return true;
}

// Estados que cuentan como volumen operado (todos menos `failed`).
const VOLUME_STATES = new Set([
  "pending", "submitting", "entry_filled", "protected", "sl_failed", "closed", "unknown",
]);
// Estados FINALES inmutables (con o sin posición resuelta). `protected` NO es final:
// el cron lo reconcilia para detectar que el SL se ejecutó (→ closed) y liberar la cuenta.
const FINAL_STATES = new Set(["closed", "failed"]);
// Solo los finales reales registran en trades_history (evita un log obsoleto en protected).
const TERMINAL_HISTORY = new Set(["closed", "failed"]);

// Lease del claim exclusivo de reconciliación (anti-carrera entre cron y reintento).
export const RECONCILE_LEASE_MS = 60_000;

// Transiciones permitidas: evita degradar un estado (p. ej. protected → sl_failed).
const ALLOWED: Record<string, Set<string>> = {
  pending: new Set(["submitting", "entry_filled", "protected", "sl_failed", "closed", "unknown", "failed"]),
  submitting: new Set(["entry_filled", "protected", "sl_failed", "closed", "unknown", "failed"]),
  unknown: new Set(["entry_filled", "protected", "sl_failed", "closed", "failed"]),
  entry_filled: new Set(["protected", "sl_failed", "closed"]),
  sl_failed: new Set(["protected", "closed", "sl_failed"]),
  protected: new Set(["closed"]),   // nunca degradar a sl_failed
};

// Reserva atómica (OCC) de idempotency + nocional, ANTES de tocar HL.
// Margen de seguridad sobre el colateral disponible (cota conservadora; HL es autoridad final).
const MARGIN_SAFETY_BUFFER = 0.10;
// Estados que mantienen margen comprometido en la cuenta (todos menos los finales).
const OPEN_MARGIN_STATES = new Set([
  "pending", "submitting", "entry_filled", "protected", "sl_failed", "unknown",
]);
// JAV-44: estados de un trigger_arm que mantienen margen comprometido (todos menos ARM_TERMINAL).
// ARM_TERMINAL = { disarmed, closed, failed }.
const ARM_OPEN_MARGIN_STATES = new Set([
  "arming", "submitting", "armed", "disarming", "filled", "unknown",
]);

// Margen comprometido en una cuenta HL sumando AMBOS motores (IOC manual + triggers automáticos),
// para que ninguna reserva pueda gastar dos veces el mismo colateral. Helper plano reutilizado por
// `reserveExecution` (JAV-43) y por la reserva del arm (JAV-44) dentro de su misma mutation OCC.
export async function committedMarginForAccount(
  ctx: MutationCtx, hlAccountId: Id<"hl_api_credentials">,
): Promise<number> {
  const exec = await ctx.db
    .query("execution_requests")
    .withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId))
    .collect();
  const execMargin = exec
    .filter((r) => OPEN_MARGIN_STATES.has(r.status))
    .reduce((sum, r) => sum + (r.marginReserved ?? r.notional), 0);
  const arms = await ctx.db
    .query("trigger_arms")
    .withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId))
    .collect();
  const armMargin = arms
    .filter((a) => ARM_OPEN_MARGIN_STATES.has(a.status))
    .reduce((sum, a) => sum + (a.marginReserved ?? a.reservedNotional), 0);
  return execMargin + armMargin;
}

// Nocional usado en las últimas 24h por un usuario sumando AMBOS motores (límite diario compartido).
export async function dailyNotionalUsed(
  ctx: MutationCtx, userId: Id<"users">, since: number,
): Promise<number> {
  const recent = await ctx.db
    .query("execution_requests")
    .withIndex("by_user_created", (q) => q.eq("userId", userId).gte("createdAt", since))
    .collect();
  const execUsed = recent
    .filter((r) => VOLUME_STATES.has(r.status))
    .reduce((sum, r) => sum + r.notional, 0);
  const recentArms = await ctx.db
    .query("trigger_arms")
    .withIndex("by_user_created", (q) => q.eq("userId", userId).gte("createdAt", since))
    // cuenta el nocional de arms vivos o llenos (no los liberados sin efecto: disarmed/failed)
    .collect();
  const armUsed = recentArms
    .filter((a) => a.status !== "disarmed" && a.status !== "failed")
    .reduce((sum, a) => sum + a.reservedNotional, 0);
  return execUsed + armUsed;
}

// Dedupe-check ligero ANTES de los gates de modo/margen (evita que un reintento de una
// solicitud existente falle por saldo/modo actuales antes de poder reconciliarse).
export const findByIdempotency = internalQuery({
  args: { userId: v.id("users"), idempotencyKey: v.string() },
  handler: async (ctx, { userId, idempotencyKey }) => {
    return await ctx.db
      .query("execution_requests")
      .withIndex("by_user_idempotency", (q) => q.eq("userId", userId).eq("idempotencyKey", idempotencyKey))
      .first();
  },
});

export const reserveExecution = internalMutation({
  args: {
    userId: v.id("users"),
    botId: v.id("bots"),
    idempotencyKey: v.string(),
    hlAccountId: v.id("hl_api_credentials"),
    asset: v.string(),
    stopLossPct: v.number(),
    requestedAmount: v.number(),
    notional: v.number(),
    marginRequired: v.number(),       // notional/leverage de ESTA ejecución
    availableCollateral: v.number(),  // colateral snapshot (USDC spot libre) — sin doble conteo
    side: v.union(v.literal("Long"), v.literal("Short")),
    network: v.string(),
    entryCloid: v.string(),
    slCloid: v.string(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.notional) || args.notional <= 0) {
      throw new Error("notional debe ser un número finito > 0");
    }
    if (!Number.isFinite(args.marginRequired) || args.marginRequired <= 0) {
      throw new Error("marginRequired debe ser un número finito > 0");
    }
    if (!Number.isFinite(args.availableCollateral) || args.availableCollateral < 0) {
      throw new Error("availableCollateral debe ser un número finito >= 0");
    }
    // (0) Admisión autoritativa: revalida switches + canTradeLive + estado del bot en la misma
    // mutation que reserva, cerrando la ventana entre la validación de la action y la reserva.
    if (!(await assertLiveAdmissible(ctx, args.userId, args.botId, args.hlAccountId))) {
      throw new Error("Ejecución no admisible: switch/permiso/estado del bot cambió.");
    }
    // (1) Dedupe: misma clave del mismo usuario. Se compara el `requestedAmount` solicitado
    // (estable), NO el nocional efectivo (que depende del markPx cambiante entre reintentos).
    const existing = await ctx.db
      .query("execution_requests")
      .withIndex("by_user_idempotency", (q) =>
        q.eq("userId", args.userId).eq("idempotencyKey", args.idempotencyKey))
      .first();
    if (existing) {
      const same = existing.botId === args.botId && existing.side === args.side
        && existing.network === args.network && existing.requestedAmount === args.requestedAmount;
      if (!same) throw new Error("Conflicto de idempotencia: la clave ya existe con otros parámetros.");
      return { requestId: existing._id, status: existing.status, alreadyExists: true };
    }
    // (2) Límites: por orden y volumen diario (rolling 24h, estados no-`failed`).
    const maxPerOrder = await getLimit(ctx, "maxNotionalPerOrder");
    const maxDaily = await getLimit(ctx, "maxNotionalPerUserDaily");
    if (args.notional > maxPerOrder) {
      throw new Error(`Nocional ${args.notional} supera el máximo por orden (${maxPerOrder}).`);
    }
    const since = Date.now() - DAY_MS;
    // Límite diario COMPARTIDO entre ambos motores (IOC manual + triggers automáticos JAV-44).
    const dailyUsed = await dailyNotionalUsed(ctx, args.userId, since);
    if (dailyUsed + args.notional > maxDaily) {
      throw new Error(`Volumen diario excedido: ${dailyUsed} + ${args.notional} > ${maxDaily}.`);
    }
    // (2b) Reserva de margen ATÓMICA por cuenta (anti-carrera). Esta mutation serializa, así que
    // dos ejecuciones concurrentes de la misma cuenta se contabilizan una tras otra. Se suma el
    // margen ya comprometido por AMBOS motores en la cuenta + el de esta; debe caber en el
    // colateral disponible (snapshot) con un buffer de seguridad.
    const marginCommitted = await committedMarginForAccount(ctx, args.hlAccountId);
    if ((marginCommitted + args.marginRequired) > args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER)) {
      throw new Error(
        `Margen insuficiente en la cuenta: comprometido ${marginCommitted.toFixed(2)} + requerido ` +
        `${args.marginRequired.toFixed(2)} > colateral ${args.availableCollateral.toFixed(2)} (buffer ${MARGIN_SAFETY_BUFFER * 100}%).`);
    }
    // (3) Reservar en estado pending.
    const now = Date.now();
    const requestId = await ctx.db.insert("execution_requests", {
      userId: args.userId,
      botId: args.botId,
      idempotencyKey: args.idempotencyKey,
      hlAccountId: args.hlAccountId,
      asset: args.asset,
      stopLossPct: args.stopLossPct,
      requestedAmount: args.requestedAmount,
      notional: args.notional,
      marginReserved: args.marginRequired,
      side: args.side,
      status: "pending",
      network: args.network,
      entryCloid: args.entryCloid,
      slCloid: args.slCloid,
      slAttempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { requestId, status: "pending" as const, alreadyExists: false };
  },
});

// Claim exclusivo de reconciliación (CAS, OCC): solo un reconciliador trabaja a la vez.
// Respeta el lease de la action que envía (pending/submitting recientes) y un final.
export const claimReconcile = internalMutation({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get(requestId);
    if (!req) return { claimed: false as const, reason: "not_found" };
    if (FINAL_STATES.has(req.status)) return { claimed: false as const, reason: "final" };
    const now = Date.now();
    if ((req.status === "pending" || req.status === "submitting") && now - req.updatedAt < LEASE_MS) {
      return { claimed: false as const, reason: "active" };
    }
    if (req.reconcileLeaseUntil && req.reconcileLeaseUntil > now) {
      return { claimed: false as const, reason: "locked" };
    }
    const token = crypto.randomUUID();   // fencing token: identifica al dueño del claim
    await ctx.db.patch(requestId, { reconcileLeaseUntil: now + RECONCILE_LEASE_MS, reconcileLeaseToken: token });
    return { claimed: true as const, token };
  },
});

// Libera solo si el token coincide (un claim vencido y re-tomado por otro NO se libera por error).
export const releaseReconcile = internalMutation({
  args: { requestId: v.id("execution_requests"), token: v.string() },
  handler: async (ctx, { requestId, token }) => {
    const req = await ctx.db.get(requestId);
    if (req && req.reconcileLeaseToken === token) {
      await ctx.db.patch(requestId, { reconcileLeaseUntil: 0, reconcileLeaseToken: undefined });
    }
  },
});

// Renueva el lease justo antes de un efecto externo (placeStopLoss). Falla si el token ya no es
// nuestro o el lease venció → el proceso debe abortar sin enviar nada a HL.
export const renewReconcile = internalMutation({
  args: { requestId: v.id("execution_requests"), token: v.string() },
  handler: async (ctx, { requestId, token }) => {
    const req = await ctx.db.get(requestId);
    if (!req || FINAL_STATES.has(req.status)) return { ok: false };
    if (req.reconcileLeaseToken !== token || (req.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false };
    await ctx.db.patch(requestId, { reconcileLeaseUntil: Date.now() + RECONCILE_LEASE_MS });
    return { ok: true };
  },
});

// Persiste un nuevo slCloid (por intento) antes de recolocar el SL. CAS con fencing: solo si el
// token sigue siendo nuestro, el estado no es final y el intento es exactamente el siguiente.
export const prepareSlRetry = internalMutation({
  args: { requestId: v.id("execution_requests"), token: v.string(), newSlCloid: v.string(), attempt: v.number() },
  handler: async (ctx, { requestId, token, newSlCloid, attempt }) => {
    const req = await ctx.db.get(requestId);
    if (!req || FINAL_STATES.has(req.status)) return { ok: false };
    if (req.reconcileLeaseToken !== token || (req.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false };
    if (attempt !== (req.slAttempt ?? 0) + 1) return { ok: false };
    // Limpiar slSubmittedAt al rotar el CLOID: el marcador pertenecía al cloid anterior; si no se
    // borra, el grace anti-doble-SL se aplicaría a un cloid NUEVO aún no enviado, retrasando la
    // protección. Se vuelve a fijar solo cuando el nuevo intento se acepte (resting/pending).
    await ctx.db.patch(requestId, { slCloid: newSlCloid, slAttempt: attempt, slSubmittedAt: undefined, updatedAt: Date.now() });
    return { ok: true };
  },
});

// Marca `submitting` con timestamp de lease, justo antes de enviar la entrada a HL.
export const markSubmitting = internalMutation({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get(requestId);
    if (!req) return { ok: false as const, reason: "not_found" as const };
    // CAS: solo desde `pending`. Si otro proceso (cron) ya avanzó/cerró la solicitud, NO re-enviar
    // (evita resucitar un failed/entry_filled a submitting). Es carrera de estado, no rechazo.
    if (req.status !== "pending") return { ok: false as const, reason: "state" as const };
    // Último gate antes del envío: switch/permiso/estado del bot. Si cambió → no marcar.
    if (!(await assertLiveAdmissible(ctx, req.userId, req.botId, req.hlAccountId))) {
      return { ok: false as const, reason: "blocked" as const };
    }
    const now = Date.now();
    await ctx.db.patch(requestId, { status: "submitting", submittedAt: now, updatedAt: now });
    return { ok: true as const };
  },
});

// Transición de estado atómica + log final único en trades_history.
type TransitionArgs = {
  requestId: Id<"execution_requests">;
  status: "entry_filled" | "protected" | "sl_failed" | "closed" | "unknown" | "failed";
  entryOrderId?: string; slOrderId?: string; filledSize?: number; entryPrice?: number;
  slSubmittedAt?: number; error?: string; token?: string;
};

// Lógica de transición compartida (fencing + ALLOWED + log final único). Reutilizada por
// settleExecution y gateBeforeOrder (cierre CAS atómico).
async function applyTransition(ctx: MutationCtx, args: TransitionArgs): Promise<void> {
  const req = await ctx.db.get(args.requestId);
  if (!req) throw new Error("execution_request no encontrada");
  // Fencing: una transición bajo claim solo aplica si el token es el dueño actual Y el lease vigente.
  if (args.token !== undefined &&
      (req.reconcileLeaseToken !== args.token || (req.reconcileLeaseUntil ?? 0) <= Date.now())) return;
  // Idempotencia + transiciones permitidas: no sobrescribir un final ni degradar un estado.
  if (FINAL_STATES.has(req.status)) return;
  const allowed = ALLOWED[req.status];
  if (!allowed || !allowed.has(args.status)) return;
  const patch: Record<string, unknown> = { status: args.status, updatedAt: Date.now() };
  for (const k of ["entryOrderId", "slOrderId", "filledSize", "entryPrice", "slSubmittedAt", "error"] as const) {
    if (args[k] !== undefined) patch[k] = args[k];
  }
  if (TERMINAL_HISTORY.has(args.status) && !req.historyRecorded) {
    const bot = await ctx.db.get(req.botId);
    const asset = req.asset;                    // snapshot inmutable
    await ctx.db.insert("trades_history", {
      userId: req.userId,
      action: `HL ${req.side} ${asset} [${args.status}]`,
      asset,
      amount: req.notional,
      price: args.entryPrice ?? req.entryPrice ?? 0,
      simulated: false,
      network: req.network,
      timestamp: Date.now(),
      botId: req.botId,
      botName: bot?.name,
      triggerType: "auto",
      exchangeStatus: args.status,
      orderId: args.entryOrderId ?? req.entryOrderId,
      source: "hl_execution",
    });
    patch.historyRecorded = true;
  }
  await ctx.db.patch(args.requestId, patch);
}

export const settleExecution = internalMutation({
  args: {
    requestId: v.id("execution_requests"),
    status: v.union(
      v.literal("entry_filled"), v.literal("protected"), v.literal("sl_failed"),
      v.literal("closed"), v.literal("unknown"), v.literal("failed")),
    entryOrderId: v.optional(v.string()),
    slOrderId: v.optional(v.string()),
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    slSubmittedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    token: v.optional(v.string()),   // si se provee (transiciones bajo claim), debe ser el dueño
  },
  handler: async (ctx, args) => { await applyTransition(ctx, args); },
});

/**
 * Marca `slSubmittedAt` SIN cambiar de estado (caso waitingForTrigger/waitingForFill/timeout: SL
 * aceptado o incierto pero aún sin oid). Deja el estado en `entry_filled` para que el cron lo
 * confirme por CLOID; el marcador evita recolocar un 2º SL durante el lag de `unknownOid`. Requiere
 * ser dueño del claim (fencing por token + lease vigente) y que el estado no sea final.
 * @returns `{ ok: true }` si se persistió; `{ ok: false }` si se perdió el claim o el estado es final.
 */
export const markSlSubmitted = internalMutation({
  args: { requestId: v.id("execution_requests"), token: v.string() },
  handler: async (ctx, { requestId, token }) => {
    const req = await ctx.db.get(requestId);
    if (!req) return { ok: false as const };
    if (req.reconcileLeaseToken !== token || (req.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (FINAL_STATES.has(req.status)) return { ok: false as const };
    await ctx.db.patch(requestId, { slSubmittedAt: Date.now(), updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Decisión ATÓMICA del último gate antes de exchange.order. Distingue:
//  - state/expired/claimed: otro proceso (cron) tomó el control → abortar sin tocar la solicitud.
//  - blocked: sigue submitting, lease vigente, sin claim, pero autorización/bot inválido →
//    cerrar failed por CAS en la MISMA mutation (no compite con el reconciliador).
export const gateBeforeOrder = internalMutation({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get(requestId);
    if (!req || req.status !== "submitting") return { ok: false as const, reason: "state" as const };
    if (Date.now() - req.updatedAt >= LEASE_MS) return { ok: false as const, reason: "expired" as const };
    if (req.reconcileLeaseUntil && req.reconcileLeaseUntil > Date.now()) return { ok: false as const, reason: "claimed" as const };
    if (!(await assertLiveAdmissible(ctx, req.userId, req.botId, req.hlAccountId))) {
      await applyTransition(ctx, { requestId, status: "failed", error: "blocked before order (switch/permiso/estado bot)" });
      return { ok: false as const, reason: "blocked" as const };
    }
    // Renovar el lease del submitting: el cron no debe reclamar mientras exchange.order está en
    // vuelo (≤ HL_ORDER_TIMEOUT_MS). Renovar aquí cubre el envío con otros LEASE_MS.
    await ctx.db.patch(requestId, { updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const getRequestInternal = internalQuery({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => await ctx.db.get(requestId),
});

// Observabilidad admin: últimas ejecuciones con quién/qué/dónde para diagnosticar fallos.
export const listRecentExecutions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 100 }) => {
    await requireAdmin(ctx);
    const clamped = Math.min(Math.max(limit, 1), 100);
    const rows = await ctx.db
      .query("execution_requests")
      .withIndex("by_created")
      .order("desc")
      .take(clamped);
    const out = [];
    for (const r of rows) {
      const [user, bot, cred] = await Promise.all([
        ctx.db.get(r.userId), ctx.db.get(r.botId), ctx.db.get(r.hlAccountId),
      ]);
      out.push({
        requestId: r._id, status: r.status, error: r.error ?? null,
        userId: r.userId, email: user?.email ?? null,
        botId: r.botId, botName: bot?.name ?? null,
        hlAccountId: r.hlAccountId, account: cred?.label ?? null,
        accountAddress: cred?.tradingAccountAddress ?? null, network: r.network,
        asset: r.asset, side: r.side, notional: r.notional,
        filledSize: r.filledSize ?? null, entryPrice: r.entryPrice ?? null,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      });
    }
    return out;
  },
});

// Para el cron: solicitudes no-terminales cuyo lease ya expiró (updatedAt antiguo).
export const listReconcilableInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - LEASE_MS;
    // Incluye `protected`: el cron lo revisa para detectar el cierre del SL (→ closed) y
    // liberar la cuenta (revocable). Sin esto, una cuenta quedaría bloqueada hasta 3b.
    const states = ["pending", "submitting", "entry_filled", "unknown", "sl_failed", "protected"] as const;
    const out: { requestId: Id<"execution_requests"> }[] = [];
    for (const s of states) {
      const rows = await ctx.db
        .query("execution_requests")
        .withIndex("by_status_created", (q) => q.eq("status", s))
        .collect();
      for (const r of rows) {
        if (r.updatedAt < cutoff) out.push({ requestId: r._id });
      }
    }
    return out;
  },
});
