"use node";

// (QSG / JAV-92) Motor Live del Spot Grid — MONEY-PATH. Coloca y mantiene órdenes LIMIT reales en
// Hyperliquid Spot bajo lease (igual que el motor perp). Descifra la clave SOLO aquí (action node),
// firma con makeSpotClients, y delega TODA mutación de estado a las mutations NON-node de spotGridBots.ts
// (lease/CAS). Nunca loguea claves; solo escalares vía elog. Replica el patrón de triggerEngine.ts.

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { TransportError } from "@nktkas/hyperliquid";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlIsTestnet, hlNetwork } from "./hlNetwork";
import { elog, safeError } from "./log";
import { SPOT_GRID_TRANSIENT_MSG } from "./spotGridConstants";
import {
  makeSpotClients, resolveSpotAsset, getSpotPrice, getSpotBalance, getUserFees,
  getOpenSpotOrders, getSpotFills, getSpotOrderStatusByCloid,
  roundSpotPrice, floorSpotSize, roundAndValidateSpotOrder, MIN_SPOT_NOTIONAL_USD,
  placeSpotLimit, cancelSpotByCloid,
} from "./hyperliquidSpot";

// (JAV-122) Clasifica una excepción del reconcile/bootstrap/actions. "transient" = fallo de TRANSPORTE de
// HL (5xx/timeout/red): `e instanceof TransportError` (el 502 es HttpRequestError extends TransportError) →
// reintentar, NUNCA marcar error con el cuerpo HTML crudo. "fatal" = determinista (ValidationError, firma,
// ApiRequestError = rechazo explícito, lógica del bot) → error terminal con mensaje corto. Espeja el
// criterio canónico del repo (hyperliquid.ts). Vive en tierra node (usa el SDK); lo importan engine y
// actions. Las mutations non-node NO clasifican: reciben el `message` ya limpio.
export function classifySpotGridError(e: unknown): { kind: "transient" | "fatal"; message: string } {
  if (e instanceof TransportError) return { kind: "transient", message: SPOT_GRID_TRANSIENT_MSG };
  return { kind: "fatal", message: safeError(e) };
}

const SUBMIT_GRACE_MS = 30_000;     // (Codex BAJO#2) espera antes de reintentar un `submitting` colgado
const MAX_SUBMIT_ATTEMPTS = 5;      // tras esto, la orden submitting → failed
const MAX_TICK_BUMPS = 20;          // (Codex MEDIO#4) tope del loop de profit neto
// (JAV-101) Tope absoluto de niveles del grid: alineado con el cap de lectura de getSpotGridDetail (~50)
// para NO crear más órdenes reales de las que la UI puede mostrar; la colocación es serial (1 RPC + lease
// por orden). Subirlo exigiría paginar getSpotGridDetail + colocar por lotes entre reconciles (otra issue).
const ABS_MAX_GRID_LEVELS = 50;
// (CodeRabbit Major) Ventana de frescura del ancla de creación. El cron reconcilia 1/min, así que el primer
// reconcile normal ocurre a segundos de crear el grid. Si pasó mucho más (cron parado/pausa/reanudación), el
// `currentPrice` de creación puede haber quedado obsoleto: si el spot cayó, varios BUY anclados al precio
// viejo quedarían POR ENCIMA del mercado y se ejecutarían al instante. Pasada esta ventana refrescamos el
// precio en vivo (como manual/legacy) → nunca se colocan compras sobre un ancla vencida.
const ANCHOR_MAX_AGE_MS = 5 * 60 * 1000;

// (JAV-103) Siembra de inventario (tipo BingX Infinity).
const M_MIN = 2;                       // mínimo de niveles de COMPRA (abajo)
const K_MIN = 2;                       // mínimo de niveles de VENTA sembrados (arriba)
const UPSIDE_CAP_FRAC = 0.5;           // cuando el suelo NO cabe, la venta nunca toma > la mitad del presupuesto
// (CodeRabbit JAV-103, Major) Tope DURO de slippage del seed = mismo techo que el clamp de
// `getSeedMaxSlippageInternal` (0.02). La semilla se compra con LIMIT IOC agresivo: si llena por encima del
// precio ancla puede gastar hasta seedNotional·(1+slip). Para que el peor caso (M BUYs + seed con slippage)
// NUNCA supere `investmentAmount`, `deriveSeededGrid` reparte sobre un presupuesto recortado por este tope.
// Es una CONSTANTE (no el valor live del config) para que el reparto sea determinista entre creación y
// bootstrap (prometido==colocado) y cubra cualquier slippage admisible.
const SEED_SLIPPAGE_BUDGET_MAX = 0.02;
const SEED_LEVEL = -1;                 // nivel sentinela de la orden de COMPRA semilla
const LIQ_LEVEL = -2;                  // nivel sentinela de la orden de liquidación
const DEFAULT_SEED_MAX_SLIPPAGE = 0.003;   // slippage del LIMIT IOC de semilla/liquidación si no hay config
const SEED_GRACE_MS = 30_000;          // espera tras enviar el IOC de semilla antes de declararlo fallido

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

// ---- (JAV-103) calculateSellLadder (PURA): niveles de VENTA sembrados por ENCIMA del precio ----------
export type SellLevel = { idx: number; sellPrice: number; sellPriceStr: string; quantity: number; sizeStr: string; repostBuyPrice: number };

/**
 * Niveles de venta geométricos POR ENCIMA del precio actual (espejo de calculateGridLevels). QUOTE-driven
 * (planning): `quantity = floorSpotSize(orderSize/sellPrice)`. Cada SELL guarda su `repostBuyPrice`
 * (= roundSpotPrice(sellPrice/step, floor)) para la reposición sin BUY previa (§3-C). Rechaza un nivel si
 * la cantidad cae ≤0 o bajo min-notional → el oráculo de deriveSeededGrid baja N hasta que entren K exactos.
 */
