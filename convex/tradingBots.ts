import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, getUserOrNull, writeAdminLog, hasPermission } from "./helpers";
import { elog } from "./log";
import { tradingCloidInput, toHlCloid } from "./cloids";
import { hlNetwork } from "./hlNetwork";
import { armErrorKind } from "./triggerRearm";
import {
  committedMarginForAccount, liveManualExecutionForAccountAsset, liveArmForAccountAssetExcept,
} from "./executions";
import { resolveLeverage, AUTO_LEVERAGE_CAP, MARGIN_SAFETY_BUFFER } from "./leverage";
import { tradingCoverageKey, assertWithinPlanCoverageForKey, coverageAdmissibleForKey } from "./coverageUsage";
import {
  entryOrderSpecs, resolveEntryTopology, triggerSeparationOk, rangeWidthOk,
} from "./tradingMath";

// (JAV-178 / Bot Trading PR2) Persistencia + reserva atómica + gates del 4º motor money-path (breakout
// OCO sobre rango LP + entrada a mercado fuera de rango, decisión 6). NON-node (convex-testable). NO
// envía órdenes a HL (eso es el motor PR3, tradingEngine.ts "use node"). Espejo 1:1 de spotDefenseBots
// generalizado a 2 entradas OCO Long/Short + camino entry_market. El bot es la fila `bots` (kind
// "trading", config de JAV-41); aquí viven los arms (trading_arms) y sus órdenes (trading_orders).

// Gate dedicado de mainnet (OFF por defecto), espejo de mainnetSpotDefenseApproved.
const MAINNET_GATE_KEY = "mainnetTradingApproved";
// Mínimo de nocional perp en HL (≈ $10) por PATA. Por debajo, la orden se rechaza → no reservar.
const MIN_PERP_NOTIONAL_USD = 10;
// Lease/fencing del reconcile + envío (un solo worker por arm a la vez).
const TRADING_LEASE_MS = 2 * 60 * 1000;
// Cuarentena tras submittedAt: una respuesta tardía de HL aún puede materializar órdenes.
const TR_SUBMIT_QUARANTINE_MS = 90 * 1000;
// Cooldown base del auto-rearm tras un cierre (da tiempo a HL a asentar fondos — preocupación de Javier).
export const TR_REARM_COOLDOWN_MS = 5 * 60 * 1000;
// (Decisión 6b, APROBADA) Re-entradas a MERCADO consecutivas escalan el cooldown 5→15→30→60 min
// (cap 60): acota el sangrado de fees en un mercado plano oscilando junto al borde. El bot NUNCA
// abandona — solo espacia. Reset: reserva por camino OCO (mark volvió al rango) o cierre por TP.
export const MARKET_REENTRY_COOLDOWNS_MS = [5, 15, 30, 60].map((m) => m * 60 * 1000);

const ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);
// Complemento EXACTO de ARM_TERMINAL (mantener en sync con el enum de trading_arms.status).
const TR_ARM_NON_TERMINAL = [
  "arming", "submitting", "armed", "disarming", "filled", "protecting", "protected", "unknown",
  "manual_intervention",
] as const;
// Máquina de estados del arm (plan JAV-176 PR3). Desde `arming` NO se avanza por settle (solo el CAS
// markTradingArmSubmitting): cancelar/fallar pre-envío únicamente. `armed→closed` = oco_race PRE-FILL
// (ambas entradas llenas ⇒ neteo flat). `disarming→filled` = el fill gana la carrera al disarm.
// `protected→protecting` = el SL desapareció y hay que recolocarlo. Camino entry_market:
// submitting→{filled|unknown|failed} (sin `armed`: la IOC llena o muere; incierto ⇒ unknown).
const ALLOWED_TR: Record<string, Set<string>> = {
  arming: new Set(["disarming", "disarmed", "failed"]),
  submitting: new Set(["armed", "filled", "unknown", "failed", "disarming", "disarmed"]),
  armed: new Set(["filled", "closed", "disarming", "disarmed", "unknown", "failed", "manual_intervention"]),
  filled: new Set(["protecting", "protected", "closed", "failed", "manual_intervention"]),
  protecting: new Set(["protected", "closed", "failed", "manual_intervention"]),
  protected: new Set(["closed", "protecting", "manual_intervention"]),
  disarming: new Set(["disarmed", "filled", "closed", "failed"]),
  unknown: new Set(["armed", "filled", "protecting", "protected", "closed", "failed", "disarming", "disarmed", "manual_intervention"]),
  manual_intervention: new Set(["closed", "disarmed", "failed"]),
};

// Política ÚNICA de auto-rearm durable tras un `failed` TERMINAL (espejo spotDefense, sobre `bots`).
// No pisa un ciclo en curso (rearmStatus != undefined) ni una pausa (disarmPending).
async function scheduleTradingRearmAfterFailed(
  ctx: MutationCtx, botId: Id<"bots">, error: string | undefined, now: number,
): Promise<void> {
  const bot = await ctx.db.get(botId);
  if (!bot || bot.disarmPending || !bot.active || bot.autoRearm !== true) return;
  if (bot.rearmStatus !== undefined) return;
  // (CodeRabbit #144 Major) Persistir TAMBIÉN el kind clasificado: sin él, la UI/backoff verían un
  // kind viejo o vacío para un error nuevo (p.ej. [blocked_cap]). armErrorKind es la clasificación
  // canónica; "cancel" no es un kind persistible del schema → undefined.
  const kind = error ? armErrorKind(error) : undefined;
  await ctx.db.patch(botId, {
    rearmStatus: "pending", nextRearmAt: now + TR_REARM_COOLDOWN_MS, rearmAttempts: 0,
    lastRearmError: error, lastRearmErrorKind: kind === "cancel" ? undefined : kind,
    rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
  });
}

// --- Gate de mainnet (admin) -------------------------------------------------------------------

async function isMainnetTradingApproved(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
  return (gate?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

export const getMainnetTradingApproval = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    return (gate?.value as { enabled?: boolean; approvedAt?: number; approvedBy?: string } | undefined) ?? null;
  },
});

export const setMainnetTradingApproval = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const admin = await requireAdmin(ctx);
    const existing = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    const value = { enabled, approvedAt: Date.now(), approvedBy: admin.clerkId };
    if (existing) await ctx.db.patch(existing._id, { value });
    else await ctx.db.insert("system_config", { key: MAINNET_GATE_KEY, value });
    await writeAdminLog(ctx, admin.clerkId, "set_mainnet_trading_approval", { enabled });
    return { ok: true as const };
  },
});

