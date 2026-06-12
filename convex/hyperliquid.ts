"use node";

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ExchangeClient, InfoClient, HttpTransport, TransportError } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "crypto";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlNetwork, hlIsTestnet, assertExpectedNetwork } from "./hlNetwork";
// Timeout del envío de órdenes a HL (entrada y SL). Menor que RECONCILE_LEASE_MS (60s) para el SL.
const HL_ORDER_TIMEOUT_MS = 30_000;
// (G5) Grace para CONFIRMAR el cierre externo de una posición: szi==0 debe mantenerse al menos este
// tiempo (≥1 ciclo extra del cron de 1 min) entre lecturas separadas en el tiempo → defensa contra
// un lag consistente de clearinghouseState que podría dar 0 sobre una posición aún viva.
const FLAT_CONFIRM_GRACE_MS = 90_000;
// Entrada "market": IOC con precio agresivo para cruzar el book (la IOC se llena al MEJOR precio
// disponible, no al límite — el slippage solo amplía el rango aceptable, no empeora el fill).
const ENTRY_IOC_SLIPPAGE = 0.02;
// SL stop-MARKET: banda de slippage (FRACCIÓN, no %) del precio límite al activarse. Fija en 1%,
// replicando la cuenta de referencia. NO garantiza el llenado: en un gap > 1% el SL puede no
// ejecutarse (riesgo aceptado por decisión del usuario). NO confundir con MARGIN_SAFETY_BUFFER.
const SL_MARKET_SLIPPAGE_FRACTION = 0.01;
// Tras enviar (submittedAt), margen amplio antes de cerrar un unknownOid como failed: garantiza
// que la action (abortada a HL_ORDER_TIMEOUT_MS, con expiresAfter) ya no puede llenar la IOC.
const ENTRY_GRACE_MS = 5 * 60_000;
// Grace del SL: tras aceptarse (slSubmittedAt, resting/waitingForTrigger), un unknownOid pasajero
// (lag de orderStatus) NO debe disparar una 2ª colocación. Ventana de tolerancia antes de recolocar.
const SL_SUBMIT_GRACE_MS = 60_000;

// Aborta REALMENTE la request (AbortController + signal del SDK). clearTimeout evita el timer colgante.
export function abortAfter(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("HL request timeout")), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

// --- Helpers de precisión / idempotency ---

// cloid HL: "0x" + 32 hex (16 bytes). Determinista a partir de la idempotencyKey.
function cloid(key: string, suffix = ""): `0x${string}` {
  const hex = createHash("sha256").update(key + suffix).digest("hex").slice(0, 32);
  return `0x${hex}` as `0x${string}`;
}

// Trunca hacia abajo a szDecimals — nunca por encima del nocional reservado.
export function floorToDecimals(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f) / f;
}

// Precisión de precio de perps en HL: ≤5 cifras significativas y ≤ (6 − szDecimals) decimales.
export function formatHlPrice(price: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(price.toPrecision(5));
  return String(Number(sig.toFixed(maxDecimals)));
}

/**
 * Nº de decimales del tick HL para un precio: el MÁS RESTRICTIVO entre el tope por szDecimals
 * (6 − szDecimals) y el de 5 cifras significativas (5 − dígitos enteros). PUEDE SER NEGATIVO: con
 * ≥6 dígitos enteros (p.ej. BTC 123456) el tick es 10/100 (−1/−2), no 1. Para price < 1, intDigits
 * es negativo y cuenta los ceros a la izquierda (5 sig. de 0.0123 abarcan 6 decimales).
 * @param price Precio positivo.
 * @param szDecimals Decimales de tamaño del activo en HL.
 * @returns Decimales válidos del tick (puede ser negativo).
 */
function hlAllowedDecimals(price: number, szDecimals: number): number {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const intDigits = Math.floor(Math.log10(price)) + 1;
  const sigDecimals = 5 - intDigits;   // NO clampar a 0: permite tick > 1 en precios de ≥6 dígitos
  return Math.min(maxDecimals, sigDecimals);
}

/**
 * Redondeo DIRECCIONAL a un precio HL-válido (respeta 5 cifras significativas y (6−szDecimals)
 * decimales, con tick ≥ 1 para enteros grandes). Corrige el ruido flotante de `toFixed` después de
 * normalizar para que el invariante se cumpla exactamente.
 * @param price Precio positivo.
 * @param szDecimals Decimales de tamaño del activo en HL.
 * @param dir "ceil" → menor precio válido ≥ price; "floor" → mayor precio válido ≤ price.
 * @returns Precio HL-válido redondeado en la dirección pedida.
 */
export function roundHlPrice(price: number, szDecimals: number, dir: "ceil" | "floor"): number {
  const decimals = hlAllowedDecimals(price, szDecimals);   // puede ser negativo
  const tick = 10 ** -decimals;                            // negativo → 10, 100, …
  const outDecimals = Math.max(0, decimals);
  const q = price / tick;
  const n = dir === "ceil" ? Math.ceil(q) : Math.floor(q);
  // Normalizar PRIMERO (toFixed introduce ruido binario), corregir la dirección DESPUÉS para que el
  // invariante se cumpla exactamente (ceil ≥ price, floor ≤ price) pese al redondeo de toFixed.
  let r = Number((n * tick).toFixed(outDecimals));
  if (dir === "ceil" && r < price) r = Number((r + tick).toFixed(outDecimals));
  if (dir === "floor" && r > price) r = Number((r - tick).toFixed(outDecimals));
  return r;
}

