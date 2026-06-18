import { query, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireAdmin, hasPermission } from "./helpers";
import { getPlan } from "./plans";
import { consumedCoverageByPool } from "./coverageUsage";
import { hlNetwork } from "./hlNetwork";

// (JAV-80) Queries de la pestaña de Administración. TODAS admin-only (requireAdmin) y ACOTADAS.
// NO money-path: solo lectura/cache (la lógica de trading no se toca). Estado HL en vivo NO va aquí
// (una query no hace red): se expone bajo demanda en una acción aparte (futuro getUserHLState).

// Estados que mantienen capital/margen comprometido (copias LOCALES de solo lectura para no importar
// del money-path executions.ts; coherentes con OPEN_MARGIN_STATES / ARM_OPEN_MARGIN_STATES de allí).
const EXEC_OPEN = ["pending", "submitting", "entry_filled", "protected", "sl_failed", "unknown"] as const;
const ARM_OPEN = ["arming", "submitting", "armed", "disarming", "filled", "protecting", "protected", "armed_lower_only", "unknown"] as const;
const ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);
const SCAN_CAP = 1000;   // (Codex #2) tope duro por lectura — beta. Materializar si el volumen crece (JAV-79).
const DAY_MS = 24 * 60 * 60 * 1000;

// KPIs globales del sistema (acotados por SCAN_CAP).
export const getSystemStats = query({
  args: {},
  handler: async (ctx): Promise<any> => {
    await requireAdmin(ctx);

    let capitalExec = 0, marginExec = 0, openExec = 0;
    for (const status of EXEC_OPEN) {
      const rows = await ctx.db.query("execution_requests")
        .withIndex("by_status_created", (q) => q.eq("status", status)).take(SCAN_CAP);
      for (const r of rows) { capitalExec += r.notional; marginExec += (r.marginReserved ?? r.notional); openExec++; }
    }

    let capitalArm = 0, marginArm = 0, liveArm = 0;
    for (const status of ARM_OPEN) {
      const rows = await ctx.db.query("trigger_arms")
        .withIndex("by_status_updated", (q) => q.eq("status", status)).take(SCAN_CAP);
      for (const a of rows) { capitalArm += a.reservedNotional; marginArm += a.marginReserved; liveArm++; }
    }

    const bots = await ctx.db.query("bots").take(SCAN_CAP);
    const activeBots = bots.filter((b) => b.active === true);
    const activeUsers = new Set(activeBots.map((b) => b.userId).filter(Boolean) as string[]);
    const totalUsers = (await ctx.db.query("users").take(SCAN_CAP)).length;

    // "Monitoreado" = Σ liquidez LP INICIAL (cacheada) de los pools con bot activo. NO es pool.tvl (TVL del
    // pool entero de Uniswap) ni hedgeNotionalUsd (cobertura HL). Nulls NO se suman como 0 → se cuentan
    // aparte (unknownLiquidityCount) para señalar "incompleto". Dedupe por pool (un pool, un conteo).
    let monitoredInitialUsd = 0, unknownLiquidityCount = 0, knownLiquidityCount = 0;
    const seenPools = new Set<string>();
    for (const b of activeBots) {
      if (!b.poolId) continue;
      const key = String(b.poolId);
      if (seenPools.has(key)) continue;
      seenPools.add(key);
      const p = await ctx.db.get(b.poolId);
      if (!p || p.closed) continue;
      if (typeof p.initialLiquidityUsd === "number") { monitoredInitialUsd += p.initialLiquidityUsd; knownLiquidityCount++; }
      else unknownLiquidityCount++;
    }

    // Volumen 24h = nocional negociado por AMBOS motores. trades_history NO captura el motor automático
    // (trigger_arms, JAV-44) — solo el IOC legacy — por eso antes salía ~$0 con bots IL. Fuentes:
    //  - execution_requests (motor IOC): notional, por índice by_created.
    //  - trigger_arms (motor automático): nocional REAL del fill (filledSize×entryPrice). Sin índice global
    //    by_created → escaneo acotado por by_updated (SCAN_CAP) y se filtra por createdAt.
    // Sin doble conteo: cada motor tiene su tabla. Ventana actual [since,now) y previa [prevSince,since).
    const since = Date.now() - DAY_MS;
    const prevSince = since - DAY_MS;
    let volume24h = 0, volumePrev24h = 0;
    const addVol = (notional: number, ts: number) => {
      if (!Number.isFinite(notional) || notional <= 0) return;
      if (ts >= since) volume24h += notional;
      else if (ts >= prevSince) volumePrev24h += notional;
    };
    // .order("desc"): si hay >SCAN_CAP execs en la ventana de 48h, conservar las MÁS RECIENTES (la ventana
    // actual de 24h) en vez de las más antiguas; si no, infra-contaría el volumen de hoy (falso "-100%").
    const execs24 = await ctx.db.query("execution_requests")
      .withIndex("by_created", (q) => q.gte("createdAt", prevSince)).order("desc").take(SCAN_CAP);
    for (const e of execs24) addVol(e.notional, e.createdAt);
    const armsScan = await ctx.db.query("trigger_arms").withIndex("by_updated").order("desc").take(SCAN_CAP);
    for (const a of armsScan) {
      const filledNotional = (a.filledSize && a.entryPrice) ? a.filledSize * a.entryPrice : 0;
      if (filledNotional <= 0) continue;
      // Imputar por el MOMENTO DEL FILL (filledAt), no por createdAt: un arm creado hace días pero llenado
      // hoy debe contar hoy. updatedAt solo como fallback legacy (settleArm fija filledAt al confirmar el fill).
      const ts = a.filledAt ?? a.updatedAt;
      if (ts < prevSince) continue;
      addVol(filledNotional, ts);
    }
    // % vs 24h previas. null si no hay base previa (evita /0).
    const volume24hDelta = volumePrev24h > 0 ? ((volume24h - volumePrev24h) / volumePrev24h) * 100 : null;

    // Red efectiva = fuente de verdad del backend (no asumir desde el front). Defensivo: nunca rompe la vista.
    let network: string | null = null;
    try { network = hlNetwork(); } catch { network = null; }

    return {
      capitalInHL: capitalArm + capitalExec,    // armado + ejecutándose
      marginCommitted: marginArm + marginExec,  // margen comprometido (en movimiento)
      monitoredInitialUsd,                       // Σ liquidez LP inicial (cacheada) de pools con bot activo
      unknownLiquidityCount,                     // pools con bot activo SIN initialLiquidityUsd (incompleto)
      knownLiquidityCount,                       // pools con dato (distingue "$0 real" de "todo incompleto")
      volume24h,
      volume24hDelta,                            // % vs 24h previas (null si sin base)
      network,                                   // "mainnet" | "testnet" | null
      activeBots: activeBots.length,
      activeUsers: activeUsers.size,
      totalUsers,
      liveCommitments: liveArm + openExec,
    };
  },
});

