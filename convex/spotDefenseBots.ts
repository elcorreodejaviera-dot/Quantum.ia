import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, requireBotManager, getUserOrNull, writeAdminLog, hasPermission, deriveBaseAsset } from "./helpers";
import { elog } from "./log";
import { spotDefenseCloidInput, toHlCloid } from "./cloids";
import { hlNetwork } from "./hlNetwork";
import { committedMarginForAccount } from "./executions";
import { resolveLeverage, AUTO_LEVERAGE_CAP, MANUAL_LEVERAGE_MIN, MANUAL_LEVERAGE_MAX, MARGIN_SAFETY_BUFFER } from "./leverage";
import {
  spotDefenseCoverageKey, remainingCoverageForKey,
  assertWithinPlanCoverageForKey, coverageAdmissibleForKey,
} from "./coverageUsage";

// (JAV-107) Bot de defensa de posiciones SPOT — persistencia + reserva atómica + gates. NON-node
// (convex-testable). NO envía órdenes a HL (eso es el motor de Fase 3, spotDefenseEngine.ts "use node").
// La action de Fase 3 LEE HL (markPx, colateral, flat) y delega aquí: persistSpotDefenseBot (upsert) →
// reserveSpotDefenseArm (OCC: margen/cap/sizing capado = fuente de verdad) → CAS pre-envío.

// Gate dedicado de mainnet (Codex r2 #6), espejo de mainnetSpotGridApproved.
const MAINNET_GATE_KEY = "mainnetSpotDefenseApproved";
// Mínimo de nocional perp en HL (≈ $10). Por debajo, una orden se rechaza → no tiene sentido reservar.
const MIN_PERP_NOTIONAL_USD = 10;
// Lease/fencing del reconcile + envío (un solo worker por arm a la vez).
const SPOT_DEFENSE_LEASE_MS = 2 * 60 * 1000;

const ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);
// (CodeRabbit) Complemento EXACTO de ARM_TERMINAL: estados NO terminales de un arm. Se usa para consultar
// arms vivos por `by_status_updated` (sin escanear el historial terminal). Mantener en sync con el enum
// de `spot_defense_arms.status` del schema.
const SD_ARM_NON_TERMINAL = [
  "arming", "submitting", "armed", "disarming", "filled", "protecting", "protected", "unknown",
  "manual_intervention",
] as const;
// Transiciones permitidas de un arm de defensa (single-entry). Evita degradar estados (p.ej. protected→
// armed) y acota la máquina de estados. Espejo recortado de ALLOWED_ARM del motor de pool.
const ALLOWED_SD: Record<string, Set<string>> = {
  // (Codex Fase 3a/3b NO-GO #1) Desde `arming` NO se puede ir a armed/filled/unknown por settle: eso
  // marcaría el arm como cubriendo sin pasar por el CAS (markArmSubmitting, arming→submitting) ni enviar
  // la orden a HL. Solo se permite cancelar (disarming/disarmed) o fallar pre-envío.
  arming: new Set(["disarming", "disarmed", "failed"]),
  // (Codex 3c-1 NO-GO #1) submitting/unknown deben poder llegar a `disarmed` (pre-fill, sin posición):
  // el reconcile cancela la entrada y desarma. Antes solo permitían `disarming` → settle quedaba en no-op.
  submitting: new Set(["armed", "filled", "protecting", "protected", "unknown", "failed", "disarming", "disarmed"]),
  unknown: new Set(["armed", "filled", "protecting", "protected", "closed", "failed", "disarming", "disarmed", "manual_intervention"]),
  armed: new Set(["filled", "disarming", "disarmed", "unknown", "failed", "manual_intervention"]),
  filled: new Set(["protecting", "protected", "closed", "failed", "manual_intervention"]),
  protecting: new Set(["protected", "closed", "failed", "manual_intervention"]),
  protected: new Set(["closed", "manual_intervention"]),
  disarming: new Set(["disarmed", "closed", "failed"]),
  manual_intervention: new Set(["closed", "disarmed", "failed"]),
};
// Cuarentena tras `submittedAt`: una respuesta tardía de HL aún podría materializar la orden, así que no
// se terminaliza un arm que llegó a submitting hasta pasado el plazo (anti doble-envío/huérfano).
const SD_SUBMIT_QUARANTINE_MS = 90 * 1000;
// (3c-3b) Auto-rearm: cooldown tras un cierre por SL antes de reabrir; backoff y lease del cron.
const SD_REARM_COOLDOWN_MS = 5 * 60 * 1000;
const SD_REARM_BACKOFF_MS = 5 * 60 * 1000;
const SD_REARM_LEASE_MS = 2 * 60 * 1000;

// (CodeRabbit) Política ÚNICA de auto-rearm durable tras un `failed` TERMINAL. Se llama desde TODOS los
// caminos que terminalizan `failed` (settleSpotDefenseArm + los patch directos pre-envío:
// markArmSubmitting / gateArmBeforeOrder / failSpotDefensePreOrder), para que un bot con autoRearm nunca
// quede sin arm vivo y sin rearm pendiente. El guard `rearmStatus===undefined` NO pisa un ciclo de rearm
// en curso (running) ni uno ya agendado (pending/blocked): ese caso lo gestiona settleSpotDefenseRearm del
// cron (backoff + escalado a blocked). Respeta disarmPending (pausa en curso).
async function scheduleDurableRearmAfterFailed(
  ctx: MutationCtx, botId: Id<"spot_defense_bots">, error: string | undefined, now: number,
): Promise<void> {
  const bot = await ctx.db.get(botId);
  if (!bot || bot.disarmPending || !bot.active || bot.status !== "running" || bot.autoRearm !== true) return;
  if (bot.rearmStatus !== undefined) return;
  await ctx.db.patch(botId, {
    rearmStatus: "pending", nextRearmAt: now + SD_REARM_COOLDOWN_MS, rearmAttempts: 0,
    lastRearmError: error, rearmLeaseToken: undefined, rearmLeaseUntil: undefined, updatedAt: now,
  });
}

// --- Gate de mainnet (admin) -------------------------------------------------------------------

