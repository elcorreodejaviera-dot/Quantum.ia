"use node";

// (QSG / JAV-92) Motor Live del Spot Grid — MONEY-PATH. Coloca y mantiene órdenes LIMIT reales en
// Hyperliquid Spot bajo lease (igual que el motor perp). Descifra la clave SOLO aquí (action node),
// firma con makeSpotClients, y delega TODA mutación de estado a las mutations NON-node de spotGridBots.ts
// (lease/CAS). Nunca loguea claves; solo escalares vía elog. Replica el patrón de triggerEngine.ts.

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlIsTestnet, hlNetwork } from "./hlNetwork";
import { elog, safeError } from "./log";
import {
  makeSpotClients, resolveSpotAsset, getSpotPrice, getSpotBalance, getUserFees,
  getOpenSpotOrders, getSpotFills, getSpotOrderStatusByCloid,
  roundSpotPrice, floorSpotSize, roundAndValidateSpotOrder, MIN_SPOT_NOTIONAL_USD,
  placeSpotLimit, cancelSpotByCloid,
} from "./hyperliquidSpot";

const SUBMIT_GRACE_MS = 30_000;     // (Codex BAJO#2) espera antes de reintentar un `submitting` colgado
const MAX_SUBMIT_ATTEMPTS = 5;      // tras esto, la orden submitting → failed
const MAX_TICK_BUMPS = 20;          // (Codex MEDIO#4) tope del loop de profit neto
// (JAV-101) Tope absoluto de niveles del grid: alineado con el cap de lectura de getSpotGridDetail (~50)
// para NO crear más órdenes reales de las que la UI puede mostrar; la colocación es serial (1 RPC + lease
// por orden). Subirlo exigiría paginar getSpotGridDetail + colocar por lotes entre reconciles (otra issue).
const ABS_MAX_GRID_LEVELS = 50;

// ---- calculateGridLevels (PURA, exportada para tests) -------------------------------------------
export type GridLevel = {
  idx: number; buyPrice: number; buyPriceStr: string; quantity: number; sizeStr: string;
  sellPrice: number; sellPriceStr: string;
};

/**
 * Niveles geométricos del grid (BingX Infinity): buy[n] = buy[n-1]/(1+p), desde justo bajo el precio
 * actual hasta `minPrice`, hasta `gridCount` niveles. Para cada nivel calcula la SELL con **profit neto
 * post-rounding** (Codex #6): redondea precio (BUY floor / SELL ceil) y size (floor), descuenta fees
 * buy+sell, y si el neto no cubre el objetivo sube el SELL un tick — LOOP ACOTADO (Codex MEDIO#4): si tras
 * MAX_TICK_BUMPS no cubre, se RECHAZA el nivel (grid_level_uneconomic), nunca precio absurdo ni min-notional
 * inválido.
 */
// Tick HL-spot para un precio dado (≤5 sig figs y ≤8−szDecimals decimales).
function spotTick(price: number, szDecimals: number): number {
  return 10 ** -Math.max(0, Math.min(8 - szDecimals, 5 - (Math.floor(Math.log10(price)) + 1)));
}

/**
 * (Codex ALTO#3-código / #6) FUENTE ÚNICA del precio SELL pareado: resuelve ANALÍTICAMENTE el precio que
 * neto el objetivo de profit por ciclo tras fees buy+sell, lo redondea (ceil) y verifica con un loop
 * ACOTADO (MEDIO#4). Devuelve `null` (grid_level_uneconomic) si no cubre o cae bajo min-notional. La usan
 * `calculateGridLevels` Y la colocación de la SELL pareada en el reconcile → mismo cálculo, sin divergir.
 * `targetNet` = ganancia neta objetivo en quote para ESTA cantidad (orderSize·p% para el nivel completo).
 */
