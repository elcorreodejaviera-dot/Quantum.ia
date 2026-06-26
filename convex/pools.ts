import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireUser } from "./helpers";
import { hasNonTerminalArmForBot, requestDisarmAndDeactivateImpl } from "./triggerArms";

export const listPools = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", q => q.eq("clerkId", identity.subject))
      .first();
    if (!user) return [];
    return await ctx.db.query("pools").withIndex("by_user", q => q.eq("userId", user._id)).collect();
  },
});

export const listPoolsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("pools").collect();
  },
});

export const getPoolByIdInternal = internalQuery({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

export const patchPoolApy = internalMutation({
  args: {
    id: v.id("pools"),
    apy: v.number(),
    tvl: v.optional(v.number()),
    fees1d: v.optional(v.number()),
    volume1d: v.optional(v.number()),
    volume7d: v.optional(v.number()),
    feeTier: v.optional(v.number()),
    defillamaId: v.optional(v.string()),
    poolAddress: v.optional(v.string()),
  },
  handler: async (ctx, { id, apy, tvl, fees1d, volume1d, volume7d, feeTier, defillamaId, poolAddress }) => {
    const patch: Record<string, unknown> = { apy, apyUpdatedAt: Date.now() };
    if (tvl !== undefined) patch.tvl = tvl;
    if (fees1d !== undefined) patch.fees1d = fees1d;
    if (volume1d !== undefined) patch.volume1d = volume1d;
    if (volume7d !== undefined) patch.volume7d = volume7d;
    if (feeTier !== undefined) patch.feeTier = feeTier;
    if (defillamaId !== undefined) patch.defillamaId = defillamaId;
    if (poolAddress !== undefined) patch.poolAddress = poolAddress;
    await ctx.db.patch(id, patch);
  },
});

export const patchPoolAddress = internalMutation({
  args: { id: v.id("pools"), poolAddress: v.string() },
  handler: async (ctx, { id, poolAddress }) => {
    await ctx.db.patch(id, { poolAddress });
  },
});

export const patchPoolSubgraph = internalMutation({
  args: {
    id: v.id("pools"),
    volumeUsd1d: v.optional(v.number()),
    feesUsd1d: v.optional(v.number()),
    tvlUsd: v.optional(v.number()),
  },
  handler: async (ctx, { id, volumeUsd1d, feesUsd1d, tvlUsd }) => {
    const patch: Record<string, unknown> = { subgraphUpdatedAt: Date.now() };
    if (volumeUsd1d !== undefined) patch.subgraphVolumeUsd1d = volumeUsd1d;
    if (feesUsd1d !== undefined) patch.subgraphFeesUsd1d = feesUsd1d;
    if (tvlUsd !== undefined) patch.subgraphTvlUsd = tvlUsd;
    await ctx.db.patch(id, patch);
  },
});

export const createPool = mutation({
  args: {
    pair: v.string(),
    network: v.string(),
    minRange: v.number(),
    maxRange: v.number(),
    status: v.string(),
    feeTier: v.optional(v.number()),
    poolAddress: v.optional(v.string()),
    tokenId: v.optional(v.number()),
    initialLiquidityUsd: v.optional(v.number()),
    initialLiquidityAt: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.minRange < 0 || args.maxRange < 0) throw new Error("Los rangos deben ser no negativos.");
    // (Codex #7) Estricto: minRange === maxRange daría anchura 0 → división por cero (NaN%) en el
    // gráfico de rango (posición de precio y de entrada).
    if (args.minRange >= args.maxRange) throw new Error("minRange debe ser menor que maxRange.");
    if (args.tokenId != null) {
      const existing = await ctx.db.query("pools")
        .withIndex("by_user", q => q.eq("userId", user._id))
        .filter(q => q.eq(q.field("tokenId"), args.tokenId))
        .first();
      if (existing) throw new Error("Este Token ID ya está siendo monitoreado. Si cerraste la posición, elimina primero el pool anterior para volver a registrarlo.");
    }
    return await ctx.db.insert("pools", {
      userId: user._id as any,
      pair: args.pair,
      network: args.network,
      minRange: args.minRange,
      maxRange: args.maxRange,
      status: args.status,
      feeTier: args.feeTier,
      poolAddress: args.poolAddress,
      tokenId: args.tokenId,
      initialLiquidityUsd: args.initialLiquidityUsd,
      initialLiquidityAt: args.initialLiquidityAt,
      // C: precio de entrada = slot0 al registrar (solo si es válido). Se fija una vez.
      entryPrice: (args.entryPrice != null && args.entryPrice > 0) ? args.entryPrice : undefined,
      entryPriceAt: (args.entryPrice != null && args.entryPrice > 0) ? Date.now() : undefined,
    });
  },
});

// C (JAV-UI): captura idempotente del precio de entrada para pools ya existentes (registrados antes
// de esta función). Lo fija la primera vez que el portal tiene un precio en vivo y el pool no lo tiene.
// Ownership obligatorio y NUNCA sobreescribe un valor ya guardado.
export const setPoolEntryPriceIfMissing = mutation({
  args: { id: v.id("pools"), price: v.number() },
  handler: async (ctx, { id, price }) => {
    const user = await requireUser(ctx);
    if (!(price > 0)) return;
    const pool = await ctx.db.get(id);
    if (!pool) return;
    if (pool.userId !== user._id && user.role !== "admin") return;
    if (pool.entryPrice != null) return; // nunca sobreescribir
    await ctx.db.patch(id, { entryPrice: price, entryPriceAt: Date.now() });
  },
});

export const patchPoolInitialLiquidity = internalMutation({
  args: { id: v.id("pools"), initialLiquidityUsd: v.number(), initialLiquidityAt: v.number() },
  handler: async (ctx, { id, initialLiquidityUsd, initialLiquidityAt }) => {
    const pool = await ctx.db.get(id);
    if (!pool || pool.initialLiquidityUsd != null) return; // nunca sobreescribir el histórico
    await ctx.db.patch(id, { initialLiquidityUsd, initialLiquidityAt });
  },
});

export const deletePool = mutation({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const pool = await ctx.db.get(id);
    if (!pool) throw new Error("Pool no encontrado.");
    if (pool.userId !== user._id && user.role !== "admin") throw new Error("Sin permiso para eliminar este pool.");
    // Desvincular y pausar atómicamente los bots que protegían este pool, para
    // no dejar poolId colgante (Convex no aplica claves foráneas).
    const linkedBots = await ctx.db.query("bots").withIndex("by_pool", q => q.eq("poolId", id)).collect();
    // JAV-44 (R4): no borrar el pool si algún bot tiene un trigger_arm NO terminal — se perdería el
    // snapshot necesario para cancelar/cerrar el trigger vivo en HL.
    for (const bot of linkedBots) {
      if (await hasNonTerminalArmForBot(ctx, bot._id)) {
        throw new Error("El pool tiene un bot con cobertura automática activa; pausa/cierra el trigger antes de eliminar.");
      }
    }
    for (const bot of linkedBots) {
      await ctx.db.patch(bot._id, { active: false, poolId: undefined });
    }
    await ctx.db.delete(id);
  },
});