export function calculateSellLadder(p: {
  currentPrice: number; gridProfitPercent: number; orderSize: number; sellCount: number; szDecimals: number;
}): { levels: SellLevel[]; rejected: number } {
  const levels: SellLevel[] = [];
  let rejected = 0;
  const step = 1 + p.gridProfitPercent / 100;
  if (!(step > 1) || !(p.currentPrice > 0) || !(p.orderSize > 0)) return { levels, rejected };
  let raw = p.currentPrice * step;   // primera venta justo por encima del precio
  for (let i = 0; i < p.sellCount; i++, raw = raw * step) {
    const sellPrice = roundSpotPrice(raw, p.szDecimals, "ceil");
    const quantity = floorSpotSize(p.orderSize / sellPrice, p.szDecimals);
    if (!(quantity > 0) || sellPrice * quantity < MIN_SPOT_NOTIONAL_USD) { rejected++; continue; }
    const repostBuyPrice = roundSpotPrice(sellPrice / step, p.szDecimals, "floor");
    levels.push({ idx: i, sellPrice, sellPriceStr: String(sellPrice), quantity, sizeStr: String(quantity), repostBuyPrice });
  }
  return { levels, rejected };
}

/**
 * (JAV-103) Asignación BASE-driven de las SELL sembradas tras conocer `seedQtyReal` (lo realmente comprado).
 * Reparte `seedQtyReal` en KReal niveles uniformes: `perLevelQty = floorSpotSize(seedQtyReal/K)`. Baja K
 * desde `plannedK` hasta que TODOS los niveles cumplan min-notional (basta el de menor precio = el 1º) y
 * K ≥ K_MIN. Σ(perLevelQty·K) ≤ seedQtyReal por construcción; el residual (<1 lote) es dust (queda en
 * inventario). Devuelve KReal=0 si ni K_MIN cabe → el caller hace fail-closed.
 */
export function allocateSeededSells(p: {
  currentPrice: number; gridProfitPercent: number; seedQtyReal: number; plannedK: number; szDecimals: number;
}): { KReal: number; perLevelQty: number; levels: SellLevel[] } {
  const step = 1 + p.gridProfitPercent / 100;
  const startK = Math.min(p.plannedK, ABS_MAX_GRID_LEVELS);
  for (let K = startK; K >= K_MIN; K--) {
    const perLevelQty = floorSpotSize(p.seedQtyReal / K, p.szDecimals);
    if (!(perLevelQty > 0)) continue;
    const levels: SellLevel[] = [];
    let ok = true;
    let raw = p.currentPrice * step;
    for (let i = 0; i < K; i++, raw = raw * step) {
      const sellPrice = roundSpotPrice(raw, p.szDecimals, "ceil");
      if (sellPrice * perLevelQty < MIN_SPOT_NOTIONAL_USD) { ok = false; break; }
      const repostBuyPrice = roundSpotPrice(sellPrice / step, p.szDecimals, "floor");
      levels.push({ idx: i, sellPrice, sellPriceStr: String(sellPrice), quantity: perLevelQty, sizeStr: String(perLevelQty), repostBuyPrice });
    }
    if (ok && levels.length === K) return { KReal: K, perLevelQty, levels };
  }
  return { KReal: 0, perLevelQty: 0, levels: [] };
}

/**
 * (JAV-103, PURA, exportada para tests) Deriva el reparto SEEDED del grid: M niveles de COMPRA abajo +
 * K niveles de VENTA sembrados arriba, con `orderSize` uniforme. Oráculo-dirigida (como deriveAutoGrid):
 * M/K salen de `nFull` (rango) y `nCapital` (capital), con guarda dura M≥M_MIN y K≥K_MIN o ERROR explícito.
 * `seedQtyTarget` (en BASE) = Σ qty de las K SELLs = lo que hay que comprar en la semilla.
 */