export function solveSellPrice(buyPrice: number, quantity: number, gridProfitPercent: number, feeRate: number, szDecimals: number, targetNet: number): number | null {
  if (!(buyPrice > 0) || !(quantity > 0)) return null;
  const step = 1 + gridProfitPercent / 100;
  const tick = spotTick(buyPrice, szDecimals);
  const denom = 1 - feeRate;
  const idealSell = denom > 0 ? (targetNet / quantity + buyPrice * (1 + feeRate)) / denom : buyPrice * step;
  let sellPrice = roundSpotPrice(Math.max(idealSell, buyPrice * step), szDecimals, "ceil");
  const net = (sp: number) => (sp - buyPrice) * quantity - feeRate * (buyPrice + sp) * quantity;
  for (let b = 0; b < MAX_TICK_BUMPS; b++) {
    if (net(sellPrice) >= targetNet - 1e-9 && sellPrice * quantity >= MIN_SPOT_NOTIONAL_USD) return sellPrice;
    sellPrice = roundSpotPrice(sellPrice + tick, szDecimals, "ceil");
  }
  return null;   // grid_level_uneconomic
}

export function calculateGridLevels(p: {
  currentPrice: number; minPrice: number; gridProfitPercent: number; orderSize: number;
  gridCount: number; szDecimals: number; feeRate: number;
}): { levels: GridLevel[]; rejected: number } {
  const levels: GridLevel[] = [];
  let rejected = 0;
  const step = 1 + p.gridProfitPercent / 100;
  if (!(step > 1) || !(p.currentPrice > 0) || !(p.orderSize > 0)) return { levels, rejected };
  let raw = p.currentPrice / step;   // primera compra justo por debajo del precio actual
  for (let i = 0; i < p.gridCount && raw >= p.minPrice; i++, raw = raw / step) {
    const buyPrice = roundSpotPrice(raw, p.szDecimals, "floor");
    if (!(buyPrice > 0) || buyPrice < p.minPrice) { rejected++; continue; }
    const quantity = floorSpotSize(p.orderSize / buyPrice, p.szDecimals);
    if (!(quantity > 0) || buyPrice * quantity < MIN_SPOT_NOTIONAL_USD) { rejected++; continue; }
    const targetNet = quantity * buyPrice * (p.gridProfitPercent / 100);   // p% del costo real del nivel
    const sellPrice = solveSellPrice(buyPrice, quantity, p.gridProfitPercent, p.feeRate, p.szDecimals, targetNet);
    if (sellPrice == null) { rejected++; continue; }   // grid_level_uneconomic
    levels.push({
      idx: i, buyPrice, buyPriceStr: String(buyPrice), quantity, sizeStr: String(quantity),
      sellPrice, sellPriceStr: String(sellPrice),
    });
  }
  return { levels, rejected };
}

// (JAV-101) Tamaño por orden en CENTAVOS ENTEROS para que orderSize×gridCount ≤ investment sea exacto
// (sin ULP de coma flotante). `orderCents = floor(invCents / n)` ⇒ orderCents·n ≤ invCents por construcción.
export function floorQuoteForBudget(investmentAmount: number, n: number): { orderSize: number; orderCents: number; invCents: number } {
  const invCents = Math.floor(investmentAmount * 100 + 1e-6);
  const orderCents = Math.floor(invCents / n);
  return { orderSize: orderCents / 100, orderCents, invCents };
}

/**
 * (JAV-101, PURA, exportada para tests) Deriva el nº de niveles del grid (estilo BingX Infinity) a partir
 * del RANGO (suelo→precio) y el profit%, topado por el capital (mínimo $10/orden de HL) y por ABS_MAX_GRID_LEVELS.
 * El recuento NO se fija por la fórmula cerrada: SIMULA con `calculateGridLevels` (la misma lógica pura del
 * motor: roundSpotPrice floor + rechazo de niveles bajo el suelo o min-notional) y baja `n` hasta que el motor
 * acepta EXACTAMENTE `n` niveles → lo prometido == lo que se coloca. `orderSize` por centavos enteros (mismo
 * valor que persiste y revalida). Lanza con mensaje claro si el rango/capital no dan ≥2 niveles válidos.
 */