// Detección de cierre — mutaciones internas usadas por el cron checkAllPoolClosures.

// Marca el pool como cerrado y pausa atómicamente los bots vinculados.
// Idempotente: closedAt = inicio del cierre VIGENTE (no se sobrescribe mientras siga cerrado; se
// limpia al reabrir). closureCheckedAt siempre se refresca. El historial completo de cierres/
// reaperturas vive en `pool_events` (JAV-40), no en closedAt.
export const markPoolClosedAndPauseBots = internalMutation({
  args: { id: v.id("pools"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const pool = await ctx.db.get(id);
    if (!pool) return;
    const now = Date.now();
    // (JAV-40 #15) Evento SOLO en la transición real (no estaba cerrado) → sin spam por-ciclo.
    if (!pool.closed) {
      await ctx.db.insert("pool_events", { poolId: id, type: "closed", reason, at: now });
    }
    await ctx.db.patch(id, {
      closed: true,
      closureReason: reason,
      closureCheckedAt: now,
      ...(pool.closedAt == null ? { closedAt: now } : {}),
    });
    const linkedBots = await ctx.db.query("bots").withIndex("by_pool", q => q.eq("poolId", id)).collect();
    for (const bot of linkedBots) {
      // (Fix #3) Pausa SEGURA (H1/N2): si el bot tiene un trigger vivo, no desactivar de golpe —
      // disarmPending + el cron lo cancela en HL y luego completa active=false (la reconciliación
      // ve pool.closed → killed → cancela). Nunca dejar un trigger huérfano por el cierre de pool.
      if (bot.active) await requestDisarmAndDeactivateImpl(ctx, bot._id);
    }
  },
});

// La posición volvió a estar activa: limpia el estado de cierre si lo tenía.
export const reopenPoolIfClosed = internalMutation({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => {
    const pool = await ctx.db.get(id);
    if (!pool) return;
    const now = Date.now();
    if (pool.closed) {
      // (JAV-40 #15) Evento de reapertura dentro de la transición (atómico con el cambio de estado).
      await ctx.db.insert("pool_events", { poolId: id, type: "reopened", at: now });
      // No reactivamos bots automáticamente — el usuario decide reanudar la protección.
      await ctx.db.patch(id, {
        closed: false,
        closureReason: undefined,
        closedAt: undefined,
        closureCheckedAt: now,
      });
    } else {
      await ctx.db.patch(id, { closureCheckedAt: now });
    }
  },
});

// RPC no disponible: solo registra que se intentó el chequeo, sin concluir cierre.
export const touchPoolChecked = internalMutation({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => {
    const pool = await ctx.db.get(id);
    if (!pool) return;
    await ctx.db.patch(id, { closureCheckedAt: Date.now() });
  },
});

// =====================================================================================
// (JAV-117) Lifetime fees — eventos on-chain como fuente de verdad + agregados cacheados.
// =====================================================================================

// Recompone los agregados raw aplicando la contabilidad principal/fee en orden cronológico.
// Decrease suma deuda de principal; Collect paga primero esa deuda y SOLO el excedente es fee cobrada;
// Increase no afecta (su principal sigue activo, no es cobrable). Determinista y recomputable: SIEMPRE
// se calcula desde la tabla completa, nunca sumando sobre el agregado previo (evita doble conteo).
function computeLifetimeAggregates(
  events: Array<{ blockNumber: number; logIndex: number; eventType: string; amount0Raw: string; amount1Raw: string }>,
): { feesCollectedRaw0: string; feesCollectedRaw1: string; principalDebt0: string; principalDebt1: string } {
  const sorted = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  let debt0 = 0n, debt1 = 0n, fee0 = 0n, fee1 = 0n;
  for (const e of sorted) {
    let a0: bigint, a1: bigint;
    // (CodeRabbit) NO silenciar filas corruptas: un raw no parseable subcontaría los agregados sin
    // señal. pool_fee_events es la fuente de verdad → abortar el recompute conserva el cache previo
    // (la mutation es transaccional) en vez de persistir un total incorrecto.
    try { a0 = BigInt(e.amount0Raw); a1 = BigInt(e.amount1Raw); }
    catch { throw new Error(`pool_fee_events raw inválido en ${e.blockNumber}:${e.logIndex}`); }
    if (e.eventType === "decrease") {
      debt0 += a0; debt1 += a1;
    } else if (e.eventType === "collect") {
      const pay0 = a0 < debt0 ? a0 : debt0; debt0 -= pay0; fee0 += a0 - pay0;
      const pay1 = a1 < debt1 ? a1 : debt1; debt1 -= pay1; fee1 += a1 - pay1;
    }
    // "increase": no afecta deuda ni fee cobrada.
  }
  return {
    feesCollectedRaw0: fee0.toString(), feesCollectedRaw1: fee1.toString(),
    principalDebt0: debt0.toString(), principalDebt1: debt1.toString(),
  };
}

export const getPoolLifetimeStateInternal = internalQuery({
  args: { id: v.id("pools") },
  handler: async (ctx, { id }) => {
    const pool = await ctx.db.get(id);
    if (!pool) return null;
    return {
      tokenId: pool.tokenId ?? null,
      network: pool.network,
      poolAddress: pool.poolAddress ?? null,
      closed: pool.closed ?? false,
      cursorBlock: pool.feesLifetimeCursorBlock ?? null,
      snapshotKey: pool.lifetimeSnapshotKey ?? null,
      backfilledAt: pool.feesLifetimeBackfilledAt ?? null,
      initialLiquidityAt: pool.initialLiquidityAt ?? null,
    };
  },
});

// (ALTO-1) Reemplazo ATÓMICO de una ventana de eventos + recompute. Se llama SOLO con eventos ya leídos
// con éxito de `[fromBlock, toBlock]` (una sola transacción Convex): borra esa ventana, reinserta la rama
// canónica (dedupe por lote), recomputa agregados DESDE LA TABLA y persiste cursor/estado. Como NUNCA se
// borra antes de tener los logs, un fallo de RPC no puede convertir un cache correcto en subconteo.
export const applyPoolFeeEventsWindow = internalMutation({
  args: {
    poolId: v.id("pools"),
    fromBlock: v.number(),
    toBlock: v.number(),
    events: v.array(v.object({
      txHash: v.string(),
      logIndex: v.number(),
      blockNumber: v.number(),
      blockHash: v.string(),
      eventType: v.union(v.literal("increase"), v.literal("decrease"), v.literal("collect")),
      amount0Raw: v.string(),
      amount1Raw: v.string(),
    })),
    cursorBlock: v.optional(v.number()),
    status: v.optional(v.union(v.literal("ok"), v.literal("stale"), v.literal("no_key"), v.literal("error"))),
    snapshotKey: v.optional(v.string()),
    backfilledAt: v.optional(v.number()),
  },
  handler: async (ctx, { poolId, fromBlock, toBlock, events, cursorBlock, status, snapshotKey, backfilledAt }) => {
    // 1) Borrar SOLO la ventana re-escaneada (anti-reorg: elimina logs de rama vieja en [fromBlock,toBlock]).
    const inWindow = await ctx.db
      .query("pool_fee_events")
      .withIndex("by_pool_block", q => q.eq("poolId", poolId).gte("blockNumber", fromBlock).lte("blockNumber", toBlock))
      .collect();
    for (const ev of inWindow) await ctx.db.delete(ev._id);
    // 2) Reinsertar la rama canónica (dedupe por lote en memoria).
    const seen = new Set<string>();
    for (const e of events) {
      if (e.blockNumber < fromBlock || e.blockNumber > toBlock) continue;   // defensa: solo la ventana
      const key = `${e.txHash}:${e.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.db.insert("pool_fee_events", { poolId, ...e });
    }
    // 3) Recomputar agregados desde la tabla completa y persistir meta.
    const all = await ctx.db
      .query("pool_fee_events")
      .withIndex("by_pool_block", q => q.eq("poolId", poolId))
      .collect();
    const agg = computeLifetimeAggregates(all);
    const patch: Record<string, unknown> = { ...agg, feesLifetimeCalcAt: Date.now() };
    if (cursorBlock !== undefined) patch.feesLifetimeCursorBlock = cursorBlock;
    if (status !== undefined) patch.feesLifetimeStatus = status;
    if (snapshotKey !== undefined) patch.lifetimeSnapshotKey = snapshotKey;
    if (backfilledAt !== undefined) patch.feesLifetimeBackfilledAt = backfilledAt;
    await ctx.db.patch(poolId, patch);
    return { events: all.length, ...agg };
  },
});

// Camino SIN tocar la tabla (sin cambio estructural / init / no_key / error): solo patchea meta. NUNCA
// borra eventos ni agregados → un error transitorio no degrada el cache previo (a lo sumo marca estado).
export const patchPoolLifetimeMeta = internalMutation({
  args: {
    poolId: v.id("pools"),
    cursorBlock: v.optional(v.number()),
    status: v.optional(v.union(v.literal("ok"), v.literal("stale"), v.literal("no_key"), v.literal("error"))),
    snapshotKey: v.optional(v.string()),
    backfilledAt: v.optional(v.number()),
  },
  handler: async (ctx, { poolId, cursorBlock, status, snapshotKey, backfilledAt }) => {
    // (CodeRabbit) NO tocar feesLifetimeCalcAt aquí: este camino no recomputa agregados (solo avanza
    // cursor / degrada estado) → marcar el timestamp volvería engañoso el "actualizado hace X".
    // feesLifetimeCalcAt se setea SOLO en applyPoolFeeEventsWindow (donde sí hay recompute).
    const patch: Record<string, unknown> = {};
    if (cursorBlock !== undefined) patch.feesLifetimeCursorBlock = cursorBlock;
    if (status !== undefined) patch.feesLifetimeStatus = status;
    if (snapshotKey !== undefined) patch.lifetimeSnapshotKey = snapshotKey;
    if (backfilledAt !== undefined) patch.feesLifetimeBackfilledAt = backfilledAt;
    await ctx.db.patch(poolId, patch);
  },
});

// (JAV-120) Inserta un snapshot de fees del pool y poda los viejos. Guarda los componentes BRUTOS
// (tokensOwed/collected/principalDebt) + snapshotKey + safeHeadBlock + aggregatesComplete; el neteo y la
// valuación USD se hacen al LEER (F3). NO money-path. Idempotencia: no aplica (serie temporal append-only),
// el cron corre 1/h. `at` se sella aquí (Date.now()) para mantener el writer/action sin estado de tiempo.
const FEE_SNAPSHOT_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;   // ~10 días: cubre la ventana de 24h + margen

export const insertPoolFeeSnapshot = internalMutation({
  args: {
    poolId: v.id("pools"),
    tokensOwed0Raw: v.string(),
    tokensOwed1Raw: v.string(),
    collected0Raw: v.string(),
    collected1Raw: v.string(),
    principalDebt0Raw: v.string(),
    principalDebt1Raw: v.string(),
    snapshotKey: v.string(),
    safeHeadBlock: v.number(),
    aggregatesComplete: v.boolean(),
  },
  handler: async (ctx, args) => {
    const at = Date.now();
    await ctx.db.insert("pool_fee_snapshots", { ...args, at });
    // Poda por antigüedad (inline, por pool). El índice by_pool_at acota el barrido a ESTE pool.
    const cutoff = at - FEE_SNAPSHOT_RETENTION_MS;
    const stale = await ctx.db
      .query("pool_fee_snapshots")
      .withIndex("by_pool_at", q => q.eq("poolId", args.poolId).lt("at", cutoff))
      .collect();
    for (const s of stale) await ctx.db.delete(s._id);
  },
});

// (JAV-120 F3) Datos para "Fees 24h" real: valida acceso (owner/admin) y devuelve los snapshots de los
// extremos de la ventana — el más reciente ("ahora") y el más nuevo con at ≤ now−24h ("referencia") — más
// el más viejo (para el countdown de warming_up). Read-only. La valuación USD se hace en la action (RPC).
const FEE24H_WINDOW_MS = 24 * 60 * 60 * 1000;

export const getFees24hWindowInternal = internalQuery({
  args: { poolId: v.id("pools") },
  handler: async (ctx, { poolId }) => {
    const user = await requireUser(ctx);
    const pool = await ctx.db.get(poolId);
    if (!pool) throw new Error("Pool no encontrado.");
    if (pool.userId !== user._id && user.role !== "admin") throw new Error("Sin permiso para ver este pool.");
    const serverNow = Date.now();
    const nowSnap = await ctx.db
      .query("pool_fee_snapshots")
      .withIndex("by_pool_at", q => q.eq("poolId", poolId))
      .order("desc").first();
    // (Codex F3 ALTO) El ref se ancla en nowSnap.at − 24h (NO en serverNow): así la ventana se mide entre
    // dos puntos de datos REALES y es SIEMPRE ≥24h. Anclar en serverNow podía dar ventana <24h (o 0h con
    // nowSnap===refSnap si el cron murió) y reportar ok engañoso.
    const refSnap = nowSnap
      ? await ctx.db
          .query("pool_fee_snapshots")
          .withIndex("by_pool_at", q => q.eq("poolId", poolId).lte("at", nowSnap.at - FEE24H_WINDOW_MS))
          .order("desc").first()
      : null;
    const oldestSnap = await ctx.db
      .query("pool_fee_snapshots")
      .withIndex("by_pool_at", q => q.eq("poolId", poolId))
      .order("asc").first();
    return {
      tokenId: pool.tokenId ?? null,
      network: pool.network,
      serverNow,
      oldestAt: oldestSnap?.at ?? null,
      nowSnap: nowSnap ?? null,
      refSnap: refSnap ?? null,
    };
  },
});

export const updatePool = mutation({
  args: {
    id: v.id("pools"),
    minRange: v.optional(v.number()),
    maxRange: v.optional(v.number()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    await requireAdmin(ctx);
    const current = await ctx.db.get(id);
    if (!current) throw new Error("Pool not found");

    const nextMin = fields.minRange ?? current.minRange;
    const nextMax = fields.maxRange ?? current.maxRange;
    if (nextMin < 0 || nextMax < 0) throw new Error("Ranges must be non-negative");
    // (Codex #7) Estricto: anchura 0 (min===max) daría NaN% en el gráfico de rango.
    if (nextMin >= nextMax) throw new Error("minRange must be less than maxRange");

    const filtered = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(id, filtered);
  },
});
