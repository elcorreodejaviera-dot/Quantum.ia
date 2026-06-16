import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireUser } from "./helpers";
import { getLimit } from "./executionLimits";
import { committedMarginForAccount, dailyNotionalUsed, assertLiveAdmissible } from "./executions";
import { resolveLeverage, MARGIN_SAFETY_BUFFER } from "./leverage";
import { hlNetwork } from "./hlNetwork";
import { REARM_COOLDOWN_MS } from "./triggerRearm";

// (Codex #1) Reprograma un auto-rearm en el BOT atómicamente (dentro de la mutation que lo invoca).
// Solo si la config sigue siendo válida: activo, autoRearm, sin pausa, pool abierto y SIN otro rearm en
// curso. No pisa un rearm existente. Devuelve si reprogramó. Pensado para cuando un arm `fromRearm`
// termina `failed` sin cobertura → el trabajo durable vuelve, nunca queda el bot activo sin nada.
async function rescheduleRearmIfEligible(ctx: MutationCtx, botId: Id<"bots">): Promise<boolean> {
  const bot = await ctx.db.get(botId);
  if (!bot) return false;
  if (bot.active !== true || bot.autoRearm !== true || bot.disarmPending === true) return false;
  if (bot.rearmStatus != null) return false;   // ya hay un rearm en curso → no duplicar
  if (!bot.poolId) return false;               // (Codex) exigir pool: sin pool no hay cobertura que rearmar
  const pool = await ctx.db.get(bot.poolId);
  if (!pool || pool.closed) return false;
  await ctx.db.patch(botId, {
    rearmStatus: "pending", nextRearmAt: Date.now() + REARM_COOLDOWN_MS, rearmAttempts: 0,
    lastRearmError: undefined, lastRearmErrorKind: undefined,
    rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
  });
  return true;
}

// --- JAV-44 Etapa 1: máquina de estados del trigger_arm (lease/fencing como reconcileExecution) ---