export const getMainnetTradingApprovedInternal = internalQuery({
  args: {},
  handler: async (ctx) => ({ approved: await isMainnetTradingApproved(ctx) }),
});

// --- Admisión LIVE (espejo assertSpotDefenseLiveAdmissible, sobre `bots` kind trading) -----------
// Revalida switches globales + canTradeLive + estado del bot + cuenta + gate mainnet en CADA punto
// sensible (reserva y ambos CAS): un kill-switch/permiso/pausa/simulación entre medias ⇒ NO procede.

async function assertTradingLiveAdmissible(
  ctx: QueryCtx | MutationCtx, botId: Id<"bots">,
): Promise<boolean> {
  const bot = await ctx.db.get(botId);
  if (!bot || bot.kind !== "trading") return false;
  if (!bot.userId || !bot.hlAccountId || !bot.baseAsset || !bot.poolId) return false;
  const user = await ctx.db.get(bot.userId);
  if (!user) return false;
  const [trading, sim] = await Promise.all([
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "tradingEnabled")).first(),
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "simulationMode")).first(),
  ]);
  if (trading?.value !== true || sim?.value !== false) return false;
  if (!(await hasPermission(ctx, user, "canTradeLive"))) return false;
  // (CodeRabbit #144 Major) Fail-closed: el modo real exige `false` EXPLÍCITO — un legacy/migrado
  // con simulationMode undefined jamás debe alcanzar el money-path.
  if (!bot.active || bot.disarmPending || bot.simulationMode !== false) return false;
  if (hlNetwork() === "mainnet" && !(await isMainnetTradingApproved(ctx))) return false;
  const cred = await ctx.db.get(bot.hlAccountId);
  if (!cred || cred.userId !== bot.userId) return false;
  const pool = await ctx.db.get(bot.poolId);
  if (!pool || pool.closed) return false;
  return true;
}

