"use node";

// (QSG / JAV-90) Connector AISLADO de Hyperliquid SPOT para el módulo Quantum Spot Grid.
// Capa pura de integración: resolver de assets spot por red, redondeo spot, lecturas de
// precio/balance/fees y construcción/envío de órdenes LIMIT. NO crea bots ni motor (eso es PR2/PR3).
//
// AISLAMIENTO (Codex): este módulo NO importa el path perp/money-path. En concreto NO importa
// convex/hyperliquid.ts (que arrastra _generated/server) ni triggerArms.ts. El cloid viene del
// helper hoja convex/cloids.ts. makeSpotClients se reimplementa localmente (es trivial).
//
// SEGURIDAD: las LECTURAS de cuenta (balances/openOrders/fills) usan SIEMPRE el
// `tradingAccountAddress` (la cuenta principal), NUNCA la agent wallet — la agent wallet sólo FIRMA
// (Codex #9). Nunca se loguean claves ni firmas. Solo órdenes LIMIT (sin reduceOnly/trigger).

import { ExchangeClient, InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { toHlCloid, spotGridCloidInput } from "./cloids";
import type { HlNetwork } from "./hlNetwork";

// assetId de un activo SPOT en HL = 10000 + índice de su universe (Codex #4: NO hardcodear el id;
// se descubre desde spotMeta por red).
export const SPOT_ASSET_ID_OFFSET = 10000;

// Timeout por defecto del envío de órdenes spot. Igual criterio que el path perp (HL_ORDER_TIMEOUT_MS
// = 30s): el envío real NUNCA debe quedar colgado y bloquear un lease/reconcile en PR3.
export const SPOT_ORDER_TIMEOUT_MS = 30_000;

// Aborta REALMENTE la request (AbortController + signal del SDK). clearTimeout evita el timer
// colgante. Helper local para mantener el connector AISLADO (no importa hyperliquid.ts).
export function abortAfter(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("HL spot request timeout")), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

export type SpotRpcOpts = { signal?: AbortSignal; expiresAfter?: number; timeoutMs?: number };

/**
 * (Codex #3-pr1-r2) Prepara las opciones de un RPC real a HL garantizando timeout/abort LOCAL
 * SIEMPRE, incluso si el caller (PR3) pasa su propio `signal` (p.ej. atado al lease): se COMBINAN
 * con `AbortSignal.any([callerSignal, localTimeout])`, de modo que la request aborta al primero de
 * los dos. `expiresAfter` evita aceptación tardía por HL, pero NO aborta la request local — por eso
 * el timeout local es imprescindible. Devuelve `clear()` para soltar el timer en finally.
 */
export function withSpotTimeout(opts?: SpotRpcOpts): {
  signal: AbortSignal;
  expiresAfter: number;
  clear: () => void;
} {
  const timeoutMs = opts?.timeoutMs ?? SPOT_ORDER_TIMEOUT_MS;
  const local = abortAfter(timeoutMs);
  const signal = opts?.signal ? AbortSignal.any([opts.signal, local.signal]) : local.signal;
  const expiresAfter = opts?.expiresAfter ?? Date.now() + timeoutMs;
  return { signal, expiresAfter, clear: local.clear };
}

// Quote canónica del MVP. Hyperliquid Spot no ofrece quote USDT para estos pares → USDC siempre.
export const SPOT_QUOTE = "USDC";

// Nocional mínimo de orden en HL (~$10). Por debajo, HL rechaza ("Order must have minimum value").
export const MIN_SPOT_NOTIONAL_USD = 10;

// Allowlist LÓGICA del MVP (decisión de producto). El símbolo real del token base se resuelve por
// red desde spotMeta (mainnet usa los activos Unit UBTC/UETH; testnet suele exponer BTC/ETH).
export const ALLOWED_SPOT_BASES = ["BTC", "ETH"] as const;
export type SpotBase = (typeof ALLOWED_SPOT_BASES)[number];

/**
 * Nombres de token base candidatos para un activo lógico, por red. El resolver prueba estos
 * candidatos contra spotMeta en orden y se queda con el primero que exista emparejado con USDC.
 * No hardcodea assetId: solo acota qué nombre de token representa "BTC"/"ETH" en cada red.
 */
function baseTokenCandidates(logical: SpotBase, network: HlNetwork): string[] {
  if (network === "mainnet") {
    return logical === "BTC" ? ["UBTC"] : ["UETH"];
  }
  // testnet: el token canónico suele ser BTC/ETH, pero aceptamos también Unit como respaldo.
  return logical === "BTC" ? ["BTC", "UBTC"] : ["ETH", "UETH"];
}

export type ResolvedSpotAsset = {
  /** Activo lógico del MVP. */
  logicalBase: SpotBase;
  /** assetId a usar en el campo `a` de la orden (10000 + universeIndex). */
  assetId: number;
  /** Índice del universe en spotMeta. */
  universeIndex: number;
  /** Símbolo de presentación, p.ej. "UBTC/USDC". */
  symbol: string;
  /** Nombre del token base tal y como aparece en spotMeta (p.ej. "UBTC"). */
  baseAsset: string;
  /** Quote (siempre "USDC"). */
  quoteAsset: string;
  /** Decimales de tamaño del token base. */
  szDecimals: number;
};

/**
 * Resuelve un activo lógico ("BTC"/"ETH") contra un objeto spotMeta YA leído, por red. Función PURA
 * (testeable sin red). Rechaza activo fuera de la allowlist o par inexistente en esa red.
 * @param meta Respuesta de info.spotMeta() (o el meta de spotMetaAndAssetCtxs).
 * @param logicalBase "BTC" | "ETH".
 * @param network Red del backend (mainnet/testnet).
 */
export function resolveSpotAssetFromMeta(
  meta: { universe: any[]; tokens: any[] },
  logicalBase: string,
  network: HlNetwork,
): ResolvedSpotAsset {
  if (!ALLOWED_SPOT_BASES.includes(logicalBase as SpotBase)) {
    throw new Error(`Activo spot no permitido: '${logicalBase}'. Permitidos: ${ALLOWED_SPOT_BASES.join(", ")}.`);
  }
  const candidates = baseTokenCandidates(logicalBase as SpotBase, network);

  // (Codex #1-pr1) Los `tokens[].index` de spotMeta pueden tener HUECOS y NO coincidir con la
  // posición en el array. `universe[].tokens` referencia esos `index`, así que resolvemos por un
  // Map(index -> token), nunca por posición del array.
  const tokenByIndex = new Map<number, any>();
  for (const t of meta.tokens ?? []) tokenByIndex.set(Number(t.index), t);
  const tokenName = (idx: number): string => tokenByIndex.get(Number(idx))?.name ?? "";

  // Recorre cada par del universe; nos quedamos con el primer candidato (en orden de preferencia)
  // cuyo token base exista emparejado con USDC.
  let best: { u: any; baseTok: any; rank: number } | null = null;
  for (const u of meta.universe ?? []) {
    const baseIdx = u?.tokens?.[0];
    const quoteIdx = u?.tokens?.[1];
    const base = tokenName(baseIdx);
    const quote = tokenName(quoteIdx);
    if (quote !== SPOT_QUOTE) continue;
    const rank = candidates.indexOf(base);
    if (rank === -1) continue;
    if (best === null || rank < best.rank) best = { u, baseTok: tokenByIndex.get(Number(baseIdx)), rank };
  }
  if (best === null) {
    throw new Error(
      `Par spot no encontrado para '${logicalBase}/${SPOT_QUOTE}' en ${network} ` +
        `(candidatos base: ${candidates.join(", ")}). No se hardcodea: debe existir en spotMeta.`,
    );
  }

  const u = best.u;
  const baseTok = best.baseTok;
  const universeIndex = Number(u.index);
  return {
    logicalBase: logicalBase as SpotBase,
    assetId: SPOT_ASSET_ID_OFFSET + universeIndex,
    universeIndex,
    symbol: `${baseTok.name}/${SPOT_QUOTE}`,
    baseAsset: baseTok.name,
    quoteAsset: SPOT_QUOTE,
    szDecimals: Number(baseTok.szDecimals),
  };
}

// --- Precisión de precio/size SPOT ---------------------------------------------------------------
// HL spot: ≤5 cifras significativas y ≤ (8 − szDecimals) decimales en el precio (perps usan 6; spot
// usa 8). El size se trunca hacia abajo a szDecimals (nunca por encima del nocional disponible).

/** Decimales válidos del tick HL spot: el más restrictivo entre (8−szDecimals) y 5 sig. figs. */
function spotAllowedDecimals(price: number, szDecimals: number): number {
  const maxDecimals = Math.max(0, 8 - szDecimals);
  const intDigits = Math.floor(Math.log10(price)) + 1;
  const sigDecimals = 5 - intDigits; // puede ser negativo (precios de ≥6 dígitos enteros → tick ≥10)
  return Math.min(maxDecimals, sigDecimals);
}

/**
 * Redondeo DIRECCIONAL a un precio HL-spot válido. "floor" para BUY (maker más barato, no cruza
 * el book) y "ceil" para SELL (maker más caro). Corrige el ruido flotante de toFixed.
 */
export function roundSpotPrice(price: number, szDecimals: number, dir: "ceil" | "floor"): number {
  if (!(price > 0)) throw new Error("roundSpotPrice: price debe ser > 0");
  const decimals = spotAllowedDecimals(price, szDecimals);
  const tick = 10 ** -decimals;
  const outDecimals = Math.max(0, decimals);
  const q = price / tick;
  const n = dir === "ceil" ? Math.ceil(q) : Math.floor(q);
  let r = Number((n * tick).toFixed(outDecimals));
  if (dir === "ceil" && r < price) r = Number((r + tick).toFixed(outDecimals));
  if (dir === "floor" && r > price) r = Number((r - tick).toFixed(outDecimals));
  return r;
}

/** Precio HL-spot válido como string, redondeado en la dirección pedida. */
export function formatSpotPrice(price: number, szDecimals: number, dir: "ceil" | "floor"): string {
  return String(roundSpotPrice(price, szDecimals, dir));
}

/**
 * Trunca un tamaño hacia abajo a szDecimals. INVARIANTE DURA (money-path): el resultado NUNCA supera
 * `size` — en PR3 el size puede venir del balance/free o de un presupuesto exacto, así que jamás debe
 * generarse una orden mayor que lo disponible/autorizado. Por eso es floor estricto y NO se redondea
 * al alza para "recuperar" un tick por ruido binario (Codex MEDIO-pr1-r3: ese redondeo violaba la
 * invariante). La rara sub-truncación por ruido es conservadora y la valida igualmente
 * `roundAndValidateSpotOrder` (min-notional) aguas abajo.
 */
export function floorSpotSize(size: number, szDecimals: number): number {
  if (!(size > 0)) return 0;
  const f = 10 ** szDecimals;
  const r = Math.floor(size * f) / f;
  // Defensa ante ULP: si la división deja `r` un epsilon por ENCIMA de `size`, baja un tick.
  return r > size ? Math.max(0, Math.floor(size * f) - 1) / f : r;
}

/**
 * Lanza si el nocional (precio×tamaño) queda por debajo del mínimo de HL.
 * IMPORTANTE (Codex #2-pr1): valida SIEMPRE con los valores FINALES (post-redondeo/post-truncado),
 * no con los crudos — un nocional de $10 en crudo puede caer sub-mínimo tras floorSpotSize. Para no
 * depender de la disciplina del caller, usar `roundAndValidateSpotOrder`, que redondea y valida en
 * un solo paso.
 */
export function assertMinNotional(price: number, size: number, min = MIN_SPOT_NOTIONAL_USD): void {
  const notional = price * size;
  if (notional < min) {
    throw new Error(`Nocional de orden ${notional.toFixed(2)} < mínimo ${min} USD.`);
  }
}

export type RoundedSpotOrder = { priceStr: string; sizeStr: string; price: number; size: number };

/**
 * Redondea precio (direccional: BUY→floor, SELL→ceil) y trunca tamaño a szDecimals, y valida el
 * min-notional con los valores YA FINALES (Codex #2-pr1). Devuelve strings listos para la orden.
 * Es la API recomendada en el money-path: garantiza que lo validado es exactamente lo que se envía.
 */
export function roundAndValidateSpotOrder(args: {
  price: number;
  size: number;
  szDecimals: number;
  isBuy: boolean;
  min?: number;
}): RoundedSpotOrder {
  const price = roundSpotPrice(args.price, args.szDecimals, args.isBuy ? "floor" : "ceil");
  const size = floorSpotSize(args.size, args.szDecimals);
  assertMinNotional(price, size, args.min ?? MIN_SPOT_NOTIONAL_USD); // valida sobre valores FINALES
  return { priceStr: String(price), sizeStr: String(size), price, size };
}

// --- Construcción y envío de órdenes --------------------------------------------------------------

export type SpotLimitParams = {
  assetId: number;
  isBuy: boolean;
  /** Precio ya formateado a tick HL (usar formatSpotPrice). */
  priceStr: string;
  /** Tamaño ya formateado a szDecimals. */
  sizeStr: string;
  cloid: `0x${string}`;
  /** Gtc (resting maker, por defecto) | Alo (post-only). Spot MVP: sin market/IOC. */
  tif?: "Gtc" | "Alo";
};

/**
 * Construye el objeto de orden LIMIT spot (PURO, testeable). SIN reduceOnly (`r:false`) ni trigger:
 * spot no tiene posiciones a reducir. Idempotencia vía `c` (cloid determinista).
 */
export function buildSpotLimitOrder(p: SpotLimitParams) {
  return {
    orders: [
      {
        a: p.assetId,
        b: p.isBuy,
        p: p.priceStr,
        s: p.sizeStr,
        r: false,
        t: { limit: { tif: p.tif ?? "Gtc" } },
        c: p.cloid,
      },
    ],
    grouping: "na" as const,
  };
}

/** Crea los clientes HL (info + exchange firmado) para spot. Equivalente a makeClients perp. */
export function makeSpotClients(privKey: `0x${string}`, isTestnet: boolean) {
  const wallet = privateKeyToAccount(privKey);
  const transport = new HttpTransport({ isTestnet });
  return {
    wallet,
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ transport, wallet }),
  };
}

