import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getLimit } from "./executionLimits";
import { committedMarginForAccount, dailyNotionalUsed, assertLiveAdmissible } from "./executions";

// --- JAV-44 Etapa 1: máquina de estados del trigger_arm (lease/fencing como reconcileExecution) ---

const DAY_MS = 24 * 60 * 60 * 1000;
const MARGIN_SAFETY_BUFFER = 0.10;
export const ARM_RECONCILE_LEASE_MS = 60_000;
// Cuarentena N5/N6: desde el CAS (submittedAt) hasta el momento máximo en que una petición en vuelo
// puede aceptarse/hacerse visible en HL. Holgura generosa (vida máx. de action Convex + transporte),
// equivalente al ENTRY_GRACE_MS de JAV-43. Gobierna TODA terminalización de un arm que llegó a submitting.
export const ARM_SUBMIT_QUARANTINE_MS = 5 * 60_000;
// Plazo para recuperar un `arming` abandonado pre-CAS (la action murió entre reserva y CAS): nunca
// envió a HL, así que puede terminalizarse sin cuarentena tras este margen.
export const ARM_ARMING_RECOVERY_MS = 2 * 60_000;

// Terminalidad única (N3). Tras `closed` se permite nueva generación.
const ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);
// Transiciones permitidas (no degradar; no resucitar un terminal). Un `triggered` observado NO es
// un status persistido (se maneja sin transición en reconcileArm), por eso no aparece aquí.
const ALLOWED_ARM: Record<string, Set<string>> = {
  arming: new Set(["submitting", "failed", "disarmed"]),
  submitting: new Set(["armed", "filled", "unknown", "failed", "disarmed"]),
  armed: new Set(["filled", "disarming", "unknown", "disarmed", "failed"]),
  disarming: new Set(["disarmed", "filled", "unknown", "failed"]),
  filled: new Set(["closed"]),
  unknown: new Set(["armed", "filled", "disarmed", "failed", "closed"]),
};

function isArmTerminal(status: string): boolean {
  return ARM_TERMINAL.has(status);
}

// --- Helpers planos (invocables DIRECTAMENTE desde otras mutations; no via runMutation) ---

// ¿El bot tiene algún arm NO terminal? (bloquea borrados/pausas destructivas — H1/R4).
export async function hasNonTerminalArmForBot(ctx: MutationCtx, botId: Id<"bots">): Promise<boolean> {
  const arms = await ctx.db.query("trigger_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect();
  return arms.some((a) => !isArmTerminal(a.status));
}

// ¿La cuenta HL tiene algún arm NO terminal? (bloquea revocación de credencial — R4).
export async function hasNonTerminalArmForAccount(ctx: MutationCtx, hlAccountId: Id<"hl_api_credentials">): Promise<boolean> {
  const arms = await ctx.db.query("trigger_arms").withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId)).collect();
  return arms.some((a) => !isArmTerminal(a.status));
}