export function deriveAutoGrid(p: {
  currentPrice: number; minPrice: number; gridProfitPercent: number;
  investmentAmount: number; szDecimals: number; feeRate: number; minNotional?: number;
}): { gridCount: number; orderSize: number; capped: boolean; coveredFloor: number; nFull: number; nCapital: number; minNotEff: number } {
  const minNotional = p.minNotional ?? MIN_SPOT_NOTIONAL_USD;
  for (const [k, val] of [["currentPrice", p.currentPrice], ["minPrice", p.minPrice],
    ["investmentAmount", p.investmentAmount], ["gridProfitPercent", p.gridProfitPercent]] as const) {
    if (!Number.isFinite(val) || !(val > 0)) throw new Error(`deriveAutoGrid: ${k} debe ser finito > 0.`);
  }
  if (!Number.isFinite(p.feeRate) || p.feeRate < 0) throw new Error("deriveAutoGrid: feeRate debe ser finito ≥ 0.");
  if (!(p.gridProfitPercent >= 0.5 && p.gridProfitPercent <= 10)) throw new Error("deriveAutoGrid: gridProfitPercent fuera de [0.5, 10].");
  if (!(p.minPrice < p.currentPrice)) throw new Error("deriveAutoGrid: el suelo (minPrice) debe estar por debajo del precio actual.");

  const step = 1 + p.gridProfitPercent / 100;
  const sizeTick = 10 ** (-p.szDecimals);
  const minNotEff = minNotional + p.currentPrice * sizeTick;   // colchón por truncado de tamaño (peor caso = precio más alto)
  const nFull = Math.floor(Math.log(p.currentPrice / p.minPrice) / Math.log(step));   // niveles para cubrir suelo→precio
  const nCapital = Math.floor(p.investmentAmount / minNotEff);                         // máx que permite el capital con colchón
  if (nFull < 2) throw new Error("deriveAutoGrid: rango demasiado estrecho para ≥2 niveles con este profit% (sube el % o baja el suelo).");
  if (nCapital < 2) throw new Error("deriveAutoGrid: capital insuficiente para ≥2 órdenes respetando el mínimo de HL (sube la inversión).");
  const nCand = Math.min(nFull, nCapital, ABS_MAX_GRID_LEVELS);

  // ORÁCULO: baja n desde nCand hasta que calculateGridLevels acepte EXACTAMENTE n. Aceptación monótona al
  // bajar n (menos profundidad + mayor orderSize) → el primer n que cumple es el MAYOR válido.
  let chosen = 0;
  let chosenLevels: GridLevel[] = [];
  for (let n = nCand; n >= 2; n--) {
    const orderSize = floorQuoteForBudget(p.investmentAmount, n).orderSize;
    if (orderSize < minNotional) continue;   // el truncado lo dejó bajo el mínimo → prueba un n menor
    const { levels } = calculateGridLevels({
      currentPrice: p.currentPrice, minPrice: p.minPrice, gridProfitPercent: p.gridProfitPercent,
      orderSize, gridCount: n, szDecimals: p.szDecimals, feeRate: p.feeRate,
    });
    if (levels.length === n) { chosen = n; chosenLevels = levels; break; }
  }
  if (chosen < 2) throw new Error("deriveAutoGrid: no se pueden colocar ni 2 niveles válidos (ajusta suelo/%/capital).");
  const orderSize = floorQuoteForBudget(p.investmentAmount, chosen).orderSize;   // EXACTO el que va a persist
  const coveredFloor = chosenLevels[chosenLevels.length - 1].buyPrice;            // último nivel REALMENTE aceptado
  const capped = nFull > Math.min(nCapital, ABS_MAX_GRID_LEVELS) || chosen < nCand;
  return { gridCount: chosen, orderSize, capped, coveredFloor, nFull, nCapital, minNotEff };
}

/**
 * (JAV-101, PURA, exportada para tests) Decide el precio de la COLOCACIÓN INICIAL.
 * - Grid AUTO-derivado (autoDerived) con currentPrice ancla válido (> minPrice): usa ese MISMO precio con
 *   que deriveAutoGrid calculó gridCount → garantiza "prometido == colocado" (sin drift entre crear y el
 *   primer reconcile).
 * - Manual / legacy (autoDerived != true) o ancla corrupta (currentPrice ≤ minPrice, p.ej. el viejo bug ~0):
 *   `null` → el caller refresca el precio spot EN VIVO (preserva la protección del #103; no depende de un
 *   snapshot persistido que podría ser stale/corrupto).
 */