const DAY_MS = 24 * 60 * 60 * 1000;
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
  // arming→submitting NO va por settleArm (necesita submittedAt+lease que pone markArmSubmitting).
  arming: new Set(["failed", "disarmed"]),
  submitting: new Set(["armed", "filled", "unknown", "failed", "disarmed"]),
  armed: new Set(["filled", "disarming", "unknown", "disarmed", "failed"]),
  // post-fill: filled→protecting (colocar SL); protecting→protected (SL puesto) | closed (cierre de
  // emergencia o SL llenado); protected→closed (SL/cierre). disarming desde cualquier estado abierto.
  // (JAV-61) En armMode="reentry_coexist", si el short de arriba cierra (TP-final) pero entry_lower
  // sigue armada → transición a `armed_lower_only` (flat, sin short, cobertura inferior viva).
  filled: new Set(["protecting", "closed", "disarming", "unknown", "armed_lower_only"]),
  protecting: new Set(["protected", "closed", "disarming", "unknown", "armed_lower_only"]),
  protected: new Set(["closed", "disarming", "armed_lower_only"]),
  // (JAV-61) armed_lower_only: esperando que el precio perfore el borde inferior y llene entry_lower
  // (→ filled → protecting → protected, el ciclo normal del nuevo short), o cierre/pausa.
  armed_lower_only: new Set(["filled", "protecting", "protected", "closed", "disarming", "unknown"]),
  disarming: new Set(["disarmed", "filled", "protecting", "protected", "closed", "unknown", "failed", "armed_lower_only"]),
  unknown: new Set(["armed", "filled", "protecting", "protected", "disarmed", "failed", "closed", "armed_lower_only"]),
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
  // (Codex #4) La pausa CANCELA cualquier auto-rearm pendiente/blocked en la MISMA mutation: limpiar
  // estado, lease y próximo intento (si no, el rearm quedaría visible hasta el siguiente ciclo del cron).
  const clearRearm = {
    rearmStatus: undefined, nextRearmAt: undefined,
    rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
  } as const;
  const arms = await ctx.db.query("trigger_arms").withIndex("by_bot_generation", (q) => q.eq("botId", botId)).collect();
  const live = arms.filter((a) => !isArmTerminal(a.status));
  if (live.length === 0) {
    // Desactivación inmediata (sin arm vivo): limpiar también el ancla del contador.
    await ctx.db.patch(botId, { active: false, disarmPending: false, disarmRequestedAt: undefined, ...clearRearm });
    return { deactivated: true };
  }
  for (const a of live) {
    if (a.desiredState !== "disarmed") await ctx.db.patch(a._id, { desiredState: "disarmed", updatedAt: Date.now() });
  }
  // (Codex) NO reiniciar el contador: setear disarmRequestedAt solo en la PRIMERA solicitud
  // (disarmPending pasa de no-true a true). Una llamada repetida mientras ya se está pausando lo conserva.
  const anchor = bot.disarmPending === true ? {} : { disarmRequestedAt: Date.now() };
  await ctx.db.patch(botId, { disarmPending: true, ...anchor, ...clearRearm });
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
    triggerPx: v.number(), size: v.number(),
    orderNotional: v.number(),    // nocional de UNA entrada (para el límite por orden)
    reservedNotional: v.number(), // worst-case para daily/margen (2× si dos entradas)
    // Leverage: reserveArm lo resuelve (auto/manual) con el helper compartido, atómico con el
    // margen comprometido. El marginReserved se deriva de reservedNotional/appliedLeverage.
    autoLeverage: v.boolean(),
    manualLeverage: v.optional(v.number()),   // bot.leverage (modo manual)
    assetMaxLeverage: v.number(),             // maxLeverage del activo en HL (entero ≥ 1)
    lowerEdge: v.number(),
    upperEdge: v.optional(v.number()),
    allowReentryFromAbove: v.optional(v.boolean()),
    // (JAV-61) Modo de coexistencia + semántica de entry_upper + triggerPx de entry_lower.
    // En "reentry_coexist" entry_lower va con triggerPx de PERFORACIÓN (estrictamente bajo lowerEdge)
    // para no chocar con el tp_final que se coloca EN lowerEdge. undefined → flujo OCO clásico.
    armMode: v.optional(v.union(v.literal("oco"), v.literal("reentry_coexist"))),
    entryUpperMode: v.optional(v.union(v.literal("breakout_up"), v.literal("reentry_down"))),
    entryLowerTriggerPx: v.optional(v.number()),
    stopLossPct: v.number(),
    bufferPct: v.optional(v.number()),
    tps: v.optional(v.array(v.object({ gainPct: v.number(), closePct: v.number() }))),
    // (JAV-66) % de ganancia que activa el BE. El caller ya lo valida/desactiva (undefined = BE off).
    breakevenPct: v.optional(v.number()),
    availableCollateral: v.number(),
    // (Codex #2) Auto-rearm: si viene, la inserción de la generación CONSUME el trabajo de rearm
    // atómicamente (valida token+lease+running y limpia rearmStatus en la misma transacción). Opcional:
    // el armado MANUAL no lo pasa.
    rearmToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // throws con prefijo [kind] (auto-rearm): el cron los mapea a la política de Codex. Config inválida
    // → [blocked_config]; falta de margen/volumen → [blocked_margin]; colisión de generación → [transient].
    if (args.network !== "testnet" && args.network !== "mainnet") throw new Error("[blocked_config] network inválida.");
    if (!(args.reservedNotional > 0) || !(args.size > 0)) {
      throw new Error("[blocked_config] reservedNotional/size deben ser > 0");
    }
    if (!(args.availableCollateral >= 0)) throw new Error("[blocked_config] availableCollateral inválido");
    // (CodeRabbit) Validar el snapshot inmutable en la frontera de persistencia: un triggerPx/
    // lowerEdge inválido dejaría un arm corrupto consumiendo margen hasta fallar más tarde.
    // (appliedLeverage/marginReserved los resuelve y valida el helper resolveLeverage abajo.)
    if (!(args.triggerPx > 0) || !(args.lowerEdge > 0)) {
      throw new Error("[blocked_config] triggerPx/lowerEdge deben ser > 0");
    }
    // (JAV-61) Si viene un triggerPx de perforación para entry_lower, debe ser válido y < lowerEdge
    // (estrictamente por debajo del borde, donde vive el tp_final).
    if (args.entryLowerTriggerPx !== undefined
      && !(args.entryLowerTriggerPx > 0 && args.entryLowerTriggerPx < args.lowerEdge)) {
      throw new Error("[blocked_config] entryLowerTriggerPx debe ser > 0 y < lowerEdge (perforación).");
    }
    // (CodeRabbit #22) Validación defensiva: el límite por orden asume orderNotional > 0.
    if (!(args.orderNotional > 0)) {
      throw new Error("[blocked_config] orderNotional debe ser > 0");
    }
    if (!(args.stopLossPct > 0 && args.stopLossPct < 100)) throw new Error("[blocked_config] stopLossPct inválido");

    // (Codex #2) Revalidar atómicamente el ESTADO del bot, no solo que exista: una action pudo
    // leerlo y, antes de llegar aquí, deletePoolBot pudo desactivarlo/borrarlo o cambiar su cuenta/
    // pool. Sin esto insertaríamos un arm colgante o incoherente que el cron tendría que limpiar.
    // El ctx.db.get registra la lectura → OCC aborta/reintenta si el bot cambió. (2ª ronda Codex #2.)
    const bot = await ctx.db.get(args.botId);
    if (!bot) throw new Error("[transient] El bot ya no existe (posible borrado concurrente).");
    if (!bot.active) throw new Error("[transient] El bot no está activo.");
    if (bot.disarmPending) throw new Error("[transient] El bot se está desarmando.");
    if (bot.userId !== args.userId) throw new Error("[blocked_config] El bot no pertenece al usuario del armado.");
    if (bot.poolId !== args.poolId) throw new Error("[blocked_config] El pool del armado no coincide con el del bot.");
    if (bot.hlAccountId !== args.hlAccountId) throw new Error("[blocked_config] La cuenta HL del armado no coincide con la del bot.");

    // (1) Unicidad: una sola generación NO terminal por bot.
    const arms = await ctx.db
      .query("trigger_arms")
      .withIndex("by_bot_generation", (q) => q.eq("botId", args.botId))
      .collect();
    const liveArm = arms.find((a) => !isArmTerminal(a.status));
    if (liveArm) {
      throw new Error("[transient] Ya existe un armado activo para este bot (una generación no terminal).");
    }
    // (2) generation = max+1 (backend).
    const generation = arms.reduce((m, a) => Math.max(m, a.generation), 0) + 1;

    // (3) Límites compartidos con JAV-43: por orden + diario + margen por cuenta (misma OCC).
    const maxPerOrder = await getLimit(ctx, "maxNotionalPerOrder");
    const maxDaily = await getLimit(ctx, "maxNotionalPerUserDaily");
    // Límite POR ORDEN sobre el nocional de UNA entrada (cada trigger es una orden de ese tamaño).
    if (args.orderNotional > maxPerOrder) {
      throw new Error(`[blocked_config] Nocional ${args.orderNotional} supera el máximo por orden (${maxPerOrder}).`);
    }
    const dailyUsed = await dailyNotionalUsed(ctx, args.userId, Date.now() - DAY_MS);
    if (dailyUsed + args.reservedNotional > maxDaily) {
      throw new Error(`[blocked_margin] Volumen diario excedido: ${dailyUsed} + ${args.reservedNotional} > ${maxDaily}.`);
    }
    const marginCommitted = await committedMarginForAccount(ctx, args.hlAccountId);
    // Resolver leverage + margen JUNTOS (helper único, mismo que JAV-43). autoLeverage sube hasta el
    // tope para que el nocional (worst-case 2× en OCO) quepa; si ni al tope cabe → [blocked_margin].
    const { appliedLeverage, marginRequired: marginReserved } = resolveLeverage({
      autoLeverage: args.autoLeverage, manualLeverage: args.manualLeverage,
      reservedNotional: args.reservedNotional, availableCollateral: args.availableCollateral,
      marginCommitted, assetMaxLeverage: args.assetMaxLeverage,
    });
    if ((marginCommitted + marginReserved) > args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER)) {
      throw new Error(
        `[blocked_margin] Margen insuficiente: comprometido ${marginCommitted.toFixed(2)} + requerido ` +
        `${marginReserved.toFixed(2)} > colateral ${args.availableCollateral.toFixed(2)}.`);
    }

    // Leer el bot ANTES de consumir su estado de rearm. (Codex #2) Re-armado: validar el lease (token +
    // vigente + running). (Codex crítico) `inheritsRearm` = viene de un auto-rearm O reemplaza un rearm
    // pendiente (armado MANUAL durante el cooldown): en ambos casos el arm hereda la responsabilidad de
    // rearm (fromRearm=true) → si falla antes del envío, devuelve el trabajo durable. Se decide AQUÍ,
    // antes de limpiar rearmStatus.
    const botPre = await ctx.db.get(args.botId);
    if (args.rearmToken !== undefined) {
      if (!botPre || botPre.rearmStatus !== "running"
        || botPre.rearmLeaseToken !== args.rearmToken
        || (botPre.rearmLeaseUntil ?? 0) <= Date.now()) {
        throw new Error("[transient] Lease de rearm inválido/expirado al reservar (reintentar).");
      }
    }
    const inheritsRearm = args.rearmToken !== undefined || (botPre?.rearmStatus != null);

    // (4) Insertar arm (arming) + trigger_order(s) (pending, SIN submittedAt — se fija en el CAS).
    const now = Date.now();
    const cloidLower = await armCloid(args.botId, generation, "entry_lower");
    const twoEntries = args.allowReentryFromAbove === true && args.upperEdge != null && args.upperEdge > 0;
    const armId = await ctx.db.insert("trigger_arms", {
      botId: args.botId, userId: args.userId, hlAccountId: args.hlAccountId, poolId: args.poolId,
      asset: args.asset, network: args.network, generation, status: "arming", desiredState: "armed",
      side: "Short", triggerPx: args.triggerPx, size: args.size, appliedLeverage,
      reservedNotional: args.reservedNotional, marginReserved, lowerEdge: args.lowerEdge,
      upperEdge: twoEntries ? args.upperEdge : undefined,
      allowReentryFromAbove: twoEntries ? true : undefined,
      // (JAV-61) Persistir el modo (default "oco") y, si dos entradas, la semántica del entry_upper.
      armMode: args.armMode ?? "oco",
      entryUpperMode: twoEntries ? args.entryUpperMode : undefined,
      stopLossPct: args.stopLossPct, bufferPct: args.bufferPct, tps: args.tps,
      // (JAV-66) snapshot del break-even (ya validado por el caller; undefined → BE desactivado).
      breakevenPct: args.breakevenPct,
      // (Codex crítico) hereda la responsabilidad de rearm si viene de un auto-rearm O reemplaza uno
      // pendiente → si falla antes del envío, settleArm/recover devuelven el trabajo (no se pierde).
      fromRearm: inheritsRearm ? true : undefined,
      createdAt: now, updatedAt: now,
    });
    // (Codex #2/#3) CONSUMIR/cancelar el trabajo de rearm en la MISMA transacción que crea la
    // generación: el re-armado (token ya validado) O un armado MANUAL que gana sobre un rearm pendiente.
    // Atómico → no quedan dos caminos abriendo. Limpia estado, lease, error e intentos.
    if (botPre && botPre.rearmStatus != null) {
      await ctx.db.patch(args.botId, {
        rearmStatus: undefined, nextRearmAt: undefined,
        rearmLeaseToken: undefined, rearmLeaseUntil: undefined,
        rearmAttempts: 0, lastRearmError: undefined, lastRearmErrorKind: undefined,
      });
    }
    await ctx.db.insert("trigger_orders", {
      armId, role: "entry_lower", cloid: cloidLower, oid: undefined,
      triggerPx: args.entryLowerTriggerPx ?? args.triggerPx, size: args.size,
      reduceOnly: false, observedStatus: "pending", createdAt: now, updatedAt: now,
    });
    let cloidUpper: string | undefined;
    if (twoEntries) {
      cloidUpper = await armCloid(args.botId, generation, "entry_upper");
      await ctx.db.insert("trigger_orders", {
        armId, role: "entry_upper", cloid: cloidUpper, oid: undefined, triggerPx: args.upperEdge!, size: args.size,
        reduceOnly: false, observedStatus: "pending", createdAt: now, updatedAt: now,
      });
    }
    return { armId, generation, cloid: cloidLower, cloidUpper, appliedLeverage, marginReserved };
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
    if (arm.network !== hlNetwork()) return { ok: false as const, reason: "blocked" as const };  // deploy cambió de red
    const now = Date.now();
    const token = crypto.randomUUID();
    await ctx.db.patch(armId, {
      status: "submitting", submittedAt: now, updatedAt: now,
      reconcileLeaseUntil: now + ARM_RECONCILE_LEASE_MS, reconcileLeaseToken: token,
    });
    return { ok: true as const, token };
  },
});

