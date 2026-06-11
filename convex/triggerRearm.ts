import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// --- JAV-44 auto-rearm durable (Codex GO) ---
// Estado persistente del re-armado tras un cierre por SL, en la tabla `bots`. El cron lo reclama con
// lease, revalida TODOS los gates (armBotInternal) y reabre la cobertura. Política de Codex:
//  - técnico/transitorio → pending, reintento indefinido cada 5 min (nunca abandona por error técnico)
//  - pausa/kill/pool cerrado → cancel (el bot no debe operar)
//  - margen/config → blocked, reevaluable cada 5 min + alerta
//  - posición/órdenes incompatibles → pending, reintento + alerta (estado externo/residual)
// El rearm se PROGRAMA en triggerArms.closeArmAndScheduleRearm (atómico con el cierre del arm) y se
// CONSUME en triggerArms.reserveArm (atómico con la creación de la generación). Aquí van el claim del
// cron, el registro de resultado, y la alerta de whipsaw.

// Cooldown entre el cierre por SL y el rearm. 5 min (directriz del usuario). Durante este lapso el pool
// queda SIN short deliberadamente; "nunca desprotegido" = ningún fallo técnico abandona el rearm.
export const REARM_COOLDOWN_MS = 5 * 60_000;
export const REARM_RETRY_MS = 5 * 60_000;           // reintento transitorio (forzado, indefinido)
export const REARM_BLOCKED_RECHECK_MS = 5 * 60_000; // reevaluación de un bloqueo corregible
// (Codex #3) Lease del armado: cubre el peor caso (2 órdenes de 30s + Info + leverage + mutaciones).
export const REARM_LEASE_MS = 5 * 60_000;
export const STOP_ALERT_THRESHOLD = 5;              // SL consecutivos → alerta de whipsaw

export type RearmErrorKind = "transient" | "blocked_margin" | "blocked_config" | "retry_incompatible" | "cancel";

// Extrae el [kind] del prefijo del mensaje de error de armBotInternal/reserveArm. Sin prefijo conocido
// → "transient" (default SEGURO: un error no clasificado nunca abandona el rearm, solo reintenta).
export function armErrorKind(message: string): RearmErrorKind {
  const m = /^\[(transient|blocked_margin|blocked_config|retry_incompatible|cancel)\]/.exec(message);
  return (m?.[1] as RearmErrorKind | undefined) ?? "transient";
}

// Claim del rearm por el cron (lease, un worker a la vez). pending/blocked = trabajo normal; running con
// lease vencido = recuperación de un worker muerto. Devuelve el token + userId (armBotInternal sin auth).
export const claimRearm = internalMutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return { ok: false as const, reason: "not_found" as const };
    if (bot.rearmStatus !== "pending" && bot.rearmStatus !== "blocked" && bot.rearmStatus !== "running") {
      return { ok: false as const, reason: "state" as const };
    }
    if ((bot.rearmLeaseUntil ?? 0) > Date.now()) return { ok: false as const, reason: "leased" as const };
    // pending/blocked respetan el cooldown; un "running" con lease vencido se reclama ya (recuperación).
    if (bot.rearmStatus !== "running" && (bot.nextRearmAt ?? 0) > Date.now()) return { ok: false as const, reason: "cooldown" as const };
    if (!bot.userId) return { ok: false as const, reason: "no_user" as const };
    const token = crypto.randomUUID();
    await ctx.db.patch(botId, { rearmStatus: "running", rearmLeaseToken: token, rearmLeaseUntil: Date.now() + REARM_LEASE_MS });
    return { ok: true as const, token, userId: bot.userId };
  },
});