async function isMainnetSpotDefenseApproved(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
  return (gate?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

// (Codex Fase 2 NO-GO #1) Admisión LIVE del bot de defensa, equivalente a executions.assertLiveAdmissible
// pero sobre `spot_defense_bots`. Revalida los gates globales + permiso + estado del bot + cuenta + red +
// gate mainnet en CADA punto sensible (reserva y ambos CAS), cerrando la ventana entre persist y envío:
// si entre medias se apaga el kill-switch, se activa simulación, se revoca canTradeLive, se desvincula la
// credencial, se pausa el bot o cambia la red, la reserva/CAS NO procede.
async function assertSpotDefenseLiveAdmissible(
  ctx: QueryCtx | MutationCtx, botId: Id<"spot_defense_bots">,
): Promise<boolean> {
  const bot = await ctx.db.get(botId);
  if (!bot) return false;
  const user = await ctx.db.get(bot.userId);
  if (!user) return false;
  const [trading, sim] = await Promise.all([
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "tradingEnabled")).first(),
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "simulationMode")).first(),
  ]);
  if (trading?.value !== true || sim?.value !== false) return false;
  if (!(await hasPermission(ctx, user, "canTradeLive"))) return false;
  // (Codex #4) El bot debe estar activo, corriendo y sin pausa en curso.
  if (!bot.active || bot.status !== "running" || bot.disarmPending) return false;
  if (bot.network !== hlNetwork()) return false;
  if (bot.network === "mainnet" && !(await isMainnetSpotDefenseApproved(ctx))) return false;
  const cred = await ctx.db.get(bot.hlAccountId);
  if (!cred || cred.userId !== bot.userId) return false;   // la cuenta sigue siendo del dueño
  return true;
}

export const getMainnetSpotDefenseApproval = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    return (gate?.value as { enabled?: boolean; approvedAt?: number; approvedBy?: string } | undefined) ?? null;
  },
});

export const setMainnetSpotDefenseApproval = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const admin = await requireAdmin(ctx);
    const existing = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    const value = { enabled, approvedAt: Date.now(), approvedBy: admin.clerkId };
    if (existing) await ctx.db.patch(existing._id, { value });
    else await ctx.db.insert("system_config", { key: MAINNET_GATE_KEY, value });
    await writeAdminLog(ctx, admin.clerkId, "set_mainnet_spot_defense_approval", { enabled });
    return { ok: true as const };
  },
});

// Lectura interna del gate para el motor (action) — sin auth de admin.
export const getMainnetSpotDefenseApprovedInternal = internalQuery({
  args: {},
  handler: async (ctx) => ({ approved: await isMainnetSpotDefenseApproved(ctx) }),
});

// --- Validación de config + exclusividad (JAV-102) ---------------------------------------------

function validateSpotDefenseConfig(args: {
  leverage: number; stopLossPct: number; bufferPct?: number; triggerPrice: number;
  triggerMode: "manual" | "dca"; minCoveragePct?: number; breakevenPct?: number;
  tps?: { gainPct: number; closePct: number }[];
}) {
  if (!Number.isFinite(args.leverage) || args.leverage < MANUAL_LEVERAGE_MIN || args.leverage > MANUAL_LEVERAGE_MAX) {
    throw new Error(`leverage debe estar entre ${MANUAL_LEVERAGE_MIN} y ${MANUAL_LEVERAGE_MAX}.`);
  }
  if (!Number.isFinite(args.stopLossPct) || args.stopLossPct <= 0 || args.stopLossPct >= 100) {
    throw new Error("stopLossPct debe estar entre 0 y 100 (exclusivo).");
  }
  // (Codex 3c-3ab no bloqueante) Validar breakevenPct (finitud/rango); el guard anti-auto-disparo del
  // motor ya protege, pero un valor absurdo no debe persistirse. >50 no tiene sentido para mover a BE.
  if (args.breakevenPct !== undefined && (!Number.isFinite(args.breakevenPct) || args.breakevenPct <= 0 || args.breakevenPct > 50)) {
    throw new Error("breakevenPct debe estar entre 0 y 50 (exclusivo/50).");
  }
  if (args.bufferPct !== undefined && (!Number.isFinite(args.bufferPct) || args.bufferPct < 0 || args.bufferPct > 100)) {
    throw new Error("bufferPct debe estar entre 0 y 100.");
  }
  if (!Number.isFinite(args.triggerPrice) || args.triggerPrice <= 0) {
    throw new Error("triggerPrice debe ser un número finito > 0.");
  }
  if (args.minCoveragePct !== undefined && (!Number.isFinite(args.minCoveragePct) || args.minCoveragePct < 0 || args.minCoveragePct > 100)) {
    throw new Error("minCoveragePct debe estar entre 0 y 100.");
  }
  let totalClosePct = 0;
  for (const tp of args.tps ?? []) {
    if (!Number.isFinite(tp.gainPct) || tp.gainPct <= 0 || !Number.isFinite(tp.closePct) || tp.closePct <= 0 || tp.closePct > 100) {
      throw new Error("Cada TP requiere gainPct > 0 y closePct en (0,100].");
    }
    totalClosePct += tp.closePct;
  }
  // (Codex 3c-3c NO-GO #3) La suma de closePct NO puede superar 100%: reduceOnly evita invertir la
  // posición, pero un sizing > 100% genera TPs incoherentes/rechazos y cierres mayores a la intención.
  if (totalClosePct > 100 + 1e-9) {
    throw new Error(`La suma de closePct de los TPs (${totalClosePct.toFixed(2)}%) no puede superar 100%.`);
  }
}

// Exclusividad de cuenta JAV-102 escaneando las TRES tablas por la cuenta HL (credencial). Mismas
// reglas que la cobertura: mismo baseAsset en la cuenta (cobertura/trading/otra defensa viva) → rechazo;
// grid vivo en la cuenta → rechazo (el grid exige cuenta dedicada total). `self` excluye el propio bot
// en un upsert.
async function assertSpotDefenseAccountExclusivity(
  ctx: MutationCtx, userId: Id<"users">, hlAccountId: Id<"hl_api_credentials">,
  baseAsset: string, self?: Id<"spot_defense_bots">,
) {
  const perp = await ctx.db.query("bots").withIndex("by_user_account", (q) =>
    q.eq("userId", userId).eq("hlAccountId", hlAccountId)).collect();
  if (perp.some((b) => b.baseAsset === baseAsset)) {
    throw new Error(`Esta cuenta de Hyperliquid ya tiene una cobertura para ${baseAsset}/USDC. Usá otra cuenta para defender este activo.`);
  }
  const others = await ctx.db.query("spot_defense_bots").withIndex("by_user_account", (q) =>
    q.eq("userId", userId).eq("hlAccountId", hlAccountId)).collect();
  if (others.some((b) => b._id !== self && b.baseAsset === baseAsset && b.status !== "stopped")) {
    throw new Error(`Esta cuenta ya tiene un bot de defensa para ${baseAsset}/USDC.`);
  }
  const grid = (await ctx.db.query("spot_grid_bots").withIndex("by_account", (q) =>
    q.eq("hlAccountId", hlAccountId)).collect()).find((g) => g.status !== "stopped");
  if (grid) {
    throw new Error("Esta cuenta está vinculada a un Spot Grid (cuenta dedicada). Usá una cuenta distinta.");
  }
}

