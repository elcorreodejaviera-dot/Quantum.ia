import { internalAction, internalMutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireAdmin } from "./helpers";

// (OBS-2) Health/heartbeat de los crons.
//
// PRINCIPIO CLAVE (Codex ALTO #1): la observabilidad NUNCA debe poder romper ni marcar como fallido
// un cron money-path. Por eso TODAS las escrituras de salud son best-effort (se tragan con
// console.warn si fallan) y el error REAL del cuerpo del cron se re-lanza intacto.
//
// Variante de implementación (Codex permitió ambas): en vez de operar dentro de cada uno de los 6
// reconciliadores, `crons.ts` apunta a 6 wrapper internalActions de ESTE módulo, que llaman al cron
// real vía `runAction`. Así los cuerpos money-path quedan INTACTOS.

// --- Registro (internal mutations) ---

type HealthPatch = {
  lastStartedAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveFailures?: number;
};

async function upsert(ctx: MutationCtx, name: string, patch: HealthPatch) {
  const row = await ctx.db.query("cron_health").withIndex("by_name", (q) => q.eq("name", name)).first();
  if (row) await ctx.db.patch(row._id, patch);
  else await ctx.db.insert("cron_health", { name, ...patch });
}

export const recordCronStart = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await upsert(ctx, name, { lastStartedAt: Date.now() });
  },
});

export const recordCronSuccess = internalMutation({
  args: { name: v.string(), durMs: v.number() },
  handler: async (ctx, { name, durMs }) => {
    // El éxito resetea el contador de fallos consecutivos.
    await upsert(ctx, name, { lastSuccessAt: Date.now(), lastDurationMs: durMs, consecutiveFailures: 0 });
  },
});

export const recordCronError = internalMutation({
  args: { name: v.string(), durMs: v.number(), msg: v.string() },
  handler: async (ctx, { name, durMs, msg }) => {
    const row = await ctx.db.query("cron_health").withIndex("by_name", (q) => q.eq("name", name)).first();
    const prev = row?.consecutiveFailures ?? 0;
    await upsert(ctx, name, {
      lastErrorAt: Date.now(), lastError: msg.slice(0, 300), lastDurationMs: durMs,
      consecutiveFailures: prev + 1,
    });
  },
});

// --- Wrapper best-effort ---

// Escritura de salud que NUNCA lanza: si falla, solo console.warn. Garantiza que la observabilidad
// no pueda convertir un cron exitoso en fallo ni abortar uno money-path.
async function safeHealth(fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) { console.warn("[cron_health] write failed:", String(e).slice(0, 200)); }
}

// Envuelve la ejecución del cron real con registro de salud best-effort. Re-lanza SIEMPRE el error
// ORIGINAL del cuerpo (tras intentar registrarlo) y conserva su valor de retorno.
async function withCronHealth<T>(ctx: ActionCtx, name: string, body: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  await safeHealth(() => ctx.runMutation(internal.cronHealth.recordCronStart, { name }));
  try {
    const result = await body();
    await safeHealth(() => ctx.runMutation(internal.cronHealth.recordCronSuccess, { name, durMs: Date.now() - t0 }));
    return result;
  } catch (e) {
    await safeHealth(() => ctx.runMutation(internal.cronHealth.recordCronError, { name, durMs: Date.now() - t0, msg: String(e) }));
    throw e; // re-lanzar el error ORIGINAL: el cron sigue fallando de verdad, solo que ahora visible
  }
}

// --- 6 wrappers (crons.ts apunta aquí) ---
// El `name` coincide con el nombre del cron en crons.ts para legibilidad en el panel.

export const fetchDefiLlamaApyWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "fetch DeFiLlama APY",
    () => ctx.runAction(internal.actions.defillama.fetchAndUpdateApys, {})),
});

export const fetchUniswapSubgraphWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "fetch Uniswap V3 subgraph",
    () => ctx.runAction(internal.actions.uniswap.fetchUniswapSubgraphData, {})),
});

export const checkPoolClosuresWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "check pool closures",
    () => ctx.runAction(internal.actions.poolScanner.checkAllPoolClosures, {})),
});

export const reconcileExecutionsWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "reconcile HL executions",
    () => ctx.runAction(internal.executionsCron.reconcileStaleExecutions, {})),
});

export const reconcileArmsWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "reconcile pool arms",
    () => ctx.runAction(internal.triggerEngine.reconcileStaleArms, {})),
});

export const processRearmsWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "process bot rearms",
    () => ctx.runAction(internal.triggerEngine.processRearms, {})),
});

// (JAV-92) Reconcile del motor Spot Grid (money-path): coloca/mantiene órdenes reales bajo lease.
export const reconcileSpotGridWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "reconcile spot grid",
    () => ctx.runAction(internal.spotGridEngine.reconcileAllSpotGrids, {})),
});

// (OBS-3b) Poda diaria de engine_events (best-effort vía withCronHealth, no afecta money-path).
export const pruneEngineEventsWithHealth = internalAction({
  args: {},
  handler: async (ctx) => withCronHealth(ctx, "prune engine events",
    () => ctx.runMutation(internal.engineEvents.pruneEngineEvents, {})),
});

// --- Lectura para el panel admin ---

export const listCronHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("cron_health").collect();
  },
});