/**
 * Cota SUPERIOR conservadora para dimensionar/reservar el nocional: menor precio HL-válido ≥ price.
 * @param price Precio positivo.
 * @param szDecimals Decimales de tamaño del activo en HL.
 * @returns Precio HL-válido ≥ price.
 */
export function ceilHlPrice(price: number, szDecimals: number): number {
  return roundHlPrice(price, szDecimals, "ceil");
}

/**
 * Precio HL-válido AGRESIVO (que cruza el book / mantiene la banda): una COMPRA redondea hacia
 * ARRIBA (ceil) y una VENTA hacia ABAJO (floor), siempre alejándose del book. NUNCA usar el
 * redondeo al más cercano (formatHlPrice) en límites sensibles a la ejecución: podría acercar el
 * precio al book (Long con límite más bajo / Short más alto) o estrechar la banda del SL < 1%.
 * @param price Precio objetivo.
 * @param szDecimals Decimales de tamaño del activo en HL.
 * @param isBuy true = compra (ceil); false = venta (floor).
 * @returns Precio HL-válido como string, listo para el campo `p` de la orden.
 */
export function aggressiveHlPriceStr(price: number, szDecimals: number, isBuy: boolean): string {
  return String(roundHlPrice(price, szDecimals, isBuy ? "ceil" : "floor"));
}

type AssetMeta = { assetId: number; szDecimals: number; markPx: number; maxLeverage: number };
export async function getAssetMeta(info: InfoClient, asset: string): Promise<AssetMeta> {
  const [meta, ctxs] = await info.metaAndAssetCtxs();
  const idx = meta.universe.findIndex((u: any) => u.name === asset);
  if (idx < 0) throw new Error(`Asset no encontrado en HL: ${asset}`);
  const szDecimals = Number(meta.universe[idx].szDecimals);
  const markPx = Number((ctxs[idx] as any)?.markPx);
  if (!Number.isFinite(markPx) || markPx <= 0) throw new Error(`markPx inválido para ${asset}`);
  // maxLeverage del activo (autoLeverage no debe superarlo). Se devuelve EN CRUDO y NO se valida aquí:
  // getAssetMeta lo usan también rutas defensivas (cierre de emergencia, reconciliación) que NO deben
  // fallar por metadata exclusiva de apertura. La validación estricta (entero ≥ 1) vive en
  // resolveLeverage, que solo corre al abrir/reservar.
  const maxLeverage = Number((meta.universe[idx] as any)?.maxLeverage);
  return { assetId: idx, szDecimals, markPx, maxLeverage };
}

// Resultado de la orden de entrada (límit IOC), discriminado:
//  - filled: posición abierta. - rejected: HL la rechazó explícitamente (sin posición → failed).
//  - ambiguous: respuesta no concluyente (resting/waitingForFill/desconocida) → unknown, reconciliar.
type EntryResult =
  | { kind: "filled"; filledSize: number; avgPx: number; oid: string }
  | { kind: "rejected"; reason: string }
  | { kind: "ambiguous"; detail: string };

function parseEntryResult(response: unknown): EntryResult {
  const st = (response as any)?.response?.data?.statuses?.[0];
  if (st?.filled?.oid != null) {
    const filledSize = Number(st.filled.totalSz);
    const avgPx = Number(st.filled.avgPx);
    if (Number.isFinite(filledSize) && filledSize > 0 && Number.isFinite(avgPx) && avgPx > 0) {
      return { kind: "filled", filledSize, avgPx, oid: String(st.filled.oid) };
    }
  }
  if (st?.error) return { kind: "rejected", reason: String(st.error) };
  return { kind: "ambiguous", detail: JSON.stringify(st ?? null).slice(0, 200) };
}

// Suma de fills de un cloid concreto (tamaño y precio medio ponderado).
export async function fillsByCloid(info: InfoClient, user: string, target: string): Promise<{ size: number; avgPx: number }> {
  const fills = await info.userFills({ user: user as `0x${string}` });
  let size = 0, notional = 0;
  for (const f of fills as any[]) {
    if (f.cloid && f.cloid.toLowerCase() === target.toLowerCase()) {
      const sz = Number(f.sz), px = Number(f.px);
      if (Number.isFinite(sz) && Number.isFinite(px)) { size += sz; notional += sz * px; }
    }
  }
  return { size, avgPx: size > 0 ? notional / size : 0 };
}

// Precio trigger del SL stop-market según el lado de la posición.
function slTriggerPx(side: "Long" | "Short", entryPx: number, stopLossPct: number): number {
  // Long protege con un Sell por debajo; Short con un Buy por encima.
  return side === "Long" ? entryPx * (1 - stopLossPct / 100) : entryPx * (1 + stopLossPct / 100);
}

// Resultado de colocar el SL:
//  - resting/filled: con oid → SL en el book / ya ejecutado.
//  - pending: HL aceptó el trigger pero devolvió "waitingForTrigger" (literal, SIN oid) → se
//    confirma luego por CLOID en reconcileExecution; NO inventar oid ni declarar protegido.
type SlPlaceResult =
  | { state: "resting" | "filled"; oid: string }
  | { state: "pending" };