// --- Gate ATÓMICO justo antes de exchange.order (Fix #1) — como gateBeforeOrder de JAV-43 ---
// Entre el CAS y el envío corre updateLeverage (espera): un kill switch/pausa/revocación puede
// ocurrir ahí y desiredState no lo refleja. Este gate revalida TODO bajo el lease, inmediatamente
// antes del envío, y renueva el lease para cubrir el RPC. Si falla → NO enviar.
export const gateArmBeforeOrder = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "submitting" || arm.desiredState !== "armed") return { ok: false as const };
    if (arm.network !== hlNetwork()) return { ok: false as const };  // deploy cambió de red bajo el arm
    const bot = await ctx.db.get(arm.botId);
    if (!bot || !bot.active || bot.disarmPending || bot.kind !== "il" || bot.direction !== "short" || bot.poolId !== arm.poolId) {
      return { ok: false as const };
    }
    if (!(await assertLiveAdmissible(ctx, arm.userId, arm.botId, arm.hlAccountId))) return { ok: false as const };
    const pool = await ctx.db.get(arm.poolId);
    if (!pool || pool.closed) return { ok: false as const };
    await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() + ARM_RECONCILE_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Reduce la reserva worst-case (2×) a 1× tras confirmar el OCO (la entrada hermana cancelada).