export function deriveSeededGrid(p: {
  currentPrice: number; minPrice: number; gridProfitPercent: number;
  investmentAmount: number; szDecimals: number; feeRate: number; minNotional?: number;
}): { M: number; K: number; orderSize: number; seedQtyTarget: number; seedNotional: number; seedPercent: number; coveredFloor: number; capped: boolean } {
  const minNotional = p.minNotional ?? MIN_SPOT_NOTIONAL_USD;
  for (const [k, val] of [["currentPrice", p.currentPrice], ["minPrice", p.minPrice],
    ["investmentAmount", p.investmentAmount], ["gridProfitPercent", p.gridProfitPercent]] as const) {
    if (!Number.isFinite(val) || !(val > 0)) throw new Error(`deriveSeededGrid: ${k} debe ser finito > 0.`);
  }
  if (!Number.isFinite(p.feeRate) || p.feeRate < 0) throw new Error("deriveSeededGrid: feeRate debe ser finito ≥ 0.");
  if (!(p.gridProfitPercent >= 0.5 && p.gridProfitPercent <= 10)) throw new Error("deriveSeededGrid: gridProfitPercent fuera de [0.5, 10].");
  if (!(p.minPrice < p.currentPrice)) throw new Error("deriveSeededGrid: el suelo (minPrice) debe estar por debajo del precio actual.");

  const step = 1 + p.gridProfitPercent / 100;
  const sizeTick = 10 ** (-p.szDecimals);
  const minNotEff = minNotional + p.currentPrice * sizeTick;
  // (CodeRabbit JAV-103, Major) Presupuesto recortado por el peor slippage del seed → garantiza que
  // M·orderSize + seedNotional·(1+slip) ≤ investmentAmount para cualquier slip ≤ SEED_SLIPPAGE_BUDGET_MAX.
  const budgetForOrders = p.investmentAmount / (1 + SEED_SLIPPAGE_BUDGET_MAX);
  const nFull = Math.floor(Math.log(p.currentPrice / p.minPrice) / Math.log(step));
  const nCapital = Math.floor(budgetForOrders / minNotEff);
  if (nFull < M_MIN) throw new Error("deriveSeededGrid: rango demasiado estrecho para ≥2 compras (sube el % o baja el suelo).");
  if (nCapital < M_MIN + K_MIN) throw new Error("deriveSeededGrid: capital insuficiente para sembrar (≥2 compras y ≥2 ventas con el mínimo de HL). Sube la inversión.");

  for (let N = Math.min(nCapital, ABS_MAX_GRID_LEVELS); N >= M_MIN + K_MIN; N--) {
    const orderSize = floorQuoteForBudget(budgetForOrders, N).orderSize;
    if (orderSize < minNotional) continue;
    let M: number, K: number;
    if (nFull <= N - K_MIN) { M = nFull; K = N - M; }                 // el suelo CABE → el extra va al upside
    else { K = Math.min(Math.max(Math.round(N * UPSIDE_CAP_FRAC), K_MIN), N - M_MIN); M = N - K; }
    if (M < M_MIN || K < K_MIN) continue;
    const buys = calculateGridLevels({
      currentPrice: p.currentPrice, minPrice: p.minPrice, gridProfitPercent: p.gridProfitPercent,
      orderSize, gridCount: M, szDecimals: p.szDecimals, feeRate: p.feeRate,
    });
    const sells = calculateSellLadder({
      currentPrice: p.currentPrice, gridProfitPercent: p.gridProfitPercent, orderSize, sellCount: K, szDecimals: p.szDecimals,
    });
    if (buys.levels.length === M && sells.levels.length === K) {
      const seedQtyTarget = sells.levels.reduce((s, l) => s + l.quantity, 0);
      const seedNotional = seedQtyTarget * p.currentPrice;
      const coveredFloor = buys.levels[buys.levels.length - 1].buyPrice;
      const capped = nFull > M;   // no se alcanzó el suelo
      return { M, K, orderSize, seedQtyTarget, seedNotional, seedPercent: seedNotional / p.investmentAmount, coveredFloor, capped };
    }
  }
  throw new Error("deriveSeededGrid: no se pueden colocar ≥2 compras y ≥2 ventas válidas (ajusta suelo/%/capital).");
}

/**
 * (JAV-101, PURA, exportada para tests) Decide el precio de la COLOCACIÓN INICIAL.
 * - Grid AUTO-derivado (autoDerived) con currentPrice ancla válido (> minPrice): usa ese MISMO precio con
 *   que deriveAutoGrid calculó gridCount → garantiza "prometido == colocado" (sin drift entre crear y el
 *   primer reconcile).
 * - Manual / legacy (autoDerived != true), ancla corrupta (currentPrice ≤ minPrice, p.ej. el viejo bug ~0)
 *   o ANCLA VENCIDA (creación hace más de ANCHOR_MAX_AGE_MS, CodeRabbit): `null` → el caller refresca el
 *   precio spot EN VIVO (preserva la protección del #103; nunca coloca compras sobre un snapshot stale).
 */