// --- Persistencia (upsert por (userId, spotPositionId)) -----------------------------------------
// Llamada por la action de Fase 3 tras leer HL. `requestedNotionalUsd` = amount×markPx×(1+buffer)
// calculado por la action (markPx es HL). Aquí se valida config + exclusividad + gate + ownership.

export const persistSpotDefenseBot = mutation({
  args: {
    spotPositionId: v.id("spot_positions"),
    hlAccountId: v.id("hl_api_credentials"),
    leverage: v.number(),
    autoLeverage: v.optional(v.boolean()),
    bufferPct: v.optional(v.number()),
    stopLossPct: v.number(),
    breakevenPct: v.optional(v.number()),
    tps: v.optional(v.array(v.object({ gainPct: v.number(), closePct: v.number() }))),
    autoRearm: v.optional(v.boolean()),
    triggerMode: v.union(v.literal("manual"), v.literal("dca")),
    triggerPrice: v.number(),
    requestedNotionalUsd: v.number(),
    minCoveragePct: v.optional(v.number()),
    active: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ botId: Id<"spot_defense_bots"> }> => {
    const user = await requireBotManager(ctx);
    // Defensa = trading REAL → exige canTradeLive (separado de canManageBots). Admin tiene bypass.
    if (!(await hasPermission(ctx, user, "canTradeLive"))) {
      throw new Error("Crear un bot de defensa spot requiere el permiso canTradeLive.");
    }
    const pos = await ctx.db.get(args.spotPositionId);
    // spot_positions.userId = identity.subject (Clerk) = user.clerkId.
    if (!pos || pos.userId !== user.clerkId) {
      throw new Error("La posición spot no existe o no te pertenece.");
    }
    const cred = await ctx.db.get(args.hlAccountId);
    if (!cred || cred.userId !== user._id) {
      throw new Error("La cuenta Hyperliquid no existe o no te pertenece.");
    }
    validateSpotDefenseConfig(args);
    if (!Number.isFinite(args.requestedNotionalUsd) || args.requestedNotionalUsd <= 0) {
      throw new Error("requestedNotionalUsd inválido.");
    }
    const network = hlNetwork();
    if (network === "mainnet" && !(await isMainnetSpotDefenseApproved(ctx))) {
      throw new Error("El bot de defensa spot en mainnet no está aprobado por un administrador.");
    }
    const baseAsset = deriveBaseAsset(`${pos.asset}/USDC`);   // normaliza WETH→ETH/WBTC→BTC, nunca del cliente

    const existing = await ctx.db.query("spot_defense_bots").withIndex("by_user_position", (q) =>
      q.eq("userId", user._id).eq("spotPositionId", args.spotPositionId)).first();

    await assertSpotDefenseAccountExclusivity(ctx, user._id, args.hlAccountId, baseAsset, existing?._id);

    const now = Date.now();
    const common = {
      hlAccountId: args.hlAccountId,
      asset: baseAsset,
      baseAsset,
      side: "Short" as const,
      leverage: args.leverage,
      autoLeverage: args.autoLeverage,
      bufferPct: args.bufferPct,
      stopLossPct: args.stopLossPct,
      breakevenPct: args.breakevenPct,
      tps: args.tps,
      autoRearm: args.autoRearm,
      triggerMode: args.triggerMode,
      triggerPrice: args.triggerPrice,
      requestedNotionalUsd: args.requestedNotionalUsd,
      minCoveragePct: args.minCoveragePct,
      active: args.active,
      network,
      updatedAt: now,
    };
    if (existing) {
      // (Codex Fase 2 NO-GO #3) Con un arm NO terminal, cualquier patch de config/cuenta/trigger/nocional
      // dejaría el trigger vivo incoherente — se rechaza SIEMPRE (no solo cuando active=true). La única
      // operación segura es pausar (pauseSpotDefenseBot → disarmPending → el motor desarma).
      const live = (await ctx.db.query("spot_defense_arms").withIndex("by_bot_generation", (q) =>
        q.eq("botId", existing._id)).collect()).find((a) => !ARM_TERMINAL.has(a.status));
      if (live) {
        throw new Error("El bot tiene una cobertura activa; pausa el trigger (no se puede reconfigurar con un armado vivo).");
      }
      // (CodeRabbit) Reactivar un bot que quedó `stopped` (tras pausar) debe volver a `running`, o el
      // siguiente armado falla en assertSpotDefenseLiveAdmissible (exige status==="running").
      await ctx.db.patch(existing._id, { ...common, status: args.active ? "running" : "stopped" });
      return { botId: existing._id };
    }
    const botId = await ctx.db.insert("spot_defense_bots", {
      userId: user._id,
      spotPositionId: args.spotPositionId,
      ...common,
      status: "running",
      generation: 0,
      createdAt: now,
    });
    elog("spot_defense", "bot_persisted", { botId: String(botId), asset: baseAsset, network });
    // El arranque del armado (lee HL → reserva → coloca el trigger SELL) lo dispara la ACTION de creación
    // (Fase 4, "use node") tras persistir — no desde aquí, para no acoplar este módulo al motor "use node".
    return { botId };
  },
});

// --- Reserva atómica del arm (Codex r2 #1): margen real + cap + sizing capado en UNA OCC ----------

