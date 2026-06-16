import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { hasPermission, requireAdmin } from "./helpers";
import { assertWithinPlanCoverage, coverageAdmissible } from "./coverageUsage";
import { resolveLeverage, MARGIN_SAFETY_BUFFER } from "./leverage";

// Lease anti-carrera: la reconciliación no toca pending/submitting con updatedAt más reciente.
export const LEASE_MS = 90_000;

// Revalidación autoritativa de la admisión: master switch global + permiso canTradeLive (bypass
// admin) + estado del bot (ownership, activo, real, misma cuenta). Si algo cambió durante la
// action (revocación, kill switch, pausa, vuelta a simulación, cambio de cuenta) → no admisible.
export async function assertLiveAdmissible(
  ctx: QueryCtx | MutationCtx, userId: Id<"users">, botId: Id<"bots">, hlAccountId: Id<"hl_api_credentials">,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  if (!user) return false;
  const [trading, sim] = await Promise.all([
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "tradingEnabled")).first(),
    ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "simulationMode")).first(),
  ]);
  if (trading?.value !== true || sim?.value !== false) return false;
  if (!(await hasPermission(ctx, user, "canTradeLive"))) return false;
  const bot = await ctx.db.get(botId);
  if (!bot || bot.userId !== userId || !bot.active || bot.simulationMode) return false;
  if (bot.hlAccountId !== hlAccountId) return false;   // la cuenta no cambió bajo la solicitud
  return true;
}

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
// Margen de seguridad: FUENTE ÚNICA en leverage.ts (compartida con el dimensionado de autoleverage).
// Estados que mantienen margen comprometido en la cuenta (todos menos los finales).
const OPEN_MARGIN_STATES = new Set([
  "pending", "submitting", "entry_filled", "protected", "sl_failed", "unknown",
]);
// JAV-44: estados de un trigger_arm que mantienen margen comprometido (todos menos ARM_TERMINAL).
// ARM_TERMINAL = { disarmed, closed, failed }.
const ARM_OPEN_MARGIN_STATES = new Set([
  "arming", "submitting", "armed", "disarming", "filled", "protecting", "protected", "unknown",
]);

// Margen comprometido en una cuenta HL sumando AMBOS motores (IOC manual + triggers automáticos),
// para que ninguna reserva pueda gastar dos veces el mismo colateral. Helper plano reutilizado por
// `reserveExecution` (JAV-43) y por la reserva del arm (JAV-44) dentro de su misma mutation OCC.
export async function committedMarginForAccount(
  ctx: MutationCtx, hlAccountId: Id<"hl_api_credentials">,
): Promise<number> {
  const exec = await ctx.db
    .query("execution_requests")
    .withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId))
    .collect();
  const execMargin = exec
    .filter((r) => OPEN_MARGIN_STATES.has(r.status))
    .reduce((sum, r) => sum + (r.marginReserved ?? r.notional), 0);
  const arms = await ctx.db
    .query("trigger_arms")
    .withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId))
    .collect();
  const armMargin = arms
    .filter((a) => ARM_OPEN_MARGIN_STATES.has(a.status))
    .reduce((sum, a) => sum + (a.marginReserved ?? a.reservedNotional), 0);
  return execMargin + armMargin;
}

// D (JAV-UI): ¿el bot tiene alguna ejecución JAV-37 (IOC manual) ABIERTA? Solo `closed` (SL
// ejecutado) y `failed` (sin entrada) son seguros: el resto puede tener posición/orden viva en HL
// — incluido `protected` (SL resting, posición abierta). Bloquea el borrado del bot (huérfanos).
export async function hasOpenExecutionForBot(
  ctx: MutationCtx, botId: Id<"bots">,
): Promise<boolean> {
  const exec = await ctx.db
    .query("execution_requests")
    .withIndex("by_bot", (q) => q.eq("botId", botId))
    .collect();
  return exec.some((r) => !["closed", "failed"].includes(r.status));
}

