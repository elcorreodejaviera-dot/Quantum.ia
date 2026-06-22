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
// Espejo NON-node de ABS_MAX_GRID_LEVELS de spotGridEngine.ts ("use node", no importable aquí sin contaminar):
// tope duro de niveles. (CodeRabbit Major) También en MANUAL, para que un payload no persista más órdenes de
// las que el motor coloca y el detalle/UI muestran (mismo límite que aplica el AUTO).
const ABS_MAX_GRID_LEVELS = 50;

type GridInputs = {
  minPrice: number; gridProfitPercent: number; investmentAmount: number;
  orderSize: number; gridCount: number; feeRate: number;
};

type BaseGridInputs = { minPrice: number; gridProfitPercent: number; investmentAmount: number; feeRate: number };

// (JAV-101) Validación de los inputs base que NO dependen del nº de niveles. La usa el preflight en modo
// AUTO (donde gridCount/orderSize aún no existen — se derivan tras leer el precio spot) y la reusa
// validateGridInputs (modo manual / persist). gridProfitPercent acotado a [0.5, 10] (mismo rango que el
// form y que deriveAutoGrid); feeRate finito ≥ 0.
function validateBaseGridInputs(a: BaseGridInputs): void {
  for (const [k, val] of [["minPrice", a.minPrice], ["investmentAmount", a.investmentAmount]] as const) {
    if (!Number.isFinite(val) || !(val > 0)) throw new Error(`Parámetro inválido: ${k} debe ser finito > 0.`);
  }
  if (!Number.isFinite(a.gridProfitPercent) || !(a.gridProfitPercent >= 0.5 && a.gridProfitPercent <= 10)) {
    throw new Error("gridProfitPercent debe estar entre 0.5 y 10.");
  }
  if (!Number.isFinite(a.feeRate) || a.feeRate < 0) throw new Error("feeRate no puede ser negativo.");
}

// Validación PURA completa de parámetros del grid (sin red, sin balance). Reusada por preflight (manual) y
// persist. (Codex ALTO) presupuesto orderSize×gridCount ≤ investmentAmount. (Codex MEDIO) orderSize ≥ min
// notional de HL (~$10). (JAV-101) El budget-check se hace en CENTAVOS con redondeo CONSERVADOR (ceil) para
// no falso-aceptar un orderSize manual con >2 decimales (p.ej. 10.004×3 > 30.00) ni falso-rechazar por ULP.
function validateGridInputs(a: GridInputs): void {
  validateBaseGridInputs(a);
  if (!Number.isFinite(a.orderSize) || !(a.orderSize > 0)) throw new Error("Parámetro inválido: orderSize debe ser finito > 0.");
  if (!(Number.isInteger(a.gridCount) && a.gridCount >= 1 && a.gridCount <= ABS_MAX_GRID_LEVELS)) {
    throw new Error(`gridCount debe ser entero entre 1 y ${ABS_MAX_GRID_LEVELS}.`);
  }
  if (a.orderSize < MIN_SPOT_NOTIONAL_USD) {
    throw new Error(`orderSize ${a.orderSize} < mínimo notional de HL (${MIN_SPOT_NOTIONAL_USD} USDC).`);
  }
  // (JAV-101 / Codex) Canonicalización: orderSize debe ser un nº exacto de centavos (≤2 decimales). El AUTO
  // ya lo garantiza (floorQuoteForBudget); en MANUAL rechazamos un tamaño "fantasma" con >2 decimales
  // (p.ej. 10.004) para no persistir ni operar con centavos que no existen.
  if (Math.abs(a.orderSize * 100 - Math.round(a.orderSize * 100)) > 1e-9) {
    throw new Error("orderSize: máximo 2 decimales (centavos).");
  }
  const invCents = Math.floor(a.investmentAmount * 100 + 1e-6);
  const orderCents = Math.ceil(a.orderSize * 100 - 1e-6);
  if (orderCents * a.gridCount > invCents) {
    throw new Error(`Presupuesto del grid (orderSize×gridCount) supera investmentAmount (${a.investmentAmount}).`);
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
  if (perpBot) throw new Error("Esta cuenta ya la usa un bot de cobertura/trading. El Spot Grid necesita una cuenta dedicada.");
  const otherGrid = (await ctx.db.query("spot_grid_bots")
    .withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId)).collect())
    .find((b) => b.status !== "stopped");
  if (otherGrid) throw new Error("Esta cuenta ya está vinculada a un Spot Grid. Para abrir otro grid, vinculá otra cuenta.");
  return { manager, cred };
}