export function pickInitialPlacementPrice(bot: { autoDerived?: boolean; currentPrice?: number; minPrice: number }): number | null {
  if (bot.autoDerived === true && typeof bot.currentPrice === "number" && bot.currentPrice > bot.minPrice) {
    return bot.currentPrice;
  }
  return null;   // refrescar en vivo
}

// ---- helpers internos del reconcile -------------------------------------------------------------

type Clients = { info: any; exchange: any; address: string };

// (Codex MEDIO#6, FUENTE ÚNICA de envío) Revalida el gate live INMEDIATAMENTE antes de CADA envío real
// (renew lease + assertLiveAdmissible) — un kill switch / pérdida de permiso / cambio de red entre el
// claim y este envío debe abortar. Si la orden ya está viva en HL (openCloids), confirma `open` sin
// reenviar (idempotente). Devuelve el oid si HL la dejó resting. La usan placeOrder, el retry y el repost.
async function gatedPlace(ctx: any, exchange: any, botId: any, token: string, p: {
  assetId: number; isBuy: boolean; priceStr: string; sizeStr: string; cloid: string; openCloids: Set<string>;
}): Promise<{ ok: boolean; oid?: string; gateBlocked?: boolean }> {
  const renew: any = await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
  if (!renew.ok) return { ok: false, gateBlocked: true };
  const live: any = await ctx.runQuery(internal.spotGridBots.assertSpotGridLiveAdmissibleInternal, { botId });
  if (!live.ok) return { ok: false, gateBlocked: true };
  if (p.openCloids.has(p.cloid.toLowerCase())) {
    await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: p.cloid, status: "open" });
    return { ok: true };
  }
  const st: any = await placeSpotLimit(exchange, { assetId: p.assetId, isBuy: p.isBuy, priceStr: p.priceStr, sizeStr: p.sizeStr, cloid: p.cloid as `0x${string}` });
  const oid = st?.resting?.oid != null ? String(st.resting.oid) : (st?.filled?.oid != null ? String(st.filled.oid) : undefined);
  await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: p.cloid, status: "open", ...(oid ? { oid } : {}) });
  return { ok: true, oid };
}

// Coloca una orden bajo el contrato DB-intent (ALTO#1): record `submitting` → gatedPlace → mark `open`.
async function placeOrder(ctx: any, exchange: any, args: {
  botId: any; token: string; side: "buy" | "sell"; gridLevel: number; generation: number; cycleId: number;
  assetId: number; price: number; quantity: number; priceStr: string; sizeStr: string;
  pairedOrderId?: any; tranche?: number; costBasis?: number; openCloids: Set<string>;
}): Promise<{ ok: boolean; cloid?: string }> {
  const rec = await ctx.runMutation(internal.spotGridBots.recordSpotGridOrder, {
    botId: args.botId, token: args.token, side: args.side, gridLevel: args.gridLevel,
    generation: args.generation, cycleId: args.cycleId, assetId: args.assetId,
    price: args.price, quantity: args.quantity, quoteSize: args.price * args.quantity,
    ...(args.pairedOrderId ? { pairedOrderId: args.pairedOrderId } : {}),
    ...(args.tranche !== undefined ? { tranche: args.tranche } : {}),
    ...(args.costBasis !== undefined ? { costBasis: args.costBasis } : {}),
  });
  if (!rec.ok) return { ok: false };
  try {
    const r = await gatedPlace(ctx, exchange, args.botId, args.token, {
      assetId: args.assetId, isBuy: args.side === "buy", priceStr: args.priceStr, sizeStr: args.sizeStr,
      cloid: rec.cloid, openCloids: args.openCloids,
    });
    return { ok: r.ok, cloid: rec.cloid };   // gateBlocked → queda `submitting`, el reconcile reintenta
  } catch (e) {
    elog("spotgrid", "place_failed", { botId: String(args.botId), side: args.side, err: safeError(e) });
    return { ok: false, cloid: rec.cloid };
  }
}