// Dedupe-check ligero ANTES de los gates de modo/margen (evita que un reintento de una
// solicitud existente falle por saldo/modo actuales antes de poder reconciliarse).
export const findByIdempotency = internalQuery({
  args: { userId: v.id("users"), idempotencyKey: v.string() },
  handler: async (ctx, { userId, idempotencyKey }) => {
    return await ctx.db
      .query("execution_requests")
      .withIndex("by_user_idempotency", (q) => q.eq("userId", userId).eq("idempotencyKey", idempotencyKey))
      .first();
  },
});

export const reserveExecution = internalMutation({
  args: {
    userId: v.id("users"),
    botId: v.id("bots"),
    idempotencyKey: v.string(),
    hlAccountId: v.id("hl_api_credentials"),
    // (JAV-77) pool + liquidez LP (sin buffer) para el hard-cap por plan (Modelo B). El caller los
    // obtiene fiables on-chain (fetchPositionNotionalStrict) ANTES de reservar; si no puede, NO reserva.
    poolId: v.id("pools"),
    hedgeNotionalUsd: v.number(),
    asset: v.string(),
    stopLossPct: v.number(),
    requestedAmount: v.number(),
    notional: v.number(),
    availableCollateral: v.number(),  // colateral snapshot (USDC spot libre) — sin doble conteo
    // Leverage: reserveExecution lo resuelve (auto/manual) con el helper compartido, atómico con
    // el margen comprometido. autoLeverage activo ignora manualLeverage.
    autoLeverage: v.boolean(),
    manualLeverage: v.optional(v.number()),   // bot.leverage (modo manual)
    assetMaxLeverage: v.number(),             // maxLeverage del activo en HL (entero ≥ 1)
    side: v.union(v.literal("Long"), v.literal("Short")),
    network: v.string(),
    entryCloid: v.string(),
    slCloid: v.string(),
  },
  // Promise<any>: corta el ciclo de inferencia TS2589 (el handler llama a coverageUsage, que recorre
  // el grafo de tipos del DataModel; sin anotar, el retorno inferido desborda el presupuesto y revienta
  // en cascada por todo el backend). El cuerpo se sigue type-checkeando.
  handler: async (ctx, args): Promise<any> => {
    if (!Number.isFinite(args.notional) || args.notional <= 0) {
      throw new Error("notional debe ser un número finito > 0");
    }
    if (!Number.isFinite(args.availableCollateral) || args.availableCollateral < 0) {
      throw new Error("availableCollateral debe ser un número finito >= 0");
    }
    // (0) Admisión autoritativa: revalida switches + canTradeLive + estado del bot en la misma
    // mutation que reserva, cerrando la ventana entre la validación de la action y la reserva.
    if (!(await assertLiveAdmissible(ctx, args.userId, args.botId, args.hlAccountId))) {
      throw new Error("Ejecución no admisible: switch/permiso/estado del bot cambió.");
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
      // Dedupe: NO se recalcula ni sobrescribe leverage/margen — se devuelve lo PERSISTIDO (Codex #3).
      // Una fila legacy puede no tener appliedLeverage (undefined); el caller no re-ejecuta updateLeverage.
      return { requestId: existing._id, status: existing.status, alreadyExists: true as const, appliedLeverage: existing.appliedLeverage };
    }
    // (2) Hard-cap por plan (JAV-77, Modelo B): la cobertura de POOLS del usuario (Σ hedgeNotionalUsd
    // sin buffer, dedupe por pool) + este pool no puede superar el tope del plan. Sin plan/suspendido →
    // bloquea. LANZA [blocked_config]/[blocked_margin] en la misma OCC. Reemplaza los límites beta $500/$2k.
    if (!(args.hedgeNotionalUsd > 0) || !Number.isFinite(args.hedgeNotionalUsd)) {
      throw new Error("[blocked_config] hedgeNotionalUsd inválido (cobertura del pool no cuantificable).");
    }
    await assertWithinPlanCoverage(ctx, args.userId, args.poolId, args.hedgeNotionalUsd);
    // (2b) Reserva de margen ATÓMICA por cuenta (anti-carrera). Esta mutation serializa, así que
    // dos ejecuciones concurrentes de la misma cuenta se contabilizan una tras otra. Se suma el
    // margen ya comprometido por AMBOS motores en la cuenta + el de esta; debe caber en el
    // colateral disponible (snapshot) con un buffer de seguridad.
    const marginCommitted = await committedMarginForAccount(ctx, args.hlAccountId);
    // Resolver leverage + margen JUNTOS (helper único). autoLeverage sube hasta el tope para que
    // el nocional quepa; si ni al tope cabe lanza [blocked_margin]. El margen resultante alimenta el
    // gate de abajo con el MISMO buffer (usableReal coherente).
    const { appliedLeverage, marginRequired } = resolveLeverage({
      autoLeverage: args.autoLeverage, manualLeverage: args.manualLeverage,
      reservedNotional: args.notional, availableCollateral: args.availableCollateral,
      marginCommitted, assetMaxLeverage: args.assetMaxLeverage,
    });
    if ((marginCommitted + marginRequired) > args.availableCollateral * (1 - MARGIN_SAFETY_BUFFER)) {
      throw new Error(
        // (CodeRabbit) Prefijo [blocked_margin]: coherente con resolveLeverage/reserveArm y con el
        // contrato de buckets de capacidad (la misma función ya lanza [blocked_margin] desde el helper).
        `[blocked_margin] Margen insuficiente en la cuenta: comprometido ${marginCommitted.toFixed(2)} + requerido ` +
        `${marginRequired.toFixed(2)} > colateral ${args.availableCollateral.toFixed(2)} (buffer ${MARGIN_SAFETY_BUFFER * 100}%).`);
    }
    // (3) Reservar en estado pending.
    const now = Date.now();
    const requestId = await ctx.db.insert("execution_requests", {
      userId: args.userId,
      botId: args.botId,
      idempotencyKey: args.idempotencyKey,
      hlAccountId: args.hlAccountId,
      poolId: args.poolId,
      hedgeNotionalUsd: args.hedgeNotionalUsd,
      asset: args.asset,
      stopLossPct: args.stopLossPct,
      requestedAmount: args.requestedAmount,
      notional: args.notional,
      marginReserved: marginRequired,
      appliedLeverage,
      side: args.side,
      status: "pending",
      network: args.network,
      entryCloid: args.entryCloid,
      slCloid: args.slCloid,
      slAttempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { requestId, status: "pending" as const, alreadyExists: false as const, appliedLeverage };
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
    // Limpiar slSubmittedAt al rotar el CLOID: el marcador pertenecía al cloid anterior; si no se
    // borra, el grace anti-doble-SL se aplicaría a un cloid NUEVO aún no enviado, retrasando la
    // protección. Se vuelve a fijar solo cuando el nuevo intento se acepte (resting/pending).
    await ctx.db.patch(requestId, { slCloid: newSlCloid, slAttempt: attempt, slSubmittedAt: undefined, updatedAt: Date.now() });
    return { ok: true };
  },
});

// Marca `submitting` con timestamp de lease, justo antes de enviar la entrada a HL.
export const markSubmitting = internalMutation({
  args: { requestId: v.id("execution_requests") },
  // Promise<any>: corta el ciclo TS2589 (llama a coverageAdmissible). El cuerpo se sigue chequeando.
  handler: async (ctx, { requestId }): Promise<any> => {
    const req = await ctx.db.get(requestId);
    if (!req) return { ok: false as const, reason: "not_found" as const };
    // CAS: solo desde `pending`. Si otro proceso (cron) ya avanzó/cerró la solicitud, NO re-enviar
    // (evita resucitar un failed/entry_filled a submitting). Es carrera de estado, no rechazo.
    if (req.status !== "pending") return { ok: false as const, reason: "state" as const };
    // Último gate antes del envío: switch/permiso/estado del bot. Si cambió → no marcar.
    if (!(await assertLiveAdmissible(ctx, req.userId, req.botId, req.hlAccountId))) {
      return { ok: false as const, reason: "blocked" as const };
    }
    // (JAV-77) Revalidar hard-cap/plan/suspensión (ventana reserva→CAS). Bloqueado → `blocked`: el
    // caller (executePerpMarketOrder) lo terminaliza a `failed` sin envío (libera margen/cap).
    if (!(await coverageAdmissible(ctx, req.userId, req.poolId, req.hedgeNotionalUsd))) {
      return { ok: false as const, reason: "blocked" as const };
    }
    const now = Date.now();
    await ctx.db.patch(requestId, { status: "submitting", submittedAt: now, updatedAt: now });
    return { ok: true as const };
  },
});

// Transición de estado atómica + log final único en trades_history.
type TransitionArgs = {
  requestId: Id<"execution_requests">;
  status: "entry_filled" | "protected" | "sl_failed" | "closed" | "unknown" | "failed";
  entryOrderId?: string; slOrderId?: string; filledSize?: number; entryPrice?: number;
  slSubmittedAt?: number; error?: string; token?: string;
};

// Lógica de transición compartida (fencing + ALLOWED + log final único). Reutilizada por
// settleExecution y gateBeforeOrder (cierre CAS atómico).
async function applyTransition(ctx: MutationCtx, args: TransitionArgs): Promise<void> {
  const req = await ctx.db.get(args.requestId);
  if (!req) throw new Error("execution_request no encontrada");
  // Fencing: una transición bajo claim solo aplica si el token es el dueño actual Y el lease vigente.
  if (args.token !== undefined &&
      (req.reconcileLeaseToken !== args.token || (req.reconcileLeaseUntil ?? 0) <= Date.now())) return;
  // Idempotencia + transiciones permitidas: no sobrescribir un final ni degradar un estado.
  if (FINAL_STATES.has(req.status)) return;
  const allowed = ALLOWED[req.status];
  if (!allowed || !allowed.has(args.status)) return;
  const patch: Record<string, unknown> = { status: args.status, updatedAt: Date.now() };
  for (const k of ["entryOrderId", "slOrderId", "filledSize", "entryPrice", "slSubmittedAt", "error"] as const) {
    if (args[k] !== undefined) patch[k] = args[k];
  }
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
}

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
    slSubmittedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    token: v.optional(v.string()),   // si se provee (transiciones bajo claim), debe ser el dueño
  },
  handler: async (ctx, args) => { await applyTransition(ctx, args); },
});

