import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, requireBotManager, requireTradeLive, getUserOrNull, writeAdminLog, hasPermission } from "./helpers";
import { elog } from "./log";
import { toHlCloid, spotGridCloidInput } from "./cloids";   // (JAV-92) cloid determinista (helper hoja, no-node)
import { hlNetwork } from "./hlNetwork";   // (JAV-92) red efectiva del backend (fuente de verdad)

// (QSG / JAV-91) Spot Grid Live — persistencia + comandos backend. NON-node (convex-testable). NO envía
// órdenes a HL (eso es el motor de PR3). La resolución de activo/precio/balance vía RPC vive en la
// action `createSpotGridBot` (convex/spotGridActions.ts, "use node"), que PRIMERO corre el preflight
// (guards de DB, antes de tocar HL) y luego delega el persistido (re-valida todo, atómico con el insert).

const MAINNET_GATE_KEY = "mainnetSpotGridApproved";
// Espejo NON-node de la constante de hyperliquidSpot.ts (no se puede importar de un módulo "use node"
// sin contaminar este archivo). HL rechaza órdenes spot por debajo de ~$10.
const MIN_SPOT_NOTIONAL_USD = 10;

type GridInputs = {
  minPrice: number; gridProfitPercent: number; investmentAmount: number;
  orderSize: number; gridCount: number; feeRate: number;
};

// Validación PURA de parámetros del grid (sin red, sin balance). Reusada por preflight y persist.
// (Codex ALTO) El presupuesto total del grid = orderSize × gridCount NO puede superar investmentAmount.
// (Codex MEDIO) orderSize no puede caer bajo el mínimo notional de HL (~$10).
function validateGridInputs(a: GridInputs): void {
  for (const [k, val] of [["minPrice", a.minPrice], ["gridProfitPercent", a.gridProfitPercent],
    ["investmentAmount", a.investmentAmount], ["orderSize", a.orderSize]] as const) {
    if (!(val > 0)) throw new Error(`Parámetro inválido: ${k} debe ser > 0.`);
  }
  if (!(Number.isInteger(a.gridCount) && a.gridCount >= 1)) throw new Error("gridCount debe ser entero ≥ 1.");
  if (a.feeRate < 0) throw new Error("feeRate no puede ser negativo.");
  if (a.orderSize < MIN_SPOT_NOTIONAL_USD) {
    throw new Error(`orderSize ${a.orderSize} < mínimo notional de HL (${MIN_SPOT_NOTIONAL_USD} USDC).`);
  }
  if (a.orderSize * a.gridCount > a.investmentAmount) {
    throw new Error(`Presupuesto del grid (orderSize×gridCount = ${a.orderSize * a.gridCount}) supera investmentAmount (${a.investmentAmount}).`);
  }
}

async function getConfigBool(ctx: QueryCtx | MutationCtx, key: string): Promise<boolean> {
  const row = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", key)).first();
  return row?.value === true;
}