export const reserveSpotDefenseArm = internalMutation({
  args: {
    botId: v.id("spot_defense_bots"),
    triggerPx: v.number(),               // ya normalizado al tick por la action
    availableCollateral: v.number(),     // USDC libre (snapshot HL)
    assetMaxLeverage: v.number(),        // maxLeverage del activo en HL
    szDecimals: v.number(),              // decimales de tamaño del activo
  },
  // Promise<any>: corta el ciclo TS2589 (llama a coverageUsage). El cuerpo se sigue type-checkeando.
  handler: async (ctx, args): Promise<any> => {
    const bot = await ctx.db.get(args.botId);
    if (!bot) throw new Error("[blocked_config] Bot de defensa no encontrado.");
    // (Codex Fase 2 NO-GO #1+#4) Admisión LIVE autoritativa: switches globales + canTradeLive + bot
    // active/running/!disarmPending + cuenta owned + red + gate mainnet, en la MISMA OCC que reserva.
    if (!(await assertSpotDefenseLiveAdmissible(ctx, bot._id))) {
      throw new Error("[blocked_config] No admisible para trading real (switch/permiso/estado/cuenta/red/gate).");
    }
    if (!Number.isFinite(args.triggerPx) || args.triggerPx <= 0) throw new Error("[blocked_config] triggerPx inválido.");
    if (!Number.isFinite(args.availableCollateral) || args.availableCollateral < 0) {
      throw new Error("[blocked_config] availableCollateral inválido.");
    }

    // (1) Unicidad: una sola generación NO terminal por bot.
    const arms = await ctx.db.query("spot_defense_arms").withIndex("by_bot_generation", (q) =>
      q.eq("botId", args.botId)).collect();
    if (arms.find((a) => !ARM_TERMINAL.has(a.status))) {
      throw new Error("[transient] Ya existe un armado activo para este bot.");
    }
    const generation = arms.reduce((m, a) => Math.max(m, a.generation), 0) + 1;

    // (2) Margen real comprometido en la cuenta (AMBOS motores + grid ya incluidos en el helper).
    const marginCommitted = await committedMarginForAccount(ctx, bot.hlAccountId);
    const usableReal = args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER) - marginCommitted;
    if (!(usableReal > 0)) {
      throw new Error("[blocked_margin] Sin colateral usable para abrir la cobertura (fondea la cuenta).");
    }

    // (3) Cota de leverage para acotar el nocional por margen ANTES de capar. El leverage definitivo lo
    // resuelve `resolveLeverage` abajo (fuente única auditada); aquí solo se usa el techo para el cap.
    const maxLevForCap = Number.isInteger(args.assetMaxLeverage) && args.assetMaxLeverage >= 1
      ? args.assetMaxLeverage : AUTO_LEVERAGE_CAP;
    const hardCapForMargin = bot.autoLeverage === true
      ? Math.min(AUTO_LEVERAGE_CAP, maxLevForCap)
      : Math.min(Math.round(bot.leverage), maxLevForCap);
    if (!(hardCapForMargin >= 1)) throw new Error("[blocked_config] leverage efectivo inválido.");

    // (4) Sizing CAPADO (Codex r2 #1+#4): nocional = min(pedido, cota por margen, cap del plan restante).
    const marginCapNotional = usableReal * hardCapForMargin;
    const requested = bot.requestedNotionalUsd;
    const remaining = await remainingCoverageForKey(ctx, bot.userId, spotDefenseCoverageKey(bot._id));
    const target = Math.min(requested, marginCapNotional, remaining);
    const f = Math.pow(10, args.szDecimals);
    const size = Math.floor((target / args.triggerPx) * f) / f;     // floor = no sobre-dimensionar
    const effectiveNotionalUsd = size * args.triggerPx;
    if (!(size > 0) || effectiveNotionalUsd < MIN_PERP_NOTIONAL_USD) {
      throw new Error(`[blocked_margin] Cobertura efectiva por debajo del mínimo (${MIN_PERP_NOTIONAL_USD} USD): revisá colateral/cap/leverage.`);
    }
    // Umbral mínimo de cobertura (Codex r2 #4): si el cap/margen recorta por debajo, bloquear.
    if (bot.minCoveragePct !== undefined && effectiveNotionalUsd < (bot.minCoveragePct / 100) * requested) {
      throw new Error(`[blocked_margin] Cobertura efectiva (${effectiveNotionalUsd.toFixed(2)}) por debajo del umbral mínimo (${bot.minCoveragePct}% de ${requested.toFixed(2)}).`);
    }

    // (5) Leverage + margen por el helper ÚNICO auditado (Codex Fase 2 NO-GO #5): manual valida rango y
    // RECHAZA > máx del activo (no capa en silencio); auto calcula el mínimo entero que cabe. El nocional
    // efectivo ya está acotado por `hardCapForMargin`, así que el helper siempre encuentra solución.
    const { appliedLeverage, marginRequired: marginReserved } = resolveLeverage({
      autoLeverage: bot.autoLeverage === true,
      manualLeverage: bot.leverage,
      reservedNotional: effectiveNotionalUsd,
      availableCollateral: args.availableCollateral,
      marginCommitted, assetMaxLeverage: args.assetMaxLeverage,
    });
    if ((marginCommitted + marginReserved) > args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER)) {
      throw new Error(
        `[blocked_margin] Margen insuficiente: comprometido ${marginCommitted.toFixed(2)} + requerido ` +
        `${marginReserved.toFixed(2)} > colateral ${args.availableCollateral.toFixed(2)}.`);
    }

    // (Codex 3c-3c NO-GO #3) Revalidar el snapshot de TPs al reservar: Σ closePct ≤ 100 (defensa ante
    // datos migrados/manipulados que no pasaron por validateSpotDefenseConfig).
    const totalClosePct = (bot.tps ?? []).reduce((s, tp) => s + tp.closePct, 0);
    if (totalClosePct > 100 + 1e-9) {
      throw new Error(`[blocked_config] Σ closePct de TPs (${totalClosePct.toFixed(2)}%) supera 100%.`);
    }

    // (6) Hard-cap del plan AUTORITATIVO (idempotente, fail-closed) con el nocional EFECTIVO.
    await assertWithinPlanCoverageForKey(ctx, bot.userId, spotDefenseCoverageKey(bot._id), effectiveNotionalUsd);

    // (6) Insertar arm (arming) + orden entry (pending, sin submittedAt — se fija en el CAS).
    const now = Date.now();
    const armId = await ctx.db.insert("spot_defense_arms", {
      botId: bot._id, userId: bot.userId, hlAccountId: bot.hlAccountId,
      asset: bot.asset, network: bot.network, generation, status: "arming", desiredState: "armed",
      side: "Short", triggerPx: args.triggerPx, size, appliedLeverage,
      reservedNotional: effectiveNotionalUsd, marginReserved,
      requestedNotionalUsd: requested, effectiveNotionalUsd,
      stopLossPct: bot.stopLossPct, breakevenPct: bot.breakevenPct, tps: bot.tps,
      createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(bot._id, { effectiveNotionalUsd, generation, updatedAt: now });
    // (Codex NO-GO r2) El CLOID del entry DEBE ser un cloid HL válido ("0x"+32hex), igual que SL/TP: se
    // persiste, se envía a HL (`c:`) y se reconcilia por él (orderStatus/openByCloid/cancelByCloid/fills).
    // Antes se guardaba el input lógico crudo (`spot-defense:...`) → HL podía rechazar/no reconciliar.
    const cloid = await toHlCloid(spotDefenseCloidInput(String(armId), generation, "entry"));
    await ctx.db.insert("spot_defense_orders", {
      armId, role: "entry", cloid, oid: undefined,
      triggerPx: args.triggerPx, size, reduceOnly: false, observedStatus: "pending",
      createdAt: now, updatedAt: now,
    });
    elog("spot_defense", "reserved", {
      armId: String(armId), botId: String(bot._id), asset: bot.asset, generation, appliedLeverage,
      partial: effectiveNotionalUsd < requested,
    });
    return { armId, generation, cloid, appliedLeverage, size, effectiveNotionalUsd, requestedNotionalUsd: requested, marginReserved };
  },
});

