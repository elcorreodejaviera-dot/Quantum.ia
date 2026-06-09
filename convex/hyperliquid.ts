"use node";

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ExchangeClient, InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "crypto";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlNetwork, hlIsTestnet, assertExpectedNetwork } from "./hlNetwork";
import { LIMIT_DEFAULTS } from "./executionLimits";
// Timeout del envío de órdenes a HL (entrada y SL). Menor que RECONCILE_LEASE_MS (60s) para el SL.
const HL_ORDER_TIMEOUT_MS = 30_000;
// Tras enviar (submittedAt), margen amplio antes de cerrar un unknownOid como failed: garantiza
// que la action (abortada a HL_ORDER_TIMEOUT_MS, con expiresAfter) ya no puede llenar la IOC.
const ENTRY_GRACE_MS = 5 * 60_000;

// Aborta REALMENTE la request (AbortController + signal del SDK). clearTimeout evita el timer colgante.
function abortAfter(ms: number): { signal: AbortSignal; clear: () => void } {
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
function floorToDecimals(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f) / f;
}

// Precisión de precio de perps en HL: ≤5 cifras significativas y ≤ (6 − szDecimals) decimales.
function formatHlPrice(price: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(price.toPrecision(5));
  return String(Number(sig.toFixed(maxDecimals)));
}