// Pausa segura (N2 + H1): si no hay arm vivo → desactiva YA; si lo hay → desiredState=disarmed +
// disarmPending (el cron cancela en HL y luego completa active=false). Devuelve si se desactivó ya.
export async function requestDisarmAndDeactivateImpl(ctx: MutationCtx, botId: Id<"bots">): Promise<{ deactivated: boolean }> {
  const bot = await ctx.db.get(botId);
  if (!bot) return { deactivated: false };
  const arms = await ctx.db.query("trigger_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect();
  const live = arms.filter((a) => !isArmTerminal(a.status));
  if (live.length === 0) {
    await ctx.db.patch(botId, { active: false, disarmPending: false });
    return { deactivated: true };
  }
  for (const a of live) {
    if (a.desiredState !== "disarmed") await ctx.db.patch(a._id, { desiredState: "disarmed", updatedAt: Date.now() });
  }
  await ctx.db.patch(botId, { disarmPending: true });
  return { deactivated: false };
}

// cloid determinista del arm: botId|generation|role (identidad primaria). Web Crypto (runtime Convex),
// NO Node `require`. Formato HL: "0x" + 32 hex (16 bytes).
export async function armCloid(botId: string, generation: number, role: string): Promise<string> {
  const data = new TextEncoder().encode(`${botId}:${generation}:${role}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return `0x${hex}`;
}

// --- Reserva atómica del arm (OCC): generación, unicidad, margen/daily compartidos con JAV-43 ---
export const reserveArm = internalMutation({
  args: {
    botId: v.id("bots"), userId: v.id("users"), hlAccountId: v.id("hl_api_credentials"),
    poolId: v.id("pools"), asset: v.string(), network: v.string(),
    triggerPx: v.number(), size: v.number(), appliedLeverage: v.number(),
    reservedNotional: v.number(), marginReserved: v.number(), lowerEdge: v.number(),
    availableCollateral: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.network !== "testnet") throw new Error("Etapa 1: solo testnet.");
    if (!(args.reservedNotional > 0) || !(args.marginReserved > 0) || !(args.size > 0)) {
      throw new Error("reservedNotional/marginReserved/size deben ser > 0");
    }
    if (!(args.availableCollateral >= 0)) throw new Error("availableCollateral inválido");

    // (1) Unicidad: una sola generación NO terminal por bot.
    const arms = await ctx.db
      .query("trigger_arms")
      .withIndex("by_bot_generation", (q) => q.eq("botId", args.botId))
      .collect();
    const liveArm = arms.find((a) => !isArmTerminal(a.status));
    if (liveArm) {
      throw new Error("Ya existe un armado activo para este bot (una generación no terminal).");
    }
    // (2) generation = max+1 (backend).
    const generation = arms.reduce((m, a) => Math.max(m, a.generation), 0) + 1;

    // (3) Límites compartidos con JAV-43: por orden + diario + margen por cuenta (misma OCC).
    const maxPerOrder = await getLimit(ctx, "maxNotionalPerOrder");
    const maxDaily = await getLimit(ctx, "maxNotionalPerUserDaily");
    if (args.reservedNotional > maxPerOrder) {
      throw new Error(`Nocional ${args.reservedNotional} supera el máximo por orden (${maxPerOrder}).`);
    }
    const dailyUsed = await dailyNotionalUsed(ctx, args.userId, Date.now() - DAY_MS);
    if (dailyUsed + args.reservedNotional > maxDaily) {
      throw new Error(`Volumen diario excedido: ${dailyUsed} + ${args.reservedNotional} > ${maxDaily}.`);
    }
    const marginCommitted = await committedMarginForAccount(ctx, args.hlAccountId);
    if ((marginCommitted + args.marginReserved) > args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER)) {
      throw new Error(
        `Margen insuficiente: comprometido ${marginCommitted.toFixed(2)} + requerido ` +
        `${args.marginReserved.toFixed(2)} > colateral ${args.availableCollateral.toFixed(2)}.`);
    }

    // (4) Insertar arm (arming) + trigger_order (pending, SIN submittedAt — se fija en el CAS).
    const now = Date.now();
    const cloid = await armCloid(args.botId, generation, "entry_lower");
    const armId = await ctx.db.insert("trigger_arms", {
      botId: args.botId, userId: args.userId, hlAccountId: args.hlAccountId, poolId: args.poolId,
      asset: args.asset, network: args.network, generation, status: "arming", desiredState: "armed",
      side: "Short", triggerPx: args.triggerPx, size: args.size, appliedLeverage: args.appliedLeverage,
      reservedNotional: args.reservedNotional, marginReserved: args.marginReserved, lowerEdge: args.lowerEdge,
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("trigger_orders", {
      armId, role: "entry_lower", cloid, oid: undefined, triggerPx: args.triggerPx, size: args.size,
      reduceOnly: false, observedStatus: "pending", createdAt: now, updatedAt: now,
    });
    return { armId, generation, cloid };
  },
});

// --- CAS pre-envío (N1/N5): arming → submitting, fija submittedAt, valida intención y gates ---
export const markArmSubmitting = internalMutation({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const, reason: "not_found" as const };
    if (arm.status !== "arming") return { ok: false as const, reason: "state" as const };
    // CAS: solo si la intención sigue siendo armar y no se está pausando.
    if (arm.desiredState !== "armed") return { ok: false as const, reason: "disarmed" as const };
    const bot = await ctx.db.get(arm.botId);
    if (!bot || !bot.active || bot.disarmPending) return { ok: false as const, reason: "blocked" as const };
    // (Fix #6) Revalidar TODOS los gates de admisión JUSTO antes del envío (revoca/switch/sim/
    // ownership/cuenta cambió entre reserveArm y el CAS): reutiliza assertLiveAdmissible de JAV-43.
    if (!(await assertLiveAdmissible(ctx, arm.userId, arm.botId, arm.hlAccountId))) {
      return { ok: false as const, reason: "blocked" as const };
    }
    if (bot.kind !== "il" || bot.direction !== "short") return { ok: false as const, reason: "blocked" as const };
    if (bot.poolId !== arm.poolId) return { ok: false as const, reason: "blocked" as const };
    const pool = await ctx.db.get(arm.poolId);
    if (!pool || pool.closed) return { ok: false as const, reason: "blocked" as const };
    if (arm.network !== "testnet") return { ok: false as const, reason: "blocked" as const };
    const now = Date.now();
    const token = crypto.randomUUID();
    await ctx.db.patch(armId, {
      status: "submitting", submittedAt: now, updatedAt: now,
      reconcileLeaseUntil: now + ARM_RECONCILE_LEASE_MS, reconcileLeaseToken: token,
    });
    return { ok: true as const, token };
  },
});

// --- Transición genérica con fencing + cuarentena N6 + finalización de pausa N2 ---
export const settleArm = internalMutation({
  args: {
    armId: v.id("trigger_arms"),
    status: v.union(
      v.literal("submitting"), v.literal("armed"), v.literal("disarming"), v.literal("disarmed"),
      v.literal("filled"), v.literal("closed"), v.literal("unknown"), v.literal("failed")),
    token: v.optional(v.string()),
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const arm = await ctx.db.get(args.armId);
    if (!arm) return { ok: false as const };
    // Fencing: bajo claim, solo el dueño con lease vigente.
    if (args.token !== undefined &&
        (arm.reconcileLeaseToken !== args.token || (arm.reconcileLeaseUntil ?? 0) <= Date.now())) {
      return { ok: false as const };
    }
    if (isArmTerminal(arm.status)) return { ok: false as const };
    const allowed = ALLOWED_ARM[arm.status];
    if (!allowed || !allowed.has(args.status)) return { ok: false as const };

    // (N6) Cuarentena: toda terminalización de un arm que YA alcanzó submitting (tiene submittedAt)
    // se subordina a la cuarentena. Antes del plazo, una petición tardía aún podría aparecer.
    if (ARM_TERMINAL.has(args.status) && arm.submittedAt != null
        && Date.now() - arm.submittedAt <= ARM_SUBMIT_QUARANTINE_MS) {
      return { ok: false as const, quarantined: true as const };
    }

    const now = Date.now();
    const patch: Record<string, unknown> = { status: args.status, updatedAt: now };
    for (const k of ["filledSize", "entryPrice", "error"] as const) {
      if (args[k] !== undefined) patch[k] = args[k];
    }
    await ctx.db.patch(args.armId, patch);

    // (N2) Finalización de la pausa: al alcanzar terminal con disarmPending, completar active=false.
    if (ARM_TERMINAL.has(args.status)) {
      const bot = await ctx.db.get(arm.botId);
      if (bot?.disarmPending) {
        await ctx.db.patch(arm.botId, { active: false, disarmPending: false });
      }
    }
    return { ok: true as const };
  },
});

// --- Claim/renew/release del lease de reconciliación (anti-carrera cron vs action) ---
export const claimArmReconcile = internalMutation({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { claimed: false as const, reason: "not_found" as const };
    if (isArmTerminal(arm.status)) return { claimed: false as const, reason: "terminal" as const };
    if ((arm.reconcileLeaseUntil ?? 0) > Date.now()) return { claimed: false as const, reason: "leased" as const };
    const token = crypto.randomUUID();
    await ctx.db.patch(armId, {
      reconcileLeaseUntil: Date.now() + ARM_RECONCILE_LEASE_MS, reconcileLeaseToken: token, updatedAt: Date.now(),
    });
    return { claimed: true as const, token };
  },
});

export const renewArmReconcile = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || isArmTerminal(arm.status)) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + ARM_RECONCILE_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const releaseArmReconcile = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token) return;
    await ctx.db.patch(armId, { reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: Date.now() });
  },
});

// --- Pausa segura (N2 + H1): si no hay arm vivo → desactivar YA; si lo hay → disarmPending + cron ---
export const requestDisarmAndDeactivate = internalMutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const r = await requestDisarmAndDeactivateImpl(ctx, botId);
    return { ok: true as const, deactivated: r.deactivated };
  },
});

// --- Recuperación de `arming` abandonado pre-CAS (N7): nunca envió → failed sin cuarentena ---
export const recoverAbandonedArming = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.status !== "arming" || arm.submittedAt != null) return { ok: false as const };
    // Se llama BAJO el claim de reconcileArm: verificar propiedad del lease (no rechazar por tenerlo).
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    // Solo recuperar tras el plazo: un arming muy reciente puede ser una action aún viva pre-CAS.
    if (Date.now() - arm.createdAt <= ARM_ARMING_RECOVERY_MS) return { ok: false as const, tooRecent: true as const };
    await ctx.db.patch(armId, { status: "failed", error: "arming abandonado pre-CAS (nunca envió)", updatedAt: Date.now() });
    const bot = await ctx.db.get(arm.botId);
    if (bot?.disarmPending) await ctx.db.patch(arm.botId, { active: false, disarmPending: false });
    return { ok: true as const };
  },
});

// --- Queries internas para el motor/cron ---
export const getArmInternal = internalQuery({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) => ctx.db.get(armId),
});

export const getArmOrderInternal = internalQuery({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) =>
    ctx.db.query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "entry_lower")).first(),
});

export const listReconcilableArmsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const arms = await ctx.db.query("trigger_arms").withIndex("by_status_updated").collect();
    return arms.filter((a) => !isArmTerminal(a.status)).slice(0, limit ?? 50).map((a) => a._id);
  },
});

export const setArmOrderObserved = internalMutation({
  args: {
    armId: v.id("trigger_arms"), token: v.string(),
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    oid: v.optional(v.string()),
  },
  handler: async (ctx, { armId, token, observedStatus, oid }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const order = await ctx.db
      .query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "entry_lower")).first();
    if (!order) return { ok: false as const };
    const patch: Record<string, unknown> = { observedStatus, updatedAt: Date.now() };
    if (oid !== undefined) patch.oid = oid;
    await ctx.db.patch(order._id, patch);
    return { ok: true as const };
  },
});