// ¿El bot (kind trading) tiene un arm NO terminal? Helper plano + internalQuery (la usa
// closeBotPosition para su política propia: con arm vivo se rechaza el cierre manual — V2-P3/P2).
export async function hasNonTerminalTradingArmForBot(
  ctx: QueryCtx | MutationCtx, botId: Id<"bots">,
): Promise<boolean> {
  const arms = await ctx.db.query("trading_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect();
  return arms.some((a) => !ARM_TERMINAL.has(a.status));
}

export const hasNonTerminalTradingArmForBotInternal = internalQuery({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => ({ live: await hasNonTerminalTradingArmForBot(ctx, botId) }),
});

// --- Reserva atómica del arm (OCC): guard simétrico + sizing LP + rango + cap + margen ------------
// La invoca armTradingInternal (PR3) tras leer HL: nocional LP FRESCO on-chain
// (fetchPositionNotionalStrict — P3), mark, triggers normalizados al tick y colateral.

export const reserveTradingArm = internalMutation({
  args: {
    botId: v.id("bots"),
    // Snapshot ESTRICTO leído on-chain por la action (P3). La mutation NO lee campos de `pools`.
    lpNotionalUsd: v.number(),
    markPx: v.number(),
    lowerEdge: v.number(),
    upperEdge: v.number(),
    tickSize: v.number(),
    // Camino de par de triggers (normalizados al tick por la action) + limitPx agresivos por pata.
    lowerTriggerPx: v.optional(v.number()),
    upperTriggerPx: v.optional(v.number()),
    entryUpperLimitPx: v.optional(v.number()),
    entryLowerLimitPx: v.optional(v.number()),
    // Variante ENTRY A MERCADO (decisión 6): omite la validación de rango, 1 pata, legsFactor=1.
    marketEntry: v.optional(v.object({ side: v.union(v.literal("Long"), v.literal("Short")) })),
    marketLimitPx: v.optional(v.number()),
    availableCollateral: v.number(),
    assetMaxLeverage: v.number(),
    szDecimals: v.number(),
    rearmToken: v.optional(v.string()),
  },
  // Promise<any>: corta el ciclo TS2589 (llama a coverageUsage). El cuerpo se sigue type-checkeando.
  handler: async (ctx, args): Promise<any> => {
    const bot = await ctx.db.get(args.botId);
    if (!bot || bot.kind !== "trading") throw new Error("[blocked_config] Bot de trading no encontrado.");
    if (!(await assertTradingLiveAdmissible(ctx, args.botId))) {
      throw new Error("[blocked_config] No admisible para trading real (switch/permiso/estado/cuenta/red/gate).");
    }
    const { userId, hlAccountId, poolId } = bot;
    const asset = (bot.baseAsset as string).toUpperCase();
    if (!userId || !hlAccountId || !poolId) throw new Error("[blocked_config] Bot sin usuario/cuenta/pool.");
    for (const [name, val] of [
      ["markPx", args.markPx], ["lowerEdge", args.lowerEdge], ["upperEdge", args.upperEdge],
      ["tickSize", args.tickSize], ["availableCollateral", args.availableCollateral],
    ] as const) {
      if (!Number.isFinite(val) || (name !== "availableCollateral" && val <= 0) || val < 0) {
        throw new Error(`[blocked_config] ${name} inválido (${val}).`);
      }
    }
    // (P3) El snapshot LP es OBLIGATORIO y fiable; sin él NO se reserva (fail-closed, sin estimaciones).
    if (!Number.isFinite(args.lpNotionalUsd) || args.lpNotionalUsd <= 0) {
      throw new Error("[blocked_config] Nocional del LP no cuantificable (snapshot on-chain requerido).");
    }
    const direction = bot.direction;
    if (direction !== "long_short" && direction !== "long" && direction !== "short") {
      throw new Error("[blocked_config] El bot de trading no tiene dirección válida.");
    }
    if (!Number.isFinite(bot.capitalPct as number) || (bot.capitalPct as number) < 50 || (bot.capitalPct as number) > 200) {
      throw new Error("[blocked_config] capitalPct inválido (50–200).");
    }
    if (!Number.isFinite(bot.stopLossPct as number) || (bot.stopLossPct as number) <= 0 || (bot.stopLossPct as number) >= 100) {
      throw new Error("[blocked_config] stopLossPct inválido.");
    }

    // Re-armado: validar el lease del cron ANTES de consumirlo (espejo reserveArm/JAV-53).
    if (args.rearmToken !== undefined) {
      if (bot.rearmStatus !== "running" || bot.rearmLeaseToken !== args.rearmToken
        || (bot.rearmLeaseUntil ?? 0) <= Date.now()) {
        throw new Error("[transient] Lease de rearm inválido/expirado al reservar (reintentar).");
      }
    }
    const fromRearm = args.rearmToken !== undefined || bot.rearmStatus != null;

    // (1) Unicidad: una sola generación NO terminal por bot.
    const arms = await ctx.db.query("trading_arms").withIndex("by_bot_generation", (q) =>
      q.eq("botId", args.botId)).collect();
    if (arms.find((a) => !ARM_TERMINAL.has(a.status))) {
      throw new Error("[transient] Ya existe un armado activo para este bot.");
    }
    const generation = arms.reduce((m, a) => Math.max(m, a.generation), 0) + 1;

    // (2) GUARD SIMÉTRICO (P2 + V2-P3), DENTRO de la OCC — dos helpers con nombre:
    //  (a) ejecución manual viva del mismo coin ⇒ [transient] (termina sola; el rearm reintenta);
    //  (b) arm vivo de OTRO motor en (cuenta, coin) ⇒ fail-closed contra drift legacy, aunque JAV-102
    //      debería impedirlo (los arms propios ya los cubrió la unicidad de arriba — este bot es el
    //      único trading de la cuenta/coin por exclusividad, así que cualquier hit es ajeno).
    const manual = await liveManualExecutionForAccountAsset(ctx, hlAccountId, asset);
    if (manual) {
      throw new Error(`[transient] Ejecución manual viva (${manual.status}) en esta cuenta para ${asset}; esperando a que cierre.`);
    }
    const foreignArm = await liveArmForAccountAssetExcept(ctx, hlAccountId, asset, {});
    if (foreignArm) {
      throw new Error(`[transient] Arm vivo de otro motor (${foreignArm.table}:${foreignArm.status}) en esta cuenta para ${asset}.`);
    }

    // (3) Topología / validación de rango — SOLO camino de par de triggers. La variante marketEntry
    // la OMITE por completo (no hay triggers que validar — V2-P4 coherencia).
    const isMarket = args.marketEntry !== undefined;
    let legsFactor: number;
    if (isMarket) {
      // El lado DEBE ser compatible con la dirección configurada: esta OCC es la autoridad money-path
      // (un bug/dato stale en la action jamás debe abrir posición del lado contrario a la config).
      const side = args.marketEntry!.side;
      if ((direction === "long" && side !== "Long") || (direction === "short" && side !== "Short")) {
        throw new Error(`[blocked_config] marketEntry.side (${side}) incompatible con la dirección del bot (${direction}).`);
      }
      legsFactor = 1;   // una sola pata SIEMPRE (decisión 6)
    } else {
      const lo = args.lowerTriggerPx, hi = args.upperTriggerPx;
      if (!Number.isFinite(lo as number) || !Number.isFinite(hi as number) || (lo as number) <= 0 || (hi as number) <= 0) {
        throw new Error("[blocked_config] Triggers de entrada inválidos.");
      }
      if (!triggerSeparationOk(lo as number, hi as number, args.tickSize)) {
        throw new Error("[blocked_config] Separación de triggers < 1 tick (pre-trigger colapsa/invierte el rango).");
      }
      // (JAV-178-C1) TOPOLOGÍA PRIMERO: mark FUERA del rango ⇒ resultado TIPADO (no throw) — la
      // action re-bifurca a marketEntry EN EL MISMO tick (cierra la carrera bifurcación→OCC sin
      // alerta falsa de config). Debe clasificarse ANTES del rango mínimo: rangeWidthOk usa el mark
      // como denominador, y un mark MUY lejos del rango encoge el ancho relativo — un rango de
      // config válida caería como [blocked_config] (bloqueo 5 min + alerta) en vez de entrar a
      // mercado: el caso Benjamin extremo que la decisión 6 cubre.
      const topo = resolveEntryTopology(args.markPx, lo as number, hi as number, direction);
      if (topo.kind === "market") {
        return { ok: false as const, reason: "out_of_range" as const, side: topo.side };
      }
      // Rango mínimo SOLO con el mark DENTRO (denominador sano): mitiga el double-fill por whipsaw.
      if (!rangeWidthOk(lo as number, hi as number, args.markPx, bot.stopLossPct as number)) {
        throw new Error("[blocked_config] Rango demasiado angosto: ancho < RANGE_MIN_K×(SL+slippage) — riesgo de double-fill.");
      }
      legsFactor = direction === "long_short" ? 1 : 2;
    }

    // (4) Sizing: nocional = valor REAL del LP × capitalPct; size = nocional/mark (floor a szDecimals).
    if (!Number.isInteger(args.szDecimals) || args.szDecimals < 0) throw new Error("[blocked_config] szDecimals inválido.");
    const requestedNotionalUsd = args.lpNotionalUsd * ((bot.capitalPct as number) / 100);
    const f = Math.pow(10, args.szDecimals);
    const size = Math.floor((requestedNotionalUsd / args.markPx) * f) / f;   // floor = no sobre-dimensionar
    const effectiveNotionalUsd = size * args.markPx;
    if (!(size > 0) || effectiveNotionalUsd < MIN_PERP_NOTIONAL_USD) {
      throw new Error(`[blocked_config] Nocional efectivo por pata (< ${MIN_PERP_NOTIONAL_USD} USD): LP/capitalPct demasiado chicos.`);
    }

    // (5) Margen worst-case por modo: legsFactor patas pueden convivir hasta confirmar OCO
    // (long/short = 2×; long_short netea = 1×; market = 1×). resolveLeverage valida/ajusta leverage.
    const reservedNotional = effectiveNotionalUsd * legsFactor;
    const marginCommitted = await committedMarginForAccount(ctx, hlAccountId);
    const usableReal = args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER) - marginCommitted;
    if (!(usableReal > 0)) {
      throw new Error("[blocked_margin] Sin colateral usable para armar el trading (fondea la cuenta o espera a que HL libere el margen).");
    }
    // (CodeRabbit #144 Major) resolveLeverage recibe el máximo SANEADO (fallback AUTO_LEVERAGE_CAP
    // ante un assetMaxLeverage corrupto), no el crudo.
    const maxLevForCap = Number.isInteger(args.assetMaxLeverage) && args.assetMaxLeverage >= 1
      ? args.assetMaxLeverage : AUTO_LEVERAGE_CAP;
    const { appliedLeverage, marginRequired: marginReserved } = resolveLeverage({
      autoLeverage: bot.autoLeverage === true,
      manualLeverage: bot.leverage,
      reservedNotional,
      availableCollateral: args.availableCollateral,
      marginCommitted, assetMaxLeverage: maxLevForCap,
    });
    if ((marginCommitted + marginReserved) > args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER)) {
      throw new Error(
        `[blocked_margin] Margen insuficiente: comprometido ${marginCommitted.toFixed(2)} + requerido ` +
        `${marginReserved.toFixed(2)} > colateral ${args.availableCollateral.toFixed(2)}.`);
    }

    // Revalidar snapshot de TPs (defensa ante datos migrados que no pasaron por validatePoolBotConfig).
    const totalClosePct = (bot.tps ?? []).reduce((s, tp) => s + tp.closePct, 0);
    if (totalClosePct > 100 + 1e-9) {
      throw new Error(`[blocked_config] Σ closePct de TPs (${totalClosePct.toFixed(2)}%) supera 100%.`);
    }
    // Revalidar trailing (misma defensa): un bot legacy (JAV-41) con trailingStop:true y trailingPct
    // ausente/inválido NO debe armar con el trailing silenciosamente desactivado — el usuario cree
    // tener esa protección.
    if (bot.trailingStop === true
      && (!Number.isFinite(bot.trailingPct as number) || (bot.trailingPct as number) <= 0 || (bot.trailingPct as number) > 50)) {
      throw new Error(`[blocked_config] trailingStop activo con trailingPct inválido (${bot.trailingPct}); reconfigurá el bot.`);
    }

    // (6) Hard-cap del plan AUTORITATIVO con el consumo VIVO: coverageNotionalUsd = efectivo×legsFactor
    // (baja a 1× al confirmar OCO — reduceTradingReservation). El assert lanza [blocked_cap] (P6).
    const coverageNotionalUsd = reservedNotional;
    await assertWithinPlanCoverageForKey(ctx, userId, tradingCoverageKey(args.botId), coverageNotionalUsd);

    // (7) Insertar arm(arming) + filas de entrada pending (cloids attempt 0, HL-válidos).
    const now = Date.now();
    const trailingEnabled = bot.trailingStop === true;
    const armId = await ctx.db.insert("trading_arms", {
      botId: args.botId, userId, hlAccountId, poolId,
      asset, network: hlNetwork(), generation, status: "arming", desiredState: "armed",
      direction,
      lowerEdge: args.lowerEdge, upperEdge: args.upperEdge, preTriggerPct: bot.preTriggerPct,
      lowerTriggerPx: isMarket ? undefined : args.lowerTriggerPx,
      upperTriggerPx: isMarket ? undefined : args.upperTriggerPx,
      size, appliedLeverage, legsFactor,
      reservedNotional, marginReserved,
      requestedNotionalUsd, effectiveNotionalUsd, coverageNotionalUsd,
      ocoConfirmed: isMarket ? true : undefined,   // entry_market: OCO resuelto de ORIGEN (decisión 6)
      stopLossPct: bot.stopLossPct as number,
      breakevenPct: bot.breakevenPct,
      trailingPct: trailingEnabled ? bot.trailingPct : undefined,
      tps: bot.tps,
      fromRearm: fromRearm ? true : undefined,
      createdAt: now, updatedAt: now,
    });
    const cloids: Record<string, string> = {};
    if (isMarket) {
      const side = args.marketEntry!.side;
      const cloid = await toHlCloid(tradingCloidInput(String(armId), generation, "entry_market"));
      cloids.entry_market = cloid;
      await ctx.db.insert("trading_orders", {
        armId, role: "entry_market", isBuy: side === "Long", cloid,
        limitPx: args.marketLimitPx, size, reduceOnly: false, observedStatus: "pending",
        createdAt: now, updatedAt: now,
      });
    } else {
      for (const spec of entryOrderSpecs(direction)) {
        const cloid = await toHlCloid(tradingCloidInput(String(armId), generation, spec.role));
        cloids[spec.role] = cloid;
        await ctx.db.insert("trading_orders", {
          armId, role: spec.role, isBuy: spec.isBuy, cloid,
          triggerPx: spec.role === "entry_upper" ? args.upperTriggerPx : args.lowerTriggerPx,
          limitPx: spec.role === "entry_upper" ? args.entryUpperLimitPx : args.entryLowerLimitPx,
          size, reduceOnly: false, observedStatus: "pending",
          createdAt: now, updatedAt: now,
        });
      }
    }
    // Consumir el rearmToken EN LA MISMA OCC (el cron ya no registra outcome: fencing idempotente) +
    // reset del streak de re-entradas a mercado cuando se reserva por el camino OCO (decisión 6b:
    // "mark dentro del rango al rearmar" resetea la escalada).
    await ctx.db.patch(args.botId, {
      ...(args.rearmToken !== undefined ? {
        rearmStatus: undefined, nextRearmAt: undefined, rearmAttempts: 0,
        lastRearmError: undefined, lastRearmErrorKind: undefined,
        rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
      } : {}),
      ...(isMarket ? {} : { marketReentryStreak: 0 }),
    });
    elog("trading", "reserved", {
      armId: String(armId), botId: String(args.botId), asset, generation, appliedLeverage,
      legsFactor, market: isMarket, fromRearm,
    });
    return {
      ok: true as const, armId, generation, cloids, appliedLeverage, size,
      effectiveNotionalUsd, coverageNotionalUsd, reservedNotional, marginReserved, legsFactor,
    };
  },
});