// Solo baja (nunca sube). Libera colateral del margen compartido. Bajo claim.
export const reduceArmReservation = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string(), reservedNotional: v.number(), marginReserved: v.number() },
  handler: async (ctx, { armId, token, reservedNotional, marginReserved }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    if (arm.reservationReduced) return { ok: true as const };   // idempotente
    const newRes = Math.min(arm.reservedNotional, reservedNotional);
    const newMar = Math.min(arm.marginReserved, marginReserved);
    await ctx.db.patch(armId, { reservedNotional: newRes, marginReserved: newMar, reservationReduced: true, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (JAV-61) Marca qué entrada llenó la posición (entry_lower | entry_upper). El TP-final solo se
// coloca si filledEntryRole === "entry_upper". Bajo claim/fencing.
export const setArmFilledEntryRole = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string(), role: v.union(v.literal("entry_lower"), v.literal("entry_upper")) },
  handler: async (ctx, { armId, token, role }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    await ctx.db.patch(armId, { filledEntryRole: role, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (JAV-61) reentry_coexist: el short de ARRIBA cerró (TP-final/parciales/SL) y la posición quedó flat,
// pero entry_lower sigue armada esperando PERFORACIÓN. En vez de cerrar el arm, transiciona a
// `armed_lower_only` y limpia los datos del fill/SL para que el SIGUIENTE short (entry_lower) arranque
// limpio. Mantiene reservedNotional/marginReserved (2×: ambas patas siguen reservadas). Bajo fencing.
export const transitionToArmedLowerOnly = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    const allowed = ALLOWED_ARM[arm.status];
    if (!allowed || !allowed.has("armed_lower_only")) return { ok: false as const };
    await ctx.db.patch(armId, {
      status: "armed_lower_only",
      filledSize: undefined, entryPrice: undefined, filledAt: undefined, filledEntryRole: undefined,
      closeConfirmSince: undefined, slAttempts: undefined, slSubmittedAt: undefined, protectDeadline: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

// (JAV-61 fix P1#6) Terminaliza un arm en `armed_lower_only` cuya entry_lower murió sin perforar (ya
// confirmado flat + grace en el motor). Cierre limpio (closeReason "manual": NO es un SL → no cuenta
// whipsaw) y, si el bot sigue activo + autoRearm, reprograma una generación NUEVA (esquema completo)
// para no dejar el bot activo sin cobertura. Bajo fencing.
export const closeArmLowerOnlyExpired = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "armed_lower_only") return { ok: false as const };
    await ctx.db.patch(armId, { status: "closed", closeReason: "manual", updatedAt: Date.now() });
    // (JAV-61 fix P1#5) Conservar la finalización de pausa del resto del state machine: si había una
    // pausa pendiente, completarla (desactivar) y NO rearmar.
    const bot = await ctx.db.get(arm.botId);
    if (bot?.disarmPending) {
      await ctx.db.patch(arm.botId, { active: false, disarmPending: false, disarmRequestedAt: undefined });
      return { ok: true as const, rearmScheduled: false as const };
    }
    const rearmScheduled = await rescheduleRearmIfEligible(ctx, arm.botId);
    return { ok: true as const, rearmScheduled };
  },
});

// --- TPs (role:"tp"): un trigger_order por tpIndex. Idempotencia por cloid …|tp:i:attempt. ---

export const getArmTpOrder = internalQuery({
  args: { armId: v.id("trigger_arms"), tpIndex: v.number() },
  handler: async (ctx, { armId, tpIndex }) =>
    ctx.db.query("trigger_orders").withIndex("by_arm_role_index", (q) => q.eq("armId", armId).eq("role", "tp").eq("tpIndex", tpIndex)).first(),
});

// Crea/rota el trigger_order de un TP concreto (bump attempt, cloid nuevo, observedStatus pending,
// submittedAt limpio). Devuelve el cloid. Bajo claim. Persiste triggerPx/size del intento.
export const prepareTpAttempt = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string(), tpIndex: v.number(), triggerPx: v.number(), size: v.number() },
  handler: async (ctx, { armId, token, tpIndex, triggerPx, size }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    const existing = await ctx.db.query("trigger_orders").withIndex("by_arm_role_index", (q) => q.eq("armId", armId).eq("role", "tp").eq("tpIndex", tpIndex)).first();
    const attempt = (existing?.attempt ?? 0) + 1;
    const cloid = await armCloid(arm.botId, arm.generation, `tp:${tpIndex}:${attempt}`);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { cloid, oid: undefined, observedStatus: "pending", attempt, submittedAt: undefined, triggerPx, size, updatedAt: now });
    } else {
      await ctx.db.insert("trigger_orders", {
        armId, role: "tp", tpIndex, cloid, oid: undefined, triggerPx, size, reduceOnly: true,
        attempt, observedStatus: "pending", createdAt: now, updatedAt: now,
      });
    }
    return { ok: true as const, cloid };
  },
});