// Resultado del intento (bajo lease). NB: si armBotInternal llegó a reserveArm, el rearm YA se consumió
// (reserveArm limpió rearmLeaseToken) → estas escrituras quedan no-op por el fencing del token (idempotente,
// Codex #3). success → limpia (si aún era nuestro); cancel → limpia con motivo; transient/blocked →
// persiste error/kind, incrementa intentos, reprograma, suelta lease.
export const recordRearmOutcome = internalMutation({
  args: {
    botId: v.id("bots"), token: v.string(),
    outcome: v.union(v.literal("success"), v.literal("transient"), v.literal("blocked"), v.literal("cancel")),
    kind: v.optional(v.union(
      v.literal("transient"), v.literal("blocked_margin"),
      v.literal("blocked_config"), v.literal("retry_incompatible"))),
    error: v.optional(v.string()),
    nextRearmAt: v.optional(v.number()),
  },
  handler: async (ctx, { botId, token, outcome, kind, error, nextRearmAt }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return { ok: false as const };
    if (bot.rearmLeaseToken !== token || (bot.rearmLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (outcome === "success") {
      await ctx.db.patch(botId, {
        rearmStatus: undefined, nextRearmAt: undefined, rearmAttempts: 0,
        lastRearmError: undefined, lastRearmErrorKind: undefined,
        rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
      });
    } else if (outcome === "cancel") {
      await ctx.db.patch(botId, {
        rearmStatus: undefined, nextRearmAt: undefined,
        rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
        lastRearmError: error, lastRearmErrorKind: undefined,
      });
    } else {
      await ctx.db.patch(botId, {
        rearmStatus: outcome === "blocked" ? "blocked" : "pending",
        rearmAttempts: (bot.rearmAttempts ?? 0) + 1,
        nextRearmAt: nextRearmAt ?? (Date.now() + REARM_RETRY_MS),
        lastRearmError: error, lastRearmErrorKind: kind,
        rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
      });
    }
    return { ok: true as const };
  },
});

// --- Stops consecutivos (alerta de whipsaw) ---
// El contador (consecutiveStops) lo gestiona closeArmAndScheduleRearm (atómico con el cierre). Aquí solo
// se sube el nivel ya alertado, y SOLO tras Resend OK (Codex #7).
export const markStopAlertSent = internalMutation({
  args: { botId: v.id("bots"), level: v.number() },
  handler: async (ctx, { botId, level }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return { ok: false as const };
    // Monótono: nunca bajar el nivel alertado (evita re-alertar por una carrera).
    const newLevel = Math.max(bot.lastStopAlertLevel ?? 0, level);
    await ctx.db.patch(botId, { lastStopAlertLevel: newLevel, stopAlertSentAt: Date.now() });
    return { ok: true as const };
  },
});

// Datos para el email de alerta (bot + pool + email del usuario), sin exponer credenciales.
export const getStopAlertContext = internalQuery({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot || !bot.userId) return null;
    const user = await ctx.db.get(bot.userId);
    const pool = bot.poolId ? await ctx.db.get(bot.poolId) : null;
    return {
      email: user?.email ?? null,
      botName: bot.name,
      pair: pool?.pair ?? bot.baseAsset ?? "?",
      network: pool?.network ?? "?",
      consecutiveStops: bot.consecutiveStops ?? 0,
      lastStopAlertLevel: bot.lastStopAlertLevel ?? 0,
    };
  },
});

// Bots con rearm listo (pending/blocked, cooldown vencido, sin lease vivo) + running con lease expirado
// (recuperación de worker muerto). Acotado.
export const listRearmReadyBots = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const max = limit ?? 25;
    const out: Id<"bots">[] = [];
    for (const status of ["pending", "blocked", "running"] as const) {
      for await (const b of ctx.db
        .query("bots")
        .withIndex("by_rearm_status", (q) => q.eq("rearmStatus", status).lte("nextRearmAt", now))
        .order("asc")) {
        if ((b.rearmLeaseUntil ?? 0) <= now) out.push(b._id);
        if (out.length >= max) return out;
      }
    }
    return out;
  },
});

// (Codex #6) Bots con una alerta de stop PENDIENTE: consecutiveStops − lastStopAlertLevel ≥ THRESHOLD.
// El cron los reintenta cada ciclo (una alerta fallida en Resend no espera al siguiente SL). Sin índice
// específico: la tabla bots es pequeña y se filtra en memoria sobre los que tienen stops.
export const listStopAlertPendingBots = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const max = limit ?? 25;
    const out: Id<"bots">[] = [];
    for await (const b of ctx.db.query("bots")) {
      const cs = b.consecutiveStops ?? 0;
      if (cs >= STOP_ALERT_THRESHOLD && cs - (b.lastStopAlertLevel ?? 0) >= STOP_ALERT_THRESHOLD) {
        out.push(b._id);
        if (out.length >= max) break;
      }
    }
    return out;
  },
});