// --- CAS pre-envío + gate bajo lease (revalidan live + cap + guard simétrico) ---------------------

export const markTradingArmSubmitting = internalMutation({
  args: { armId: v.id("trading_arms") },
  handler: async (ctx, { armId }): Promise<any> => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const, reason: "not_found" as const };
    if (arm.status !== "arming") return { ok: false as const, reason: "state" as const };
    if (arm.desiredState !== "armed") return { ok: false as const, reason: "disarmed" as const };
    if (!(await assertTradingLiveAdmissible(ctx, arm.botId))) return { ok: false as const, reason: "blocked" as const };
    if (!(await coverageAdmissibleForKey(ctx, arm.userId, tradingCoverageKey(arm.botId), arm.coverageNotionalUsd))) {
      // (P6/V2-P4) El clon trading escribe [blocked_cap]: lo que este gate revalida es cobertura de
      // PLAN, no margen HL — con el string legacy "[blocked_margin]" entraría al backoff acelerado.
      const tFail = Date.now();
      await ctx.db.patch(armId, { status: "failed", error: "[blocked_cap] cap/plan/suspensión (markTradingArmSubmitting)", updatedAt: tFail });
      await scheduleTradingRearmAfterFailed(ctx, arm.botId, "[blocked_cap] cap/plan/suspensión (markTradingArmSubmitting)", tFail);
      return { ok: false as const, reason: "blocked" as const };
    }
    const now = Date.now();
    const token = crypto.randomUUID();
    await ctx.db.patch(armId, {
      status: "submitting", submittedAt: now, updatedAt: now,
      reconcileLeaseUntil: now + TRADING_LEASE_MS, reconcileLeaseToken: token,
    });
    return { ok: true as const, token };
  },
});