// --- CAS pre-envío: arming → submitting, revalida intención + gate + cap (Codex r1 #5 / r2 #3) ----

export const markArmSubmitting = internalMutation({
  args: { armId: v.id("spot_defense_arms") },
  handler: async (ctx, { armId }): Promise<any> => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const, reason: "not_found" as const };
    if (arm.status !== "arming") return { ok: false as const, reason: "state" as const };
    if (arm.desiredState !== "armed") return { ok: false as const, reason: "disarmed" as const };
    // (Codex Fase 2 NO-GO r2 #1) Admisión LIVE COMPLETA justo antes de pasar a submitting: switches
    // globales + canTradeLive + bot active/running/!disarm + cuenta owned + red + gate mainnet.
    if (!(await assertSpotDefenseLiveAdmissible(ctx, arm.botId))) return { ok: false as const, reason: "blocked" as const };
    if (!(await coverageAdmissibleForKey(ctx, arm.userId, spotDefenseCoverageKey(arm.botId), arm.effectiveNotionalUsd))) {
      const tFail = Date.now();
      await ctx.db.patch(armId, { status: "failed", error: "[blocked_margin] cap/plan/suspensión (markArmSubmitting)", updatedAt: tFail });
      await scheduleDurableRearmAfterFailed(ctx, arm.botId, "[blocked_margin] cap/plan/suspensión (markArmSubmitting)", tFail);
      return { ok: false as const, reason: "blocked" as const };
    }
    const now = Date.now();
    const token = crypto.randomUUID();
    await ctx.db.patch(armId, {
      status: "submitting", submittedAt: now, updatedAt: now,
      reconcileLeaseUntil: now + SPOT_DEFENSE_LEASE_MS, reconcileLeaseToken: token,
    });
    return { ok: true as const, token };
  },
});

export const gateArmBeforeOrder = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string() },
  handler: async (ctx, { armId, token }): Promise<any> => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "submitting" || arm.desiredState !== "armed") return { ok: false as const };
    // (Codex Fase 2 NO-GO r2 #1) Última revalidación LIVE bajo lease, inmediatamente antes del envío:
    // un kill-switch / simulación / revocación de permiso / desvínculo de cuenta entre el CAS y el RPC.
    if (!(await assertSpotDefenseLiveAdmissible(ctx, arm.botId))) return { ok: false as const };
    if (!(await coverageAdmissibleForKey(ctx, arm.userId, spotDefenseCoverageKey(arm.botId), arm.effectiveNotionalUsd))) {
      const tFail = Date.now();
      await ctx.db.patch(armId, {
        status: "failed", error: "[blocked_margin] cap/plan/suspensión (gateArmBeforeOrder)",
        reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: tFail,
      });
      await scheduleDurableRearmAfterFailed(ctx, arm.botId, "[blocked_margin] cap/plan/suspensión (gateArmBeforeOrder)", tFail);
      return { ok: false as const };
    }
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + SPOT_DEFENSE_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// --- Queries / comandos de UI -------------------------------------------------------------------

export const listMySpotDefenseBots = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUserOrNull(ctx);
    if (!user) return [];
    return await ctx.db.query("spot_defense_bots").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
  },
});

// Detalle con el arm vivo + sus órdenes (topadas), para la tarjeta en vivo (Fase 4).
export const getSpotDefenseDetail = query({
  args: { botId: v.id("spot_defense_bots") },
  handler: async (ctx, { botId }) => {
    const user = await getUserOrNull(ctx);
    if (!user) return null;
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) return null;
    const arms = await ctx.db.query("spot_defense_arms").withIndex("by_bot_generation", (q) =>
      q.eq("botId", botId)).collect();
    const liveArm = arms.find((a) => !ARM_TERMINAL.has(a.status)) ?? null;
    let orders: any[] = [];
    if (liveArm) {
      orders = (await ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) =>
        q.eq("armId", liveArm._id)).collect()).slice(0, 50);
    }
    return { bot, arm: liveArm, orders };
  },
});

// Pausa/Stop: con arm vivo → disarmPending (el motor cancela/cierra en HL y completa la desactivación
// al confirmar terminal); SIN arm vivo → stopped+inactivo directo (no hay nada que desarmar en HL).
export const pauseSpotDefenseBot = mutation({
  args: { botId: v.id("spot_defense_bots") },
  // Promise<any>: corta el ciclo de inferencia TS2589 (agenda internal.spotDefenseEngine.* y este, a su
  // vez, llama internal.spotDefenseBots.* → grafo mutuo). El cuerpo se sigue type-checkeando.
  handler: async (ctx, { botId }): Promise<any> => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) throw new Error("Bot no encontrado.");
    const live = (await ctx.db.query("spot_defense_arms").withIndex("by_bot_generation", (q) =>
      q.eq("botId", botId)).collect()).find((a) => !ARM_TERMINAL.has(a.status));
    if (live) {
      // disarmPending=wantDisarm → el cron "reconcile spot defense" (≤1 min) cancela y cierra reduceOnly.
      // (NO se agenda el motor aquí para no crear un ciclo de tipos spotDefenseBots↔spotDefenseEngine.)
      await ctx.db.patch(botId, { disarmPending: true, disarmRequestedAt: Date.now(), updatedAt: Date.now() });
    } else {
      await ctx.db.patch(botId, { active: false, status: "stopped", disarmPending: false, disarmRequestedAt: undefined, updatedAt: Date.now() });
    }
    return { ok: true as const, hadLiveArm: !!live };
  },
});

// =============================================================================================
// Fase 3 (3a) — Mutations de ciclo de vida del arm (lease/fencing + máquina de estados). NON-node;
// las invoca el motor `spotDefenseEngine.ts` ("use node"). Espejo recortado de triggerArms.
// =============================================================================================

const SD_RECONCILE_LEASE_MS = SPOT_DEFENSE_LEASE_MS;

export const getSpotDefenseBotInternal = internalQuery({
  args: { botId: v.id("spot_defense_bots") },
  handler: async (ctx, { botId }) => await ctx.db.get(botId),
});

