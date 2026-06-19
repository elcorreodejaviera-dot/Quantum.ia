import { internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { DatabaseWriter } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireAdmin } from "./helpers";

// (OBS-3b) Persistencia de hitos del motor money-path (subconjunto de los elog de OBS-3) en la tabla
// engine_events, para el panel admin (histórico/consultable). Mismo contrato de seguridad que elog:
// SOLO escalares no sensibles; NUNCA claves/direcciones/payloads/errores crudos del SDK.

// (JAV-77 fix TS2589) ctx ligero `{ db: DatabaseWriter }` (NO MutationCtx) para no arrastrar el grafo
// `api` y reventar el presupuesto de inferencia en los call-sites del motor. Un MutationCtx encaja
// estructuralmente. El helper NO importa internal/api.
type WriteCtx = { db: DatabaseWriter };

type EngineEventFields = {
  scope: string;
  event: string;
  botId?: Id<"bots">;
  armId?: Id<"trigger_arms">;
  requestId?: Id<"execution_requests">;
  userId?: Id<"users">;
  fromStatus?: string;   // estado de origen (enum del schema)
  toStatus?: string;     // estado de destino / outcome (enum)
  // (Codex BAJO#5) `reason` es CATEGORÍA: closeReason/kind/outcome o un símbolo acotado (coin:estado).
  // PROHIBIDO meter aquí un mensaje de error o string crudo del SDK. Auditar cada call-site nuevo.
  reason?: string;
};

// Inserta un hito. BEST-EFFORT (decisión de implementación, money-path): la asimetría es clara —
// perder un evento de diagnóstico cuesta cero, abortar un trade cuesta mucho. Por eso el insert va en
// try/catch: ni un fallo de validación inesperado puede tumbar la mutation de trading que lo llamó.
// Se sigue insertando DENTRO de la transacción (consistente con admin_logs: si la mutation hace
// rollback, el evento también → no hay evento sin efecto).
export async function recordEngineEvent(ctx: WriteCtx, e: EngineEventFields): Promise<void> {
  try {
    await ctx.db.insert("engine_events", { ...e, at: Date.now() });
  } catch (err) {
    console.warn(`[engine_events] insert failed: ${e.scope}/${e.event}: ${String(err).slice(0, 160)}`);
  }
}

// Variante internalMutation para los ACTIONS del motor (hyperliquid.ts), que no tienen ctx.db y deben
// persistir vía ctx.runMutation. Mismos campos escalares. Best-effort: el caller envuelve la llamada.
export const record = internalMutation({
  args: {
    scope: v.string(),
    event: v.string(),
    botId: v.optional(v.id("bots")),
    armId: v.optional(v.id("trigger_arms")),
    requestId: v.optional(v.id("execution_requests")),
    userId: v.optional(v.id("users")),
    fromStatus: v.optional(v.string()),
    toStatus: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await recordEngineEvent(ctx, args);
  },
});

// Poda: borra eventos más viejos que la retención, por lotes acotados con el índice by_at (no recorre
// toda la tabla → transacción pequeña). La llama un cron diario envuelto en withCronHealth (OBS-2) →
// su fallo nunca afecta money-path. (Codex MEDIO#2) Si un lote se llena, hay más backlog → se RE-AGENDA
// a sí misma (scheduler.runAfter 0) hasta vaciar: drenaje garantizado sea cual sea el volumen diario,
// sin transacciones gigantes. Retención 30 días; lote de 500.
const ENGINE_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

export const pruneEngineEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - ENGINE_EVENTS_RETENTION_MS;
    const old = await ctx.db
      .query("engine_events")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    // Lote lleno = puede quedar backlog → continuar en otra transacción acotada (no re-agendar si no).
    if (old.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.engineEvents.pruneEngineEvents, {});
    }
    return { deleted: old.length };
  },
});

// Lectura admin: últimos eventos, opcionalmente filtrados por bot o arm. Sin datos sensibles (la tabla
// ya es segura por construcción). Espeja listRecentExecutions/listCronHealth.
export const listEngineEvents = query({
  args: {
    botId: v.optional(v.id("bots")),
    armId: v.optional(v.id("trigger_arms")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { botId, armId, limit = 100 }) => {
    await requireAdmin(ctx);
    // (CodeRabbit) Filtros mutuamente excluyentes: con ambos, la rama botId ignoraría armId en
    // silencio → rechazar explícitamente en vez de devolver resultados engañosos.
    if (botId !== undefined && armId !== undefined) {
      throw new Error("listEngineEvents: usar solo un filtro (botId o armId), no ambos.");
    }
    const clamped = Math.min(Math.max(limit, 1), 200);
    if (botId) {
      return await ctx.db.query("engine_events")
        .withIndex("by_bot_at", (q) => q.eq("botId", botId)).order("desc").take(clamped);
    }
    if (armId) {
      return await ctx.db.query("engine_events")
        .withIndex("by_arm_at", (q) => q.eq("armId", armId)).order("desc").take(clamped);
    }
    return await ctx.db.query("engine_events")
      .withIndex("by_at").order("desc").take(clamped);
  },
});