// Guards de DB compartidos por preflight (query, ANTES de la RPC) y persist (mutation, atómico con el
// insert): permisos (canManageBots + canTradeLive AMBOS), switches live-only, gate mainnet, ownership y
// exclusividad TOTAL de cuenta. Devuelve el user (manager) y la credencial. Funciona en Query y Mutation.
async function assertCreateGuards(
  ctx: QueryCtx | MutationCtx, hlAccountId: Id<"hl_api_credentials">, network: "mainnet" | "testnet",
) {
  // Crear infraestructura de bots = permiso de GESTIÓN; operar real = canTradeLive. AMBOS requeridos.
  const manager = await requireBotManager(ctx);
  await requireTradeLive(ctx);
  if (!(await getConfigBool(ctx, "tradingEnabled"))) throw new Error("Trading global deshabilitado (kill switch).");
  if (await getConfigBool(ctx, "simulationMode")) throw new Error("Modo simulación global activo: Spot Grid es live-only.");
  if (network === "mainnet") {
    const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    if ((gate?.value as any)?.enabled !== true) throw new Error("Spot Grid en mainnet no aprobado por admin.");
  }
  const cred = await ctx.db.get(hlAccountId);
  if (!cred || cred.userId !== manager._id) throw new Error("Cuenta HL no encontrada o ajena.");
  // 🔑 Exclusividad TOTAL de cuenta (JAV-89/JAV-91): tradingAccountAddress (1:1 con la credencial,
  // unicidad global) NO la puede usar ningún bot IL/Trading ni otro spot grid vivo. En HL spot y perp
  // viven en la MISMA wallet → compartir cuenta mezclaría órdenes/balance.
  const perpBot = await ctx.db.query("bots")
    .withIndex("by_user_account", (q) => q.eq("userId", cred.userId).eq("hlAccountId", hlAccountId)).first();
  if (perpBot) throw new Error("Esa cuenta HL ya la usa un bot de cobertura/trading: usa una cuenta dedicada.");
  const otherGrid = (await ctx.db.query("spot_grid_bots")
    .withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId)).collect())
    .find((b) => b.status !== "stopped");
  if (otherGrid) throw new Error("Esa cuenta HL ya la usa otro Spot Grid activo: usa una cuenta dedicada.");
  return { manager, cred };
}

// --- Gate mainnet: aprobación admin sellada (Codex #2-r3) -----------------------------------------
export const setMainnetSpotGridApproval = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const admin = await requireAdmin(ctx);
    const existing = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    const value = { enabled, approvedAt: Date.now(), approvedBy: admin.clerkId };
    if (existing) await ctx.db.patch(existing._id, { value });
    else await ctx.db.insert("system_config", { key: MAINNET_GATE_KEY, value });
    await writeAdminLog(ctx, admin.clerkId, "set_mainnet_spot_grid_approval", { enabled });
    return { ok: true as const };
  },
});

// --- Preflight (Codex MEDIO #2): valida TODO lo que NO necesita HL (permisos, switches, gate, ownership,
// exclusividad, inputs) ANTES de cualquier RPC. La action lo corre primero; si falla, nunca toca HL.
// Devuelve la tradingAccountAddress para las lecturas públicas.
export const preflightCreateSpotGridBot = internalQuery({
  args: {
    hlAccountId: v.id("hl_api_credentials"),
    network: v.union(v.literal("mainnet"), v.literal("testnet")),
    minPrice: v.number(), gridProfitPercent: v.number(), investmentAmount: v.number(),
    orderSize: v.number(), gridCount: v.number(), feeRate: v.number(),
  },
  handler: async (ctx, a) => {
    const { cred } = await assertCreateGuards(ctx, a.hlAccountId, a.network);
    validateGridInputs(a);
    return { tradingAccountAddress: cred.tradingAccountAddress };
  },
});

// --- Persistir el bot: re-valida TODOS los guards + inputs + balance, atómico con el insert ---------
export const persistSpotGridBot = internalMutation({
  args: {
    hlAccountId: v.id("hl_api_credentials"),
    symbol: v.string(), assetId: v.number(), baseAsset: v.string(), quoteAsset: v.string(),
    minPrice: v.number(), gridProfitPercent: v.number(), investmentAmount: v.number(),
    orderSize: v.number(), gridCount: v.number(), feeRate: v.number(),
    currentPrice: v.number(), freeQuoteBalance: v.number(),
    network: v.union(v.literal("mainnet"), v.literal("testnet")),
  },
  handler: async (ctx, a) => {
    const { manager } = await assertCreateGuards(ctx, a.hlAccountId, a.network);
    validateGridInputs(a);
    if (!(a.currentPrice > 0)) throw new Error("Parámetro inválido: currentPrice debe ser > 0.");
    if (a.freeQuoteBalance < a.investmentAmount) {
      throw new Error(`Balance ${a.quoteAsset} insuficiente: ${a.freeQuoteBalance} < ${a.investmentAmount}.`);
    }
    const now = Date.now();
    const botId = await ctx.db.insert("spot_grid_bots", {
      userId: manager._id, hlAccountId: a.hlAccountId, symbol: a.symbol, assetId: a.assetId,
      baseAsset: a.baseAsset, quoteAsset: a.quoteAsset, minPrice: a.minPrice,
      gridProfitPercent: a.gridProfitPercent, investmentAmount: a.investmentAmount, orderSize: a.orderSize,
      gridCount: a.gridCount, feeRate: a.feeRate, currentPrice: a.currentPrice,
      status: "running", network: a.network, generation: 1,
      createdAt: now, updatedAt: now,
    });
    elog("spotgrid", "bot_created", { botId: String(botId), gridCount: a.gridCount });
    return { ok: true as const, botId };
  },
});