// Coloca el SL stop-MARKET reduceOnly (banda fija SL_MARKET_SLIPPAGE_FRACTION). Devuelve el
// resultado discriminado o lanza si HL rechaza.
export async function placeStopLoss(
  exchange: ExchangeClient, assetId: number, szDecimals: number,
  side: "Long" | "Short", filledSize: number, entryPx: number,
  stopLossPct: number, slCloidVal: `0x${string}`,
): Promise<SlPlaceResult> {
  const triggerPx = slTriggerPx(side, entryPx, stopLossPct);
  const isBuy = side === "Short";                  // cerrar un Short = Buy; cerrar un Long = Sell
  // Peor precio aceptable al activarse (banda 1%): cerrar un Short = comprar hasta +1%;
  // cerrar un Long = vender hasta −1%. Banda fina: en un gap > 1% puede NO llenarse.
  const marketLimitPx = isBuy
    ? triggerPx * (1 + SL_MARKET_SLIPPAGE_FRACTION)
    : triggerPx * (1 - SL_MARKET_SLIPPAGE_FRACTION);
  const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
  let resp: unknown;
  try {
    resp = await exchange.order({
      orders: [{
        a: assetId,
        b: isBuy,
        // Límite del market AGRESIVO en la dirección del cierre (buy→ceil, sell→floor) para que la
        // banda nunca quede < 1% tras normalizar al tick. El triggerPx es el nivel de activación
        // (no la ejecución) → redondeo al más cercano basta.
        p: aggressiveHlPriceStr(marketLimitPx, szDecimals, isBuy),
        s: String(floorToDecimals(filledSize, szDecimals)),
        r: true,                                      // reduceOnly
        t: { trigger: { isMarket: true, triggerPx: formatHlPrice(triggerPx, szDecimals), tpsl: "sl" } },
        c: slCloidVal,
      }],
      grouping: "na",
    }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
  } catch (e) {
    // Clasificación por CAPA de error del SDK (jerarquía: HttpRequestError extends TransportError):
    //  - TransportError (incl. el timeout INTERNO de 10s del transporte, red, 5xx, 4xx): la orden
    //    PUDO despacharse y aceptarse aunque la respuesta se perdiera → AMBIGUO → pending
    //    (slSubmittedAt + grace + confirmación por CLOID en reconcileExecution).
    //  - Resto (ValidationError y errores de firma pre-envío, ApiRequestError = rechazo EXPLÍCITO
    //    de HL): DEFINITIVO sin orden colocada → throw → sl_failed (observable). La consulta
    //    orderStatus(slCloid) ANTES de recolocar + idempotencia por CLOID impiden un 2º SL aunque
    //    HL hubiera aceptado (el siguiente ciclo lo ve como open→protected y no recoloca).
    if (e instanceof TransportError) return { state: "pending" };
    throw e;
  } finally {
    ac.clear();
  }
  // Defensa en profundidad: si una versión del SDK devolviera el error en vez de lanzarlo.
  const st = (resp as any)?.response?.data?.statuses?.[0];
  if (st?.error) throw new Error(String(st.error));   // rechazo EXPLÍCITO de HL: sin orden → sl_failed (rota CLOID al reintentar)
  // resting/filled traen oid. "waitingForTrigger" y "waitingForFill" son LITERALES string (SDK
  // 0.32.2), respuestas EXITOSAS de order() sin oid: orden aceptada a la espera del cruce / del
  // llenado → pending (se confirma por CLOID en la reconciliación, NO inventar oid ni protected).
  if (st?.resting?.oid != null) return { state: "resting", oid: String(st.resting.oid) };
  if (st?.filled?.oid != null) return { state: "filled", oid: String(st.filled.oid) };
  if (st === "waitingForTrigger" || st === "waitingForFill") return { state: "pending" };
  throw new Error(`Respuesta de SL ambigua: ${JSON.stringify(st ?? null).slice(0, 120)}`);
}

// szi (tamaño firmado) de la posición del activo; 0 si no hay posición. Para detectar cierre.
async function positionSzi(info: InfoClient, user: string, asset: string): Promise<number> {
  const ch = await info.clearinghouseState({ user: user as `0x${string}` });
  const pos = (ch.assetPositions ?? []).find((p: any) => p.position?.coin === asset);
  return pos ? Number(pos.position?.szi ?? 0) : 0;
}

export function makeClients(privKey: `0x${string}`, isTestnet: boolean) {
  const wallet = privateKeyToAccount(privKey);
  const transport = new HttpTransport({ isTestnet });
  return {
    wallet,
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ transport, wallet }),
  };
}