// Listado de usuarios (paginado). SOLO campos baratos (sin coberturas con collect, sin on-chain).
export const listUsersOverview = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }): Promise<any> => {
    await requireAdmin(ctx);
    const result = await ctx.db.query("users").paginate(paginationOpts);
    const page = [];
    for (const u of result.page) {
      const plan = getPlan(u.subscriptionPlan);
      const bots = await ctx.db.query("bots").withIndex("by_user", (q) => q.eq("userId", u._id)).collect();
      const activeBotsList = bots.filter((b) => b.active === true);
      const activeBots = activeBotsList.length;
      const hlAcct = await ctx.db.query("hl_api_credentials").withIndex("by_user", (q) => q.eq("userId", u._id)).first();

      // $ monitoreado del usuario = Σ liquidez LP INICIAL (cacheada) de sus pools con bot activo (dedupe por
      // pool). Nulls → unknownLiquidityCount (no se suman como 0). NO usar hedgeNotionalUsd aquí.
      let monitoredInitialUsd = 0, unknownLiquidityCount = 0, knownLiquidityCount = 0;
      const seenPools = new Set<string>();
      for (const b of activeBotsList) {
        if (!b.poolId) continue;
        const key = String(b.poolId);
        if (seenPools.has(key)) continue;
        seenPools.add(key);
        const p = await ctx.db.get(b.poolId);
        if (!p || p.closed) continue;
        if (typeof p.initialLiquidityUsd === "number") { monitoredInitialUsd += p.initialLiquidityUsd; knownLiquidityCount++; }
        else unknownLiquidityCount++;
      }

      page.push({
        userId: u._id, email: u.email ?? null, name: u.name ?? null, role: u.role,
        plan: plan ? { id: plan.id, label: plan.label, cap: plan.coverageCapUsd } : null,
        suspended: u.suspended === true,
        activeBots, hasHlAccount: !!hlAcct,
        monitoredInitialUsd, unknownLiquidityCount, knownLiquidityCount,
        canManageBots: await hasPermission(ctx, u, "canManageBots"),
        canTradeLive: await hasPermission(ctx, u, "canTradeLive"),
      });
    }
    return { ...result, page };
  },
});