export const gateTradingArmBeforeOrder = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string() },
  handler: async (ctx, { armId, token }): Promise<any> => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "submitting" || arm.desiredState !== "armed") return { ok: false as const };
    if (!(await assertTradingLiveAdmissible(ctx, arm.botId))) return { ok: false as const };
    if (!(await coverageAdmissibleForKey(ctx, arm.userId, tradingCoverageKey(arm.botId), arm.coverageNotionalUsd))) {
      const tFail = Date.now();
      await ctx.db.patch(armId, {
        status: "failed", error: "[blocked_cap] cap/plan/suspensión (gateTradingArmBeforeOrder)",
        reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: tFail,
      });
      await scheduleTradingRearmAfterFailed(ctx, arm.botId, "[blocked_cap] cap/plan/suspensión (gateTradingArmBeforeOrder)", tFail);
      return { ok: false as const };
    }
    // Re-chequeo del guard simétrico bajo lease (P2): una manual pudo reservarse entre la OCC y aquí.
    // El lado trading consulta SOLO execution_requests + arms AJENOS (exclusión del propio armId —
    // V2-P3: sin scope el gate se auto-bloquearía con su propia fila viva).
    const manual = await liveManualExecutionForAccountAsset(ctx, arm.hlAccountId, arm.asset);
    const foreign = manual ? null : await liveArmForAccountAssetExcept(ctx, arm.hlAccountId, arm.asset, { exceptTradingArmId: armId });
    if (manual || foreign) {
      const who = manual ? `manual:${manual.status}` : `${foreign!.table}:${foreign!.status}`;
      const tFail = Date.now();
      await ctx.db.patch(armId, {
        status: "failed", error: `[transient] Intent vivo (${who}) en (cuenta, coin) al enviar (gate)`,
        reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: tFail,
      });
      await scheduleTradingRearmAfterFailed(ctx, arm.botId, `[transient] Intent vivo (${who}) en (cuenta, coin) al enviar (gate)`, tFail);
      return { ok: false as const };
    }
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + TRADING_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Terminalización "pre-orden" (espejo failSpotDefensePreOrder + failArmPreOrder): GARANTIZADO sin RPC
// en vuelo — lease vigente, submitting, sin fill, y TODAS las filas de entrada pre-envío (pending, sin
// oid, sin submittedAt). Lo usa también la REVALIDACIÓN FRESCA pre-RPC (V2-P1): topología stale ⇒
// abortar sin HL, liberar reserva YA y reprogramar rearm.
export const failTradingPreOrder = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string(), error: v.string() },
  handler: async (ctx, { armId, token, error }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "submitting") return { ok: false as const };
    if (arm.filledSize != null || arm.entryPrice != null) return { ok: false as const };
    const orders = await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId)).collect();
    const entries = orders.filter((o) => o.role === "entry_upper" || o.role === "entry_lower" || o.role === "entry_market");
    if (entries.length === 0) return { ok: false as const };
    if (entries.some((o) => o.observedStatus !== "pending" || o.oid != null || o.submittedAt != null)) {
      return { ok: false as const };
    }
    const tFail = Date.now();
    await ctx.db.patch(armId, { status: "failed", error, reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: tFail });
    await scheduleTradingRearmAfterFailed(ctx, arm.botId, error, tFail);
    return { ok: true as const };
  },
});

// --- Lease del reconcile (espejo spotDefense) -----------------------------------------------------

export const claimTradingReconcile = internalMutation({
  args: { armId: v.id("trading_arms") },
  handler: async (ctx, { armId }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { claimed: false as const, reason: "not_found" as const };
    if (ARM_TERMINAL.has(arm.status)) return { claimed: false as const, reason: "terminal" as const };
    if ((arm.reconcileLeaseUntil ?? 0) > Date.now()) return { claimed: false as const, reason: "leased" as const };
    const token = crypto.randomUUID();
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + TRADING_LEASE_MS, reconcileLeaseToken: token, updatedAt: Date.now() });
    return { claimed: true as const, token };
  },
});

export const renewTradingReconcile = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || ARM_TERMINAL.has(arm.status)) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + TRADING_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const releaseTradingReconcile = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token) return;
    await ctx.db.patch(armId, { reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: Date.now() });
  },
});

// --- Máquina de estados (settle) + reducción 2×→1× -------------------------------------------------