export function pickInitialPlacementPrice(
  bot: { autoDerived?: boolean; currentPrice?: number; minPrice: number; _creationTime?: number },
  now: number = Date.now(),
): number | null {
  if (
    bot.autoDerived === true &&
    typeof bot.currentPrice === "number" && bot.currentPrice > bot.minPrice &&
    typeof bot._creationTime === "number" && now - bot._creationTime <= ANCHOR_MAX_AGE_MS
  ) {
    return bot.currentPrice;
  }
  return null;   // refrescar en vivo (manual/legacy/ancla corrupta/ancla vencida/sin timestamp)
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

// (JAV-103) Σ de los fills de HL que casan un cloid (idempotencia de IOC: el resultado real de la semilla/
// liquidación se LEE de los fills, nunca se asume). Devuelve cantidad, VWAP y fee acumulada.
async function fillsForCloid(info: any, address: string, cloid: string, sinceMs?: number): Promise<{ qty: number; avgPx: number; feeUsd: number }> {
  const fills = await getSpotFills(info, address, sinceMs);
  const target = cloid.toLowerCase();
  let qty = 0, notional = 0, feeUsd = 0;
  for (const f of fills) {
    if ((f.cloid ?? "") !== target) continue;
    qty += f.sz; notional += f.sz * f.px; feeUsd += Math.abs(f.fee);
  }
  return { qty, avgPx: qty > 0 ? notional / qty : 0, feeUsd };
}

// (JAV-103, ALTO-L) Envío GATEADO de un LIMIT IOC (semilla/liquidación) con los MISMOS gates que
// gatedPlace: renew lease + assertLiveAdmissible (incluye red===bot.network) ANTES de enviar. Idempotente:
// si el cloid YA tiene fills, NO reenvía (evita doble compra/venta de un IOC que no queda resting). El
// resultado real se resuelve por fills (el caller los relee).
async function gatedPlaceIoc(ctx: any, exchange: any, info: any, address: string, botId: any, token: string, p: {
  assetId: number; isBuy: boolean; priceStr: string; sizeStr: string; cloid: string; sinceMs?: number;
}): Promise<{ ok: boolean; gateBlocked?: boolean; alreadyFilled?: boolean; qty: number; avgPx: number; feeUsd: number }> {
  const renew: any = await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
  if (!renew.ok) return { ok: false, gateBlocked: true, qty: 0, avgPx: 0, feeUsd: 0 };
  const live: any = await ctx.runQuery(internal.spotGridBots.assertSpotGridLiveAdmissibleInternal, { botId });
  if (!live.ok) return { ok: false, gateBlocked: true, qty: 0, avgPx: 0, feeUsd: 0 };
  const pre = await fillsForCloid(info, address, p.cloid, p.sinceMs);
  if (pre.qty > 0) return { ok: true, alreadyFilled: true, ...pre };   // ya ejecutado: NO reenviar
  // (Codex código r1, ALTO#2) Si placeSpotLimit LANZA (timeout/error de red tras llegar la orden a HL), la
  // orden pudo EJECUTARSE igualmente → releer fills por cloid antes de propagar el error; si hubo fill,
  // devolverlo como ejecutado (no se reenvía). Solo si NO hay fill se propaga el fallo real.
  try {
    await placeSpotLimit(exchange, { assetId: p.assetId, isBuy: p.isBuy, priceStr: p.priceStr, sizeStr: p.sizeStr, cloid: p.cloid as `0x${string}`, tif: "Ioc" });
  } catch (e) {
    const onErr = await fillsForCloid(info, address, p.cloid, p.sinceMs);
    if (onErr.qty > 0) return { ok: true, ...onErr };
    throw e;
  }
  const post = await fillsForCloid(info, address, p.cloid, p.sinceMs);
  return { ok: true, ...post };
}

// Coloca una orden bajo el contrato DB-intent (ALTO#1): record `submitting` → gatedPlace → mark `open`.
async function placeOrder(ctx: any, exchange: any, args: {
  botId: any; token: string; side: "buy" | "sell"; gridLevel: number; generation: number; cycleId: number;
  assetId: number; price: number; quantity: number; priceStr: string; sizeStr: string;
  pairedOrderId?: any; tranche?: number; costBasis?: number; openCloids: Set<string>;
  kind?: "grid" | "seed" | "liquidation"; repostBuyPrice?: number;
}, flags?: { transientPlace: boolean }): Promise<{ ok: boolean; cloid?: string }> {
  const rec = await ctx.runMutation(internal.spotGridBots.recordSpotGridOrder, {
    botId: args.botId, token: args.token, side: args.side, gridLevel: args.gridLevel,
    generation: args.generation, cycleId: args.cycleId, assetId: args.assetId,
    price: args.price, quantity: args.quantity, quoteSize: args.price * args.quantity,
    ...(args.pairedOrderId ? { pairedOrderId: args.pairedOrderId } : {}),
    ...(args.tranche !== undefined ? { tranche: args.tranche } : {}),
    ...(args.costBasis !== undefined ? { costBasis: args.costBasis } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.repostBuyPrice !== undefined ? { repostBuyPrice: args.repostBuyPrice } : {}),
  });
  if (!rec.ok) return { ok: false };
  try {
    const r = await gatedPlace(ctx, exchange, args.botId, args.token, {
      assetId: args.assetId, isBuy: args.side === "buy", priceStr: args.priceStr, sizeStr: args.sizeStr,
      cloid: rec.cloid, openCloids: args.openCloids,
    });
    return { ok: r.ok, cloid: rec.cloid };   // gateBlocked → queda `submitting`, el reconcile reintenta
  } catch (e) {
    // (JAV-122) El intento idempotente (record `submitting`) ya está persistido y el reconcile lo reintenta
    // por CLOID. Un TRANSITORIO de HL aquí debe contar como fallo transitorio de la RONDA (backoff/escalada
    // del bot, Codex código ALTO-1): se señaliza vía `flags` y se procesa al cierre del loop, SIN re-lanzar
    // (re-lanzar saltearía el avance de fillCursor → doble-conteo). Un fatal queda local (orden fallida).
    const c = classifySpotGridError(e);
    if (c.kind === "transient" && flags) flags.transientPlace = true;
    elog("spotgrid", "place_failed", { botId: String(args.botId), side: args.side, err: c.message });
    return { ok: false, cloid: rec.cloid };
  }
}

// ---- (JAV-103) Bootstrap SEEDED por fases (semilla → SELLs → BUYs) -------------------------------
// Idempotente y re-entrante: cada fase resuelve su estado contra HL antes de (re)enviar y avanza
// `bootstrapPhase` al confirmarla. NO depende de "no hay órdenes de la generación". Solo se ejecuta con el
// bot running. Las fases se encadenan en la misma ronda cuando ya están confirmadas.
async function runSeededBootstrap(ctx: any, bot: any, token: string, clients: Clients, resolved: any, szDecimals: number, flags: { transientPlace: boolean }): Promise<void> {
  const botId = bot._id;
  const anchorPrice = pickInitialPlacementPrice(bot, Date.now()) ?? await getSpotPrice(clients.info, resolved);
  // Reparto determinista desde los MISMOS parámetros que en la creación → prometido==colocado.
  let derived: ReturnType<typeof deriveSeededGrid>;
  try {
    derived = deriveSeededGrid({
      currentPrice: anchorPrice, minPrice: bot.minPrice, gridProfitPercent: bot.gridProfitPercent,
      investmentAmount: bot.investmentAmount, szDecimals, feeRate: bot.feeRate,
    });
  } catch (e) {
    await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, seedStatus: "failed", status: "error", errorMessage: safeError(e) });
    return;
  }
  const step = 1 + bot.gridProfitPercent / 100;

  // ---- FASE "seed": comprar el inventario (LIMIT IOC agresivo), EXACTAMENTE una vez ----
  if (bot.bootstrapPhase === "seed") {
    const slip = (await ctx.runQuery(internal.spotGridBots.getSeedMaxSlippageInternal, {})).seedMaxSlippage;
    const seedLimit = roundSpotPrice(anchorPrice * (1 + slip), szDecimals, "ceil");
    const seedQty = floorSpotSize(derived.seedQtyTarget, szDecimals);
    if (!(seedQty > 0) || seedLimit * seedQty < MIN_SPOT_NOTIONAL_USD || seedLimit * seedQty > bot.investmentAmount) {
      await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, seedStatus: "failed", status: "error", errorMessage: "semilla inválida (qty/notional/exposición)" });
      return;
    }
    // Orden semilla (idempotente por cloid). recordSpotGridOrder computa el cloid (kind=seed).
    const rec: any = await ctx.runMutation(internal.spotGridBots.recordSpotGridOrder, {
      botId, token, side: "buy", gridLevel: SEED_LEVEL, generation: bot.generation, cycleId: 0,
      assetId: bot.assetId, price: seedLimit, quantity: seedQty, quoteSize: seedLimit * seedQty, kind: "seed",
    });
    if (!rec.ok) return;
    const seedCloid = rec.cloid;
    const resolveSeed = async (qty: number, avgPx: number, feeUsd: number) => {
      const seedQtyReal = floorSpotSize(qty, szDecimals);
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, {
        botId, token, cloid: seedCloid, status: "filled", filledQty: qty, avgFillPx: avgPx, filledFeeUsd: feeUsd, remainingQty: 0,
      });
      const alloc = allocateSeededSells({ currentPrice: anchorPrice, gridProfitPercent: bot.gridProfitPercent, seedQtyReal, plannedK: derived.K, szDecimals });
      if (alloc.KReal < K_MIN) {   // parcial NO usable → fail-closed (inventario visible/liquidable)
        await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, seedStatus: "failed", seedQty: seedQtyReal, seedAvgPx: avgPx, seedNotionalReal: seedQtyReal * avgPx, status: "error", errorMessage: "semilla insuficiente para ≥2 ventas" });
        return false;
      }
      await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, {
        botId, token, seedStatus: "done", seedQty: seedQtyReal, seedAvgPx: avgPx, seedNotionalReal: seedQtyReal * avgPx, bootstrapPhase: "sells",
      });
      return true;
    };
    const pre = await fillsForCloid(clients.info, clients.address, seedCloid, bot.fillCursor ?? 0);
    if (pre.qty > 0) { if (!(await resolveSeed(pre.qty, pre.avgPx, pre.feeUsd))) return; }
    else {
      const ord: any = await ctx.runQuery(internal.spotGridBots.getSpotGridOrderByCloidInternal, { botId, cloid: seedCloid });
      const sent = (ord?.attempt ?? 1) >= 2;
      if (!sent) {
        const r = await gatedPlaceIoc(ctx, clients.exchange, clients.info, clients.address, botId, token, {
          assetId: bot.assetId, isBuy: true, priceStr: String(seedLimit), sizeStr: String(seedQty), cloid: seedCloid, sinceMs: bot.fillCursor ?? 0,
        });
        if (r.gateBlocked) return;   // reintenta próxima ronda (attempt sigue en 1)
        await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: seedCloid, status: "submitting", incAttempt: true });
        if (r.qty > 0) { if (!(await resolveSeed(r.qty, r.avgPx, r.feeUsd))) return; }
        else return;   // sin fills aún: confirmar en la próxima ronda por fills
      } else {
        // Ya enviado y sin fills: esperar grace; si pasa, fail-closed (NO reenviar un IOC → evita doble compra).
        if (Date.now() - (ord?.submittedAt ?? ord?.createdAt ?? Date.now()) < SEED_GRACE_MS) return;
        await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: seedCloid, status: "failed", errorMessage: "semilla sin fills tras grace" });
        await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, seedStatus: "failed", status: "error", errorMessage: "semilla no ejecutada (IOC sin fill)" });
        return;
      }
    }
    bot = await ctx.runQuery(internal.spotGridBots.getSpotGridBotInternal, { botId });   // refresca fase
    if (!bot || bot.bootstrapPhase !== "sells") return;
  }

  // ---- FASE "sells": colocar las SELLs sembradas (base-driven sobre seedQtyReal) ----
  if (bot.bootstrapPhase === "sells") {
    const seedQtyReal = bot.seedQty ?? 0;
    const seedBasis = bot.seedAvgPx ?? anchorPrice;
    const alloc = allocateSeededSells({ currentPrice: anchorPrice, gridProfitPercent: bot.gridProfitPercent, seedQtyReal, plannedK: derived.K, szDecimals });
    if (alloc.KReal < K_MIN) {
      await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, seedStatus: "failed", status: "error", errorMessage: "semilla insuficiente para ≥2 ventas (fase sells)" });
      return;
    }
    const openOrders = await getOpenSpotOrders(clients.info, clients.address);
    const openCloids = new Set(openOrders.map((o) => (o.cloid ?? "").toLowerCase()).filter(Boolean));
    for (const lv of alloc.levels) {
      await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
      await placeOrder(ctx, clients.exchange, {
        botId, token, side: "sell", gridLevel: lv.idx, generation: bot.generation, cycleId: 0,
        assetId: bot.assetId, price: lv.sellPrice, quantity: lv.quantity, priceStr: lv.sellPriceStr, sizeStr: lv.sizeStr,
        costBasis: seedBasis, repostBuyPrice: lv.repostBuyPrice, kind: "seed", openCloids,
      }, flags);
    }
    await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, bootstrapPhase: "buys" });
    bot = await ctx.runQuery(internal.spotGridBots.getSpotGridBotInternal, { botId });
    if (!bot || bot.bootstrapPhase !== "buys") return;
  }

  // ---- FASE "buys": colocar las M BUYs grid abajo ----
  if (bot.bootstrapPhase === "buys") {
    const { levels } = calculateGridLevels({
      currentPrice: anchorPrice, minPrice: bot.minPrice, gridProfitPercent: bot.gridProfitPercent,
      orderSize: derived.orderSize, gridCount: derived.M, szDecimals, feeRate: bot.feeRate,
    });
    const openOrders = await getOpenSpotOrders(clients.info, clients.address);
    const openCloids = new Set(openOrders.map((o) => (o.cloid ?? "").toLowerCase()).filter(Boolean));
    for (const lv of levels) {
      await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
      await placeOrder(ctx, clients.exchange, {
        botId, token, side: "buy", gridLevel: lv.idx, generation: bot.generation, cycleId: 0,
        assetId: bot.assetId, price: lv.buyPrice, quantity: lv.quantity, priceStr: lv.buyPriceStr, sizeStr: lv.sizeStr, kind: "grid", openCloids,
      }, flags);
    }
    await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, bootstrapPhase: "done" });
    elog("spotgrid", "seed_bootstrap_done", { botId: String(botId), sells: derived.K, buys: levels.length });
  }
}