// Detalle de UN usuario (solo DB/cache). La cobertura usa consumedCoverageByPool (un solo usuario).
export const getUserDetail = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<any> => {
    await requireAdmin(ctx);
    const u = await ctx.db.get(userId);
    if (!u) throw new Error("Usuario no encontrado");
    const plan = getPlan(u.subscriptionPlan);

    // consumedCoverageByPool puede lanzar [blocked_config] si una fila viva no es cuantificable:
    // en una vista admin de lectura no debe romper → lo tratamos como "desconocido".
    let coverageUsed: number | null = 0;
    try {
      const byPool = await consumedCoverageByPool(ctx, userId);
      coverageUsed = 0;
      for (const val of byPool.values()) coverageUsed += val;
    } catch {
      coverageUsed = null;
    }

    const bots = await ctx.db.query("bots").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const positions = [];
    for (const b of bots) {
      if (b.active !== true) continue;
      let pool = null;
      if (b.poolId) {
        const p = await ctx.db.get(b.poolId);
        if (p) pool = {
          poolId: p._id, pair: p.pair, network: p.network, tokenId: p.tokenId ?? null,
          feeTier: p.feeTier ?? null,
          minRange: p.minRange, maxRange: p.maxRange,
          initialLiquidityUsd: typeof p.initialLiquidityUsd === "number" ? p.initialLiquidityUsd : null,
          tvl: p.tvl ?? p.subgraphTvlUsd ?? null,
          fees1d: p.fees1d ?? p.subgraphFeesUsd1d ?? null,
          closed: p.closed === true,
        };
      }
      let armStatus: string | null = null;
      const arms = await ctx.db.query("trigger_arms")
        .withIndex("by_bot_generation", (q) => q.eq("botId", b._id)).order("desc").take(1);
      if (arms[0] && !ARM_TERMINAL.has(arms[0].status)) armStatus = arms[0].status;
      positions.push({
        botId: b._id, kind: b.kind ?? null, leverage: b.leverage ?? null, direction: b.direction ?? null,
        stopLossPct: b.stopLossPct ?? null, hedgeNotionalUsd: b.hedgeNotionalUsd ?? null,
        baseAsset: b.baseAsset ?? null, hlAccountId: b.hlAccountId ?? null,
        pool, armStatus,
      });
    }

    return {
      userId: u._id, email: u.email ?? null, name: u.name ?? null, role: u.role,
      plan: plan ? { id: plan.id, label: plan.label, cap: plan.coverageCapUsd } : null,
      suspended: u.suspended === true,
      coverageUsed,
      coverageCap: u.role === "admin" ? null : (plan ? plan.coverageCapUsd : 0),  // admin = ilimitado
      positions,
    };
  },
});