export const settleTradingArm = internalMutation({
  args: {
    armId: v.id("trading_arms"),
    status: v.union(
      v.literal("armed"), v.literal("disarming"), v.literal("disarmed"), v.literal("filled"),
      v.literal("protecting"), v.literal("protected"), v.literal("closed"), v.literal("unknown"),
      v.literal("failed"), v.literal("manual_intervention")),
    token: v.string(),   // fencing OBLIGATORIO
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    filledEntryRole: v.optional(v.union(
      v.literal("entry_upper"), v.literal("entry_lower"), v.literal("entry_market"))),
    filledSide: v.optional(v.union(v.literal("Long"), v.literal("Short"))),
    error: v.optional(v.string()),
    closeReason: v.optional(v.union(
      v.literal("sl"), v.literal("tp"), v.literal("oco_race"), v.literal("manual"),
      v.literal("emergency"), v.literal("disarm"))),
  },
  handler: async (ctx, args): Promise<any> => {
    const arm = await ctx.db.get(args.armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== args.token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) {
      return { ok: false as const };
    }
    if (ARM_TERMINAL.has(arm.status)) return { ok: false as const };
    const allowed = ALLOWED_TR[arm.status];
    if (!allowed || !allowed.has(args.status)) return { ok: false as const };
    if (args.status === "closed" && args.closeReason === undefined) return { ok: false as const };
    // Cuarentena: no terminalizar un arm que llegó a submitting hasta pasado el plazo (RPC en vuelo).
    if (ARM_TERMINAL.has(args.status) && arm.submittedAt != null
        && Date.now() - arm.submittedAt <= TR_SUBMIT_QUARANTINE_MS) {
      return { ok: false as const, quarantined: true as const };
    }
    const now = Date.now();
    const patch: Record<string, unknown> = { status: args.status, updatedAt: now };
    for (const k of ["filledSize", "entryPrice", "filledEntryRole", "filledSide", "error"] as const) {
      if (args[k] !== undefined) patch[k] = args[k];
    }
    if (args.status === "closed" && args.closeReason !== undefined) patch.closeReason = args.closeReason;
    if (args.status === "filled" && arm.filledAt == null) {
      patch.filledAt = now;
      // (Revisión PR3) Ventana de PROTECCIÓN de 4 min desde el fill (plan: SL_PROTECT_DEADLINE_MS ⇒
      // cierre de emergencia). El motor la LIMPIA al confirmar el SL resting y la REFRESCA al
      // necesitar recolocar (ventana fresca, patrón triggerArms) — sin esto el deadline era código
      // muerto y la escalada dependía del contador de cloids (roto por las rotaciones de trailing).
      patch.protectDeadline = now + 4 * 60_000;
    }
    await ctx.db.patch(args.armId, patch);
    elog("trading", "transition", { armId: String(args.armId), from: arm.status, to: args.status, closeReason: args.closeReason ?? null });

    if (ARM_TERMINAL.has(args.status)) {
      const bot = await ctx.db.get(arm.botId);
      if (bot?.disarmPending) {
        // Completar la pausa (el disarm ganó): desactivar y limpiar rearm.
        await ctx.db.patch(arm.botId, {
          active: false, disarmPending: false, disarmRequestedAt: undefined,
          rearmStatus: undefined, nextRearmAt: undefined, rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
        });
      } else if (args.status === "closed" && bot) {
        const reason = args.closeReason!;
        // Whipsaw: sl y oco_race cuentan stops consecutivos (alerta a los 5, sendStopAlert reusado);
        // tp resetea contador Y streak de re-entradas a mercado (decisión 6b) — INCONDICIONAL, aunque
        // el autoRearm esté apagado (un TP exitoso siempre desarma la escalera; sin esto un streak
        // viejo re-escalaría de más al reactivar). disarm/emergency/manual no tocan nada ni rearman.
        if (reason === "sl" || reason === "oco_race") {
          await ctx.db.patch(arm.botId, { consecutiveStops: (bot.consecutiveStops ?? 0) + 1 });
        } else if (reason === "tp") {
          await ctx.db.patch(arm.botId, { consecutiveStops: 0, marketReentryStreak: 0 });
        }
        if ((reason === "sl" || reason === "tp" || reason === "oco_race")
          && bot.active && bot.autoRearm === true && bot.rearmStatus === undefined) {
          // (Decisión 6b) Cooldown del rearm: base 5 min. Si el arm cerrado por SL era ENTRY_MARKET,
          // el streak de re-entradas consecutivas sube y la ESCALERA del plan es literal por streak:
          // 1º SL de mercado ⇒ 5, 2º ⇒ 15, 3º ⇒ 30, 4º+ ⇒ 60 (índice streak−1; ningún elemento del
          // array queda muerto — espíritu JAV-111: el primer reintento no se sobre-espacia). Resets:
          // reserva por camino OCO (mark dentro, reserveTradingArm) y cierre por TP (arriba).
          let cooldown = TR_REARM_COOLDOWN_MS;
          let streakPatch: Record<string, unknown> = {};
          if (reason === "sl" && arm.filledEntryRole === "entry_market") {
            const streak = (bot.marketReentryStreak ?? 0) + 1;
            cooldown = MARKET_REENTRY_COOLDOWNS_MS[Math.min(streak - 1, MARKET_REENTRY_COOLDOWNS_MS.length - 1)];
            streakPatch = { marketReentryStreak: streak };
          }
          await ctx.db.patch(arm.botId, {
            rearmStatus: "pending", nextRearmAt: now + cooldown, rearmAttempts: 0,
            lastRearmError: undefined, lastRearmErrorKind: undefined,
            rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
            ...streakPatch,
          });
        }
      } else if (args.status === "failed") {
        await scheduleTradingRearmAfterFailed(ctx, arm.botId, args.error, now);
      }
    }
    return { ok: true as const };
  },
});

// Reducción 2×→1× al confirmar OCO (SOLO tras la relectura NEGATIVA de fills de la hermana
// post-cancelación — P1: el motor la invoca únicamente en ese punto). Idempotente. En long_short
// (legsFactor 1) solo late el latch ocoConfirmed.
export const reduceTradingReservation = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (ARM_TERMINAL.has(arm.status)) return { ok: false as const };
    if (arm.ocoConfirmed === true && arm.reservationReduced === true) return { ok: true as const, already: true as const };
    const now = Date.now();
    if (arm.legsFactor === 2 && arm.reservationReduced !== true) {
      await ctx.db.patch(armId, {
        ocoConfirmed: true, reservationReduced: true,
        reservedNotional: arm.reservedNotional / 2,
        marginReserved: arm.marginReserved / 2,
        coverageNotionalUsd: arm.effectiveNotionalUsd ?? arm.reservedNotional / 2,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(armId, { ocoConfirmed: true, updatedAt: now });
    }
    return { ok: true as const };
  },
});

// --- Mutations de órdenes bajo lease (espejo spotDefense, generalizado a roles trading) -----------

const TR_OBSERVED = v.union(
  v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
  v.literal("canceled"), v.literal("rejected"), v.literal("unknown"));

export const setTradingOrderObserved = internalMutation({
  args: {
    armId: v.id("trading_arms"), token: v.string(),
    role: v.union(
      v.literal("entry_upper"), v.literal("entry_lower"), v.literal("entry_market"),
      v.literal("sl"), v.literal("tp"), v.literal("close")),
    tpIndex: v.optional(v.number()),
    observedStatus: TR_OBSERVED,
    oid: v.optional(v.string()),
    limitPx: v.optional(v.number()),
    markSubmitted: v.optional(v.boolean()),
  },
  handler: async (ctx, { armId, token, role, tpIndex, observedStatus, oid, limitPx, markSubmitted }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const order = role === "tp"
      ? await ctx.db.query("trading_orders").withIndex("by_arm_role_index", (q) => q.eq("armId", armId).eq("role", "tp").eq("tpIndex", tpIndex)).first()
      : await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", role)).first();
    if (!order) return { ok: false as const };
    const patch: Record<string, unknown> = { observedStatus, updatedAt: Date.now() };
    if (oid !== undefined) patch.oid = oid;
    if (limitPx !== undefined) patch.limitPx = limitPx;
    if (markSubmitted) patch.submittedAt = Date.now();
    await ctx.db.patch(order._id, patch);
    return { ok: true as const };
  },
});