// --- Gate mainnet: aprobación admin sellada (Codex #2-r3) -----------------------------------------
// Lectura admin del gate de mainnet (para que el Panel de Admin muestre ON/OFF).
// Solo admin; devuelve el value del gate o null si nunca se fijó.
export const getMainnetSpotGridApproval = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    return (gate?.value as { enabled?: boolean; approvedAt?: number; approvedBy?: string } | undefined) ?? null;
  },
});

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
    feeRate: v.number(),
    // (JAV-101) En modo AUTO el nº de niveles se deriva tras leer el precio spot → gridCount/orderSize
    // aún no existen aquí. En modo manual sí se envían y se validan completos antes de tocar HL.
    auto: v.optional(v.boolean()),
    orderSize: v.optional(v.number()), gridCount: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const { cred } = await assertCreateGuards(ctx, a.hlAccountId, a.network);
    if (a.auto) {
      validateBaseGridInputs(a);   // sin count: el resto se valida en persist tras derivar
    } else {
      if (a.orderSize === undefined || a.gridCount === undefined) {
        throw new Error("Modo manual requiere orderSize y gridCount.");
      }
      validateGridInputs({ ...a, orderSize: a.orderSize, gridCount: a.gridCount });
    }
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
    autoDerived: v.optional(v.boolean()),   // (JAV-101) gridCount/orderSize derivados del rango → ancla a currentPrice
    network: v.union(v.literal("mainnet"), v.literal("testnet")),
    // (JAV-103) Grid SEEDED: arranca por fases (compra semilla → SELLs → BUYs). `gridCount` aquí = M (niveles
    // de COMPRA); las K SELLs se derivan en el bootstrap (deriveSeededGrid sobre los mismos parámetros).
    seeded: v.optional(v.boolean()), seedPercent: v.optional(v.number()),
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
      autoDerived: a.autoDerived === true,
      status: "running", network: a.network, generation: 1,
      // (JAV-103) seeded → máquina de fases del bootstrap; no-seeded (manual/legacy) deja ambos ausentes
      // → camino de colocación inicial actual.
      ...(a.seeded ? { bootstrapPhase: "seed" as const, seedStatus: "pending" as const, seedPercent: a.seedPercent } : {}),
      createdAt: now, updatedAt: now,
    });
    elog("spotgrid", "bot_created", { botId: String(botId), gridCount: a.gridCount, seeded: a.seeded === true });
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