// (JAV-84 Fase 2) Objetivos para el snapshot en VIVO de un usuario: posiciones (pools con bot activo)
// + cuentas HL. SOLO datos baratos de DB; las lecturas on-chain/HL las hace la ACCIÓN adminLive.
// Acotado por MAX_LIVE_POSITIONS (tope duro de fan-out, Codex #5).
export const MAX_LIVE_POSITIONS = 8;
export const getUserLiveTargetsInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<any> => {
    const bots = await ctx.db.query("bots").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const positions = [];
    for (const b of bots) {
      if (b.active !== true || !b.poolId) continue;
      const p = await ctx.db.get(b.poolId);
      if (!p || p.closed || p.tokenId == null) continue;
      positions.push({
        botId: b._id, baseAsset: b.baseAsset ?? null, hlAccountId: b.hlAccountId ?? null,
        poolId: p._id, tokenId: p.tokenId, network: p.network,
        poolAddress: p.poolAddress ?? null, minRange: p.minRange, maxRange: p.maxRange,
      });
      if (positions.length >= MAX_LIVE_POSITIONS) break;
    }
    // (Codex Fase 2 #2) Solo las cuentas HL REFERENCIADAS por las posiciones visibles (topadas) → el
    // fan-out de clearinghouseState queda acotado al mismo tope, sin consultar cuentas no mostradas.
    const referenced = new Set(positions.map((p) => p.hlAccountId).filter(Boolean).map(String));
    const creds = await ctx.db.query("hl_api_credentials").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const hlAccounts = creds
      .filter((c) => referenced.has(String(c._id)))
      .map((c) => ({ id: c._id, tradingAccountAddress: c.tradingAccountAddress }));
    return { positions, hlAccounts };
  },
});

// Feed de actividad: merge de fuentes indexadas por tiempo (Codex #5: sin tabla activity_log en v1).
export const listActivity = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<any> => {
    await requireAdmin(ctx);
    const cap = Math.max(1, Math.min(limit ?? 50, 100));   // clamp inferior: limit negativo → take() válido
    type Ev = { at: number; type: string; userId: Id<"users"> | null; text: string; meta: any };
    const events: Ev[] = [];

    const trades = await ctx.db.query("trades_history").withIndex("by_timestamp").order("desc").take(cap);
    for (const t of trades) events.push({ at: t.timestamp, type: "trade", userId: t.userId, text: `${t.action} ${t.asset}`, meta: { amount: t.amount, simulated: t.simulated } });

    const logs = await ctx.db.query("admin_logs").withIndex("by_timestamp").order("desc").take(cap);
    for (const l of logs) events.push({ at: l.timestamp, type: "admin", userId: null, text: l.action, meta: l.meta ?? null });

    const execs = await ctx.db.query("execution_requests").withIndex("by_created").order("desc").take(cap);
    for (const e of execs) events.push({ at: e.createdAt, type: "execution", userId: e.userId, text: `${e.side} ${e.asset} · ${e.status}`, meta: { notional: e.notional } });

    const arms = await ctx.db.query("trigger_arms").withIndex("by_updated").order("desc").take(cap);
    for (const a of arms) events.push({ at: a.updatedAt, type: "arm", userId: a.userId, text: `arm ${a.asset} · ${a.status}`, meta: { reservedNotional: a.reservedNotional } });

    events.sort((a, b) => b.at - a.at);
    const top = events.slice(0, cap);

    const cache = new Map<string, string | null>();
    const out = [];
    for (const ev of top) {
      let who: string | null = null;
      if (ev.userId) {
        const key = String(ev.userId);
        if (cache.has(key)) who = cache.get(key) ?? null;
        else { const u = await ctx.db.get(ev.userId); who = u?.email ?? u?.name ?? null; cache.set(key, who); }
      }
      out.push({ at: ev.at, type: ev.type, text: ev.text, meta: ev.meta, who });
    }
    return out;
  },
});