/** Lee spotMeta y resuelve el activo lógico por red. */
export async function resolveSpotAsset(
  info: InfoClient,
  logicalBase: string,
  network: HlNetwork,
): Promise<ResolvedSpotAsset> {
  const meta = await info.spotMeta();
  return resolveSpotAssetFromMeta(meta as any, logicalBase, network);
}

/** Precio mid (o mark como respaldo) del par spot resuelto, vía spotMetaAndAssetCtxs. */
export async function getSpotPrice(info: InfoClient, resolved: ResolvedSpotAsset): Promise<number> {
  const [meta, ctxs] = (await info.spotMetaAndAssetCtxs()) as [any, any[]];
  const pos = (meta.universe ?? []).findIndex((u: any) => Number(u.index) === resolved.universeIndex);
  const ctx = pos >= 0 ? ctxs[pos] : undefined;
  const mid = ctx?.midPx != null ? Number(ctx.midPx) : NaN;
  const mark = ctx?.markPx != null ? Number(ctx.markPx) : NaN;
  const px = Number.isFinite(mid) ? mid : mark;
  if (!Number.isFinite(px) || px <= 0) {
    throw new Error(`Precio spot no disponible para ${resolved.symbol}.`);
  }
  return px;
}

export type SpotBalance = { coin: string; total: number; hold: number; free: number };