// ---- reconcile de UN bot (bajo lease ya tomado) -------------------------------------------------
async function reconcileOneBot(ctx: any, botId: any, token: string, clients: Clients, fees: { spotMaker: number; spotTaker: number }): Promise<void> {
  const bot: any = await ctx.runQuery(internal.spotGridBots.getSpotGridBotInternal, { botId });
  if (!bot) return;
  const isRunning = bot.status === "running";
  const resolved = await resolveSpotAsset(clients.info, bot.symbol, bot.network);
  const szDecimals = resolved.szDecimals;

  // Lecturas una vez por bot (la ronda por cuenta las podría compartir; MVP: por bot).
  const openOrders = await getOpenSpotOrders(clients.info, clients.address);
  const openCloids = new Set(openOrders.map((o) => (o.cloid ?? "").toLowerCase()).filter(Boolean));
  const fills = await getSpotFills(clients.info, clients.address, bot.fillCursor);

  const orders: any[] = await ctx.runQuery(internal.spotGridBots.getSpotGridOrdersInternal, { botId });

  // (1) Colocación inicial: bot running sin órdenes de la generación actual.
  if (isRunning && !orders.some((o) => o.generation === bot.generation)) {
    // (JAV-101, Codex MEDIO) SOLO los grids AUTO-derivados anclan a su `currentPrice` de creación (el
    // mismo con que deriveAutoGrid calculó gridCount → "prometido == colocado"). Los manuales y los legacy
    // (autoDerived != true) o un ancla corrupta (≤ minPrice) refrescan el precio EN VIVO → preserva la
    // protección del #103 sin reabrir el riesgo del snapshot persistido para esos bots.
    const anchorPrice = pickInitialPlacementPrice(bot) ?? await getSpotPrice(clients.info, resolved);
    const { levels } = calculateGridLevels({
      currentPrice: anchorPrice,
      minPrice: bot.minPrice, gridProfitPercent: bot.gridProfitPercent, orderSize: bot.orderSize,
      gridCount: bot.gridCount, szDecimals, feeRate: bot.feeRate,
    });
    for (const lv of levels) {
      await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
      await placeOrder(ctx, clients.exchange, { botId, token, side: "buy", gridLevel: lv.idx, generation: bot.generation, cycleId: 0,
        assetId: bot.assetId, price: lv.buyPrice, quantity: lv.quantity, priceStr: lv.buyPriceStr, sizeStr: lv.sizeStr, openCloids });
    }
    elog("spotgrid", "initial_placed", { botId: String(botId), levels: levels.length });
    return;   // próxima ronda procesa fills
  }

  // (2) Resolver `submitting` colgados.
  for (const o of orders.filter((x) => x.status === "submitting")) {
    const live = openCloids.has(o.cloid.toLowerCase());
    if (live) { await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, status: "open" }); continue; }
    const st = await getSpotOrderStatusByCloid(clients.info, clients.address, o.cloid as `0x${string}`);
    if (st === "open") { await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, status: "open" }); continue; }
    if (st === "filled") continue;   // el bloque de fills lo procesa
    // muerta/notfound: reintentar tras grace (solo si running), o failed tras demasiados intentos.
    if (Date.now() - (o.submittedAt ?? o.createdAt) < SUBMIT_GRACE_MS) continue;
    if (!isRunning) continue;
    if ((o.attempt ?? 1) >= MAX_SUBMIT_ATTEMPTS) {
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, status: "failed", errorMessage: "submitting sin confirmar tras reintentos" });
      continue;
    }
    try {
      const { priceStr, sizeStr } = roundAndValidateSpotOrder({ price: o.price, size: o.quantity, szDecimals, isBuy: o.side === "buy" });
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, incAttempt: true });
      await gatedPlace(ctx, clients.exchange, botId, token, { assetId: o.assetId, isBuy: o.side === "buy", priceStr, sizeStr, cloid: o.cloid, openCloids });
    } catch (e) {
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, errorMessage: safeError(e) });
    }
  }

  // (3) Procesar fills nuevos. (Codex ALTO#2) AGREGAR por cloid ANTES de aplicar: varios fills de la MISMA
  // orden en una ronda se suman UNA vez (no contra un snapshot viejo de filledQty). avgPx = Σ(sz·px)/Σsz.
  const byCloid = new Map(orders.map((o) => [o.cloid.toLowerCase(), o]));
  const agg = new Map<string, { sz: number; notional: number; fee: number }>();
  let maxTime = bot.fillCursor ?? 0;
  for (const f of fills) {
    if (f.time <= (bot.fillCursor ?? 0)) continue;
    maxTime = Math.max(maxTime, f.time);
    if (!f.cloid) continue;
    const a = agg.get(f.cloid) ?? { sz: 0, notional: 0, fee: 0 };
    a.sz += f.sz; a.notional += f.sz * f.px; a.fee += Math.abs(f.fee);
    agg.set(f.cloid, a);
  }
  for (const [cloid, a] of agg) {
    const o = byCloid.get(cloid);
    if (!o || !(a.sz > 0)) continue;   // no es una orden nuestra (o ya consumida)
    await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
    const prevFilled = o.filledQty ?? 0;
    const newFilled = prevFilled + a.sz;
    const full = newFilled >= o.quantity - 1e-9;
    // (Codex MEDIO#3) VWAP ACUMULADO entre rondas (no solo el batch): (prevQty·prevAvg + Σbatch)/newQty.
    const vwap = newFilled > 0 ? (prevFilled * (o.avgFillPx ?? 0) + a.notional) / newFilled : a.notional / a.sz;
    // (Codex r5 MEDIO#1) Fee REAL ACUMULADA de TODOS los fills de la orden (multi-ronda), no solo el batch.
    const newFee = (o.filledFeeUsd ?? 0) + a.fee;
    await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, {
      botId, token, cloid: o.cloid, filledQty: newFilled, avgFillPx: vwap, filledFeeUsd: newFee,
      remainingQty: Math.max(0, o.quantity - newFilled), status: full ? "filled" : "partially_filled",
    });
    if (o.side === "buy") {
      // (Codex #7/#3-r2/r3#2) SELL pareada por la cantidad REALMENTE llenada, en cuanto el acumulado
      // `pendingSellQty` alcanza el min-notional — NO se espera al BUY 100% (evita inventario sin TP). El
      // cloid de la SELL lleva `tranche` (= nº de SELL ya emitidas para este BUY) → varias SELL del mismo
      // BUY no colisionan (resuelve r2#1). Sub-mínima: se acumula en `pendingSellQty` hasta poder vender.
      if (isRunning) {
        // (Codex r4 ALTO#1) Acumular CANTIDAD y COSTO real de la base pendiente por vender (Σ sz·px de los
        // fills sin SELL). El basis del tranche = VWAP de SOLO lo pendiente, no de todo el BUY.
        const pendQty = (o.pendingSellQty ?? 0) + a.sz;
        const pendCost = (o.pendingSellCost ?? 0) + a.notional;
        const sellQty = floorSpotSize(pendQty, szDecimals);
        const basis = pendQty > 0 ? pendCost / pendQty : o.price;       // VWAP de la base pendiente
        const targetNet = sellQty * basis * (bot.gridProfitPercent / 100);
        const sellPrice = sellQty > 0 ? solveSellPrice(basis, sellQty, bot.gridProfitPercent, bot.feeRate, szDecimals, targetNet) : null;
        if (sellPrice != null && sellQty * sellPrice >= MIN_SPOT_NOTIONAL_USD) {
          const tranche = o.sellTranche ?? 0;
          // SELL lleva su propio costBasis (= VWAP de lo vendido) para un netProfit limpio por tranche.
          await placeOrder(ctx, clients.exchange, { botId, token, side: "sell", gridLevel: o.gridLevel, generation: bot.generation, cycleId: o.cycleId,
            assetId: bot.assetId, price: sellPrice, quantity: sellQty, priceStr: String(sellPrice), sizeStr: String(sellQty), pairedOrderId: o._id, tranche, costBasis: basis, openCloids });
          // Restar lo vendido del pendiente (la fracción no vendida conserva su costo proporcional al mismo VWAP).
          const remQty = Math.max(0, pendQty - sellQty);
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, pendingSellQty: remQty, pendingSellCost: basis * remQty, sellTranche: tranche + 1 });
        } else {
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, pendingSellQty: pendQty, pendingSellCost: pendCost });
        }
      }
    } else if (full) {
      // (fix #1) SELL cierra el ciclo SOLO al llenarse COMPLETA (si fue parcial, se espera a más fills).
      // (Codex r5 MEDIO#1) feesUsd = fee REAL ACUMULADA de la SELL (todas las rondas, recién persistida en
      // newFee) + fee estimada del BUY de ese tranche (feeRate·costBasis·qty).
      const feeUsd = newFee + (bot.feeRate * (o.costBasis ?? o.price) * newFilled);
      const res: any = await ctx.runMutation(internal.spotGridBots.closeCycleAndRepost, { botId, token, sellCloid: o.cloid, feesUsd: feeUsd });
      // (ALTO#1) La reposición se insertó como `submitting`; aquí se ENVÍA a HL vía gatedPlace (gate + idempotente).
      if (res.ok && !res.alreadySettled && res.repostCloid && isRunning) {
        try {
          const { priceStr, sizeStr } = roundAndValidateSpotOrder({ price: res.repostPrice, size: res.repostQuantity, szDecimals, isBuy: true });
          await gatedPlace(ctx, clients.exchange, botId, token, { assetId: res.repostAssetId, isBuy: true, priceStr, sizeStr, cloid: res.repostCloid, openCloids });
        } catch (e) {
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: res.repostCloid, errorMessage: safeError(e) });
        }
      }
    }
  }
  if (maxTime > (bot.fillCursor ?? 0)) {
    await ctx.runMutation(internal.spotGridBots.setSpotGridFillCursor, { botId, token, fillCursor: maxTime });
  }
}