// IDs de arms vivos (no terminales) por `by_updated` ASC GLOBAL — más antiguo primero, SIN sesgo por
// estado (Codex 3c-2 #2: listar por estado starveaba a filled/protecting/protected, los críticos para
// SL/cierre, si había >tope arms en estados tempranos). Topado; corta sin recorrer todo el historial.
export const listLiveSpotDefenseArmIdsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 200;
    const ids: Id<"spot_defense_arms">[] = [];
    // (CodeRabbit) Consultar SOLO los estados NO terminales por `by_status_updated` en vez de escanear toda
    // la tabla por `by_updated` (que arranca por los más viejos = historial terminal acumulado). Complemento
    // EXACTO de ARM_TERMINAL (disarmed/closed/failed).
    for (const status of SD_ARM_NON_TERMINAL) {
      for await (const a of ctx.db.query("spot_defense_arms")
        .withIndex("by_status_updated", (q) => q.eq("status", status)).order("asc")) {
        ids.push(a._id);
        if (ids.length >= cap) return ids;
      }
    }
    return ids;
  },
});

// (3c-3b) Bots con auto-rearm pendiente/recuperable y vencidos (nextRearmAt<=now). Topado.
// (Codex 3c-3ab #3) Incluye `running` con lease VENCIDO (worker murió tras el claim antes del settle) →
// se reclama; sin esto un bot quedaría `running` para siempre.
export const listDueSpotDefenseRearmsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 50;
    const now = Date.now();
    const out: Id<"spot_defense_bots">[] = [];
    for (const st of ["running", "pending", "blocked"] as const) {   // running expirado PRIMERO (recuperación)
      const rows = await ctx.db.query("spot_defense_bots").withIndex("by_rearm_status", (q) => q.eq("rearmStatus", st)).collect();
      for (const b of rows) {
        if (!(b.active && b.status === "running" && !b.disarmPending)) continue;
        if (st === "running") {
          if ((b.rearmLeaseUntil ?? 0) <= now) { out.push(b._id); if (out.length >= cap) return out; }   // lease vencido → recuperar
        } else if ((b.nextRearmAt ?? 0) <= now) {
          out.push(b._id); if (out.length >= cap) return out;
        }
      }
    }
    return out;
  },
});

// Claim del rearm bajo lease (un solo worker reabre a la vez). running + token + lease.
export const claimSpotDefenseRearm = internalMutation({
  args: { botId: v.id("spot_defense_bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return { claimed: false as const };
    if (!bot.active || bot.status !== "running" || bot.disarmPending) return { claimed: false as const };
    // (Codex 3c-3ab #3) Reclama pending/blocked, o `running` con lease VENCIDO (recuperación de worker muerto).
    if (bot.rearmStatus !== "pending" && bot.rearmStatus !== "blocked" && bot.rearmStatus !== "running") return { claimed: false as const };
    if ((bot.rearmLeaseUntil ?? 0) > Date.now()) return { claimed: false as const };   // lease vivo (incl. running en curso) → no robar
    // No reabrir si ya hay un arm vivo (defensa anti-doble).
    const live = (await ctx.db.query("spot_defense_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect()).find((a) => !ARM_TERMINAL.has(a.status));
    if (live) { await ctx.db.patch(botId, { rearmStatus: undefined, rearmLeaseToken: undefined, rearmLeaseUntil: undefined, updatedAt: Date.now() }); return { claimed: false as const }; }
    const token = crypto.randomUUID();
    await ctx.db.patch(botId, { rearmStatus: "running", rearmLeaseToken: token, rearmLeaseUntil: Date.now() + SD_REARM_LEASE_MS, updatedAt: Date.now() });
    return { claimed: true as const, token };
  },
});

// Resultado del intento de rearm (bajo token): ok → limpia; transient → reprograma con backoff;
// blocked → queda blocked reevaluable (config/margen/gate); cancel → cancela el rearm.
export const settleSpotDefenseRearm = internalMutation({
  args: {
    botId: v.id("spot_defense_bots"), token: v.string(),
    outcome: v.union(v.literal("ok"), v.literal("transient"), v.literal("blocked"), v.literal("cancel")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { botId, token, outcome, error }) => {
    const bot = await ctx.db.get(botId);
    if (!bot || bot.rearmLeaseToken !== token || (bot.rearmLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const now = Date.now();
    // (Codex 4c BAJO) Clasificar el motivo desde el prefijo [kind] del error para que la tarjeta muestre
    // un diagnóstico (espeja el `lastRearmErrorKind` del motor de pools). Sin prefijo conocido → transient.
    const errorKind = !error ? undefined
      : error.includes("[blocked_margin]") ? "blocked_margin" as const
      // (JAV-178) blocked_cap ANTES del catch-all "[blocked": el tope de plan conserva su kind propio.
      : error.includes("[blocked_cap]") ? "blocked_cap" as const
      : error.includes("[blocked_config]") || error.includes("[blocked") ? "blocked_config" as const
      : error.includes("[retry_incompatible]") ? "retry_incompatible" as const
      : "transient" as const;
    if (outcome === "ok" || outcome === "cancel") {
      await ctx.db.patch(botId, { rearmStatus: undefined, nextRearmAt: undefined, rearmLeaseToken: undefined, rearmLeaseUntil: undefined, lastRearmError: error, lastRearmErrorKind: errorKind, updatedAt: now });
    } else {
      const attempts = (bot.rearmAttempts ?? 0) + 1;
      await ctx.db.patch(botId, {
        rearmStatus: outcome === "blocked" ? "blocked" : "pending",
        nextRearmAt: now + SD_REARM_BACKOFF_MS, rearmAttempts: attempts,
        rearmLeaseToken: undefined, rearmLeaseUntil: undefined, lastRearmError: error, lastRearmErrorKind: errorKind, updatedAt: now,
      });
    }
    return { ok: true as const };
  },
});

// (JAV-107 3c-3a) Latch one-way del break-even: una vez movido el SL a ≈entrada, no se revierte.
export const setSpotDefenseBeMoved = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { beMoved: true, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (Codex 3c-3ab r4) Trackea el CLOID del SL break-even en rotación (antes de sobrescribir la fila `sl`),
// o lo limpia (null) al completar/abortar. Mientras esté set, el reconcile lo suma a ownCloids → cleanup.
export const setSpotDefenseBePendingCloid = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string(), cloid: v.union(v.string(), v.null()) },
  handler: async (ctx, { armId, token, cloid }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { bePendingCloid: cloid === null ? undefined : cloid, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Marca el cierre como emergencia/desarme (gobierna el closeReason al confirmar flat). Bajo lease.
export const setSpotDefenseEmergencyClosing = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string(), value: v.union(v.literal("emergency"), v.literal("disarm")) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { emergencyClosing: value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Terminalización "pre-orden" (espejo de failArmPreOrder): cuando updateLeverage es RECHAZADO de forma
// DETERMINISTA, está GARANTIZADO que la entrada aún no se envió (corre antes de exchange.order) → cerrar
// a failed YA (libera margen sin esperar la cuarentena), SOLO si: lease vigente, status submitting, sin
// fill, y la orden `entry` sigue pre-envío (pending, sin oid, sin submittedAt).
export const failSpotDefensePreOrder = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string(), error: v.string() },
  handler: async (ctx, { armId, token, error }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "submitting") return { ok: false as const };
    if (arm.filledSize != null || arm.entryPrice != null) return { ok: false as const };
    const entry = await ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "entry")).first();
    if (!entry || entry.observedStatus !== "pending" || entry.oid != null || entry.submittedAt != null) return { ok: false as const };
    const tFail = Date.now();
    await ctx.db.patch(armId, { status: "failed", error, reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: tFail });
    await scheduleDurableRearmAfterFailed(ctx, arm.botId, error, tFail);
    return { ok: true as const };
  },
});

export const getSpotDefenseArmInternal = internalQuery({
  args: { armId: v.id("spot_defense_arms") },
  handler: async (ctx, { armId }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return null;
    const orders = await ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId)).collect();
    return { arm, orders };
  },
});

// Arm vivo (no terminal) de un bot, para el reconcile/stop del motor.
export const getLiveSpotDefenseArmInternal = internalQuery({
  args: { botId: v.id("spot_defense_bots") },
  handler: async (ctx, { botId }) => {
    const arms = await ctx.db.query("spot_defense_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect();
    return arms.find((a) => !ARM_TERMINAL.has(a.status)) ?? null;
  },
});

export const claimSpotDefenseReconcile = internalMutation({
  args: { armId: v.id("spot_defense_arms") },
  handler: async (ctx, { armId }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { claimed: false as const, reason: "not_found" as const };
    if (ARM_TERMINAL.has(arm.status)) return { claimed: false as const, reason: "terminal" as const };
    if ((arm.reconcileLeaseUntil ?? 0) > Date.now()) return { claimed: false as const, reason: "leased" as const };
    const token = crypto.randomUUID();
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + SD_RECONCILE_LEASE_MS, reconcileLeaseToken: token, updatedAt: Date.now() });
    return { claimed: true as const, token };
  },
});