/**
 * Balance spot de un coin para la cuenta principal (Codex #9: usa tradingAccountAddress, no la agent
 * wallet). `free` = total − hold (lo realmente disponible para nuevas órdenes).
 */
export async function getSpotBalance(
  info: InfoClient,
  tradingAccountAddress: string,
  coin: string,
): Promise<SpotBalance> {
  const state = (await info.spotClearinghouseState({ user: tradingAccountAddress as `0x${string}` })) as any;
  const b = (state.balances ?? []).find((x: any) => x.coin === coin);
  const total = b ? Number(b.total ?? 0) : 0;
  const hold = b ? Number(b.hold ?? 0) : 0;
  return { coin, total, hold, free: Math.max(0, total - hold) };
}

export type SpotFees = { spotMaker: number; spotTaker: number };

/** Tarifas spot efectivas del usuario (maker=Add, taker=Cross). Cuenta principal (Codex #9). */
export async function getUserFees(info: InfoClient, tradingAccountAddress: string): Promise<SpotFees> {
  const f = (await info.userFees({ user: tradingAccountAddress as `0x${string}` })) as any;
  const maker = Number(f.userSpotAddRate ?? f.feeSchedule?.spotAdd ?? 0);
  const taker = Number(f.userSpotCrossRate ?? f.feeSchedule?.spotCross ?? 0);
  return { spotMaker: maker, spotTaker: taker };
}