// ---- entry del cron: reconcilia todos los bots activos, agrupando por cuenta -----------------------
export const reconcileAllSpotGrids = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const bots: any[] = await ctx.runQuery(internal.spotGridBots.listActiveSpotGridBotsInternal, {});
    // Agrupar por cuenta (Codex #5): una ronda de cliente por cuenta.
    const byAccount = new Map<string, any[]>();
    for (const b of bots) {
      const k = String(b.hlAccountId);
      (byAccount.get(k) ?? byAccount.set(k, []).get(k)!).push(b);
    }
    let reconciled = 0;
    for (const [, group] of byAccount) {
      for (const bot of group) {
        const claim = await ctx.runMutation(internal.spotGridBots.claimSpotGridReconcile, { botId: bot._id });
        if (!claim.ok) continue;
        const token = claim.token;
        try {
          // (ALTO#2) Revalidar gate live ANTES de tocar HL.
          const gate: any = await ctx.runQuery(internal.spotGridBots.assertSpotGridLiveAdmissibleInternal, { botId: bot._id });
          if (!gate.ok) {
            await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId: bot._id, token, status: gate.policy, errorMessage: gate.reason });
            elog("spotgrid", "gate_blocked", { botId: String(bot._id), reason: gate.reason });
            continue;
          }
          const credInfo: any = await ctx.runQuery(internal.spotGridBots.getSpotGridCredentialInternal, { botId: bot._id });
          if (!credInfo) continue;
          const privKey = decryptPrivateKey(credInfo.credential);
          const { info, exchange } = makeSpotClients(privKey as `0x${string}`, hlIsTestnet());
          const address = credInfo.credential.tradingAccountAddress;
          const fees = await getUserFees(info, address);
          await reconcileOneBot(ctx, bot._id, token, { info, exchange, address }, fees);
          reconciled++;
        } catch (e) {
          await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId: bot._id, token, status: "error", errorMessage: safeError(e) });
          elog("spotgrid", "reconcile_error", { botId: String(bot._id), err: safeError(e) });
        } finally {
          await ctx.runMutation(internal.spotGridBots.releaseSpotGridReconcile, { botId: bot._id, token });
        }
      }
    }
    return { reconciled, bots: bots.length };
  },
});