// --- Pausa (NO toca HL; el motor de PR3 deja de colocar) -------------------------------------------
export const pauseSpotGridBot = mutation({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) throw new Error("Bot no encontrado o ajeno.");
    if (bot.status === "stopped") throw new Error("El bot ya está detenido.");
    await ctx.db.patch(botId, { status: "paused", updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// --- Lecturas por-usuario --------------------------------------------------------------------------
export const listSpotGridBots = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUserOrNull(ctx);             // (JAV-82) tolera el race del primer login
    if (!user) return [];
    return await ctx.db.query("spot_grid_bots").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
  },
});

export const getSpotGridBot = query({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const user = await getUserOrNull(ctx);
    if (!user) return null;
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) return null;
    return bot;
  },
});

// --- Internal query para el motor (PR3) ------------------------------------------------------------
export const getSpotGridBotInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => ctx.db.get(botId),
});

// =================================================================================================
// (JAV-92) Motor Live — mutations/queries internas. NON-node (convex-testable). Bajo lease/CAS (fencing
// por token, igual que trigger_arms). El motor (spotGridEngine.ts, "use node") las invoca por runMutation.
// =================================================================================================

const SPOT_GRID_LEASE_MS = 90_000;   // ventana del lease del reconcile (cubre la ronda de RPC del bot)

function leaseOk(bot: any, token: string): boolean {
  return !!bot && bot.reconcileLeaseToken === token && (bot.reconcileLeaseUntil ?? 0) > Date.now();
}

// Claima el lease de reconcile si está libre/vencido y el bot está activo (running|paused). NO stopped.
export const claimSpotGridReconcile = internalMutation({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return { ok: false as const };
    if (bot.status !== "running" && bot.status !== "paused") return { ok: false as const };
    if (bot.reconcileLeaseToken && (bot.reconcileLeaseUntil ?? 0) > Date.now()) return { ok: false as const };
    const token = crypto.randomUUID();
    await ctx.db.patch(botId, { reconcileLeaseToken: token, reconcileLeaseUntil: Date.now() + SPOT_GRID_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const, token };
  },
});