// SL del arm (upsert rol "sl"; rota por attempt vía slPendingCloid — generaliza bePendingCloid a
// CUALQUIER recolocación: BE y trailing). Un pre-record nuevo NO hereda oid/submittedAt del muerto.
export const recordTradingSlOrder = internalMutation({
  args: {
    armId: v.id("trading_arms"), token: v.string(),
    cloid: v.string(), oid: v.optional(v.string()),
    triggerPx: v.number(), size: v.number(),
    // (P1/3b) El LADO del SL se deriva del SIGNO del neto releído — un fill tardío de la hermana puede
    // INVERTIRLO. Explícito y aplicado también en la ROTACIÓN (patch), no solo al insertar; sin él se
    // deriva de arm.filledSide (camino normal sin inversión).
    isBuy: v.optional(v.boolean()),
    observedStatus: TR_OBSERVED,
    markSubmitted: v.optional(v.boolean()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { armId, token, cloid, oid, triggerPx, size, isBuy, observedStatus, markSubmitted, attempt }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const now = Date.now();
    if (attempt !== undefined && attempt !== arm.slAttempts) await ctx.db.patch(armId, { slAttempts: attempt, updatedAt: now });
    const existing = await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "sl")).first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        observedStatus, triggerPx, size, cloid, updatedAt: now,
        oid, submittedAt: markSubmitted ? now : undefined,
        ...(isBuy !== undefined ? { isBuy } : {}),
        ...(attempt !== undefined ? { attempt } : {}),
      });
      return { ok: true as const, orderId: existing._id };
    }
    const orderId = await ctx.db.insert("trading_orders", {
      armId, role: "sl", isBuy: isBuy ?? (arm.filledSide === "Short"), cloid, oid, triggerPx, size,
      reduceOnly: true, observedStatus,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(markSubmitted ? { submittedAt: now } : {}), createdAt: now, updatedAt: now,
    });
    return { ok: true as const, orderId };
  },
});

// Rotación place-antes-de-cancel: trackea el cloid del SL NUEVO antes del RPC (mientras esté set, el
// reconcile lo suma a ownCloids → cleanup si el swap muere a medias). null = swap completado/abortado.
export const setTradingSlPendingCloid = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string(), cloid: v.union(v.string(), v.null()) },
  handler: async (ctx, { armId, token, cloid }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { slPendingCloid: cloid === null ? undefined : cloid, lastSlReplaceAt: cloid === null ? arm.lastSlReplaceAt : Date.now(), updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const recordTradingTpOrder = internalMutation({
  args: {
    armId: v.id("trading_arms"), token: v.string(), tpIndex: v.number(),
    cloid: v.string(), oid: v.optional(v.string()),
    triggerPx: v.number(), size: v.number(),
    // (P1/3b) Igual que el SL: el lado puede invertirse con el neto releído — explícito también aquí.
    isBuy: v.optional(v.boolean()),
    observedStatus: TR_OBSERVED,
    markSubmitted: v.optional(v.boolean()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { armId, token, tpIndex, cloid, oid, triggerPx, size, isBuy, observedStatus, markSubmitted, attempt }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const now = Date.now();
    const existing = await ctx.db.query("trading_orders").withIndex("by_arm_role_index", (q) => q.eq("armId", armId).eq("role", "tp").eq("tpIndex", tpIndex)).first();
    if (existing) {
      const patch: Record<string, unknown> = {
        observedStatus, triggerPx, size, cloid, updatedAt: now,
        oid, submittedAt: markSubmitted ? now : undefined, preparedAt: markSubmitted ? undefined : now,
      };
      if (isBuy !== undefined) patch.isBuy = isBuy;
      if (attempt !== undefined) patch.attempt = attempt;
      await ctx.db.patch(existing._id, patch);
      return { ok: true as const, orderId: existing._id };
    }
    const orderId = await ctx.db.insert("trading_orders", {
      armId, role: "tp", tpIndex, isBuy: isBuy ?? (arm.filledSide === "Short"), cloid, oid, triggerPx, size,
      reduceOnly: true, observedStatus,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(markSubmitted ? { submittedAt: now } : { preparedAt: now }), createdAt: now, updatedAt: now,
    });
    return { ok: true as const, orderId };
  },
});

// Cierre IOC reduce-only con CLOID DETERMINISTA (rol "close": emergencia / oco_race / disarm) —
// mejora vs spot defense: el cierre también se audita/reconcilia por cloid.
export const recordTradingCloseOrder = internalMutation({
  args: {
    armId: v.id("trading_arms"), token: v.string(),
    cloid: v.string(), oid: v.optional(v.string()),
    isBuy: v.boolean(), limitPx: v.optional(v.number()), size: v.number(),
    observedStatus: TR_OBSERVED,
    markSubmitted: v.optional(v.boolean()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { armId, token, cloid, oid, isBuy, limitPx, size, observedStatus, markSubmitted, attempt }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const now = Date.now();
    const existing = await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "close")).first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        observedStatus, isBuy, limitPx, size, cloid, updatedAt: now,
        oid, submittedAt: markSubmitted ? now : undefined, preparedAt: markSubmitted ? undefined : now,
        ...(attempt !== undefined ? { attempt } : {}),
      });
      return { ok: true as const, orderId: existing._id };
    }
    const orderId = await ctx.db.insert("trading_orders", {
      armId, role: "close", isBuy, cloid, oid, limitPx, size, reduceOnly: true, observedStatus,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(markSubmitted ? { submittedAt: now } : { preparedAt: now }), createdAt: now, updatedAt: now,
    });
    return { ok: true as const, orderId };
  },
});