// ---- reconcile de UN bot (bajo lease ya tomado) -------------------------------------------------
async function reconcileOneBot(ctx: any, botId: any, token: string, clients: Clients, fees: { spotMaker: number; spotTaker: number }): Promise<{ transientPlace: boolean }> {
  // (JAV-122, Codex código ALTO-1) Acumula si ALGÚN envío de orden falló por transitorio de HL → el loop del
  // cron convierte el desenlace de la ronda de éxito a bump transitorio (sin re-lanzar, preservando fills).
  const flags = { transientPlace: false };
  const bot: any = await ctx.runQuery(internal.spotGridBots.getSpotGridBotInternal, { botId });
  if (!bot) return flags;
  const isRunning = bot.status === "running";
  const resolved = await resolveSpotAsset(clients.info, bot.symbol, bot.network);
  const szDecimals = resolved.szDecimals;

  // Lecturas una vez por bot (la ronda por cuenta las podría compartir; MVP: por bot).
  const openOrders = await getOpenSpotOrders(clients.info, clients.address);
  const openCloids = new Set(openOrders.map((o) => (o.cloid ?? "").toLowerCase()).filter(Boolean));
  const fills = await getSpotFills(clients.info, clients.address, bot.fillCursor);

  const orders: any[] = await ctx.runQuery(internal.spotGridBots.getSpotGridOrdersInternal, { botId });

  // (JAV-104) Precio spot VIVO de la ronda → mark-to-market del flotante (`getSpotGridDetail`). UNA lectura
  // por bot/ronda; se reutiliza en la colocación inicial para no leer dos veces. No aborta el reconcile.
  let livePrice: number | null = null;
  try {
    const p = await getSpotPrice(clients.info, resolved);
    if (p > 0) {
      livePrice = p;
      await ctx.runMutation(internal.spotGridBots.setSpotGridLastPrice, { botId, token, lastPrice: p });
    }
  } catch (e) {
    elog("spotgrid", "live_price_skip", { botId: String(botId), err: safeError(e) });
  }

  // (1-seeded, JAV-103) Bootstrap por FASES para grids sembrados. Mientras no esté "done", SOLO corre el
  // bootstrap (idempotente) — NO depende de "no hay órdenes de la generación". Si está pausado, no coloca.
  if (bot.bootstrapPhase && bot.bootstrapPhase !== "done") {
    if (isRunning) await runSeededBootstrap(ctx, bot, token, clients, resolved, szDecimals, flags);
    return flags;   // los fills se procesan en rondas posteriores (bootstrap done)
  }

  // (1) Colocación inicial LEGACY (grids no-seeded / manuales): running sin órdenes de la generación actual.
  if (isRunning && !bot.bootstrapPhase && !orders.some((o) => o.generation === bot.generation)) {
    // (JAV-101, Codex MEDIO) SOLO los grids AUTO-derivados anclan a su `currentPrice` de creación (el
    // mismo con que deriveAutoGrid calculó gridCount → "prometido == colocado"). Los manuales y los legacy
    // (autoDerived != true) o un ancla corrupta (≤ minPrice) refrescan el precio EN VIVO → preserva la
    // protección del #103 sin reabrir el riesgo del snapshot persistido para esos bots.
    // (JAV-104) Reusa el `livePrice` ya leído esta ronda; solo relee si aquella lectura falló.
    const anchorPrice = pickInitialPlacementPrice(bot, Date.now()) ?? livePrice ?? await getSpotPrice(clients.info, resolved);
    const { levels } = calculateGridLevels({
      currentPrice: anchorPrice,
      minPrice: bot.minPrice, gridProfitPercent: bot.gridProfitPercent, orderSize: bot.orderSize,
      gridCount: bot.gridCount, szDecimals, feeRate: bot.feeRate,
    });
    for (const lv of levels) {
      await ctx.runMutation(internal.spotGridBots.renewSpotGridReconcile, { botId, token });
      await placeOrder(ctx, clients.exchange, { botId, token, side: "buy", gridLevel: lv.idx, generation: bot.generation, cycleId: 0,
        assetId: bot.assetId, price: lv.buyPrice, quantity: lv.quantity, priceStr: lv.buyPriceStr, sizeStr: lv.sizeStr, openCloids }, flags);
    }
    elog("spotgrid", "initial_placed", { botId: String(botId), levels: levels.length });
    return flags;   // próxima ronda procesa fills
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
      // (JAV-122) Nunca persistir el cuerpo HTML de un 502 en spot_grid_orders.errorMessage: clasificar. Un
      // transitorio cuenta para el backoff/escalada del bot vía `flags` (Codex código ALTO-1).
      const c = classifySpotGridError(e);
      if (c.kind === "transient") flags.transientPlace = true;
      await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, errorMessage: c.message });
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
    // (JAV-103, ALTO-J) La COMPRA semilla (kind=seed/side=buy) ya quedó contabilizada en el bootstrap →
    // NO se re-aplica aquí (evita doble-conteo) ni dispara una SELL pareada (sus SELLs ya se sembraron).
    // La LIQUIDACIÓN (kind=liquidation) la maneja el stop, nunca el reconcile genérico.
    if (o.kind === "seed" && o.side === "buy") continue;
    if (o.kind === "liquidation") continue;
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
            assetId: bot.assetId, price: sellPrice, quantity: sellQty, priceStr: String(sellPrice), sizeStr: String(sellQty), pairedOrderId: o._id, tranche, costBasis: basis, openCloids }, flags);
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
          // (JAV-122) Idem: mensaje clasificado, nunca HTML crudo; transitorio cuenta vía `flags`.
          const c = classifySpotGridError(e);
          if (c.kind === "transient") flags.transientPlace = true;
          await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: res.repostCloid, errorMessage: c.message });
        }
      }
    }
  }
  if (maxTime > (bot.fillCursor ?? 0)) {
    await ctx.runMutation(internal.spotGridBots.setSpotGridFillCursor, { botId, token, fillCursor: maxTime });
  }
  return flags;
}

