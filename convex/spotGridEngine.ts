"use node";

// (QSG / JAV-92) Motor Live del Spot Grid — MONEY-PATH. Coloca y mantiene órdenes LIMIT reales en
// Hyperliquid Spot bajo lease (igual que el motor perp). Descifra la clave SOLO aquí (action node),
// firma con makeSpotClients, y delega TODA mutación de estado a las mutations NON-node de spotGridBots.ts
// (lease/CAS). Nunca loguea claves; solo escalares vía elog. Replica el patrón de triggerEngine.ts.

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlIsTestnet } from "./hlNetwork";
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
    // SELL con NETO ≥ objetivo tras fees buy+sell. Se resuelve ANALÍTICAMENTE el precio que neto el objetivo
    // (no se confía en buy*(1+p) como aproximación, Codex #6): net = (sell-buy)·qty - fee·(buy+sell)·qty.
    // Despejando sell e igualando a targetNet → idealSell; luego ceil a tick y un loop ACOTADO de "bump un
    // tick" como red de seguridad por el redondeo (Codex MEDIO#4). Si tras MAX_TICK_BUMPS no cubre → rechaza.
    const tick = 10 ** -Math.max(0, Math.min(8 - p.szDecimals, 5 - (Math.floor(Math.log10(buyPrice)) + 1)));
    const targetNet = p.orderSize * (p.gridProfitPercent / 100);   // ganancia neta objetivo por ciclo (quote)
    const denom = 1 - p.feeRate;
    const idealSell = denom > 0 ? (targetNet / quantity + buyPrice * (1 + p.feeRate)) / denom : buyPrice * step;
    let sellPrice = roundSpotPrice(Math.max(idealSell, buyPrice * step), p.szDecimals, "ceil");
    const net = (sp: number) => (sp - buyPrice) * quantity - p.feeRate * (buyPrice + sp) * quantity;
    let ok = false;
    for (let b = 0; b < MAX_TICK_BUMPS; b++) {
      if (net(sellPrice) >= targetNet && sellPrice * quantity >= MIN_SPOT_NOTIONAL_USD) { ok = true; break; }
      sellPrice = roundSpotPrice(sellPrice + tick, p.szDecimals, "ceil");
    }
    if (!ok) { rejected++; continue; }   // grid_level_uneconomic
    levels.push({
      idx: i, buyPrice, buyPriceStr: String(buyPrice), quantity, sizeStr: String(quantity),
      sellPrice, sellPriceStr: String(sellPrice),
    });
  }
  return { levels, rejected };
}

// ---- helpers internos del reconcile -------------------------------------------------------------

type Clients = { info: any; exchange: any; address: string };