type AssetMeta = { assetId: number; szDecimals: number; markPx: number };
async function getAssetMeta(info: InfoClient, asset: string): Promise<AssetMeta> {
  const [meta, ctxs] = await info.metaAndAssetCtxs();
  const idx = meta.universe.findIndex((u: any) => u.name === asset);
  if (idx < 0) throw new Error(`Asset no encontrado en HL: ${asset}`);
  const szDecimals = Number(meta.universe[idx].szDecimals);
  const markPx = Number((ctxs[idx] as any)?.markPx);
  if (!Number.isFinite(markPx) || markPx <= 0) throw new Error(`markPx inválido para ${asset}`);
  return { assetId: idx, szDecimals, markPx };
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
async function fillsByCloid(info: InfoClient, user: string, target: string): Promise<{ size: number; avgPx: number }> {
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

// Precio de SL y su límite (stop-limit) según el lado de la posición.
function slPrices(side: "Long" | "Short", entryPx: number, stopLossPct: number, bufferPct: number) {
  // Long protege con un Sell por debajo; Short con un Buy por encima.
  const triggerPx = side === "Long" ? entryPx * (1 - stopLossPct / 100) : entryPx * (1 + stopLossPct / 100);
  // Límite adverso (buffer) para que se llene al activarse.
  const limitPx = side === "Long" ? triggerPx * (1 - bufferPct / 100) : triggerPx * (1 + bufferPct / 100);
  return { triggerPx, limitPx };
}

// Coloca la orden de SL stop-limit reduceOnly. Devuelve el oid o lanza.
async function placeStopLoss(
  exchange: ExchangeClient, assetId: number, szDecimals: number,
  side: "Long" | "Short", filledSize: number, entryPx: number,
  stopLossPct: number, bufferPct: number, slCloidVal: `0x${string}`,
): Promise<{ oid: string; state: "resting" | "filled" }> {
  const { triggerPx, limitPx } = slPrices(side, entryPx, stopLossPct, bufferPct);
  const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
  let resp: unknown;
  try {
    resp = await exchange.order({
      orders: [{
        a: assetId,
        b: side === "Short",                         // cerrar un Short = Buy; cerrar un Long = Sell
        p: formatHlPrice(limitPx, szDecimals),
        s: String(floorToDecimals(filledSize, szDecimals)),
        r: true,                                      // reduceOnly
        t: { trigger: { isMarket: false, triggerPx: formatHlPrice(triggerPx, szDecimals), tpsl: "sl" } },
        c: slCloidVal,
      }],
      grouping: "na",
    }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
  } finally {
    ac.clear();
  }
  const st = (resp as any)?.response?.data?.statuses?.[0];
  if (st?.error) throw new Error(String(st.error));
  // Solo resting o filled con oid cuentan como SL colocado. Filled = el SL ya cerró la posición.
  if (st?.resting?.oid != null) return { oid: String(st.resting.oid), state: "resting" };
  if (st?.filled?.oid != null) return { oid: String(st.filled.oid), state: "filled" };
  throw new Error("Respuesta de SL ambigua (sin resting/filled oid)");
}

async function slBufferPct(ctx: any): Promise<number> {
  const row = await ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "slBufferPct" });
  const v = typeof row?.value === "number" ? row.value : LIMIT_DEFAULTS.slBufferPct;
  return Number.isFinite(v) && v >= 0 ? v : LIMIT_DEFAULTS.slBufferPct;
}

function makeClients(privKey: `0x${string}`, isTestnet: boolean) {
  const wallet = privateKeyToAccount(privKey);
  const transport = new HttpTransport({ isTestnet });
  return {
    wallet,
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ transport, wallet }),
  };
}

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

    const effectiveLeverage = (!bot.autoLeverage && bot.leverage !== undefined) ? bot.leverage : 1;
    if (!Number.isFinite(effectiveLeverage) || effectiveLeverage < 1 || effectiveLeverage > 25) {
      throw new Error("leverage must be a finite number between 1 and 25");
    }

    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: bot.hlAccountId });
    if (!credential) throw new Error("Hyperliquid account not found");
    if (credential.userId !== user._id) throw new Error("Account does not belong to this user");

    const asset = bot.baseAsset.toUpperCase();
    const { info, exchange } = makeClients(decryptPrivateKey(credential), hlIsTestnet());
    const { assetId, szDecimals, markPx } = await getAssetMeta(info, asset);

    // Precio server-side: tamaño truncado hacia abajo, nocional efectivo.
    const size = floorToDecimals(args.tradeAmount / markPx, szDecimals);
    if (size <= 0) throw new Error("Order size rounds to zero at current price");
    const actualNotional = size * markPx;

    const entryCloid = cloid(args.idempotencyKey);
    const slCloid = cloid(args.idempotencyKey, ":sl:0");

    // Reserva atómica (idempotency + nocional) ANTES de tocar HL.
    const reservation = await ctx.runMutation(internal.executions.reserveExecution, {
      userId: user._id, botId: bot._id, idempotencyKey: args.idempotencyKey,
      hlAccountId: bot.hlAccountId, asset, stopLossPct: bot.stopLossPct,
      requestedAmount: args.tradeAmount,
      notional: actualNotional, side: args.side, network: hlNetwork(),
      entryCloid, slCloid,
    });
    const requestId = reservation.requestId;
    if (reservation.alreadyExists) {
      // No re-ejecutar: reconciliar si no es FINAL (closed/failed). protected se revisa por si cerró.
      if (!["closed", "failed"].includes(reservation.status)) {
        await ctx.runAction(internal.hyperliquid.reconcileExecution, { requestId });
      }
      return { ok: true, deduped: true, requestId };
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

    await exchange.updateLeverage({ asset: assetId, isCross: false, leverage: Math.round(effectiveLeverage) });

    // Gate ATÓMICO justo antes del envío (updateLeverage pudo tardar >LEASE_MS y el cron tomar el
    // control). blocked → ya cerrado failed por CAS; state/expired/claimed → no tocar (otro lo maneja).
    const gate = await ctx.runMutation(internal.executions.gateBeforeOrder, { requestId });
    if (!gate.ok) {
      return { ok: false, status: gate.reason === "blocked" ? "failed" : "aborted", requestId, reason: gate.reason };
    }

    let entryResp: unknown;
    const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
    try {
      entryResp = await exchange.order({
        orders: [{
          a: assetId, b: args.side === "Long",
          p: formatHlPrice(markPx, szDecimals), s: String(size),
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

      // (b) Posición abierta. Estado del SL actual: solo open/triggered/filled cuentan.
      const slStatus: any = await info.orderStatus({ user: user as `0x${string}`, oid: req.slCloid });
      let slCloidToUse: `0x${string}`;
      if (slStatus.status === "order") {
        const state = slStatus.order?.status;
        if (state === "filled") {
          await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "closed", filledSize, entryPrice });
          return { result: "closed" };
        }
        if (state === "open" || state === "triggered") {
          await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: "protected", filledSize, entryPrice });
          return { result: "protected_existing" };
        }
        // canceled/rejected/… → el cloid actual está consumido: recolocar con uno NUEVO (CAS + fencing).
        const attempt = (req.slAttempt ?? 0) + 1;
        const next = cloid(req.idempotencyKey, `:sl:${attempt}`);
        const prep = await ctx.runMutation(internal.executions.prepareSlRetry, { requestId, token, newSlCloid: next, attempt });
        if (!prep.ok) return { skipped: "sl_retry_race" };
        slCloidToUse = next;
      } else {
        // unknownOid: el SL nunca se colocó con este cloid → colocarlo con el cloid actual.
        slCloidToUse = req.slCloid as `0x${string}`;
      }

      // El buffer se obtiene ANTES; la renovación del claim es la ÚLTIMA operación previa al envío.
      const buffer = await slBufferPct(ctx);
      const renew = await ctx.runMutation(internal.executions.renewReconcile, { requestId, token });
      if (!renew.ok) return { skipped: "lease_lost" };
      try {
        const sl = await placeStopLoss(exchange, assetId, szDecimals, req.side, filledSize, entryPrice, req.stopLossPct, buffer, slCloidToUse);
        const st = sl.state === "filled" ? "closed" as const : "protected" as const;
        await ctx.runMutation(internal.executions.settleExecution, { requestId, token, status: st, slOrderId: sl.oid, filledSize, entryPrice });
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