// ---- entry del cron: reconcilia todos los bots activos, agrupando por cuenta -----------------------
export const reconcileAllSpotGrids = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const active: any[] = await ctx.runQuery(internal.spotGridBots.listActiveSpotGridBotsInternal, {});
    // (JAV-122) Además de los activos, retomar los `error` transitorios RECUPERABLES (Parte 2).
    const recoverable: any[] = await ctx.runQuery(internal.spotGridBots.listRecoverableErrorSpotGridBotsInternal, {});
    const bots: any[] = [...active, ...recoverable];
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
        // (JAV-122, Codex r3) Origen AUTORITATIVO leído de DB al claimar (no el snapshot rancio de la lista):
        // ¿esta ronda es una recuperación desde `error` o una reconciliación activa?
        const wasError = claim.wasError === true;
        try {
          // (ALTO#2) Revalidar gate live ANTES de tocar HL.
          const gate: any = await ctx.runQuery(internal.spotGridBots.assertSpotGridLiveAdmissibleInternal, { botId: bot._id });
          if (!gate.ok) {
            // (JAV-122) policy:"error" = no-admisible NO transitorio → errorKind:"fatal" (no se re-recupera);
            // policy:"paused" → errorKind undefined. setSpotGridStatus limpia los campos de recovery.
            await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, {
              botId: bot._id, token, status: gate.policy,
              errorKind: gate.policy === "error" ? "fatal" : undefined, errorMessage: gate.reason,
            });
            elog("spotgrid", "gate_blocked", { botId: String(bot._id), reason: gate.reason });
            continue;
          }
          const credInfo: any = await ctx.runQuery(internal.spotGridBots.getSpotGridCredentialInternal, { botId: bot._id });
          if (!credInfo) continue;
          const privKey = decryptPrivateKey(credInfo.credential);
          const { info, exchange } = makeSpotClients(privKey as `0x${string}`, hlIsTestnet());
          const address = credInfo.credential.tradingAccountAddress;
          const fees = await getUserFees(info, address);
          const res = await reconcileOneBot(ctx, bot._id, token, { info, exchange, address }, fees);
          // (JAV-122, Codex código ALTO-1) Si algún ENVÍO de orden falló por transitorio (capturado local,
          // sin re-lanzar para no romper el avance de fillCursor), la ronda NO es un éxito limpio: cuenta
          // como fallo transitorio del bot (backoff/escalada o reintento de recuperación), igual que si el
          // transitorio hubiera llegado al catch central.
          if (res.transientPlace) {
            if (wasError) await ctx.runMutation(internal.spotGridBots.bumpSpotGridErrorRecovery, { botId: bot._id, token });
            else {
              const r: any = await ctx.runMutation(internal.spotGridBots.bumpSpotGridTransient, { botId: bot._id, token, message: SPOT_GRID_TRANSIENT_MSG });
              elog("spotgrid", r.escalated ? "place_transient_escalated" : "place_transient_retry", { botId: String(bot._id), fails: r.count });
            }
          } else if (wasError) {
            // Éxito de recuperación: restaurar el estado previo (running|paused).
            await ctx.runMutation(internal.spotGridBots.recoverSpotGridFromError, { botId: bot._id, token });
          } else {
            // Ronda activa limpia: resetear contadores de transitorio (con o sin fills).
            await ctx.runMutation(internal.spotGridBots.markSpotGridReconcileSuccess, { botId: bot._id, token });
          }
          reconciled++;
        } catch (e) {
          // (JAV-122) Clasificar: transitorio de HL (502/timeout/red) NO mata el bot; fatal sí.
          const { kind, message } = classifySpotGridError(e);
          if (kind === "transient") {
            if (wasError) {
              // Reintento de recuperación fallido → sube errorRecoveryAttempts (NO transientFailCount), backoff largo.
              await ctx.runMutation(internal.spotGridBots.bumpSpotGridErrorRecovery, { botId: bot._id, token });
              elog("spotgrid", "recovery_transient_retry", { botId: String(bot._id) });
            } else {
              const r: any = await ctx.runMutation(internal.spotGridBots.bumpSpotGridTransient, { botId: bot._id, token, message });
              elog("spotgrid", r.escalated ? "reconcile_transient_escalated" : "reconcile_transient_retry", { botId: String(bot._id), fails: r.count });
            }
          } else {
            await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId: bot._id, token, status: "error", errorKind: "fatal", errorMessage: message });
            elog("spotgrid", "reconcile_error", { botId: String(bot._id), err: message });
          }
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
  args: { botId: v.id("spot_grid_bots"), expectedNetwork: v.string(), liquidateInventory: v.optional(v.boolean()) },
  handler: async (ctx, { botId, expectedNetwork, liquidateInventory }): Promise<any> => {
    // Auth + permiso de gestión + ownership (la action no tiene db → vía query interna; auth se propaga).
    await ctx.runQuery(internal.spotGridBots.assertCanStopSpotGridInternal, { botId });
    // (JAV-103, ALTO-K) Claim que admite también `error` → reintentable tras semilla fail-closed / stop incompleto.
    const claim = await ctx.runMutation(internal.spotGridBots.claimSpotGridReconcileForStop, { botId });
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
      const bot: any = await ctx.runQuery(internal.spotGridBots.getSpotGridBotInternal, { botId });   // (JAV-103) para la liquidación
      if (!bot) throw new Error("Bot no encontrado.");
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

      // (JAV-103, ALTO-E) Liquidación opcional del inventario (LIMIT IOC, idempotente por cloid). La cuenta
      // es DEDICADA → el `free` de la base ES la bolsa del bot. Solo se vende min(free, free) = free; el
      // residuo cuyo valor < min-notional es dust (no vendible en HL) y no impide `stopped`.
      if (liquidateInventory === true) {
        const resolved = await resolveSpotAsset(info, bot.symbol, credInfo.network);
        const szDecimals = resolved.szDecimals;
        const refPrice = await getSpotPrice(info, resolved);
        const baseBal = await getSpotBalance(info, address, resolved.baseAsset);
        // (Codex código r1, ALTO#3) Vender SOLO el inventario del bot: min(free, heldQtyContable). Si en la
        // cuenta hubiese base ajena/manual (aunque la cuenta es dedicada), NO se toca.
        const inv = await ctx.runQuery(internal.spotGridBots.getHeldInventoryInternal, { botId });
        // (CodeRabbit JAV-103, Major) Fail-closed: si la lectura del inventario está truncada, heldQty puede
        // venir subcontado/inflado → NO liquidar a ciegas. Se marca error reintentable y se aborta.
        if (inv.truncated) {
          await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId, token, status: "error", errorMessage: "inventario truncado: no se puede liquidar con seguridad; reintenta", clearLease: true });
          throw new Error("Inventario truncado: liquidación abortada por seguridad. Reintenta Stop+liquidar.");
        }
        const held = inv.heldQty;
        const liqQty = floorSpotSize(Math.min(baseBal.free, held), szDecimals);
        if (liqQty > 0 && refPrice * liqQty >= MIN_SPOT_NOTIONAL_USD) {
          const slip = (await ctx.runQuery(internal.spotGridBots.getSeedMaxSlippageInternal, {})).seedMaxSlippage;
          const liqLimit = roundSpotPrice(refPrice * (1 - slip), szDecimals, "floor");
          // (Codex código r1, ALTO#1) Liquidación REINTENTABLE: nonce pre-incrementado → cada envío usa un
          // cloid NUEVO, así un IOC que llenó PARCIAL se puede reintentar (gatedPlaceIoc no lo bloquea por
          // "ya tiene fills") vendiendo el `free` restante. Pre-incremento ANTES de enviar = crash-safe (un
          // intento que pudo enviar no se reutiliza). Sobre-venta imposible: siempre se vende ≤ free actual.
          const nonce = bot.liquidationSeq ?? 0;
          await ctx.runMutation(internal.spotGridBots.setSpotGridBootstrap, { botId, token, liquidationSeq: nonce + 1 });
          const rec: any = await ctx.runMutation(internal.spotGridBots.recordSpotGridOrder, {
            botId, token, side: "sell", gridLevel: LIQ_LEVEL, generation: bot.generation, cycleId: bot.cycleSeq ?? 0,
            tranche: nonce, assetId: bot.assetId, price: liqLimit, quantity: liqQty, quoteSize: liqLimit * liqQty, kind: "liquidation",
          });
          if (rec.ok) {
            const r = await gatedPlaceIoc(ctx, exchange, info, address, botId, token, {
              assetId: bot.assetId, isBuy: false, priceStr: String(liqLimit), sizeStr: String(liqQty), cloid: rec.cloid, sinceMs: bot.fillCursor ?? 0,
            });
            await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, {
              botId, token, cloid: rec.cloid, status: r.qty >= liqQty - 1e-12 ? "filled" : (r.qty > 0 ? "partially_filled" : "submitting"),
              filledQty: r.qty, avgFillPx: r.avgPx, filledFeeUsd: r.feeUsd, remainingQty: Math.max(0, liqQty - r.qty),
            });
            if (r.gateBlocked) {
              await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId, token, status: "error", errorMessage: "liquidación bloqueada por gate; reintenta", clearLease: true });
              throw new Error("Liquidación bloqueada por el gate live. Reintenta Stop o detén sin liquidar.");
            }
          }
        }
        // Re-verificar tras la venta: residuo del bot (min free/held) cuyo valor ≥ min-notional → error
        // (NO stopped); el usuario reintenta Stop+liquidar → nonce nuevo vende el resto.
        const post = await getSpotBalance(info, address, resolved.baseAsset);
        const heldAfter = (await ctx.runQuery(internal.spotGridBots.getHeldInventoryInternal, { botId })).heldQty;   // post-venta: la liquidación recién hecha YA se descuenta
        if (refPrice * floorSpotSize(Math.min(post.free, heldAfter), szDecimals) >= MIN_SPOT_NOTIONAL_USD) {
          await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId, token, status: "error", errorMessage: "liquidación incompleta: queda inventario", clearLease: true });
          throw new Error("Liquidación incompleta: quedó inventario sin vender. Reintenta Stop+liquidar.");
        }
      }

      await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, { botId, token, status: "stopped", clearLease: true });
      elog("spotgrid", "stopped", { botId: String(botId), cancelled: live.length });
      return { ok: true };
    } catch (e) {
      // (JAV-122) Nunca mostrar al usuario el cuerpo HTML de un 502: re-lanzar el mensaje CLASIFICADO. Los
      // throws deterministas de arriba ("Liquidación incompleta…", etc.) se preservan (rama fatal = safeError).
      throw new Error(classifySpotGridError(e).message);
    } finally {
      // setSpotGridStatus(stopped) ya limpió el lease; release es no-op si el token ya no aplica.
      await ctx.runMutation(internal.spotGridBots.releaseSpotGridReconcile, { botId, token });
    }
  },
});