// Coloca una orden bajo el contrato DB-intent (ALTO#1): record `submitting` → place → mark `open`.
// Idempotente: si el cloid ya está vivo en HL (openCloids), no reenvía; solo confirma `open`.
async function placeOrder(ctx: any, exchange: any, args: {
  botId: any; token: string; side: "buy" | "sell"; gridLevel: number; generation: number; cycleId: number;
  assetId: number; price: number; quantity: number; priceStr: string; sizeStr: string;
  pairedOrderId?: any; openCloids: Set<string>;
}): Promise<{ ok: boolean; cloid?: string }> {
  const rec = await ctx.runMutation(internal.spotGridBots.recordSpotGridOrder, {
    botId: args.botId, token: args.token, side: args.side, gridLevel: args.gridLevel,
    generation: args.generation, cycleId: args.cycleId, assetId: args.assetId,
    price: args.price, quantity: args.quantity, quoteSize: args.price * args.quantity,
    ...(args.pairedOrderId ? { pairedOrderId: args.pairedOrderId } : {}),
  });
  if (!rec.ok) return { ok: false };
  if (args.openCloids.has(rec.cloid.toLowerCase())) {   // ya viva en HL → solo confirmar open
    await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId: args.botId, token: args.token, cloid: rec.cloid, status: "open" });
    return { ok: true, cloid: rec.cloid };
  }
  try {
    const st: any = await placeSpotLimit(exchange, {
      assetId: args.assetId, isBuy: args.side === "buy", priceStr: args.priceStr, sizeStr: args.sizeStr,
      cloid: rec.cloid as `0x${string}`,
    });
    const oid = st?.resting?.oid != null ? String(st.resting.oid) : (st?.filled?.oid != null ? String(st.filled.oid) : undefined);
    await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId: args.botId, token: args.token, cloid: rec.cloid, status: "open", ...(oid ? { oid } : {}) });
    return { ok: true, cloid: rec.cloid };
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
    const { levels } = calculateGridLevels({
      currentPrice: bot.currentPrice ?? (await getSpotPrice(clients.info, resolved)),
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
      const r: any = await placeSpotLimit(clients.exchange, { assetId: o.assetId, isBuy: o.side === "buy", priceStr, sizeStr, cloid: o.cloid as `0x${string}` });
      const oid = r?.resting?.oid != null ? String(r.resting.oid) : undefined;
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, status: "open", incAttempt: true, ...(oid ? { oid } : {}) });
    } catch (e) {
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, incAttempt: true, errorMessage: safeError(e) });
    }
  }

  // (3) Procesar fills nuevos (por cloid propio). Avanza fillCursor al máximo time procesado.
  const byCloid = new Map(orders.map((o) => [o.cloid.toLowerCase(), o]));
  let maxTime = bot.fillCursor ?? 0;
  for (const f of fills) {
    if (f.time <= (bot.fillCursor ?? 0)) continue;
    maxTime = Math.max(maxTime, f.time);
    const o = f.cloid ? byCloid.get(f.cloid) : undefined;
    if (!o) continue;   // no es una orden nuestra (o ya consumida)
    await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
    if (o.side === "buy") {
      // BUY (parcial/total): acumular y colocar SELL pareada por la cantidad llenada (si running).
      const filledQty = (o.filledQty ?? 0) + f.sz;
      const full = filledQty >= o.quantity - 1e-12;
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, {
        botId, token, cloid: o.cloid, filledQty, avgFillPx: f.px,
        remainingQty: Math.max(0, o.quantity - filledQty), status: full ? "filled" : "partially_filled",
      });
      if (isRunning) {
        const sellRaw = roundSpotPrice(o.price * (1 + bot.gridProfitPercent / 100), szDecimals, "ceil");
        const pending = (o.pendingSellQty ?? 0) + f.sz;
        if (sellRaw * pending >= MIN_SPOT_NOTIONAL_USD) {
          const sizeStr = String(floorSpotSize(pending, szDecimals));
          await placeOrder(ctx, clients.exchange, { botId, token, side: "sell", gridLevel: o.gridLevel, generation: bot.generation, cycleId: o.cycleId,
            assetId: bot.assetId, price: sellRaw, quantity: floorSpotSize(pending, szDecimals), priceStr: String(sellRaw), sizeStr, pairedOrderId: o._id, openCloids });
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, pendingSellQty: 0 });
        } else {
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, pendingSellQty: pending });   // (Codex #3-r2) acumular sub-mínima
        }
      }
    } else {
      // SELL llenada → cerrar ciclo + reponer BUY (idempotente). feesUsd ≈ fee del fill + fee estimada del buy.
      const feeUsd = Math.abs(f.fee) + (fees.spotMaker * o.price * f.sz);
      const res: any = await ctx.runMutation(internal.spotGridBots.closeCycleAndRepost, { botId, token, sellCloid: o.cloid, feesUsd: feeUsd });
      // (ALTO#1) La reposición se insertó como `submitting` en la mutation; aquí la ENVIAMOS a HL (solo si
      // running y no está ya viva). Idempotente por cloid. closeCycleAndRepost devuelve precio/cantidad.
      if (res.ok && !res.alreadySettled && res.repostCloid && isRunning && !openCloids.has(String(res.repostCloid).toLowerCase())) {
        try {
          const { priceStr, sizeStr } = roundAndValidateSpotOrder({ price: res.repostPrice, size: res.repostQuantity, szDecimals, isBuy: true });
          const r: any = await placeSpotLimit(clients.exchange, { assetId: res.repostAssetId, isBuy: true, priceStr, sizeStr, cloid: res.repostCloid as `0x${string}` });
          const oid = r?.resting?.oid != null ? String(r.resting.oid) : undefined;
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: res.repostCloid, status: "open", ...(oid ? { oid } : {}) });
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
      const privKey = decryptPrivateKey(credInfo.credential);
      const { info, exchange } = makeSpotClients(privKey as `0x${string}`, hlIsTestnet());
      const address = credInfo.credential.tradingAccountAddress;
      const orders: any[] = await ctx.runQuery(internal.spotGridBots.getSpotGridOrdersInternal, { botId });
      const openOrders = await getOpenSpotOrders(info, address);
      const openCloids = new Set(openOrders.map((o) => (o.cloid ?? "").toLowerCase()).filter(Boolean));
      for (const o of orders) {
        if (o.status !== "open" && o.status !== "submitting" && o.status !== "partially_filled") continue;
        try {
          if (openCloids.has(o.cloid.toLowerCase())) await cancelSpotByCloid(exchange, o.assetId, o.cloid as `0x${string}`);
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, status: "cancelled" });
        } catch (e) { elog("spotgrid", "cancel_failed", { botId: String(botId), err: safeError(e) }); }
      }
      await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId, token, status: "stopped", clearLease: true });
      elog("spotgrid", "stopped", { botId: String(botId), cancelled: orders.length });
      return { ok: true };
    } finally {
      // setSpotGridStatus(stopped) ya limpió el lease; release es no-op si el token ya no aplica.
      await ctx.runMutation(internal.spotGridBots.releaseSpotGridReconcile, { botId, token });
    }
  },
});