// Elimina un grid DETENIDO (limpieza UI). Solo el dueño; SOLO si status==="stopped"
// (detener ya canceló las órdenes vivas en HL). Borra en cascada órdenes y ciclos del bot.
// NO toca HL (no money-path): solo limpia filas de un bot ya parado.
export const deleteSpotGridBot = mutation({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) throw new Error("Bot no encontrado o ajeno.");
    if (bot.status !== "stopped") throw new Error("Solo se puede eliminar un grid detenido. Deténlo primero.");
    const orders = await ctx.db.query("spot_grid_orders").withIndex("by_bot_status", (q) => q.eq("botId", botId)).collect();
    for (const o of orders) await ctx.db.delete(o._id);
    const cycles = await ctx.db.query("spot_grid_cycles").withIndex("by_bot", (q) => q.eq("botId", botId)).collect();
    for (const c of cycles) await ctx.db.delete(c._id);
    await ctx.db.delete(botId);
    await writeAdminLog(ctx, user.clerkId, "delete_spot_grid_bot", { botId: String(botId), orders: orders.length, cycles: cycles.length });
    return { ok: true as const, orders: orders.length, cycles: cycles.length };
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

// (JAV-93) Detalle + stats de un grid para la UI. READ-ONLY, scoped por ownership. Solo escalares:
// nunca expone la credencial ni la clave. Topes explícitos para que el coste de lectura sea acotado;
// si se topa el cap se marca `truncated` para que la UI NO muestre un total parcial como exacto.
export const SPOT_GRID_DETAIL_CYCLE_CAP = 500;   // tope de ciclos sumados/contados por lectura (exportado: tests de borde)
const SPOT_GRID_DETAIL_OPEN_CAP = 50;     // tope de órdenes abiertas devueltas
const SPOT_GRID_DETAIL_RECENT_CYCLES = 20;// ciclos recientes devueltos al detalle

export const getSpotGridDetail = query({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const user = await getUserOrNull(ctx);
    if (!user) return null;
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) return null;

    // Ciclos: leemos cap+1 para distinguir "exactamente cap" de "cap+" (Codex BAJO#2); solo se cuentan/
    // suman hasta `cap` y se marca `truncated` únicamente cuando hay MÁS que el cap.
    const fetched = await ctx.db
      .query("spot_grid_cycles")
      .withIndex("by_bot_cycle", (q) => q.eq("botId", botId))
      .order("desc")
      .take(SPOT_GRID_DETAIL_CYCLE_CAP + 1);
    const truncated = fetched.length > SPOT_GRID_DETAIL_CYCLE_CAP;
    const capped = truncated ? fetched.slice(0, SPOT_GRID_DETAIL_CYCLE_CAP) : fetched;
    const cyclesCount = capped.length;
    const totalNetProfit = capped.reduce((s, c) => s + (c.netProfit ?? 0), 0);
    const recentCycles = capped.slice(0, SPOT_GRID_DETAIL_RECENT_CYCLES).map((c) => ({
      cycleId: c.cycleId, sellOrderId: c.sellOrderId ?? null, buyPrice: c.buyPrice, sellPrice: c.sellPrice ?? null,
      quantity: c.quantity, netProfit: c.netProfit ?? null, closedAt: c.closedAt ?? null,
    }));

    // Órdenes vivas (submitting/open/partially_filled). Acumulamos hasta cap+1 para SABER si hay más que
    // el tope (openOrdersTruncated) en vez de adivinar por "== cap"; luego devolvemos solo hasta cap.
    const liveStatuses = ["submitting", "open", "partially_filled"] as const;
    const collected: Array<any> = [];
    for (const st of liveStatuses) {
      if (collected.length > SPOT_GRID_DETAIL_OPEN_CAP) break;
      const rows = await ctx.db
        .query("spot_grid_orders")
        .withIndex("by_bot_status", (q) => q.eq("botId", botId).eq("status", st))
        .take(SPOT_GRID_DETAIL_OPEN_CAP + 1 - collected.length);
      for (const o of rows) {
        collected.push({
          side: o.side, price: o.price, quantity: o.quantity, status: o.status,
          gridLevel: o.gridLevel, filledQty: o.filledQty ?? null, cycleId: o.cycleId,
        });
      }
    }
    const openOrdersTruncated = collected.length > SPOT_GRID_DETAIL_OPEN_CAP;
    const openOrders = openOrdersTruncated ? collected.slice(0, SPOT_GRID_DETAIL_OPEN_CAP) : collected;

    // (JAV-103, §7) Contabilidad realizado + flotante + total, método ÚNICO de promedio ponderado:
    // inventario en mano = base comprada (BUYs grid + semilla, filled/partial) − base ya vendida en ciclos.
    // Coste = Σ(filledQty·avgFillPx + filledFeeUsd) de compras − Σ(cycle.buyPrice·cycle.quantity) de ventas
    // (la ganancia de esas ventas ya está en realizedNetProfit → restar al coste evita doble-conteo).
    // ⚠️ (Codex código r1, BAJO#4) Es una APROXIMACIÓN de DISPLAY (promedio ponderado simple, no FIFO/temporal
    // exacto): el flotante orienta la comparación con BingX, NO es un ledger financiero contable. Lectura
    // ACOTADA: si se topa, `accountingTruncated`.
    let boughtQty = 0, boughtCost = 0, acctTrunc = truncated;
    // (CodeRabbit JAV-103, Major) Restar la base ya LIQUIDADA (kind="liquidation"): no se vuelve ciclo, así
    // que sin esto el inventario contable quedaría inflado tras un Stop+liquidar.
    let liquidatedQty = 0, liquidatedCost = 0;
    for (const st of ["filled", "partially_filled"] as const) {
      const rows = await ctx.db.query("spot_grid_orders")
        .withIndex("by_bot_status", (q) => q.eq("botId", botId).eq("status", st))
        .take(SPOT_GRID_DETAIL_CYCLE_CAP + 1);
      if (rows.length > SPOT_GRID_DETAIL_CYCLE_CAP) acctTrunc = true;
      for (const o of rows.slice(0, SPOT_GRID_DETAIL_CYCLE_CAP)) {
        if (o.side === "buy") {
          const q = o.filledQty ?? 0;
          boughtQty += q;
          boughtCost += q * (o.avgFillPx ?? o.price) + (o.filledFeeUsd ?? 0);
        } else if (o.side === "sell" && o.kind === "liquidation") {
          const q = o.filledQty ?? 0;
          liquidatedQty += q;
          liquidatedCost += q * (o.costBasis ?? bot.seedAvgPx ?? o.avgFillPx ?? o.price);
        }
      }
    }
    const soldQty = capped.reduce((s, c) => s + (c.quantity ?? 0), 0) + liquidatedQty;
    const soldCost = capped.reduce((s, c) => s + (c.buyPrice ?? 0) * (c.quantity ?? 0), 0) + liquidatedCost;
    const heldQty = Math.max(0, boughtQty - soldQty);
    const heldCostUsd = Math.max(0, boughtCost - soldCost);
    const heldAvgCost = heldQty > 1e-12 ? heldCostUsd / heldQty : 0;
    // (JAV-104) Mark-to-market con el precio VIVO (`lastPrice`); `currentPrice` (ancla de creación) solo
    // como fallback legacy. `priceStale` mide la frescura REAL del precio (`lastPriceAt`), no el tiempo
    // desde el último fill (que solo movía `lastReconciledAt`).
    const refPrice = bot.lastPrice ?? bot.currentPrice ?? null;
    const STALE_MS = 5 * 60 * 1000;
    const priceStale = !bot.lastPriceAt || Date.now() - bot.lastPriceAt > STALE_MS;
    const floatingPnl = refPrice != null && heldQty > 1e-12 ? (refPrice - heldAvgCost) * heldQty : 0;
    const accounting = {
      realizedNetProfit: totalNetProfit,
      heldQty, heldAvgCost, heldCostUsd,
      floatingPnl, priceStale,
      totalEquityPnl: totalNetProfit + floatingPnl,
      seedPercent: bot.seedPercent ?? null, seedStatus: bot.seedStatus ?? null,
      accountingTruncated: acctTrunc,
    };

    return {
      bot: {
        _id: bot._id, symbol: bot.symbol, baseAsset: bot.baseAsset, quoteAsset: bot.quoteAsset,
        minPrice: bot.minPrice, gridProfitPercent: bot.gridProfitPercent,
        investmentAmount: bot.investmentAmount, orderSize: bot.orderSize, gridCount: bot.gridCount,
        status: bot.status, network: bot.network, currentPrice: bot.currentPrice ?? null,
        createdAt: bot.createdAt, lastReconciledAt: bot.lastReconciledAt ?? null,
        errorMessage: bot.errorMessage ?? null,   // (Codex BAJO#1) sin hlAccountId: la UI no lo usa
      },
      stats: { cyclesCount, totalNetProfit, truncated, cycleCap: SPOT_GRID_DETAIL_CYCLE_CAP },
      accounting,
      openOrders,
      openOrdersTruncated,
      recentCycles,
    };
  },
});