// Marca/limpia campos observados de un TP (observedStatus/oid/submittedAt) bajo claim.
export const setTpObserved = internalMutation({
  args: {
    armId: v.id("trigger_arms"), token: v.string(), tpIndex: v.number(),
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    oid: v.optional(v.string()), markSubmitted: v.optional(v.boolean()),
  },
  handler: async (ctx, { armId, token, tpIndex, observedStatus, oid, markSubmitted }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const order = await ctx.db.query("trigger_orders").withIndex("by_arm_role_index", (q) => q.eq("armId", armId).eq("role", "tp").eq("tpIndex", tpIndex)).first();
    if (!order) return { ok: false as const };
    const patch: Record<string, unknown> = { observedStatus, updatedAt: Date.now() };
    if (oid !== undefined) patch.oid = oid;
    if (markSubmitted) patch.submittedAt = Date.now();
    await ctx.db.patch(order._id, patch);
    return { ok: true as const };
  },
});

// Marca slSubmittedAt del SL (intento enviado/aceptado): grace anti-doble-SL antes de rotar cloid.
export const markArmSlSubmitted = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string() },
  handler: async (ctx, { armId, token }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    await ctx.db.patch(armId, { slSubmittedAt: Date.now(), updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (JAV-66) Activación del break-even bajo el claim (CAS+token). Fija el latch one-way `beMoved` y
// DEGRADA protected→protecting para que la ROTACIÓN del SL la haga el bloque (3) de reconcileArm
// —ya auditado: confirma por CLOID, recoloca y, si agota deadline/intentos con la posición sin SL
// confirmado, ESCALA a cierre de emergencia (el gate de emergencia exige status!=="protected")—.
// Resetea protectDeadline + slAttempts: la rotación obtiene una ventana de protección FRESCA (4 min/
// 3 intentos); si no logra el SL de BE a tiempo → emergencia. NO cancela el SL viejo (+1%): sigue vivo
// hasta que el bloque (3) lo confirme y rote (confirmar-antes-de-rotar). Solo desde `protected`.
export const activateBreakeven = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string(), protectDeadlineMs: v.number() },
  handler: async (ctx, { armId, token, protectDeadlineMs }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (arm.status !== "protected") return { ok: false as const };   // solo desde protected
    if (arm.beMoved === true) return { ok: true as const };          // idempotente
    const now = Date.now();
    await ctx.db.patch(armId, {
      beMoved: true, status: "protecting",
      protectDeadline: now + protectDeadlineMs, slAttempts: 0, slSubmittedAt: undefined,
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

// Marca/limpia closeConfirmSince (doble lectura szi==0) bajo el claim. value=null limpia.
export const setArmCloseConfirm = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string(), value: v.union(v.number(), v.null()) },
  handler: async (ctx, { armId, token, value }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(armId, { closeConfirmSince: value ?? undefined, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (auto-rearm) Marca el ORIGEN del cierre de emergencia ANTES de mandar el market close, para que al
// alcanzar `closed` se distinga emergency/disarm de un SL llenado o un cierre externo (Codex #1).
// Idempotente: solo fija si no estaba puesto. Bajo claim.
export const markEmergencyClosing = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string(), reason: v.union(v.literal("emergency"), v.literal("disarm")) },
  handler: async (ctx, { armId, token, reason }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    if (arm.emergencyClosing == null) await ctx.db.patch(armId, { emergencyClosing: reason, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// --- Transición genérica con fencing + cuarentena N6 + finalización de pausa N2 ---
export const settleArm = internalMutation({
  args: {
    armId: v.id("trigger_arms"),
    status: v.union(
      v.literal("armed"), v.literal("disarming"), v.literal("disarmed"),
      v.literal("filled"), v.literal("protecting"), v.literal("protected"),
      v.literal("closed"), v.literal("unknown"), v.literal("failed")),
    token: v.optional(v.string()),
    filledSize: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    error: v.optional(v.string()),
    // (auto-rearm) motivo del cierre — solo se persiste al pasar a "closed". "sl" habilita el re-arm.
    closeReason: v.optional(v.union(v.literal("sl"), v.literal("manual"), v.literal("emergency"), v.literal("disarm"))),
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
    // (Codex #6) Cerrar EXIGE un motivo (gobierna el auto-rearm). Protege el contrato ante call sites futuros.
    if (args.status === "closed" && args.closeReason === undefined) return { ok: false as const };

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
    // (auto-rearm) persistir el motivo solo al cerrar (gobierna si el cron rearma una nueva generación).
    if (args.status === "closed" && args.closeReason !== undefined) patch.closeReason = args.closeReason;
    // filledAt: marca la PRIMERA confirmación de fill (grace anti-closed-prematuro por lag de APIs).
    if (args.status === "filled" && arm.filledAt == null) patch.filledAt = now;
    await ctx.db.patch(args.armId, patch);

    // (N2) Finalización de la pausa: al alcanzar terminal con disarmPending, completar active=false.
    if (ARM_TERMINAL.has(args.status)) {
      const bot = await ctx.db.get(arm.botId);
      if (bot?.disarmPending) {
        await ctx.db.patch(arm.botId, { active: false, disarmPending: false, disarmRequestedAt: undefined });
      }
    }
    // (Codex #1) Un arm de auto-rearm que termina `failed` AQUÍ ya pasó la cuarentena N6 y la prueba
    // negativa del motor (sin entrada viva ni fill) → DEVOLVER el trabajo: reprogramar otro rearm
    // atómicamente (si sigue elegible). Nunca queda el bot activo sin cobertura ni trabajo pendiente.
    // (Una pausa desactivó el bot arriba → rescheduleRearmIfEligible lo rechaza: no reprograma.)
    if (args.status === "failed" && arm.fromRearm === true) {
      await rescheduleRearmIfEligible(ctx, arm.botId);
    }
    return { ok: true as const };
  },
});

// (Codex #1) Cierre + programación de rearm ATÓMICOS: cerrar el arm y actualizar el bot en UNA sola
// transacción (evita la ventana donde la action muere entre cerrar y programar → cerrado sin rearm).
// Conserva fencing, transición permitida y cuarentena de settleArm. Programa rearm SOLO si
// closeReason="sl" Y config válida (autoRearm, activo, sin pausa, sin rearm en curso). Cuenta el stop.
export const closeArmAndScheduleRearm = internalMutation({
  args: {
    armId: v.id("trigger_arms"),
    token: v.string(),
    closeReason: v.union(v.literal("sl"), v.literal("emergency"), v.literal("disarm"), v.literal("manual")),
    nextRearmAt: v.number(),   // cuándo podrá rearmar el cron si aplica (closedAt + cooldown)
  },
  handler: async (ctx, { armId, token, closeReason, nextRearmAt }) => {
    const arm = await ctx.db.get(armId);
    if (!arm) return { ok: false as const };
    // Fencing + transición permitida + cuarentena N6 (idéntico a settleArm).
    if (arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    const allowed = ALLOWED_ARM[arm.status];
    if (!allowed || !allowed.has("closed")) return { ok: false as const };
    if (arm.submittedAt != null && Date.now() - arm.submittedAt <= ARM_SUBMIT_QUARANTINE_MS) {
      return { ok: false as const, quarantined: true as const };
    }
    const now = Date.now();
    await ctx.db.patch(armId, { status: "closed", closeReason, updatedAt: now });

    const bot = await ctx.db.get(arm.botId);
    // (Codex #3) Reiniciar la secuencia de whipsaw limpia los TRES campos (consecutiveStops,
    // lastStopAlertLevel, stopAlertSentAt): si no, tras alertar en 5 y reiniciar, una nueva secuencia
    // de 5 daría 5−5=0 y no alertaría.
    const resetAlert = { consecutiveStops: 0, lastStopAlertLevel: 0, stopAlertSentAt: undefined } as const;
    // N2: finalizar pausa si estaba pendiente (la pausa gana; no rearmar).
    if (bot?.disarmPending) {
      await ctx.db.patch(arm.botId, { active: false, disarmPending: false, disarmRequestedAt: undefined, ...resetAlert });
      return { ok: true as const, rearmScheduled: false as const, consecutiveStops: 0 };
    }
    if (closeReason !== "sl") {
      if (bot) await ctx.db.patch(arm.botId, resetAlert);
      return { ok: true as const, rearmScheduled: false as const, consecutiveStops: 0 };
    }
    // Cierre por SL: contar el stop y, si la config es válida, programar el rearm (no pisar uno en curso).
    const count = (bot?.consecutiveStops ?? 0) + 1;
    const patch: Record<string, unknown> = { consecutiveStops: count };
    let rearmScheduled = false;
    if (bot && bot.autoRearm === true && bot.active === true && bot.disarmPending !== true && bot.rearmStatus == null) {
      patch.rearmStatus = "pending";
      patch.nextRearmAt = nextRearmAt;
      patch.rearmAttempts = 0;
      patch.lastRearmError = undefined;
      patch.lastRearmErrorKind = undefined;
      patch.rearmLeaseToken = undefined;
      patch.rearmLeaseUntil = undefined;
      rearmScheduled = true;
    }
    if (bot) await ctx.db.patch(arm.botId, patch);
    return { ok: true as const, rearmScheduled, consecutiveStops: count };
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
    if (bot?.disarmPending) await ctx.db.patch(arm.botId, { active: false, disarmPending: false, disarmRequestedAt: undefined });
    // (Codex #1) Abandonado pre-CAS = NUNCA envió a HL (submittedAt==null) → sin orden posible. Si era
    // auto-rearm, devolver el trabajo (reprogramar) para no dejar el bot activo sin cobertura.
    if (arm.fromRearm === true) await rescheduleRearmIfEligible(ctx, arm.botId);
    return { ok: true as const };
  },
});

// --- Query pública: estado vivo de la cobertura para la UI (JAV-58 Fase A) ---
// (Codex) Multi-tenant ESTRICTO: NO acepta botId del cliente; requireUser; bots por by_user; además
// valida arm.userId === user._id (defensa en profundidad) y devuelve órdenes SOLO de esos arms. Es
// READ-ONLY: no toca el motor de ejecución/rearm ni el dimensionado de margen/leverage.
export const listMyActiveArms = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const bots = await ctx.db.query("bots").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const out: Array<{
      botId: Id<"bots">; status: string; desiredState: string; side: string;
      triggerPx: number; lowerEdge: number; upperEdge: number | undefined;
      appliedLeverage: number; reservedNotional: number; generation: number;
      reservationReduced: boolean; allowReentryFromAbove: boolean;
      // (feature BE) precio de fill + latch break-even, para que la UI muestre SL real + estado BE.
      entryPrice: number | undefined; beMoved: boolean;
      orders: Array<{ role: string; oid: string | undefined; cloid: string; triggerPx: number; observedStatus: string }>;
    }> = [];
    for (const bot of bots) {
      const arms = await ctx.db
        .query("trigger_arms")
        .withIndex("by_bot_generation", (q) => q.eq("botId", bot._id))
        .collect();
      // Solo arms del usuario (defensa en profundidad), por generación desc.
      const mine = arms.filter((a) => a.userId === user._id).sort((a, b) => b.generation - a.generation);
      // (Codex #2) Arm vivo (no terminal) más reciente; si no hay y el ÚLTIMO arm FALLÓ, devolverlo para
      // NO ocultar el fallo. closed/disarmed (terminales normales) no se muestran.
      const live = mine.find((a) => !isArmTerminal(a.status)) ?? (mine[0]?.status === "failed" ? mine[0] : undefined);
      if (!live) continue;
      const orders = await ctx.db
        .query("trigger_orders")
        .withIndex("by_arm_role", (q) => q.eq("armId", live._id))
        .collect();
      out.push({
        botId: bot._id, status: live.status, desiredState: live.desiredState, side: live.side,
        triggerPx: live.triggerPx, lowerEdge: live.lowerEdge, upperEdge: live.upperEdge,
        appliedLeverage: live.appliedLeverage, reservedNotional: live.reservedNotional, generation: live.generation,
        reservationReduced: live.reservationReduced ?? false, allowReentryFromAbove: live.allowReentryFromAbove ?? false,
        entryPrice: live.entryPrice, beMoved: live.beMoved ?? false,
        orders: orders.map((o) => ({
          role: o.role, oid: o.oid, cloid: o.cloid, triggerPx: o.triggerPx, observedStatus: o.observedStatus,
        })),
      });
    }
    return out;
  },
});

// --- Queries internas para el motor/cron ---
export const getArmInternal = internalQuery({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) => ctx.db.get(armId),
});

const ARM_ROLE = v.union(v.literal("entry_lower"), v.literal("entry_upper"), v.literal("sl_upper"), v.literal("tp_final"));

export const getArmOrderByRole = internalQuery({
  args: { armId: v.id("trigger_arms"), role: ARM_ROLE },
  handler: async (ctx, { armId, role }) =>
    ctx.db.query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", role)).first(),
});

// Wrapper de compat (entrada inferior).
export const getArmOrderInternal = internalQuery({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) =>
    ctx.db.query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "entry_lower")).first(),
});

// Todos los trigger_orders de un arm (para cancelar TODOS los roles vivos en el camino defensivo).
export const getArmOrdersInternal = internalQuery({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) =>
    ctx.db.query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId)).collect(),
});