// --- Cierre de emergencia (one-off, capital real reduceOnly): aplana la posición del activo y
// cancela sus órdenes vivas (SL). reduceOnly = SOLO reduce, nunca abre/invierte. Lo invoca el
// USUARIO vía CLI para desbloquear el borrado del bot (la reconciliación marca las ejecuciones
// closed al ver szi==0). NO marca DB aquí: deja que el cron de reconcileExecution lo cierre. ---
export const closePositionEmergency = internalAction({
  args: { hlAccountId: v.id("hl_api_credentials"), asset: v.string() },
  handler: async (ctx, { hlAccountId, asset }): Promise<any> => {
    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: hlAccountId });
    if (!credential) throw new Error("Cuenta HL no encontrada");
    const a = asset.toUpperCase();
    const { info, exchange } = makeClients(decryptPrivateKey(credential), hlIsTestnet());
    const { assetId, szDecimals, markPx } = await getAssetMeta(info, a);
    const tradingAccount = credential.tradingAccountAddress as `0x${string}`;

    // 1) Posición actual del activo.
    const chState = await info.clearinghouseState({ user: tradingAccount });
    const pos = (chState.assetPositions ?? []).find((p: any) => p.position?.coin === a);
    const szi = pos ? Number(pos.position?.szi ?? 0) : 0;

    // 2) Aplanar PRIMERO (reduceOnly IOC market agresivo) — nunca deja la posición sin SL antes de cerrar.
    let closeResult: any = "no_position";
    if (Math.abs(szi) > 0) {
      const isBuy = szi < 0;                            // short → BUY para cerrar
      const size = floorToDecimals(Math.abs(szi), szDecimals);
      const limitPx = isBuy ? markPx * (1 + ENTRY_IOC_SLIPPAGE) : markPx * (1 - ENTRY_IOC_SLIPPAGE);
      const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
      try {
        const resp = await exchange.order({
          orders: [{ a: assetId, b: isBuy, p: aggressiveHlPriceStr(limitPx, szDecimals, isBuy), s: String(size), r: true, t: { limit: { tif: "Ioc" } } }],
          grouping: "na",
        }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
        closeResult = (resp as any)?.response?.data?.statuses?.[0] ?? resp;
      } finally { ac.clear(); }
    }

    // 3) Confirmar FLAT antes de tocar los SL (Codex ALTO): si el IOC se llenó PARCIAL o falló,
    // queda posición residual y NO se deben cancelar sus SL (dejaría capital real sin protección).
    const after = await info.clearinghouseState({ user: tradingAccount });
    const posAfter = (after.assetPositions ?? []).find((p: any) => p.position?.coin === a);
    const sziAfter = posAfter ? Number(posAfter.position?.szi ?? 0) : 0;

    // 4) SOLO si está flat: cancelar las órdenes vivas del activo (SL ya inútiles). Si NO está flat,
    // se dejan los SL intactos (protección) y se devuelve sziAfter != 0 → el llamador NO borra/desarma.
    // (Codex ALTO) FAIL-CLOSED: tras cancelar, RE-LEER y exigir que NO quede ninguna orden del activo.
    // `ordersRemaining = null` = no se intentó (posición no flat); 0 = limpio; >0 = quedó alguna viva.
    // El llamador solo cierra/desarma/borra si sziAfter===0 Y ordersRemaining===0 (sin SL huérfano).
    const canceled: string[] = [];
    let ordersRemaining: number | null = null;
    if (sziAfter === 0) {
      const open: any[] = await info.frontendOpenOrders({ user: tradingAccount });
      const assetOrders = open.filter((o: any) => o?.coin === a);
      for (const o of assetOrders) {
        try {
          if (o.cloid) await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: o.cloid as `0x${string}` }] });
          else await exchange.cancel({ cancels: [{ a: assetId, o: Number(o.oid) }] });
          canceled.push(String(o.oid));
        } catch { /* re-lectura de abajo decide el resultado, no este catch */ }
      }
      // Confirmación dura: cualquier orden del activo que siga viva = NO limpio → el llamador aborta.
      const openAfter: any[] = await info.frontendOpenOrders({ user: tradingAccount });
      ordersRemaining = openAfter.filter((o: any) => o?.coin === a).length;
    }
    return { sziBefore: szi, closeResult, canceledOrders: canceled, sziAfter, ordersRemaining };
  },
});

// (G4) Acción PÚBLICA: cerrar la posición de un bot desde el portal (al quitarlo, sin quedar
// bloqueado). Auth canTradeLive + ownership → aplana la posición del activo + cancela sus órdenes
// (reduceOnly, vía closePositionEmergency) y, si queda flat, cierra en DB las ejecuciones abiertas y
// pide el desarmado de cualquier trigger_arm. Tras esto deletePoolBot ya no se bloquea.
export const closeBotPosition = action({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }): Promise<any> => {
    const user = await ctx.runQuery(internal.users.getCurrentUserInternal, {});
    await ctx.runQuery(internal.users.assertTradeLiveInternal, {});
    const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: botId });
    if (!bot) throw new Error("Bot no encontrado");
    if (bot.userId !== user._id) throw new Error("Ese bot no te pertenece.");
    if (!bot.hlAccountId) throw new Error("El bot no tiene cuenta HL vinculada.");
    if (!bot.baseAsset) throw new Error("El bot no tiene activo base.");

    // (CodeRabbit #3) closePositionEmergency aplana TODA la posición del activo de la cuenta. Es
    // seguro porque rige la INVARIANTE 1 cuenta = 1 bot: getOrCreatePoolBot rechaza vincular una
    // cuenta HL ya asignada a otro bot ("Esa cuenta ya está asignada a otro bot") → la posición de
    // ese activo en esa cuenta pertenece EXCLUSIVAMENTE a este bot. No hay otro consumidor que cerrar.
    // Aplanar la posición del activo + cancelar sus órdenes (reduceOnly: solo reduce, nunca abre).
    const closeRes = await ctx.runAction(internal.hyperliquid.closePositionEmergency, {
      hlAccountId: bot.hlAccountId, asset: bot.baseAsset,
    });
    // Solo si HL confirma flat Y sin órdenes vivas del activo (sin SL huérfano): cerrar en DB las
    // ejecuciones JAV-37 abiertas y desarmar arms JAV-44. Si no, NO se toca nada → el bot queda
    // intacto y protegido para reintentar (Codex: fail-closed, nunca borrar dejando un SL vivo).
    if (closeRes?.sziAfter === 0 && closeRes?.ordersRemaining === 0) {
      await ctx.runMutation(internal.executions.closeOpenExecutionsForBotInternal, { botId });
      await ctx.runMutation(internal.triggerArms.requestDisarmAndDeactivate, { botId });
    }
    return closeRes;
  },
});