// --- Internal query para el motor (PR3) ------------------------------------------------------------
export const getSpotGridBotInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => ctx.db.get(botId),
});

// (JAV-103) Slippage máximo del LIMIT IOC de semilla/liquidación. Configurable en system_config; default
// 0.003 (0.3%). Acotado a un rango sano [0.0005, 0.02] para que un valor corrupto no autorice un slippage
// absurdo en el money-path.
export const getSeedMaxSlippageInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", "seedMaxSlippage")).first();
    const raw = Number((row?.value as any) ?? 0.003);
    const v = Number.isFinite(raw) ? raw : 0.003;
    return { seedMaxSlippage: Math.min(0.02, Math.max(0.0005, v)) };
  },
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

// (JAV-103, ALTO-N) Claim DEDICADO de stop/liquidación: admite además `error` (la semilla fail-closed o un
// stop incompleto dejan el bot en `error`; el usuario DEBE poder reintentar Stop+liquidar). Mantiene el
// MISMO fencing por token. SOLO se usa desde stopSpotGridBot; el claim del cron (arriba) NO admite `error`.
export const claimSpotGridReconcileForStop = internalMutation({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return { ok: false as const };
    if (bot.status !== "running" && bot.status !== "paused" && bot.status !== "error") return { ok: false as const };
    if (bot.reconcileLeaseToken && (bot.reconcileLeaseUntil ?? 0) > Date.now()) return { ok: false as const };
    const token = crypto.randomUUID();
    await ctx.db.patch(botId, { reconcileLeaseToken: token, reconcileLeaseUntil: Date.now() + SPOT_GRID_LEASE_MS, updatedAt: Date.now() });
    return { ok: true as const, token };
  },
});