/**
 * Coloca una orden LIMIT spot real. (Codex #3-pr1) SIEMPRE con timeout/abort + expiresAfter: el
 * envío real no debe colgar el reconcile/lease del motor (PR3). Por defecto SPOT_ORDER_TIMEOUT_MS;
 * el caller puede inyectar su propio `signal`/`expiresAfter` (p.ej. atados al lease de PR3).
 * Devuelve el status crudo del primer order.
 */
export async function placeSpotLimit(exchange: ExchangeClient, p: SpotLimitParams, opts?: SpotRpcOpts) {
  // (Codex MEDIO-pr1) Revalidación defensiva del min-notional con los valores que REALMENTE se envían.
  // placeSpotLimit acepta `SpotLimitParams` crudos (priceStr/sizeStr), así que un caller (PR3) podría
  // saltarse `roundAndValidateSpotOrder` y mandar < $10 → HL rechazaría en el reconcile real. Revalidar
  // aquí garantiza que lo enviado SIEMPRE cumple el mínimo, sin depender de la disciplina del caller.
  // `!(notional >= MIN)` cubre además priceStr/sizeStr no numéricos (NaN).
  const notional = Number(p.priceStr) * Number(p.sizeStr);
  if (!(notional >= MIN_SPOT_NOTIONAL_USD)) {
    const shown = Number.isFinite(notional) ? notional.toFixed(2) : `${p.priceStr}×${p.sizeStr}`;
    throw new Error(`placeSpotLimit: nocional ${shown} < mínimo ${MIN_SPOT_NOTIONAL_USD} USD (revalidación defensiva).`);
  }
  const { signal, expiresAfter, clear } = withSpotTimeout(opts);
  try {
    const resp = (await exchange.order(buildSpotLimitOrder(p) as any, { signal, expiresAfter } as any)) as any;
    return resp?.response?.data?.statuses?.[0] ?? resp;
  } finally {
    clear();
  }
}

/**
 * Cancela una orden spot por cloid (sólo toca cloids propios — el llamador garantiza la pertenencia).
 * (Codex #1-pr1-r2 nuevo BAJO) Mismo wrapper de timeout/abort que placeSpotLimit: es un RPC real que
 * PR3 usará en reconcile/stop y no debe colgar un lease.
 */
export async function cancelSpotByCloid(
  exchange: ExchangeClient,
  assetId: number,
  cloid: `0x${string}`,
  opts?: SpotRpcOpts,
) {
  const { signal, expiresAfter, clear } = withSpotTimeout(opts);
  try {
    return await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid }] } as any, {
      signal,
      expiresAfter,
    } as any);
  } finally {
    clear();
  }
}

// Re-export para que el connector y el motor (PR3) compartan el mismo cloid determinista.
export { toHlCloid, spotGridCloidInput };