// --- Ejecución segura (JAV-37) ---

export const executePerpMarketOrder = action({
  args: {
    botId: v.id("bots"),
    side: v.union(v.literal("Long"), v.literal("Short")),
    tradeAmount: v.number(),
    idempotencyKey: v.string(),
    expectedNetwork: v.string(),
    confirmLive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.users.getCurrentUserInternal, {});
    const [tradingConfig, simConfig] = await Promise.all([
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
    ]);

    // Autorización de trading real (no admin-only): permiso canTradeLive (admin tiene bypass).
    // Fail-fast aquí; revalidado de forma autoritativa en reserveExecution y markSubmitting.
    await ctx.runQuery(internal.users.assertTradeLiveInternal, {});
    if (!args.confirmLive) throw new Error("Live execution requires explicit confirmation");
    if (tradingConfig?.value !== true) throw new Error("Live trading is disabled");
    if (simConfig?.value !== false) throw new Error("Simulation mode is active — live execution blocked");
    if (!Number.isFinite(args.tradeAmount) || args.tradeAmount <= 0) throw new Error("tradeAmount must be a finite number > 0");
    assertExpectedNetwork(args.expectedNetwork);   // backend = fuente de verdad de la red

    const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: args.botId });
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id) throw new Error("Bot does not belong to this user");
    if (!bot.hlAccountId) throw new Error("Bot has no Hyperliquid account linked");
    if (!bot.baseAsset) throw new Error("Bot has no base asset");
    if (!bot.active) throw new Error("Bot is not active");
    if (bot.simulationMode) throw new Error("Bot is in simulation mode — live execution blocked");
    if (!bot.poolId) throw new Error("Bot has no pool linked");
    if (bot.stopLossPct === undefined || !Number.isFinite(bot.stopLossPct) || bot.stopLossPct <= 0 || bot.stopLossPct >= 100) {
      throw new Error("Bot stopLossPct is missing or invalid");
    }
    const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: bot.poolId });
    if (!pool) throw new Error("Linked pool not found");
    if (pool.closed) throw new Error("Linked pool is closed");

    if (!bot.direction) throw new Error("Bot has no direction");
    const dirOk = bot.direction === "long_short"
      || (bot.direction === "long" && args.side === "Long")
      || (bot.direction === "short" && args.side === "Short");
    if (!dirOk) throw new Error(`side ${args.side} incompatible con la dirección del bot (${bot.direction})`);

    // El leverage (auto o manual) lo resuelve reserveExecution con el helper compartido, de forma
    // atómica con el margen comprometido de la cuenta (Codex). Aquí solo se transporta la config.
    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: bot.hlAccountId });
    if (!credential) throw new Error("Hyperliquid account not found");
    if (credential.userId !== user._id) throw new Error("Account does not belong to this user");

    const asset = bot.baseAsset.toUpperCase();
    const { info, exchange } = makeClients(decryptPrivateKey(credential), hlIsTestnet());
    const { assetId, szDecimals, markPx, maxLeverage } = await getAssetMeta(info, asset);

    // Dos precios distintos (Codex): el que se ENVÍA y el que se usa para DIMENSIONAR/RESERVAR.
    //  - orderLimitPx: límite agresivo de la IOC para cruzar el book (Long arriba, Short abajo).
    //  - notionalCapPx: cota de precio de fill = markPx*(1+slip) para AMBOS lados, redondeada ARRIBA.
    //    En Long es garantía DURA del nocional (el límite de compra es techo del precio). En Short
    //    NO hay cota dura: el límite de venta es un suelo y la venta se llena ≈ al bid; un spike
    //    alcista sub-segundo entre el snapshot de markPx y el fill PODRÍA superar la cota (residuo
    //    posible, no garantizado). El MARGIN_SAFETY_BUFFER da holgura de margen, NO acota el nocional.
    const isBuy = args.side === "Long";
    const orderLimitPx = isBuy
      ? markPx * (1 + ENTRY_IOC_SLIPPAGE)
      : markPx * (1 - ENTRY_IOC_SLIPPAGE);
    // Redondeo AGRESIVO en la dirección de la orden (Long compra→ceil, Short venta→floor) para que
    // tras normalizar al tick el límite no se acerque al book (reintroduciría el "no cruza/no llena").
    const orderLimitPxStr = aggressiveHlPriceStr(orderLimitPx, szDecimals, isBuy);
    const notionalCapPx = ceilHlPrice(markPx * (1 + ENTRY_IOC_SLIPPAGE), szDecimals);
    // Dimensionar con el techo (ya redondeado): el fill nunca supera el nocional reservado (Long);
    // en Short queda dentro salvo spike sub-segundo.
    const size = floorToDecimals(args.tradeAmount / notionalCapPx, szDecimals);
    if (size <= 0) throw new Error("Order size rounds to zero at current price");
    const actualNotional = size * notionalCapPx;

    const entryCloid = cloid(args.idempotencyKey);
    const slCloid = cloid(args.idempotencyKey, ":sl:0");
    const tradingAccount = credential.tradingAccountAddress as `0x${string}`;

    // (a) Dedupe-check temprano (Codex): un reintento de una solicitud existente se reconcilia SIN
    // re-evaluar modo/margen (que pudieron cambiar), evitando bloquear su recuperación.
    const existing = await ctx.runQuery(internal.executions.findByIdempotency, {
      userId: user._id, idempotencyKey: args.idempotencyKey,
    });
    if (existing) {
      // Misma validación que reserveExecution: una clave reutilizada con otros parámetros es
      // un conflicto, no un éxito (Codex). Solo se reconcilia si los parámetros coinciden.
      const same = existing.botId === bot._id && existing.side === args.side
        && existing.network === hlNetwork() && existing.requestedAmount === args.tradeAmount;
      if (!same) throw new Error("Conflicto de idempotencia: la clave ya existe con otros parámetros.");
      if (!["closed", "failed"].includes(existing.status)) {
        await ctx.runAction(internal.hyperliquid.reconcileExecution, { requestId: existing._id });
      }
      return { ok: true, deduped: true, requestId: existing._id };
    }

    // (b) Gates solo para reserva NUEVA. Gate 1: la cuenta debe estar en modo unified.
    const abstraction = await info.userAbstraction({ user: tradingAccount });
    if (abstraction !== "unifiedAccount") {
      throw new Error("La cuenta HL no está en modo unified; operación bloqueada por seguridad.");
    }
    // Colateral conservador SIN doble conteo (Codex): solo USDC spot LIBRE (total − hold, ≥0).
    // El margen ya comprometido por otras ejecuciones de la cuenta lo descuenta reserveExecution
    // de forma ATÓMICA (anti-carrera). HL sigue siendo la autoridad final del margen.
    const spotState = await info.spotClearinghouseState({ user: tradingAccount });
    const availableCollateral = (spotState.balances ?? [])
      .filter((b) => b.coin === "USDC")
      .reduce((s, b) => s + Math.max(0, parseFloat(b.total ?? "0") - parseFloat(b.hold ?? "0")), 0);

    // (c) Reserva atómica: idempotency + nocional + LEVERAGE + MARGEN por cuenta, ANTES de tocar HL.
    // reserveExecution resuelve el leverage (auto/manual) con el helper y devuelve el applied.
    const reservation = await ctx.runMutation(internal.executions.reserveExecution, {
      userId: user._id, botId: bot._id, idempotencyKey: args.idempotencyKey,
      hlAccountId: bot.hlAccountId, asset, stopLossPct: bot.stopLossPct,
      requestedAmount: args.tradeAmount,
      notional: actualNotional, availableCollateral,
      autoLeverage: bot.autoLeverage === true, manualLeverage: bot.leverage,
      assetMaxLeverage: maxLeverage,
      side: args.side, network: hlNetwork(),
      entryCloid, slCloid,
    });
    const requestId = reservation.requestId;
    if (reservation.alreadyExists) {
      // Carrera: otra ejecución creó la fila entre (a) y (c). Reconciliar si no es FINAL.
      // NO se re-ejecuta updateLeverage: el leverage ya quedó fijado en su envío original (Codex #3).
      if (!["closed", "failed"].includes(reservation.status)) {
        await ctx.runAction(internal.hyperliquid.reconcileExecution, { requestId });
      }
      return { ok: true, deduped: true, requestId };
    }
    // Reserva NUEVA: el leverage resuelto por el helper gobierna el updateLeverage de abajo.
    const appliedLeverage = reservation.appliedLeverage;
    if (!Number.isFinite(appliedLeverage) || appliedLeverage <= 0) {
      throw new Error("appliedLeverage inválido devuelto por la reserva");
    }

    // Gate (CAS pending→submitting + revalida) ANTES de cualquier efecto HL — incluido
    // updateLeverage, que es una escritura real en HL.
    const sub = await ctx.runMutation(internal.executions.markSubmitting, { requestId });
    if (!sub.ok) {
      // "blocked": switch/permiso/estado del bot cambió → cerrar failed (sin posición).
      // "state"/"not_found": otro proceso (cron) ya avanzó → NO tocar.
      if (sub.reason === "blocked") {
        await ctx.runMutation(internal.executions.settleExecution, {
          requestId, status: "failed", error: "blocked at submit (switch/permiso/estado bot)",
        });
        return { ok: false, status: "failed", requestId };
      }
      return { ok: false, status: "aborted", requestId, reason: sub.reason };
    }

    await exchange.updateLeverage({ asset: assetId, isCross: false, leverage: appliedLeverage });

    // Gate ATÓMICO justo antes del envío (updateLeverage pudo tardar >LEASE_MS y el cron tomar el
    // control). blocked → ya cerrado failed por CAS; state/expired/claimed → no tocar (otro lo maneja).
    const gate = await ctx.runMutation(internal.executions.gateBeforeOrder, { requestId });
    if (!gate.ok) {
      return { ok: false, status: gate.reason === "blocked" ? "failed" : "aborted", requestId, reason: gate.reason };
    }

    let entryResp: unknown;
    const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
    // Usa el orderLimitPx ya calculado/formateado (agresivo para cruzar el book). NO se recalcula
    // aquí: el mismo precio sustenta el dimensionado/reserva (Codex: coherencia precio↔nocional).
    try {
      entryResp = await exchange.order({
        orders: [{
          a: assetId, b: args.side === "Long",
          p: orderLimitPxStr, s: String(size),
          r: false, t: { limit: { tif: "Ioc" } }, c: entryCloid,
        }],
        grouping: "na",
      }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });   // HL no acepta la orden si llega tarde
    } catch (e) {
      // Resultado incierto (abort/red): NO marcar failed; queda reconciliable por cloid.
      await ctx.runMutation(internal.executions.settleExecution, {
        requestId, status: "unknown", error: String((e as Error)?.message ?? e),
      });
      return { ok: false, status: "unknown", requestId };
    } finally {
      ac.clear();
    }

    const entry = parseEntryResult(entryResp);
    if (entry.kind === "rejected") {   // HL rechazó explícitamente → sin posición
      await ctx.runMutation(internal.executions.settleExecution, { requestId, status: "failed", error: entry.reason });
      return { ok: false, status: "failed", requestId };
    }
    if (entry.kind === "ambiguous") {  // no concluyente → reconciliar, NO liberar como failed
      await ctx.runMutation(internal.executions.settleExecution, { requestId, status: "unknown", error: entry.detail });
      return { ok: false, status: "unknown", requestId };
    }
    const { filledSize, avgPx, oid: entryOid } = entry;
    await ctx.runMutation(internal.executions.settleExecution, {
      requestId, status: "entry_filled", entryOrderId: entryOid, filledSize, entryPrice: avgPx,
    });
    // La colocación del SL pasa SIEMPRE por reconcileExecution (claim exclusivo) — evita que un
    // reintento/cron coloque un segundo SL en paralelo con esta action.
    const rec = await ctx.runAction(internal.hyperliquid.reconcileExecution, { requestId });
    return { ok: true, status: "entry_filled", requestId, filledSize, entryPrice: avgPx, reconcile: rec };
  },
});