export const listReconcilableArmsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // (Fix #3) Ordenar por updatedAt ASC (más antiguo primero), NO por status: tras reconciliar un
    // arm su updatedAt se refresca y pasa al final → rotación justa, sin starvation por estado.
    const n = limit ?? 50;
    const out: Id<"trigger_arms">[] = [];
    for await (const a of ctx.db.query("trigger_arms").withIndex("by_updated").order("asc")) {
      if (!isArmTerminal(a.status)) { out.push(a._id); if (out.length >= n) break; }
    }
    return out;
  },
});

export const setArmOrderObserved = internalMutation({
  args: {
    armId: v.id("trigger_arms"), token: v.string(),
    role: v.optional(ARM_ROLE),   // por defecto entry_lower (compat)
    observedStatus: v.union(
      v.literal("pending"), v.literal("open"), v.literal("triggered"), v.literal("filled"),
      v.literal("canceled"), v.literal("rejected"), v.literal("unknown")),
    oid: v.optional(v.string()),
    markSubmitted: v.optional(v.boolean()),   // (JAV-61) fija submittedAt (grace anti-doble, p.ej. tp_final)
  },
  handler: async (ctx, { armId, token, role, observedStatus, oid, markSubmitted }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    const order = await ctx.db
      .query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", role ?? "entry_lower")).first();
    if (!order) return { ok: false as const };
    const patch: Record<string, unknown> = { observedStatus, updatedAt: Date.now() };
    if (oid !== undefined) patch.oid = oid;
    if (markSubmitted) patch.submittedAt = Date.now();
    await ctx.db.patch(order._id, patch);
    return { ok: true as const };
  },
});