// (Revisión PR3) Ventana de protección del SL: null = protegido (SL resting confirmado); número =
// deadline para lograr protección, vencido ⇒ cierre de emergencia. La fija el settle a filled y la
// gestiona el motor (refresh al recolocar, clear al confirmar resting). Bajo lease.
export const setTradingProtectDeadline = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string(), value: v.union(v.number(), v.null()) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { protectDeadline: value === null ? undefined : value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (Revisión PR3, bloqueante #2) Actualiza los datos de fill EN FASE DE POSICIÓN (plan POST-FILL (1):
// "actualizar filledSize" con el neto releído — un remanente de la entrada que llena tarde crece la
// posición LEGÍTIMAMENTE; sin esto el drift comparaba contra el snapshot stale y CANCELABA el SL).
// Solo crece (nunca reduce: las reducciones son TPs/closes) y solo en estados de posición. Bajo lease.
export const setTradingFillData = internalMutation({
  args: {
    armId: v.id("trading_arms"), token: v.string(),
    filledSize: v.number(), entryPrice: v.optional(v.number()),
  },
  handler: async (ctx, { armId, token, filledSize, entryPrice }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "filled" && arm.status !== "protecting" && arm.status !== "protected") return { ok: false as const };
    if (!Number.isFinite(filledSize) || filledSize <= (arm.filledSize ?? 0)) return { ok: true as const, unchanged: true as const };
    await ctx.db.patch(armId, {
      filledSize,
      ...(entryPrice !== undefined && Number.isFinite(entryPrice) && entryPrice > 0 ? { entryPrice } : {}),
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

// Latch one-way del break-even (no se revierte).
export const setTradingBeMoved = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { beMoved: true, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Anchor del trailing PERSISTIDO y DIRECCIONAL (P4): SOLO avances favorables bajo lease — Long sube
// (max), Short baja (min). Un valor no favorable es no-op (jamás retrocede el avance; anti-carrera).
export const setTradingTrailAnchor = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string(), anchorPx: v.number() },
  handler: async (ctx, { armId, token, anchorPx }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (!Number.isFinite(anchorPx) || anchorPx <= 0) return { ok: false as const };
    if (!arm.filledSide) return { ok: false as const };
    const old = arm.trailAnchorPx;
    const favorable = old === undefined
      || (arm.filledSide === "Long" ? anchorPx > old : anchorPx < old);
    if (!favorable) return { ok: true as const, unchanged: true as const };
    await ctx.db.patch(armId, { trailAnchorPx: anchorPx, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const setTradingCloseConfirm = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string(), value: v.union(v.number(), v.null()) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { closeConfirmSince: value === null ? undefined : value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const setTradingDriftConfirm = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string(), value: v.union(v.number(), v.null()) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { driftConfirmSince: value === null ? undefined : value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const setTradingEmergencyClosing = internalMutation({
  args: { armId: v.id("trading_arms"), token: v.string(), value: v.union(v.literal("emergency"), v.literal("disarm")) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { emergencyClosing: value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// --- Queries internas (motor PR3) + UI (PR4) ------------------------------------------------------

export const getTradingArmInternal = internalQuery({
  args: { armId: v.id("trading_arms") },
  handler: async (ctx, { armId }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return null;
    const orders = await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId)).collect();
    return { arm, orders };
  },
});

export const getLiveTradingArmInternal = internalQuery({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const arms = await ctx.db.query("trading_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect();
    return arms.find((a) => !ARM_TERMINAL.has(a.status)) ?? null;
  },
});

// IDs de arms vivos por estado NO terminal (sin escanear historial terminal) — espejo spotDefense.
export const listLiveTradingArmIdsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 200;
    const ids: Id<"trading_arms">[] = [];
    for (const status of TR_ARM_NON_TERMINAL) {
      for await (const a of ctx.db.query("trading_arms")
        .withIndex("by_status_updated", (q) => q.eq("status", status)).order("asc")) {
        ids.push(a._id);
        if (ids.length >= cap) return ids;
      }
    }
    return ids;
  },
});

// (PR3) Anti-loop del rearm: si el bot YA tiene un arm vivo (un stale-retry inmediato que armó, o un
// armado manual durante el cooldown), el rearm encolado quedó OBSOLETO — limpiarlo en vez de que el
// cron lo reclame y choque contra la unicidad para siempre. Espejo del claim de spotDefense.
export const clearTradingRearmIfArmedInternal = internalMutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot || bot.kind !== "trading") return { ok: false as const };
    if (bot.rearmStatus === undefined) return { ok: true as const, already: true as const };
    const live = await hasNonTerminalTradingArmForBot(ctx, botId);
    if (!live) return { ok: false as const, reason: "no_live_arm" as const };
    await ctx.db.patch(botId, {
      rearmStatus: undefined, nextRearmAt: undefined, rearmAttempts: 0,
      rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
    });
    return { ok: true as const };
  },
});

// Bots TRADING con rearm listo (separación por kind: el cron IL usa listRearmReadyBots, que EXCLUYE
// trading; este listado solo devuelve kind==="trading"). Incluye running con lease vencido (recovery).
export const listDueTradingRearmsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const max = limit ?? 25;
    const out: Id<"bots">[] = [];
    for (const status of ["running", "pending", "blocked"] as const) {
      for await (const b of ctx.db
        .query("bots")
        .withIndex("by_rearm_status", (q) => q.eq("rearmStatus", status).lte("nextRearmAt", now))
        .order("asc")) {
        if (b.kind !== "trading") continue;
        if ((b.rearmLeaseUntil ?? 0) <= now) out.push(b._id);
        if (out.length >= max) return out;
      }
    }
    return out;
  },
});

// Arms de trading VIVOS del usuario (tarjeta TradingViva, PR4).
export const listMyActiveTradingArms = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUserOrNull(ctx);
    if (!user) return [];
    const out: any[] = [];
    for (const st of TR_ARM_NON_TERMINAL) {
      const arms = await ctx.db.query("trading_arms").withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", st)).collect();
      out.push(...arms);
    }
    return out;
  },
});

// Detalle del bot de trading (arm vivo + órdenes topadas) para la tarjeta en vivo (PR4).
export const getTradingDetail = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const user = await getUserOrNull(ctx);
    if (!user) return null;
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id || bot.kind !== "trading") return null;
    const arms = await ctx.db.query("trading_arms").withIndex("by_bot_generation", (q) =>
      q.eq("botId", botId)).collect();
    const liveArm = arms.find((a) => !ARM_TERMINAL.has(a.status)) ?? null;
    let orders: any[] = [];
    if (liveArm) {
      orders = (await ctx.db.query("trading_orders").withIndex("by_arm_role", (q) =>
        q.eq("armId", liveArm._id)).collect()).slice(0, 50);
    }
    return { bot, arm: liveArm, orders };
  },
});