// Reconciliación por cloid (recuperación). Claim exclusivo (anti-carrera) + idempotente.
export const reconcileExecution = internalAction({
  args: { requestId: v.id("execution_requests") },
  handler: async (ctx, { requestId }) => {
    // Claim exclusivo: serializa reconciliaciones; respeta el lease de la action que envía y los finales.
    const claim = await ctx.runMutation(internal.executions.claimReconcile, { requestId });
    if (!claim.claimed) return { skipped: claim.reason };
    const token = claim.token;
    try {
      const req = await ctx.runQuery(internal.executions.getRequestInternal, { requestId });
      if (!req) return { skipped: "not_found" };

      // Snapshot inmutable: cuenta/asset/SL/red de la solicitud, NUNCA del bot.
      const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: req.hlAccountId });
      if (!credential) return { skipped: "no_credential" };
      const user = credential.tradingAccountAddress;
      const { info, exchange } = makeClients(decryptPrivateKey(credential), req.network === "testnet");
      const asset = req.asset.toUpperCase();
      const { assetId, szDecimals } = await getAssetMeta(info, asset);

      // (a) Fill de la entrada. Si YA está persistido (entry_filled/protected/sl_failed) es la
      // verdad: nunca se degrada a "sin entrada" por una lectura vacía de userFills.
      let filledSize = req.filledSize ?? 0;
      let entryPrice = req.entryPrice ?? 0;
      if (filledSize <= 0) {
        const entryStatus: any = await info.orderStatus({ user: user as `0x${string}`, oid: req.entryCloid });
        const entryFill = await fillsByCloid(info, user, req.entryCloid);
        if (entryFill.size > 0) {
          filledSize = entryFill.size; entryPrice = entryFill.avgPx;
        } else {
          const est = entryStatus.order?.status;
          if (est === "filled") {
            // orderStatus dice filled pero userFills aún no lo refleja (lag) → hubo ejecución:
            // NUNCA cerrar como failed; mantener unknown y reintentar para obtener los datos.
            await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "unknown", error: "filled sin datos de fill aún" });
            return { skipped: "fill_data_pending" };
          }
          if (est && est !== "open" && est !== "triggered") {
            // Estado terminal explícito sin fill (canceled/rejected/iocCancelRejected/…) → failed.
            await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "failed", error: `entry ${est}` });
            return { result: "failed_no_entry" };
          }
          if (entryStatus.status === "unknownOid") {
            // Sin orden conocida. Cerrar como failed solo cuando el intento esté DEFINITIVAMENTE
            // vencido: medido desde submittedAt (la action aborta a HL_ORDER_TIMEOUT_MS). Si nunca se
            // envió (sin submittedAt), se mide desde createdAt.
            const since = req.submittedAt ?? req.createdAt;
            if (Date.now() - since > ENTRY_GRACE_MS) {
              await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "failed", error: "entry unknownOid (grace)" });
              return { result: "failed_no_entry" };
            }
            return { skipped: "entry_unknown_grace" };
          }
          return { skipped: "entry_pending" };   // open/triggered
        }
      }

      // (a') Validar el fill antes de tocar el SL: tamaño y precio finitos > 0 (fillsByCloid puede
      // dar size > 0 con avgPx ≤ 0). Datos inválidos → unknown, reconciliable.
      if (!(filledSize > 0 && Number.isFinite(entryPrice) && entryPrice > 0)) {
        await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "unknown", error: "fill inválido (size/price)" });
        return { skipped: "invalid_fill" };
      }

      // (b) Posición abierta. Estado del SL actual. orderStatus devuelve open/triggered/filled/
      // terminales/unknownOid (NUNCA "waitingForTrigger": ese literal solo aparece en la respuesta
      // de exchange.order, manejado en placeStopLoss).
      const slStatus: any = await info.orderStatus({ user: user as `0x${string}`, oid: req.slCloid });
      let slCloidToUse: `0x${string}`;
      if (slStatus.status === "order") {
        const state = slStatus.order?.status;
        if (state === "filled") {
          await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "closed", filledSize, entryPrice });
          return { result: "closed" };
        }
        if (state === "open") {
          // Único estado que representa el trigger en reposo → protegido.
          await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "protected", filledSize, entryPrice });
          return { result: "protected_existing" };
        }
        if (state === "triggered") {
          // Disparado pero AÚN sin llenar (con banda 1% puede no cerrar). NO marcar protected ni
          // closed: salida pendiente, reconciliable en el siguiente ciclo. Observabilidad explícita.
          return { skipped: "sl_triggered_pending" };
        }
        // (G5) El SL ya NO está resting (canceled/rejected). ANTES de recolocar, comprobar si la
        // POSICIÓN está cerrada: si se cerró por fuera (cierre manual del portal, SL ejecutado por
        // otra vía, cierre en HL), HL cancela el SL reduceOnly y, sin esto, el reconcile entra en
        // BUCLE recolocando un SL sobre una posición inexistente y la ejecución queda `protected`
        // para siempre (bloquea el borrado del bot). Confirmación DIFERIDA (Codex MEDIO): szi==0 debe
        // mantenerse a lo largo de FLAT_CONFIRM_GRACE_MS entre ciclos del cron (lecturas separadas en
        // el tiempo), no dos lecturas seguidas de la misma fuente que un lag consistente engañaría.
        const flat = await positionSzi(info, user, asset);
        if (flat === 0) {
          if (req.flatSince === undefined) {
            // Primera observación flat → registrar y ESPERAR a confirmar en un ciclo posterior.
            await ctx.runMutation(internal.executions.setExecutionFlatSince, { requestId, token, value: Date.now() });
            return { skipped: "flat_observed_pending_confirm" };
          }
          if (Date.now() - req.flatSince >= FLAT_CONFIRM_GRACE_MS) {
            await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "closed", filledSize, entryPrice });
            return { result: "closed_position_flat" };
          }
          return { skipped: "flat_grace" };
        }
        // Posición VIVA: limpiar una marca flatSince previa (falsa alarma por lag) antes de recolocar.
        if (req.flatSince !== undefined) {
          await ctx.runMutation(internal.executions.setExecutionFlatSince, { requestId, token, value: null });
        }
        // canceled/rejected/… con posición VIVA → recolocar con uno NUEVO (CAS + fencing).
        const attempt = (req.slAttempt ?? 0) + 1;
        const next = cloid(req.idempotencyKey, `:sl:${attempt}`);
        const prep = await ctx.runMutation(internal.executions.prepareSlRetry, { requestId, token, newSlCloid: next, attempt });
        if (!prep.ok) return { skipped: "sl_retry_race" };
        slCloidToUse = next;
      } else {
        // unknownOid. Si ya aceptamos un SL con este cloid (slSubmittedAt) dentro del grace, es lag
        // de orderStatus → NO recolocar (evita un 2º SL); esperar al siguiente ciclo.
        if (req.slSubmittedAt && Date.now() - req.slSubmittedAt < SL_SUBMIT_GRACE_MS) {
          return { skipped: "sl_submit_grace" };
        }
        // El SL nunca se colocó con este cloid (o el grace ya venció sin aparecer) → colocarlo.
        slCloidToUse = req.slCloid as `0x${string}`;
      }

      // La renovación del claim es la ÚLTIMA operación previa al envío.
      const renew = await ctx.runMutation(internal.executions.renewReconcile, { requestId, token });
      if (!renew.ok) return { skipped: "lease_lost" };
      try {
        const sl = await placeStopLoss(exchange, assetId, szDecimals, req.side, filledSize, entryPrice, req.stopLossPct, slCloidToUse);
        if (sl.state === "pending") {
          // waitingForTrigger/waitingForFill o timeout: SL aceptado/incierto sin oid. Marcar
          // slSubmittedAt y dejar entry_filled; el siguiente ciclo lo confirma por CLOID
          // (open→protected). Evita declarar protected sin oid.
          // FAIL-CLOSED (CodeRabbit): si el marcador NO se persiste (lease/token perdido), NO
          // reportar éxito — otro reconciliador tiene el claim y se encargará; reportar la carrera
          // para no afirmar pending sin haber dejado el grace anti-doble-SL.
          const mark = await ctx.runMutation(internal.executions.markSlSubmitted, { requestId, token });
          if (!mark.ok) return { skipped: "sl_mark_race" };
          return { result: "sl_pending_confirmation" };
        }
        const st = sl.state === "filled" ? "closed" as const : "protected" as const;
        // En resting marcamos también slSubmittedAt (grace anti-doble-SL si hay lag posterior).
        await ctx.runMutation(internal.executions.settleExecution, {
          requestId, token, status: st, slOrderId: sl.oid, filledSize, entryPrice,
          slSubmittedAt: sl.state === "resting" ? Date.now() : undefined,
        });
        return { result: st === "closed" ? "closed_placed" : "protected_placed" };
      } catch (e) {
        await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "sl_failed", filledSize, entryPrice, error: String((e as Error)?.message ?? e) });
        return { result: "sl_failed" };
      }
    } finally {
      await ctx.runMutation(internal.executions.releaseReconcile, { requestId, token });
    }
  },
});