// (JAV-61) Crea/rota el trigger_order del TP-final (role "tp_final", reduceOnly) para un intento:
// cloid …|tp_final:<attempt>, observedStatus pending, submittedAt limpio. Bajo claim. Devuelve cloid.
export const prepareTpFinalOrder = internalMutation({
  args: { armId: v.id("trigger_arms"), token: v.string(), triggerPx: v.number(), size: v.number() },
  handler: async (ctx, { armId, token, triggerPx, size }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    const existing = await ctx.db.query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "tp_final")).first();
    const attempt = (existing?.attempt ?? 0) + 1;
    const cloid = await armCloid(arm.botId, arm.generation, `tp_final:${attempt}`);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { cloid, oid: undefined, observedStatus: "pending", attempt, submittedAt: undefined, triggerPx, size, updatedAt: now });
    } else {
      await ctx.db.insert("trigger_orders", {
        armId, role: "tp_final", cloid, oid: undefined, triggerPx, size, reduceOnly: true,
        attempt, observedStatus: "pending", createdAt: now, updatedAt: now,
      });
    }
    return { ok: true as const, cloid };
  },
});

// Crea/rota el trigger_order del SL (sl_upper) para un nuevo intento: bump slAttempts, fija
// protectDeadline si falta, y crea el trigger_order(pending) con cloid …|sl|<attempt>. Devuelve el
// cloid del intento. Bajo claim. Idempotente por (armId, attempt).
export const prepareSlAttempt = internalMutation({
  // (JAV-61 fix P0) `size`: el tamaño REAL que se enviará a HL (realSize). Debe PERSISTIRSE en el
  // trigger_order para que el guard de resize (realSize > sl_upper.size·1.02) no vuelva a disparar
  // en bucle tras recolocar full-size. Opcional → default arm.size (compat con el flujo 1×).
  // (JAV-66) `triggerPx`: el nivel REAL que se enviará a HL (entry+stopLossPct% o break-even). Se
  // persiste en la fila sl_upper para poder auditar el nivel vigente y detectar un SL desactualizado
  // (rotación a BE). Opcional → default 0 (compat con el flujo previo, que no lo persistía).
  args: { armId: v.id("trigger_arms"), token: v.string(), protectDeadlineMs: v.number(), size: v.optional(v.number()), triggerPx: v.optional(v.number()) },
  handler: async (ctx, { armId, token, protectDeadlineMs, size, triggerPx }) => {
    const arm = await ctx.db.get(armId);
    if (!arm || arm.reconcileLeaseToken !== token || (arm.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (isArmTerminal(arm.status)) return { ok: false as const };
    const attempt = (arm.slAttempts ?? 0) + 1;
    const cloid = await armCloid(arm.botId, arm.generation, `sl:${attempt}`);
    const now = Date.now();
    const slSize = (size != null && size > 0) ? size : arm.size;   // tamaño realmente enviado a HL
    const slTrig = (triggerPx != null && triggerPx > 0) ? triggerPx : 0;   // (JAV-66) nivel persistido
    // Sustituir el trigger_order sl_upper (un único role sl_upper por arm; se rota su cloid + size).
    const existing = await ctx.db
      .query("trigger_orders").withIndex("by_arm_role", (q) => q.eq("armId", armId).eq("role", "sl_upper")).first();
    if (existing) {
      await ctx.db.patch(existing._id, { cloid, oid: undefined, observedStatus: "pending", size: slSize, triggerPx: slTrig, updatedAt: now });
    } else {
      await ctx.db.insert("trigger_orders", {
        armId, role: "sl_upper", cloid, oid: undefined, triggerPx: slTrig, size: slSize,
        reduceOnly: true, observedStatus: "pending", createdAt: now, updatedAt: now,
      });
    }
    await ctx.db.patch(armId, {
      slAttempts: attempt,
      slSubmittedAt: undefined,   // nuevo intento aún NO enviado (se marca al aceptarse en HL)
      protectDeadline: arm.protectDeadline ?? (arm.filledAt ?? now) + protectDeadlineMs,
      updatedAt: now,
    });
    return { ok: true as const, cloid, attempt };
  },
});