export const renewSpotDefenseReconcile = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || ARM_TERMINAL.has(arm.status)) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + SD_RECONCILE_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const releaseSpotDefenseReconcile = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token) return;
    await ctx.db.patch(armId, { reconcileLeaseUntil: 0, reconcileLeaseToken: undefined, updatedAt: Date.now() });
  },
});

// Actualiza una orden del arm por rol (entry/sl/tp[+tpIndex]) bajo lease: observedStatus/oid.
export const setSpotDefenseOrderObserved = internalMutation({
  args: {
    armId: v.id("spot_defense_arms"), token: v.string(),
    role: v.union(v.literal("entry"), v.literal("sl"), v.literal("tp")),
    tpIndex: v.optional(v.number()),
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    oid: v.optional(v.string()),
    markSubmitted: v.optional(v.boolean()),
  },
  handler: async (ctx, { armId, token, role, tpIndex, observedStatus, oid, markSubmitted }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const order = role === "tp"
      ? await ctx.db.query("spot_defense_orders").withIndex("by_arm_role_index", (q) => q.eq("armId", armId).eq("role", "tp").eq("tpIndex", tpIndex)).first()
      : await ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", role)).first();
    if (!order) return { ok: false as const };
    const patch: Record<string, unknown> = { observedStatus, updatedAt: Date.now() };
    if (oid !== undefined) patch.oid = oid;
    if (markSubmitted) patch.submittedAt = Date.now();
    await ctx.db.patch(order._id, patch);
    return { ok: true as const };
  },
});