export const renewSpotGridReconcile = internalMutation({
  args: { botId: v.id("spot_grid_bots"), token: v.string() },
  handler: async (ctx, { botId, token }) => {
    const bot = await ctx.db.get(botId);
    if (!leaseOk(bot, token)) return { ok: false as const };
    await ctx.db.patch(botId, { reconcileLeaseUntil: Date.now() + SPOT_GRID_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const releaseSpotGridReconcile = internalMutation({
  args: { botId: v.id("spot_grid_bots"), token: v.string() },
  handler: async (ctx, { botId, token }) => {
    const bot = await ctx.db.get(botId);
    if (!leaseOk(bot, token)) return { ok: false as const };
    await ctx.db.patch(botId, { reconcileLeaseToken: undefined, reconcileLeaseUntil: 0, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Registra una orden como `submitting` (intent en DB ANTES de enviar a HL, ALTO#1). Lookup-before-insert
// por `by_cloid` (idempotente: si ya existe, no duplica). Computa el cloid determinista (cloids.ts, no-node).
export const recordSpotGridOrder = internalMutation({
  args: {
    botId: v.id("spot_grid_bots"), token: v.string(),
    side: v.union(v.literal("buy"), v.literal("sell")),
    gridLevel: v.number(), generation: v.number(), cycleId: v.number(),
    assetId: v.number(), price: v.number(), quantity: v.number(), quoteSize: v.number(),
    pairedOrderId: v.optional(v.id("spot_grid_orders")), tranche: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const bot = await ctx.db.get(a.botId);
    if (!leaseOk(bot, a.token)) return { ok: false as const };
    const cloid = await toHlCloid(spotGridCloidInput(String(a.botId), a.generation, a.cycleId, a.gridLevel, a.side, a.tranche ?? 0));
    const existing = await ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", cloid)).first();
    if (existing) return { ok: true as const, orderId: existing._id, cloid, existed: true as const };
    const now = Date.now();
    const orderId = await ctx.db.insert("spot_grid_orders", {
      botId: a.botId, userId: bot!.userId, cloid, assetId: a.assetId, side: a.side,
      price: a.price, quantity: a.quantity, quoteSize: a.quoteSize, gridLevel: a.gridLevel,
      generation: a.generation, cycleId: a.cycleId, status: "submitting",
      remainingQty: a.quantity, attempt: 1, submittedAt: now,
      ...(a.pairedOrderId ? { pairedOrderId: a.pairedOrderId } : {}),
      createdAt: now,
    });
    return { ok: true as const, orderId, cloid, existed: false as const };
  },
});

// Actualiza el estado observado de una orden (submitting→open/failed, fills, cancel). Por cloid, del bot.
export const markSpotGridOrder = internalMutation({
  args: {
    botId: v.id("spot_grid_bots"), token: v.string(), cloid: v.string(),
    status: v.optional(v.union(
      v.literal("submitting"), v.literal("open"), v.literal("partially_filled"), v.literal("filled"),
      v.literal("cancelled"), v.literal("failed"))),
    oid: v.optional(v.string()), filledQty: v.optional(v.number()), remainingQty: v.optional(v.number()),
    avgFillPx: v.optional(v.number()), pendingSellQty: v.optional(v.number()), sellTranche: v.optional(v.number()),
    incAttempt: v.optional(v.boolean()), errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const bot = await ctx.db.get(a.botId);
    if (!leaseOk(bot, a.token)) return { ok: false as const };
    const o = await ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", a.cloid)).first();
    if (!o || o.botId !== a.botId) return { ok: false as const };
    const now = Date.now();
    const patch: Record<string, unknown> = { };
    for (const k of ["oid", "filledQty", "remainingQty", "avgFillPx", "pendingSellQty", "sellTranche", "errorMessage"] as const) {
      if (a[k] !== undefined) patch[k] = a[k];
    }
    if (a.status !== undefined) {
      patch.status = a.status;
      if (a.status === "filled") patch.filledAt = now;
      if (a.status === "cancelled" || a.status === "failed") patch.cancelledAt = now;
      if (a.status === "submitting") patch.submittedAt = now;
    }
    if (a.incAttempt) patch.attempt = (o.attempt ?? 1) + 1;
    await ctx.db.patch(o._id, patch);
    return { ok: true as const };
  },
});

export const setSpotGridStatus = internalMutation({
  args: {
    botId: v.id("spot_grid_bots"), token: v.string(),
    status: v.union(v.literal("running"), v.literal("paused"), v.literal("stopped"), v.literal("error")),
    errorMessage: v.optional(v.string()), clearLease: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const bot = await ctx.db.get(a.botId);
    if (!leaseOk(bot, a.token)) return { ok: false as const };
    const patch: Record<string, unknown> = { status: a.status, updatedAt: Date.now() };
    if (a.errorMessage !== undefined) patch.errorMessage = a.errorMessage;
    if (a.clearLease || a.status === "stopped") { patch.reconcileLeaseToken = undefined; patch.reconcileLeaseUntil = 0; }
    await ctx.db.patch(a.botId, patch);
    return { ok: true as const };
  },
});

export const setSpotGridFillCursor = internalMutation({
  args: { botId: v.id("spot_grid_bots"), token: v.string(), fillCursor: v.number() },
  handler: async (ctx, { botId, token, fillCursor }) => {
    const bot = await ctx.db.get(botId);
    if (!leaseOk(bot, token)) return { ok: false as const };
    await ctx.db.patch(botId, { fillCursor, lastReconciledAt: Date.now(), updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// (Codex #4-r2 + ALTO#3) Cierra un ciclo (SELL llenada) y repone la BUY del nivel, ATÓMICO e IDEMPOTENTE.
// Idempotencia por orden: si la SELL ya tiene `cycleSettled`, no-op (no cierra dos ciclos ni crea dos BUYs).
export const closeCycleAndRepost = internalMutation({
  args: { botId: v.id("spot_grid_bots"), token: v.string(), sellCloid: v.string(), feesUsd: v.number() },
  handler: async (ctx, { botId, token, sellCloid, feesUsd }) => {
    const bot = await ctx.db.get(botId);
    if (!leaseOk(bot, token)) return { ok: false as const };
    const sell = await ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", sellCloid)).first();
    if (!sell || sell.botId !== botId || sell.side !== "sell") return { ok: false as const };
    if (sell.cycleSettled === true) return { ok: true as const, alreadySettled: true as const };  // idempotencia
    const buy = sell.pairedOrderId ? await ctx.db.get(sell.pairedOrderId) : null;
    // (Codex MEDIO#3) netProfit con el COSTO REAL: VWAP de compra (avgFillPx) y de venta (avgFillPx).
    const buyCost = (buy && buy.avgFillPx) ? buy.avgFillPx : (buy?.price ?? sell.price);
    const qty = sell.filledQty ?? sell.quantity;
    const sellPrice = sell.avgFillPx ?? sell.price;
    const gross = (sellPrice - buyCost) * qty;
    const net = gross - feesUsd;
    const repostLimit = buy?.price ?? buyCost;                  // la reposición usa el LÍMITE del nivel, no el VWAP
    const now = Date.now();
    // (a) marcar la SELL consumida + (b) incrementar cycleSeq + (c) insertar ciclo + (e) reponer BUY.
    await ctx.db.patch(sell._id, { cycleSettled: true, status: "filled", filledAt: sell.filledAt ?? now });
    const newCycle = (bot!.cycleSeq ?? 0) + 1;
    await ctx.db.patch(botId, { cycleSeq: newCycle, updatedAt: now });
    await ctx.db.insert("spot_grid_cycles", {
      botId, userId: bot!.userId, cycleId: sell.cycleId,
      buyOrderId: (buy?._id ?? sell._id) as Id<"spot_grid_orders">,
      sellOrderId: sell._id, buyPrice: buyCost, sellPrice, quantity: qty,
      grossProfit: gross, fees: feesUsd, netProfit: net, closedAt: now,
    });
    // BUY de reposición al MISMO nivel y al precio LÍMITE del nivel (no el VWAP), nuevo cycleId → cloid nuevo.
    // Cantidad = la REALMENTE vendida en esta SELL (puede ser un tranche parcial del BUY) → re-compra justo
    // lo vendido, sin sobre-reponer (Codex r2#2).
    const repostQuantity = qty;
    const cloid = await toHlCloid(spotGridCloidInput(String(botId), bot!.generation, newCycle, sell.gridLevel, "buy"));
    const existing = await ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", cloid)).first();
    let repostOrderId = existing?._id;
    if (!existing) {
      repostOrderId = await ctx.db.insert("spot_grid_orders", {
        botId, userId: bot!.userId, cloid, assetId: sell.assetId, side: "buy",
        price: repostLimit, quantity: repostQuantity, quoteSize: repostLimit * repostQuantity,
        gridLevel: sell.gridLevel, generation: bot!.generation, cycleId: newCycle, status: "submitting",
        remainingQty: repostQuantity, attempt: 1, submittedAt: now, createdAt: now,
      });
    }
    elog("spotgrid", "cycle_closed", { botId: String(botId), cycleId: sell.cycleId, net: Math.round(net * 100) / 100 });
    return {
      ok: true as const, repostOrderId, repostCloid: cloid, repostPrice: repostLimit,
      repostQuantity, repostAssetId: sell.assetId, newCycle, netProfit: net,
    };
  },
});

// Internal queries para el motor.
export const listActiveSpotGridBotsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const running = await ctx.db.query("spot_grid_bots").withIndex("by_status_updated", (q) => q.eq("status", "running")).collect();
    const paused = await ctx.db.query("spot_grid_bots").withIndex("by_status_updated", (q) => q.eq("status", "paused")).collect();
    return [...running, ...paused];   // reconcilia activos (paused registra fills pero no repone)
  },
});

export const getSpotGridOrdersInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    // Solo las NO terminales (open/submitting/partially_filled) + las filled sin consumir → trabajo del reconcile.
    const all = await ctx.db.query("spot_grid_orders").withIndex("by_bot_status", (q) => q.eq("botId", botId)).collect();
    return all.filter((o) => o.status === "submitting" || o.status === "open" || o.status === "partially_filled"
      || (o.status === "filled" && o.side === "sell" && o.cycleSettled !== true)
      || (o.status === "filled" && o.side === "buy"));
  },
});

// (Codex ALTO#2) Gate live REVALIDADO en cada reconcile: tradingEnabled + !simulationMode + el dueño SIGUE
// con canTradeLive + (mainnet) mainnetSpotGridApproved. Devuelve {ok, reason} y la política sugerida.
export const assertSpotGridLiveAdmissibleInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return { ok: false as const, reason: "bot_not_found", policy: "error" as const };
    if (!(await getConfigBool(ctx, "tradingEnabled"))) return { ok: false as const, reason: "trading_disabled", policy: "paused" as const };
    if (await getConfigBool(ctx, "simulationMode")) return { ok: false as const, reason: "simulation_mode", policy: "paused" as const };
    const user = await ctx.db.get(bot.userId);
    if (!user) return { ok: false as const, reason: "owner_not_found", policy: "error" as const };
    if (!(await hasPermission(ctx, user, "canTradeLive"))) return { ok: false as const, reason: "no_can_trade_live", policy: "paused" as const };
    // (Codex ALTO#4) La red efectiva del backend DEBE coincidir con la del bot (un deploy pudo cambiar
    // HL_NETWORK). Si no, NO operar (se firmaría/leería en la red equivocada) → pausar.
    let net: string; try { net = hlNetwork(); } catch { return { ok: false as const, reason: "hl_network_unset", policy: "error" as const }; }
    if (net !== bot.network) return { ok: false as const, reason: "network_mismatch", policy: "paused" as const };
    if (bot.network === "mainnet") {
      const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
      if ((gate?.value as any)?.enabled !== true) return { ok: false as const, reason: "mainnet_not_approved", policy: "paused" as const };
    }
    return { ok: true as const, reason: "ok", policy: "running" as const };
  },
});

// (JAV-92) Guard de `stopSpotGridBot` (la action no puede usar requireBotManager directo: no tiene db).
// La auth se propaga al runQuery desde la action. Exige canManageBots + canTradeLive + ownership del bot.
export const assertCanStopSpotGridInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const user = await requireBotManager(ctx);
    await requireTradeLive(ctx);
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) throw new Error("Bot no encontrado o ajeno.");
    return { ok: true as const };
  },
});

// Credencial cifrada del bot (solo para descifrar en la action node; nunca se expone a otros contextos).
export const getSpotGridCredentialInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return null;
    const cred = await ctx.db.get(bot.hlAccountId);
    if (!cred) return null;
    return { credential: cred, network: bot.network, userId: bot.userId };
  },
});