// (G5) Marca/limpia flatSince bajo fencing (token del claim de reconciliación). value=null limpia.
export const setExecutionFlatSince = internalMutation({
  args: { requestId: v.id("execution_requests"), token: v.string(), value: v.union(v.number(), v.null()) },
  handler: async (ctx, { requestId, token, value }) => {
    const req = await ctx.db.get(requestId);
    if (!req) return { ok: false as const };
    if (req.reconcileLeaseToken !== token || (req.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    await ctx.db.patch(requestId, { flatSince: value === null ? undefined : value, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (G4) Cierre en DB de TODAS las ejecuciones JAV-37 abiertas de un bot, tras confirmar la posición
// flat en HL (lo llama closeBotPosition). Sin token: aplica la transición a `closed` (libera margen +
// registra historial) saltando el fencing — operación deliberada del DUEÑO al cerrar+borrar el bot.
export const closeOpenExecutionsForBotInternal = internalMutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const rows = await ctx.db.query("execution_requests").withIndex("by_bot", (q) => q.eq("botId", botId)).collect();
    let closed = 0, failed = 0;
    for (const r of rows) {
      if (["closed", "failed"].includes(r.status)) continue;
      // (CodeRabbit #2) Solo es un CIERRE real si hubo posición (filledSize>0). Una ejecución sin
      // fill (pending/submitting/unknown sin datos) nunca abrió posición → terminarla como `failed`,
      // no como `closed` (que falsearía un cierre y ensuciaría el historial). Ambos son terminales →
      // ninguno bloquea el borrado del bot.
      if ((r.filledSize ?? 0) > 0) {
        await applyTransition(ctx, { requestId: r._id, status: "closed", filledSize: r.filledSize, entryPrice: r.entryPrice });
        closed++;
      } else {
        await applyTransition(ctx, { requestId: r._id, status: "failed", error: "sin fill al cerrar el bot" });
        failed++;
      }
    }
    return { closed, failed };
  },
});

/**
 * Marca `slSubmittedAt` SIN cambiar de estado (caso waitingForTrigger/waitingForFill/timeout: SL
 * aceptado o incierto pero aún sin oid). Deja el estado en `entry_filled` para que el cron lo
 * confirme por CLOID; el marcador evita recolocar un 2º SL durante el lag de `unknownOid`. Requiere
 * ser dueño del claim (fencing por token + lease vigente) y que el estado no sea final.
 * @returns `{ ok: true }` si se persistió; `{ ok: false }` si se perdió el claim o el estado es final.
 */
export const markSlSubmitted = internalMutation({
  args: { requestId: v.id("execution_requests"), token: v.string() },
  handler: async (ctx, { requestId, token }) => {
    const req = await ctx.db.get(requestId);
    if (!req) return { ok: false as const };
    if (req.reconcileLeaseToken !== token || (req.reconcileLeaseUntil ?? 0) <= Date.now()) return { ok: false as const };
    if (FINAL_STATES.has(req.status)) return { ok: false as const };
    await ctx.db.patch(requestId, { slSubmittedAt: Date.now(), updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Decisión ATÓMICA del último gate antes de exchange.order. Distingue:
//  - state/expired/claimed: otro proceso (cron) tomó el control → abortar sin tocar la solicitud.
//  - blocked: sigue submitting, lease vigente, sin claim, pero autorización/bot inválido →
//    cerrar failed por CAS en la MISMA mutation (no compite con el reconciliador).
export const gateBeforeOrder = internalMutation({
  args: { requestId: v.id("execution_requests") },
  // Promise<any>: corta el ciclo TS2589 (llama a coverageAdmissible). El cuerpo se sigue chequeando.
  handler: async (ctx, { requestId }): Promise<any> => {
    const req = await ctx.db.get(requestId);
    if (!req || req.status !== "submitting") return { ok: false as const, reason: "state" as const };
    if (Date.now() - req.updatedAt >= LEASE_MS) return { ok: false as const, reason: "expired" as const };
    if (req.reconcileLeaseUntil && req.reconcileLeaseUntil > Date.now()) return { ok: false as const, reason: "claimed" as const };
    if (!(await assertLiveAdmissible(ctx, req.userId, req.botId, req.hlAccountId))) {
      await applyTransition(ctx, { requestId, status: "failed", error: "blocked before order (switch/permiso/estado bot)" });
      return { ok: false as const, reason: "blocked" as const };
    }
    // (JAV-77) Último gate antes de exchange.order: revalidar hard-cap/plan/suspensión. Bloqueado →
    // terminalizar a `failed` inline (no se envió nada, libera margen/cap), como el bloqueo de admisión.
    if (!(await coverageAdmissible(ctx, req.userId, req.poolId, req.hedgeNotionalUsd))) {
      await applyTransition(ctx, { requestId, status: "failed", error: "[blocked_margin] cap/plan/suspensión (gateBeforeOrder)" });
      return { ok: false as const, reason: "blocked" as const };
    }
    // Renovar el lease del submitting: el cron no debe reclamar mientras exchange.order está en
    // vuelo (≤ HL_ORDER_TIMEOUT_MS). Renovar aquí cubre el envío con otros LEASE_MS.
    await ctx.db.patch(requestId, { updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const getRequestInternal = internalQuery({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => await ctx.db.get(requestId),
});

// Observabilidad admin: últimas ejecuciones con quién/qué/dónde para diagnosticar fallos.
export const listRecentExecutions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 100 }) => {
    await requireAdmin(ctx);
    const clamped = Math.min(Math.max(limit, 1), 100);
    const rows = await ctx.db
      .query("execution_requests")
      .withIndex("by_created")
      .order("desc")
      .take(clamped);
    const out = [];
    for (const r of rows) {
      const [user, bot, cred] = await Promise.all([
        ctx.db.get(r.userId), ctx.db.get(r.botId), ctx.db.get(r.hlAccountId),
      ]);
      out.push({
        requestId: r._id, status: r.status, error: r.error ?? null,
        userId: r.userId, email: user?.email ?? null,
        botId: r.botId, botName: bot?.name ?? null,
        hlAccountId: r.hlAccountId, account: cred?.label ?? null,
        accountAddress: cred?.tradingAccountAddress ?? null, network: r.network,
        asset: r.asset, side: r.side, notional: r.notional,
        filledSize: r.filledSize ?? null, entryPrice: r.entryPrice ?? null,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      });
    }
    return out;
  },
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