// ---- stopSpotGridBot (Codex #8, money-path): cancela órdenes propias vivas + marca stopped ----------
export const stopSpotGridBot = action({
  args: { botId: v.id("spot_grid_bots"), expectedNetwork: v.string() },
  handler: async (ctx, { botId, expectedNetwork }): Promise<any> => {
    // Auth + permiso de gestión + ownership (la action no tiene db → vía query interna; auth se propaga).
    await ctx.runQuery(internal.spotGridBots.assertCanStopSpotGridInternal, { botId });
    const claim = await ctx.runMutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    if (!claim.ok) throw new Error("No se pudo tomar el lease del bot (¿reconcile en curso? reintenta).");
    const token = claim.token;
    try {
      const credInfo: any = await ctx.runQuery(internal.spotGridBots.getSpotGridCredentialInternal, { botId });
      if (!credInfo) throw new Error("Bot/credencial no encontrados.");
      if (credInfo.network !== expectedNetwork) throw new Error(`Red incompatible: ${expectedNetwork} vs ${credInfo.network}.`);
      // (Codex ALTO#1-r3) La red EFECTIVA del backend DEBE coincidir con la del bot: si no, los clientes
      // (hlIsTestnet) leerían/cancelarían en la red equivocada y marcaríamos stopped dejando órdenes vivas
      // en la red correcta. Abortar antes de tocar HL.
      if (hlNetwork() !== credInfo.network) throw new Error(`HL_NETWORK del backend (${hlNetwork()}) ≠ red del bot (${credInfo.network}); no se opera.`);
      const privKey = decryptPrivateKey(credInfo.credential);
      const { info, exchange } = makeSpotClients(privKey as `0x${string}`, hlIsTestnet());
      const address = credInfo.credential.tradingAccountAddress;
      const orders: any[] = await ctx.runQuery(internal.spotGridBots.getSpotGridOrdersInternal, { botId });
      const openOrders = await getOpenSpotOrders(info, address);
      const openCloids = new Set(openOrders.map((o) => (o.cloid ?? "").toLowerCase()).filter(Boolean));
      const live = orders.filter((o) => o.status === "open" || o.status === "submitting" || o.status === "partially_filled");
      let cancelFailed = false;
      for (const o of live) {
        try {
          if (openCloids.has(o.cloid.toLowerCase())) await cancelSpotByCloid(exchange, o.assetId, o.cloid as `0x${string}`);
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, status: "cancelled" });
        } catch (e) { cancelFailed = true; elog("spotgrid", "cancel_failed", { botId: String(botId), err: safeError(e) }); }
      }
      // (Codex ALTO#5) NO marcar `stopped` si alguna cancelación falló o queda una orden propia VIVA en HL:
      // dejaría una orden activa con el bot "detenido". Re-verificar el book y, si hay residuo, `error`+throw
      // (el usuario reintenta Stop; el cron no repone porque no está running).
      const after = await getOpenSpotOrders(info, address);
      const afterCloids = new Set(after.map((o) => (o.cloid ?? "").toLowerCase()).filter(Boolean));
      const stillLive = live.some((o) => afterCloids.has(o.cloid.toLowerCase()));
      if (cancelFailed || stillLive) {
        await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId, token, status: "error", errorMessage: "stop incompleto: órdenes vivas sin cancelar", clearLease: true });
        throw new Error("Stop incompleto: quedaron órdenes vivas en HL. Reintenta en unos segundos.");
      }
      await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId, token, status: "stopped", clearLease: true });
      elog("spotgrid", "stopped", { botId: String(botId), cancelled: live.length });
      return { ok: true };
    } finally {
      // setSpotGridStatus(stopped) ya limpió el lease; release es no-op si el token ya no aplica.
      await ctx.runMutation(internal.spotGridBots.releaseSpotGridReconcile, { botId, token });
    }
  },
});