// Registra (upsert) la orden de SL del arm bajo lease. Idempotente por rol "sl" (un SL por arm/gen).
export const recordSpotDefenseSlOrder = internalMutation({
  args: {
    armId: v.id("spot_defense_arms"), token: v.string(),
    cloid: v.string(), oid: v.optional(v.string()),
    triggerPx: v.number(), size: v.number(),
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    // (Codex 3c-1 r2 #2) Fija submittedAt = "el RPC SE ENVIÓ (aceptado/ambiguo)". Un `pending` SIN
    // submittedAt = solo PREPARADO (pre-RPC) → no cuenta como SL vivo (el reconcile reintenta).
    markSubmitted: v.optional(v.boolean()),
    // (Codex 3c-1 r3) nº de intento de SL: persiste en arm.slAttempts → al recolocar un SL muerto el
    // cloid rota (spotDefenseCloidInput(...,"sl",attempt)) y no choca con el cloid cancelado en HL.
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { armId, token, cloid, oid, triggerPx, size, observedStatus, markSubmitted, attempt }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const now = Date.now();
    if (attempt !== undefined && attempt !== arm.slAttempts) await ctx.db.patch(armId, { slAttempts: attempt });
    const existing = await ctx.db.query("spot_defense_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "sl")).first();
    if (existing) {
      // (CodeRabbit) Un reintento PREPARADO (pre-RPC, markSubmitted falso) NO debe heredar el oid/submittedAt
      // del intento anterior — si no, el reconcile trataría el SL nuevo como ya enviado (mismo fix que el TP).
      await ctx.db.patch(existing._id, {
        observedStatus, triggerPx, size, cloid, updatedAt: now,
        oid, submittedAt: markSubmitted ? now : undefined,
      });
      return { ok: true as const, orderId: existing._id };
    }
    const orderId = await ctx.db.insert("spot_defense_orders", {
      armId, role: "sl", cloid, oid, triggerPx, size, reduceOnly: true, observedStatus,
      ...(markSubmitted ? { submittedAt: now } : {}), createdAt: now, updatedAt: now,
    });
    return { ok: true as const, orderId };
  },
});

// (Codex 3c-1 NO-GO #4) Doble lectura de cierre: la 1ª lectura flat fija closeConfirmSince; el 2º ciclo
// (tras grace) confirma flat + órdenes muertas → closed. Si la posición reaparece, se limpia (value:null).
export const setSpotDefenseCloseConfirm = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string(), value: v.union(v.number(), v.null()) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { closeConfirmSince: value === null ? undefined : value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (3c-3c) Upsert idempotente de un TP parcial (role "tp", único por tpIndex) bajo lease.
export const recordSpotDefenseTpOrder = internalMutation({
  args: {
    armId: v.id("spot_defense_arms"), token: v.string(), tpIndex: v.number(),
    cloid: v.string(), oid: v.optional(v.string()),
    triggerPx: v.number(), size: v.number(),
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    markSubmitted: v.optional(v.boolean()),
    // (Codex 3c-3c NO-GO #4) nº de intento del TP: al recolocar un TP muerto el cloid rota
    // (spotDefenseCloidInput(...,"tp",attempt,i)) y no choca con el cloid cancelado en HL.
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { armId, token, tpIndex, cloid, oid, triggerPx, size, observedStatus, markSubmitted, attempt }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const now = Date.now();
    const existing = await ctx.db.query("spot_defense_orders").withIndex("by_arm_role_index", (q) => q.eq("armId", armId).eq("role", "tp").eq("tpIndex", tpIndex)).first();
    if (existing) {
      // (Codex 3c-3c r2 #2) `submittedAt`/`oid` son AUTORITATIVOS por intento: un pre-record nuevo
      // (pending, sin markSubmitted/oid) DEBE limpiarlos (undefined → Convex borra el campo), o el motor
      // heredaría el submittedAt/oid del intento muerto y trataría el nuevo como "ya enviado".
      // (Codex 3c-3c r3) `preparedAt` = ahora en el PREPARE (markSubmitted falso); al confirmar enviado
      // (markSubmitted) submittedAt lo supersede → se limpia preparedAt.
      const patch: Record<string, unknown> = {
        observedStatus, triggerPx, size, cloid, updatedAt: now,
        oid, submittedAt: markSubmitted ? now : undefined, preparedAt: markSubmitted ? undefined : now,
      };
      if (attempt !== undefined) patch.attempt = attempt;
      await ctx.db.patch(existing._id, patch);
      return { ok: true as const, orderId: existing._id };
    }
    const orderId = await ctx.db.insert("spot_defense_orders", {
      armId, role: "tp", tpIndex, cloid, oid, triggerPx, size, reduceOnly: true, observedStatus,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(markSubmitted ? { submittedAt: now } : { preparedAt: now }), createdAt: now, updatedAt: now,
    });
    return { ok: true as const, orderId };
  },
});

// (Codex 3c-3c NO-GO #1) Latch de la 1ª lectura de drift (paralelo a setSpotDefenseCloseConfirm). El
// motor NO terminaliza el arm con un solo snapshot: arma el reloj aquí y solo cancela+manual si el drift
// persiste tras el grace; si el drift desaparece (era lag de eventual-consistency), se limpia (value:null).
export const setSpotDefenseDriftConfirm = internalMutation({
  args: { armId: v.id("spot_defense_arms"), token: v.string(), value: v.union(v.number(), v.null()) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { driftConfirmSince: value === null ? undefined : value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Máquina de estados del arm (fencing + ALLOWED + cuarentena post-submit). Al alcanzar terminal con
// disarmPending → completa la pausa (active=false). Espejo recortado de triggerArms.settleArm.
export const settleSpotDefenseArm = internalMutation({
  args: {
    armId: v.id("spot_defense_arms"),
    status: v.union(
      v.literal("armed"), v.literal("disarming"), v.literal("disarmed"), v.literal("filled"),
      v.literal("protecting"), v.literal("protected"), v.literal("closed"), v.literal("unknown"),
      v.literal("failed"), v.literal("manual_intervention")),
    token: v.string(),   // (Codex Fase 3a/3b NO-GO #2) OBLIGATORIO: el fencing por lease nunca se salta.
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    error: v.optional(v.string()),
    closeReason: v.optional(v.union(v.literal("sl"), v.literal("manual"), v.literal("emergency"), v.literal("disarm"))),
  },
  handler: async (ctx, args): Promise<any> => {
    const arm = await ctx.db.get(args.armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== args.token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) {
      return { ok: false as const };
    }
    if (ARM_TERMINAL.has(arm.status)) return { ok: false as const };
    const allowed = ALLOWED_SD[arm.status];
    if (!allowed || !allowed.has(args.status)) return { ok: false as const };
    if (args.status === "closed" && args.closeReason === undefined) return { ok: false as const };
    // Cuarentena: no terminalizar un arm que llegó a submitting hasta pasado el plazo (orden quizá viva).
    if (ARM_TERMINAL.has(args.status) && arm.submittedAt != null
        && Date.now() - arm.submittedAt <= SD_SUBMIT_QUARANTINE_MS) {
      return { ok: false as const, quarantined: true as const };
    }
    const now = Date.now();
    const patch: Record<string, unknown> = { status: args.status, updatedAt: now };
    for (const k of ["filledSize", "entryPrice", "error"] as const) {
      if (args[k] !== undefined) patch[k] = args[k];
    }
    if (args.status === "closed" && args.closeReason !== undefined) patch.closeReason = args.closeReason;
    if (args.status === "filled" && arm.filledAt == null) patch.filledAt = now;
    await ctx.db.patch(args.armId, patch);
    elog("spot_defense", "transition", { armId: String(args.armId), from: arm.status, to: args.status, closeReason: args.closeReason ?? null });
    // Al alcanzar terminal: completar pausa, o programar auto-rearm tras un cierre por SL.
    if (ARM_TERMINAL.has(args.status)) {
      const bot = await ctx.db.get(arm.botId);
      if (bot?.disarmPending) {
        await ctx.db.patch(arm.botId, { active: false, status: "stopped", disarmPending: false, disarmRequestedAt: undefined, updatedAt: now });
      } else if (args.status === "closed" && args.closeReason === "sl" && bot && bot.active
        && bot.status === "running" && bot.autoRearm === true) {
        // (3c-3b) Auto-rearm durable: el cron "process spot defense rearms" reabre la cobertura tras el
        // cooldown. NO se agenda el motor aquí (evita el ciclo de tipos spotDefenseBots↔engine).
        await ctx.db.patch(arm.botId, {
          rearmStatus: "pending", nextRearmAt: now + SD_REARM_COOLDOWN_MS, rearmAttempts: 0,
          lastRearmError: undefined, rearmLeaseToken: undefined, rearmLeaseUntil: undefined, updatedAt: now,
        });
      } else if (args.status === "failed") {
        // (CodeRabbit) Retry DURABLE también cuando el armado FALLA (inicial desde la UI, o un `armed`/
        // `submitting` que nunca llenó y se terminalizó). Política única → helper compartido.
        await scheduleDurableRearmAfterFailed(ctx, arm.botId, args.error, now);
      }
    }
    return { ok: true as const };
  },
});
