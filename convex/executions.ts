import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// Lease anti-carrera: la reconciliación no toca pending/submitting con updatedAt más reciente.
export const LEASE_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Defaults conservadores si la clave no está en system_config.
const DEFAULTS: Record<string, number> = {
  maxNotionalPerOrder: 500,
  maxNotionalPerUserDaily: 2000,
  slBufferPct: 0.3,
};

async function getLimit(ctx: QueryCtx | MutationCtx, key: string): Promise<number> {
  const row = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const val = typeof row?.value === "number" ? row.value : DEFAULTS[key];
  if (!Number.isFinite(val) || val <= 0) throw new Error(`${key} inválido`);
  return val;
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
    side: v.union(v.literal("Long"), v.literal("Short")),
    network: v.string(),
    entryCloid: v.string(),
    slCloid: v.string(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.notional) || args.notional <= 0) {
      throw new Error("notional debe ser un número finito > 0");
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
    const recent = await ctx.db
      .query("execution_requests")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId).gte("createdAt", since))
      .collect();
    const dailyUsed = recent
      .filter((r) => VOLUME_STATES.has(r.status))
      .reduce((sum, r) => sum + r.notional, 0);
    if (dailyUsed + args.notional > maxDaily) {
      throw new Error(`Volumen diario excedido: ${dailyUsed} + ${args.notional} > ${maxDaily}.`);
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
    await ctx.db.patch(requestId, { slCloid: newSlCloid, slAttempt: attempt, updatedAt: Date.now() });
    return { ok: true };
  },
});

// Marca `submitting` con timestamp de lease, justo antes de enviar la entrada a HL.
export const markSubmitting = internalMutation({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => {
    const now = Date.now();
    await ctx.db.patch(requestId, { status: "submitting", submittedAt: now, updatedAt: now });
  },
});

// Transición de estado atómica + log final único en trades_history.
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
    error: v.optional(v.string()),
    token: v.optional(v.string()),   // si se provee (transiciones bajo claim), debe ser el dueño
  },
  handler: async (ctx, args) => {
    const req = await ctx.db.get(args.requestId);
    if (!req) throw new Error("execution_request no encontrada");
    // Fencing: una transición bajo claim solo aplica si el token es el dueño actual Y el lease
    // sigue vigente (no persistir tras vencer, aunque nadie haya reemplazado el token todavía).
    if (args.token !== undefined &&
        (req.reconcileLeaseToken !== args.token || (req.reconcileLeaseUntil ?? 0) <= Date.now())) return;
    // Idempotencia + transiciones permitidas: no sobrescribir un final ni degradar un estado.
    if (FINAL_STATES.has(req.status)) return;
    const allowed = ALLOWED[req.status];
    if (!allowed || !allowed.has(args.status)) return;
    const patch: Record<string, unknown> = { status: args.status, updatedAt: Date.now() };
    for (const k of ["entryOrderId", "slOrderId", "filledSize", "entryPrice", "error"] as const) {
      if (args[k] !== undefined) patch[k] = args[k];
    }
    // Log final una sola vez, solo en estados terminales.
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
  },
});

export const getRequestInternal = internalQuery({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => await ctx.db.get(requestId),
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