// (JAV-103) Avanza la fase del bootstrap seeded y, opcionalmente, persiste el resultado de la semilla.
// Bajo lease. seedStatus="failed" → marca el bot en error (fail-closed) sin tocar la fase.
export const setSpotGridBootstrap = internalMutation({
  args: {
    botId: v.id("spot_grid_bots"), token: v.string(),
    bootstrapPhase: v.optional(v.union(v.literal("seed"), v.literal("sells"), v.literal("buys"), v.literal("done"))),
    seedStatus: v.optional(v.union(v.literal("pending"), v.literal("done"), v.literal("failed"))),
    seedQty: v.optional(v.number()), seedAvgPx: v.optional(v.number()), seedNotionalReal: v.optional(v.number()),
    seedPercent: v.optional(v.number()), liquidationSeq: v.optional(v.number()),
    status: v.optional(v.union(v.literal("running"), v.literal("paused"), v.literal("stopped"), v.literal("error"))),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const bot = await ctx.db.get(a.botId);
    if (!leaseOk(bot, a.token)) return { ok: false as const };
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const k of ["bootstrapPhase", "seedStatus", "seedQty", "seedAvgPx", "seedNotionalReal", "seedPercent", "liquidationSeq", "status", "errorMessage"] as const) {
      if (a[k] !== undefined) patch[k] = a[k];
    }
    await ctx.db.patch(a.botId, patch);
    return { ok: true as const };
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

// (JAV-104) Persiste el último precio spot VIVO observado en la ronda → base del mark-to-market del
// flotante en `getSpotGridDetail`. Bajo lease (un worker por bot). Rechaza precios no positivos.
export const setSpotGridLastPrice = internalMutation({
  args: { botId: v.id("spot_grid_bots"), token: v.string(), lastPrice: v.number() },
  handler: async (ctx, { botId, token, lastPrice }) => {
    const bot = await ctx.db.get(botId);
    if (!leaseOk(bot, token)) return { ok: false as const };
    if (!Number.isFinite(lastPrice) || !(lastPrice > 0)) return { ok: false as const };
    await ctx.db.patch(botId, { lastPrice, lastPriceAt: Date.now(), updatedAt: Date.now() });
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
    costBasis: v.optional(v.number()),
    // (JAV-103) rol para el namespace de cloid + precio de reposición pre-calculado de la SELL.
    kind: v.optional(v.union(v.literal("grid"), v.literal("seed"), v.literal("liquidation"))),
    repostBuyPrice: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const bot = await ctx.db.get(a.botId);
    if (!leaseOk(bot, a.token)) return { ok: false as const };
    const kind = a.kind ?? "grid";
    const cloid = await toHlCloid(spotGridCloidInput(String(a.botId), a.generation, a.cycleId, a.gridLevel, a.side, a.tranche ?? 0, kind));
    const existing = await ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", cloid)).first();
    if (existing) return { ok: true as const, orderId: existing._id, cloid, existed: true as const };
    const now = Date.now();
    const orderId = await ctx.db.insert("spot_grid_orders", {
      botId: a.botId, userId: bot!.userId, cloid, assetId: a.assetId, side: a.side,
      price: a.price, quantity: a.quantity, quoteSize: a.quoteSize, gridLevel: a.gridLevel,
      generation: a.generation, cycleId: a.cycleId, status: "submitting",
      remainingQty: a.quantity, attempt: 1, submittedAt: now, kind,
      ...(a.pairedOrderId ? { pairedOrderId: a.pairedOrderId } : {}),
      ...(a.costBasis !== undefined ? { costBasis: a.costBasis } : {}),
      ...(a.repostBuyPrice !== undefined ? { repostBuyPrice: a.repostBuyPrice } : {}),
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
    avgFillPx: v.optional(v.number()), pendingSellQty: v.optional(v.number()), pendingSellCost: v.optional(v.number()),
    filledFeeUsd: v.optional(v.number()), sellTranche: v.optional(v.number()),
    incAttempt: v.optional(v.boolean()), errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const bot = await ctx.db.get(a.botId);
    if (!leaseOk(bot, a.token)) return { ok: false as const };
    const o = await ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", a.cloid)).first();
    if (!o || o.botId !== a.botId) return { ok: false as const };
    const now = Date.now();
    const patch: Record<string, unknown> = { };
    for (const k of ["oid", "filledQty", "remainingQty", "avgFillPx", "pendingSellQty", "pendingSellCost", "filledFeeUsd", "sellTranche", "errorMessage"] as const) {
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
    // (Codex r4 MEDIO#2) netProfit con el COSTO REAL DE ESTE TRANCHE: `sell.costBasis` (VWAP de la base
    // vendida en ESTA SELL), no el VWAP de todo el BUY (que contaminaría con otros tranches). Fallbacks
    // defensivos. Precio de venta = VWAP de la SELL.
    const buyCost = sell.costBasis ?? (buy?.avgFillPx ?? buy?.price ?? sell.price);
    const qty = sell.filledQty ?? sell.quantity;
    const sellPrice = sell.avgFillPx ?? sell.price;
    const gross = (sellPrice - buyCost) * qty;
    const net = gross - feesUsd;
    // (JAV-103) La reposición usa el precio de compra del nivel. `sell.repostBuyPrice` lo lleva precalculado
    // (SELL grid = price del BUY pareado; SELL sembrada = sellPrice/step) → correcto SIN depender de una BUY
    // previa. Fallbacks legacy: buy.price → buyCost.
    const repostLimit = sell.repostBuyPrice ?? buy?.price ?? buyCost;
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

// (JAV-103) Inventario CONTABLE del bot (base comprada − base ya vendida en ciclos). Lo usa el stop para
// liquidar SOLO lo del bot: min(freeBaseBalance, heldQty) → no toca base ajena/manual de la cuenta aunque
// la garantía de cuenta dedicada se rompiese. Lectura acotada (mismo cap que el detalle).
export const getHeldInventoryInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    // (CodeRabbit JAV-103, Major) Inventario = base comprada − base vendida en ciclos − base ya LIQUIDADA.
    // Las órdenes kind="liquidation" NO se vuelven ciclos; sin restarlas, tras un Stop+liquidar exitoso el
    // bot seguiría mostrando inventario y un reintento consideraría liquidable base que ya no le pertenece.
    let boughtQty = 0, liquidatedQty = 0, truncated = false;
    for (const st of ["filled", "partially_filled"] as const) {
      const rows = await ctx.db.query("spot_grid_orders")
        .withIndex("by_bot_status", (q) => q.eq("botId", botId).eq("status", st))
        .take(SPOT_GRID_DETAIL_CYCLE_CAP + 1);
      if (rows.length > SPOT_GRID_DETAIL_CYCLE_CAP) truncated = true;
      for (const o of rows.slice(0, SPOT_GRID_DETAIL_CYCLE_CAP)) {
        if (o.side === "buy") boughtQty += o.filledQty ?? 0;
        else if (o.side === "sell" && o.kind === "liquidation") liquidatedQty += o.filledQty ?? 0;
      }
    }
    const cycles = await ctx.db.query("spot_grid_cycles").withIndex("by_bot", (q) => q.eq("botId", botId)).take(SPOT_GRID_DETAIL_CYCLE_CAP + 1);
    if (cycles.length > SPOT_GRID_DETAIL_CYCLE_CAP) truncated = true;
    const soldQty = cycles.slice(0, SPOT_GRID_DETAIL_CYCLE_CAP).reduce((s, c) => s + (c.quantity ?? 0), 0);
    // (CodeRabbit JAV-103, Major) `truncated` => la lectura del inventario es PARCIAL. El caller (stop)
    // hace fail-closed: NUNCA liquidar contra un inventario subcontado (heldQty inflado).
    return { heldQty: Math.max(0, boughtQty - soldQty - liquidatedQty), truncated };
  },
});

// (JAV-103) Lee una orden por cloid (bootstrap: estado/attempt/fills de la semilla).
export const getSpotGridOrderByCloidInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots"), cloid: v.string() },
  handler: async (ctx, { botId, cloid }) => {
    const o = await ctx.db.query("spot_grid_orders").withIndex("by_cloid", (q) => q.eq("cloid", cloid)).first();
    return o && o.botId === botId ? o : null;
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
