"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlNetwork, hlIsTestnet } from "./hlNetwork";
import {
  makeClients, getAssetMeta, roundHlPrice, aggressiveHlPriceStr, formatHlPrice, abortAfter,
  placeStopLoss, fillsByCloid, floorToDecimals, isFlatOrDust,
} from "./hyperliquid";
import { tradingCloidInput, toHlCloid } from "./cloids";
import { TransportError } from "@nktkas/hyperliquid";
import { armErrorKind } from "./triggerRearm";
import { elog } from "./log";
import {
  ENTRY_TRIGGER_SLIPPAGE, computeEntryTriggers, entryOrderSpecs, resolveEntryTopology,
  classifyLpRead, computeDesiredSlTrigger, nextTrailAnchor, tpLevels,
} from "./tradingMath";
import {
  hlPriceTick, netEntryFills, resolveOcoRaceResolution, revalidateTopology,
  classifyEntryIocStatus, pickCloseReason, beLatchReached, decideSlReplacement, tradingRearmDelayMs,
  positionSideFromSzi, decideSisterOutcome, decideDeadEntriesOutcome, preHlGateCheck,
} from "./tradingReconcileCore";
import type { NetEntryFills } from "./tradingReconcileCore";

// (JAV-179 / Bot Trading PR3) MOTOR live del 4º money-path: breakout OCO sobre el rango LP + entrada
// a mercado fuera de rango (decisión 6). Espejo de spotDefenseEngine generalizado a 2 entradas
// Long/Short + trailing + revalidación fresca pre-RPC (V2-P1). Descifra la clave SOLO aquí; TODA
// mutación de estado va por las mutations non-node de tradingBots.ts (lease/CAS/fencing). Las
// DECISIONES de carrera viven en tradingReconcileCore/tradingMath (puras, testeadas — P8).

const HL_ORDER_TIMEOUT_MS = 30_000;
// Banda agresiva de la IOC del camino market-entry (patrón ENTRY_IOC_SLIPPAGE de las ejecuciones;
// constante PROPIA del camino — el rango mínimo usa ENTRY_TRIGGER_SLIPPAGE de tradingMath).
const MARKET_IOC_SLIPPAGE = 0.02;
const CLOSE_CONFIRM_GRACE_MS = 2 * 60_000;
const DRIFT_TOL = 0.02;
const DRIFT_CONFIRM_GRACE_MS = 45_000;
const ARMING_RECOVER_GRACE_MS = 3 * 60_000;
// Grace de una orden ENVIADA/PREPARADA ambigua antes de rotar cloid (entradas, SL, TP, close).
const ORDER_SUBMIT_GRACE_MS = 60_000;
// Tope de intentos del cierre IOC (oco_race): agotado ⇒ manual_intervention con el SL resting.
const CLOSE_MAX_ATTEMPTS = 3;
// Ventana de PROTECCIÓN: si el SL no logra quedar resting antes del deadline ⇒ cierre de emergencia.
// La fija settleTradingArm al fill; el motor la LIMPIA al confirmar resting y la REFRESCA (ventana
// fresca) cuando el SL vuelve a necesitar colocación (patrón triggerArms — revisión PR3).
const SL_PROTECT_DEADLINE_MS = 4 * 60_000;

// (JAV-122) TransportError = fallo de TRANSPORTE (5xx/timeout/red) → transitorio, JAMÁS terminaliza
// ni persiste HTML crudo. El resto es determinista.
export function classifyTradingError(e: unknown): { kind: "transient" | "fatal"; message: string } {
  if (e instanceof TransportError) return { kind: "transient", message: "[transient] transporte HL (reintento)" };
  return { kind: "fatal", message: String((e as Error)?.message ?? e).slice(0, 300) };
}

async function openByCloid(info: any, user: `0x${string}`, cloid: string): Promise<boolean> {
  if (!cloid) return false;
  const oo: any[] = await info.frontendOpenOrders({ user });
  return oo.some((o) => typeof o?.cloid === "string" && o.cloid.toLowerCase() === cloid.toLowerCase());
}

async function cancelOwnByCloid(exchange: any, assetId: number, cloids: string[]): Promise<void> {
  for (const c of cloids) {
    if (!c) continue;
    try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: c as `0x${string}` }] }); } catch { /* el próximo ciclo reintenta */ }
  }
}

// Prueba negativa por CLOID: cancela las propias vivas y devuelve true SOLO si ninguna lo estaba.
async function ensureTradingOrdersDead(
  info: any, exchange: any, user: `0x${string}`, assetId: number, cloids: string[],
): Promise<boolean> {
  const oo: any[] = await info.frontendOpenOrders({ user });
  const liveSet = new Set(oo.map((o) => (typeof o?.cloid === "string" ? o.cloid.toLowerCase() : "")));
  let allDead = true;
  for (const c of cloids) {
    if (c && liveSet.has(c.toLowerCase())) {
      allDead = false;
      try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: c as `0x${string}` }] }); } catch { /* reintenta */ }
    }
  }
  return allDead;
}

// ================================================================================================
// ARMADO (inicial y rearm): gates → LP fresco on-chain → bifurcación de topología → reserva OCC →
// CAS → leverage → gate → REVALIDACIÓN FRESCA pre-RPC → envío (par OCO o IOC market).
// ================================================================================================

export const armTradingInternal = internalAction({
  args: {
    botId: v.id("bots"),
    rearmToken: v.optional(v.string()),
    // (V2-P1) Reintento inmediato ÚNICO tras un aborto por topología stale: si vuelve a quedar stale,
    // cae a la cadencia normal de 5 min del rearm (anti ping-pong con el mark oscilando en el borde).
    staleRetry: v.optional(v.boolean()),
  },
  handler: async (ctx, { botId, rearmToken, staleRetry }): Promise<any> => {
    const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: botId });
    if (!bot) throw new Error("[cancel] Bot de trading no encontrado");
    if (bot.kind !== "trading") throw new Error("[cancel] El bot no es de trading");
    if (!bot.active || bot.disarmPending) throw new Error("[cancel] Bot no activo (o pausándose)");
    if (bot.simulationMode !== false) throw new Error("[cancel] Bot en simulación: el motor real no arma");
    if (!bot.hlAccountId || !bot.baseAsset || !bot.poolId) throw new Error("[blocked_config] Bot sin cuenta/activo/pool");

    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: bot.hlAccountId });
    if (!credential) throw new Error("[blocked_config] Cuenta HL no encontrada");
    if (credential.userId !== bot.userId) throw new Error("[blocked_config] La cuenta no pertenece al dueño del bot");

    // (JAV-179-C1) Gates PRIMERA BARRERA: kill-switch/simulación/canLive/gate-mainnet ANTES de
    // descifrar la clave, crear clientes o tocar cualquier endpoint HL/LP (contrato de orden del
    // money-path — decisión pura preHlGateCheck, testeada). La reserva/CAS/gate lo revalidan después.
    const [tradingConfig0, simConfig0] = await Promise.all([
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
    ]);
    const canLive0 = bot.userId ? await ctx.runQuery(internal.users.hasTradeLiveForUserInternal, { userId: bot.userId }) : false;
    const mainnetGate0 = await ctx.runQuery(internal.tradingBots.getMainnetTradingApprovedInternal, {});
    const gate0 = preHlGateCheck({
      tradingEnabled: tradingConfig0?.value === true, simulationOff: simConfig0?.value === false,
      canLive: canLive0 === true, network: hlNetwork(), mainnetApproved: mainnetGate0.approved,
    });
    if (gate0.ok === false) throw new Error(gate0.error);

    const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: bot.poolId });
    if (!pool) throw new Error("[cancel] Pool no encontrado");
    if (pool.closed) throw new Error("[cancel] Pool cerrado: el bot no debe operar");
    if (!Number.isFinite(pool.minRange) || pool.minRange <= 0 || !Number.isFinite(pool.maxRange) || pool.maxRange <= pool.minRange) {
      throw new Error("[blocked_config] Rango del pool inválido (minRange/maxRange)");
    }

    const asset = bot.baseAsset.toUpperCase();
    const { info, exchange } = makeClients(decryptPrivateKey(credential), hlIsTestnet());
    const { assetId, szDecimals, markPx, maxLeverage } = await getAssetMeta(info, asset);
    const tradingAccount = credential.tradingAccountAddress as `0x${string}`;

    const abstraction = await info.userAbstraction({ user: tradingAccount });
    if (abstraction !== "unifiedAccount") {
      throw new Error("[blocked_config] La cuenta HL no está en modo unified; armado bloqueado.");
    }
    // Precondición FLAT + sin órdenes del coin (estado residual visible en HL = incompatible).
    const chState = await info.clearinghouseState({ user: tradingAccount });
    const pos = (chState.assetPositions ?? []).find((p: any) => p.position?.coin === asset);
    if (pos && !isFlatOrDust(Number(pos.position?.szi ?? 0), markPx)) {
      throw new Error("[retry_incompatible] Ya hay posición abierta en el activo: armado bloqueado (flat).");
    }
    const openOrders: any[] = await info.frontendOpenOrders({ user: tradingAccount });
    if (openOrders.some((o) => o?.coin === asset)) {
      throw new Error("[retry_incompatible] Hay órdenes abiertas en el activo: armado bloqueado.");
    }

    // (P3) Nocional LP FRESCO on-chain — la MISMA fuente estricta del motor IL y las ejecuciones.
    // JAMÁS campos display de `pools`. Mapeo fail-closed vía classifyLpRead (puro, testeado).
    if (pool.tokenId === undefined || pool.tokenId === null) {
      throw new Error("[blocked_config] Pool sin tokenId: nocional LP no cuantificable.");
    }
    const lpRead = await ctx.runAction(internal.actions.poolScanner.fetchPositionNotionalStrict, {
      tokenId: pool.tokenId, network: pool.network, priceUsd: markPx, poolAddress: pool.poolAddress ?? undefined,
    });
    const lpClass = classifyLpRead(String(lpRead?.reason ?? "error"));
    if (lpClass.ok === false) throw new Error(lpClass.error);
    const lpNotionalUsd = Number(lpRead.liquidityUsd);

    // Triggers normalizados al tick con redondeo direccional HACIA FUERA (jamás nacen disparados).
    const raw = computeEntryTriggers(pool.minRange, pool.maxRange, bot.preTriggerPct ?? 0);
    const lowerTriggerPx = roundHlPrice(raw.lowerTriggerPx, szDecimals, "floor");
    const upperTriggerPx = roundHlPrice(raw.upperTriggerPx, szDecimals, "ceil");
    const tickSize = hlPriceTick(markPx, szDecimals);

    // Bifurcación de TOPOLOGÍA (decisión 6, fuente única): dentro ⇒ par OCO; fuera ⇒ market-entry.
    const topo = resolveEntryTopology(markPx, lowerTriggerPx, upperTriggerPx, bot.direction as any);

    const spotState = await info.spotClearinghouseState({ user: tradingAccount });
    const availableCollateral = (spotState.balances ?? [])
      .filter((b: any) => b.coin === "USDC")
      .reduce((s: number, b: any) => s + Math.max(0, parseFloat(b.total ?? "0") - parseFloat(b.hold ?? "0")), 0);

    // Reserva OCC. El `out_of_range` tipado (la OCC vio el mark fuera con topología OCO reservada por
    // esta action un instante antes) re-bifurca a marketEntry EN EL MISMO tick (JAV-178-C1).
    const baseArgs = {
      botId, lpNotionalUsd, markPx, lowerEdge: pool.minRange, upperEdge: pool.maxRange, tickSize,
      availableCollateral, assetMaxLeverage: maxLeverage, szDecimals, rearmToken,
    };
    let reservation: any;
    let variant: { kind: "oco" } | { kind: "market"; side: "Long" | "Short" };
    if (topo.kind === "oco") {
      const entryUpperLimitPx = Number(aggressiveHlPriceStr(upperTriggerPx * (1 + ENTRY_TRIGGER_SLIPPAGE), szDecimals, true));
      const entryLowerLimitPx = Number(aggressiveHlPriceStr(lowerTriggerPx * (1 - ENTRY_TRIGGER_SLIPPAGE), szDecimals, false));
      reservation = await ctx.runMutation(internal.tradingBots.reserveTradingArm, {
        ...baseArgs, lowerTriggerPx, upperTriggerPx, entryUpperLimitPx, entryLowerLimitPx,
      });
      if (reservation?.ok === false && reservation.reason === "out_of_range") {
        const side = reservation.side as "Long" | "Short";
        const marketLimitPx = Number(aggressiveHlPriceStr(
          side === "Long" ? markPx * (1 + MARKET_IOC_SLIPPAGE) : markPx * (1 - MARKET_IOC_SLIPPAGE),
          szDecimals, side === "Long"));
        reservation = await ctx.runMutation(internal.tradingBots.reserveTradingArm, {
          ...baseArgs, marketEntry: { side }, marketLimitPx,
        });
        variant = { kind: "market", side };
      } else {
        variant = { kind: "oco" };
      }
    } else {
      const side = topo.side;
      const marketLimitPx = Number(aggressiveHlPriceStr(
        side === "Long" ? markPx * (1 + MARKET_IOC_SLIPPAGE) : markPx * (1 - MARKET_IOC_SLIPPAGE),
        szDecimals, side === "Long"));
      reservation = await ctx.runMutation(internal.tradingBots.reserveTradingArm, {
        ...baseArgs, marketEntry: { side }, marketLimitPx,
      });
      variant = { kind: "market", side };
    }
    if (reservation?.ok !== true) {
      throw new Error("[transient] Reserva no completada (carrera de topología); reintento.");
    }
    const { armId, cloids, appliedLeverage, size } = reservation;

    // CAS pre-envío.
    const sub = await ctx.runMutation(internal.tradingBots.markTradingArmSubmitting, { armId });
    if (!sub.ok) return { ok: false, status: "aborted", armId, reason: sub.reason };
    const token = sub.token;

    // updateLeverage (isolated) ANTES de cualquier orden.
    try {
      await exchange.updateLeverage({ asset: assetId, isCross: false, leverage: appliedLeverage });
    } catch (e) {
      if (e instanceof TransportError) {
        await ctx.runMutation(internal.tradingBots.releaseTradingReconcile, { armId, token });
        return { ok: false, status: "gated", armId, reason: "updateLeverage_transport" };
      }
      const msg = String((e as Error)?.message ?? e);
      const failed = await ctx.runMutation(internal.tradingBots.failTradingPreOrder, { armId, token, error: `[blocked_config] updateLeverage: ${msg}` });
      if (!failed.ok) await ctx.runMutation(internal.tradingBots.releaseTradingReconcile, { armId, token });
      throw new Error(`[blocked_config] updateLeverage rechazado: ${msg}`);
    }

    // Gate atómico bajo lease (kill-switch / cap / guard simétrico en la ventana de updateLeverage).
    const gate = await ctx.runMutation(internal.tradingBots.gateTradingArmBeforeOrder, { armId, token });
    if (!gate.ok) {
      await ctx.runMutation(internal.tradingBots.releaseTradingReconcile, { armId, token });
      return { ok: false, status: "gated", armId };
    }

    // ===== REVALIDACIÓN FRESCA pre-RPC (JAV-176-V2-P1, espejo explícito de triggerEngine.ts:349-375) =====
    // Releer el mark DESPUÉS del gate final y ANTES de exchange.order; recomputar la topología con la
    // MISMA función pura de la bifurcación. Mismatch o fallo de relectura ⇒ NO enviar: failTradingPreOrder
    // (sin petición HL en vuelo — libera reserva YA) + reintento inmediato ÚNICO / cadencia 5 min.
    let freshTopo: ReturnType<typeof resolveEntryTopology> | null = null;
    let freshMarkPx = markPx;
    try {
      const freshMeta = await getAssetMeta(info, asset);
      freshMarkPx = freshMeta.markPx;
      freshTopo = resolveEntryTopology(freshMeta.markPx, lowerTriggerPx, upperTriggerPx, bot.direction as any);
    } catch { freshTopo = null; }
    const reval = revalidateTopology(variant, freshTopo);
    if (reval.ok === false) {
      const pf = await ctx.runMutation(internal.tradingBots.failTradingPreOrder, { armId, token, error: reval.error });
      if (!pf.ok) await ctx.runMutation(internal.tradingBots.releaseTradingReconcile, { armId, token });
      else if (!staleRetry) {
        // Reintento inmediato ÚNICO con topología fresca (sin rearmToken: ya se consumió; el fail de
        // arriba dejó el rearm durable de 5 min como red si este reintento también aborta).
        await ctx.scheduler.runAfter(0, internal.tradingEngine.armTradingInternal, { botId, staleRetry: true });
      }
      elog("trading", "stale_topology_abort", { armId: String(armId), retry: !staleRetry });
      return { ok: false, status: "stale_topology", armId };
    }

    // ===== ENVÍO =====
    if (variant.kind === "oco") {
      // UNA llamada exchange.order con las 2 entradas (cloids, r:false, trigger market, limitPx agresivo).
      const specs = entryOrderSpecs(bot.direction as any);
      const orders = specs.map((s) => ({
        a: assetId, b: s.isBuy,
        p: aggressiveHlPriceStr(
          (s.role === "entry_upper" ? upperTriggerPx : lowerTriggerPx) * (s.isBuy ? 1 + ENTRY_TRIGGER_SLIPPAGE : 1 - ENTRY_TRIGGER_SLIPPAGE),
          szDecimals, s.isBuy),
        s: String(size), r: false,
        t: { trigger: { isMarket: true, triggerPx: formatHlPrice(s.role === "entry_upper" ? upperTriggerPx : lowerTriggerPx, szDecimals), tpsl: s.tpsl } },
        c: cloids[s.role] as `0x${string}`,
      }));
      let statuses: any[] = [];
      let transportUncertain = false, hardError: string | undefined;
      const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
      try {
        const resp: any = await exchange.order({ orders, grouping: "na" }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
        statuses = resp?.response?.data?.statuses ?? [];
      } catch (e) {
        if (e instanceof TransportError) transportUncertain = true;
        else hardError = String((e as Error)?.message ?? e);
      } finally { ac.clear(); }

      // Procesar statuses POR PATA. Una pata rechazada determinista + otra viva ⇒ cancelar la viva y
      // dejar el arm reconciliable (NUNCA media OCO).
      let placed = 0, rejected = 0;
      const rejectedMsgs: string[] = [];
      for (let i = 0; i < specs.length; i++) {
        const st = statuses[i];
        const role = specs[i].role;
        if (st?.resting?.oid != null) {
          await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role, observedStatus: "open", oid: String(st.resting.oid), markSubmitted: true });
          placed++;
        } else if (st === "waitingForTrigger") {
          await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role, observedStatus: "pending", markSubmitted: true });
          placed++;
        } else if (st?.error) {
          await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role, observedStatus: "rejected" });
          rejected++; rejectedMsgs.push(String(st.error));
        } else if (st?.filled?.oid != null) {
          // Un trigger no debería llenar al colocarse (jamás nace disparado), pero si HL lo reporta,
          // registrarlo: el reconcile lo clasifica como fill (fase de posición).
          await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role, observedStatus: "filled", oid: String(st.filled.oid), markSubmitted: true });
          placed++;
        } else {
          // Ambiguo (o transporte): cuenta como posiblemente enviado — el reconcile resuelve por cloid.
          await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role, observedStatus: transportUncertain ? "unknown" : "pending", markSubmitted: true });
          placed++;
        }
      }
      // Clasificación de margen PRESERVADA en arm.error (revisión PR3): el settle a `failed` caería en
      // la cuarentena post-submit (no persistiría nada) y la prueba negativa del pre-fill perdería el
      // tag [blocked_margin] (con él, el backoff acelerado). Por eso ambos caminos asientan `unknown`
      // CON el error clasificado y dejan el terminal a la prueba negativa del reconcile.
      const marginTag = rejectedMsgs.some((m) => /margin|Insufficient/i.test(m)) ? "[blocked_margin]" : "[blocked_config]";
      if (transportUncertain && statuses.length === 0) {
        await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "unknown", error: "[transient] transporte al enviar el par OCO" });
      } else if (rejected === specs.length) {
        await ctx.runMutation(internal.tradingBots.settleTradingArm, {
          armId, token, status: "unknown",
          error: `${marginTag} entradas rechazadas: ${rejectedMsgs.join(" | ").slice(0, 200)} (prueba negativa en reconcile)`,
        });
      } else if (rejected > 0) {
        // Media OCO: cancelar la pata viva YA; el error CONSERVA el tag de margen si lo hubo.
        const liveCloids = specs.map((s) => cloids[s.role]);
        await cancelOwnByCloid(exchange, assetId, liveCloids);
        await ctx.runMutation(internal.tradingBots.settleTradingArm, {
          armId, token, status: "unknown",
          error: `${marginTag} media OCO: pata rechazada (${rejectedMsgs.join(" | ").slice(0, 150)}) — cancelando la viva (prueba negativa en reconcile)`,
        });
      } else {
        await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "armed", error: hardError });
      }
      elog("trading", "oco_sent", { armId: String(armId), placed, rejected, transportUncertain });
    } else {
      // Camino MARKET-ENTRY (decisión 6): UNA IOC agresiva reduceOnly:false, espejo COMPLETO de las
      // ejecuciones incluida la incertidumbre. El limitPx se pricea con el mark FRESCO de la
      // revalidación (revisión PR3: con el stale, un breakout que siguió corriendo dejaría la banda
      // del 2% POR DETRÁS del mark ⇒ IOC que no cruza — el caso Benjamin otra vez).
      const side = variant.side;
      const limitPx = aggressiveHlPriceStr(
        side === "Long" ? freshMarkPx * (1 + MARKET_IOC_SLIPPAGE) : freshMarkPx * (1 - MARKET_IOC_SLIPPAGE),
        szDecimals, side === "Long");
      let st: any; let transportUncertain = false;
      const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
      try {
        const resp: any = await exchange.order({
          orders: [{ a: assetId, b: side === "Long", p: limitPx, s: String(size), r: false, t: { limit: { tif: "Ioc" } }, c: cloids.entry_market as `0x${string}` }],
          grouping: "na",
        }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
        st = resp?.response?.data?.statuses?.[0];
      } catch (e) {
        if (e instanceof TransportError) transportUncertain = true;
        else st = { error: String((e as Error)?.message ?? e) };
      } finally { ac.clear(); }
      const outcome = classifyEntryIocStatus(st, transportUncertain);
      if (outcome.kind === "filled") {
        await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "entry_market", observedStatus: "filled", limitPx: Number(limitPx), markSubmitted: true });
        await ctx.runMutation(internal.tradingBots.settleTradingArm, {
          armId, token, status: "filled", filledSize: outcome.size, entryPrice: outcome.avgPx,
          filledEntryRole: "entry_market", filledSide: side,
        });
        // El reconcile (kick abajo) coloca el SL de inmediato — no se espera al cron.
      } else if (outcome.kind === "rejected") {
        const margin = /margin|Insufficient/i.test(outcome.error);
        await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "entry_market", observedStatus: "rejected" });
        await ctx.runMutation(internal.tradingBots.settleTradingArm, {
          armId, token, status: "unknown",
          error: `${margin ? "[blocked_margin]" : "[blocked_config]"} IOC rechazada: ${outcome.error.slice(0, 200)} (prueba negativa en reconcile)`,
        });
      } else {
        // INCIERTO (V2-P1/D6): JAMÁS failed el mismo tick — una IOC abortada que en realidad llenó
        // dejaría posición viva sin SL. unknown ⇒ el reconcile resuelve por cloid+fills+grace+veto szi.
        await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "entry_market", observedStatus: "unknown", markSubmitted: true });
        await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "unknown", error: "[transient] IOC market-entry con resultado incierto" });
      }
      elog("trading", "market_entry_sent", { armId: String(armId), side, outcome: outcome.kind });
    }

    // Defensa post-envío + kick del reconcile (coloca SL de un fill inmediato sin esperar al cron).
    const fresh = await ctx.runQuery(internal.tradingBots.getTradingArmInternal, { armId });
    if (fresh && fresh.arm.desiredState === "disarmed") {
      await cancelOwnByCloid(exchange, assetId, Object.values(cloids) as string[]);
    }
    await ctx.runMutation(internal.tradingBots.releaseTradingReconcile, { armId, token });
    await ctx.scheduler.runAfter(0, internal.tradingEngine.reconcileTradingArm, { armId });
    return { ok: true, status: "armed", armId };
  },
});

// ================================================================================================
// RECONCILE por arm (claim/lease/fencing; gate mainnet = BARRERA TOTAL). PRE-FILL con relectura de
// AMBOS cloids (P1) y POST-FILL en orden estricto (SL primero → OCO → TPs → drift → flat → BE →
// trailing). Un fill detectado en pre-fill CONTINÚA EL MISMO TICK a la fase de posición.
// ================================================================================================

export const reconcileTradingArm = internalAction({
  args: { armId: v.id("trading_arms") },
  handler: async (ctx, { armId }): Promise<any> => {
    const claim = await ctx.runMutation(internal.tradingBots.claimTradingReconcile, { armId });
    if (!claim.claimed) return { skipped: claim.reason };
    const token = claim.token!;
    try {
      let data = await ctx.runQuery(internal.tradingBots.getTradingArmInternal, { armId });
      if (!data) return { skipped: "not_found" };

      // Recuperación: arming que nunca CAS'd y viejo → abandonado → failed (sin envío garantizado).
      if (data.arm.status === "arming" && data.arm.submittedAt == null) {
        if (Date.now() - data.arm.createdAt > ARMING_RECOVER_GRACE_MS) {
          await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "failed", error: "[blocked_config] arming abandonado (sin envío)" });
          return { result: "arming_recovered" };
        }
        return { skipped: "arming_too_recent" };
      }

      // (JAV-179-C1) Gates y BARRERA mainnet ANTES de descifrar la clave / crear clientes / tocar HL:
      // con el gate cerrado, este reconcile NO alcanza ningún endpoint (barrera total literal).
      const [tradingConfig, simConfig] = await Promise.all([
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
      ]);
      const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: data.arm.botId });
      const canLive = await ctx.runQuery(internal.users.hasTradeLiveForUserInternal, { userId: data.arm.userId });
      const mainnetGate = await ctx.runQuery(internal.tradingBots.getMainnetTradingApprovedInternal, {});
      // (CodeRabbit #145 Major / JAV-179-C1) GATES DUROS = PRIMERA barrera: kill-switch / simulación /
      // canLive / red / gate-mainnet cortan ANTES de descifrar la clave, crear clientes o tocar HL —
      // ni siquiera para desarmar (con la barrera cerrada NO se opera en HL; una pausa espera a que
      // reabra). Nada de esto puede depender de `wantDisarm`.
      const hardGateClosed =
        tradingConfig?.value !== true || simConfig?.value === true ||
        !canLive || hlNetwork() !== data.arm.network ||
        (data.arm.network === "mainnet" && !mainnetGate.approved);
      if (hardGateClosed) return { skipped: "trading_gate_closed" };
      const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: data.arm.hlAccountId });
      if (!credential) return { skipped: "no_credential" };
      if (credential.userId !== data.arm.userId) return { skipped: "credential_owner_mismatch" };
      // `killed` (blando): estado del bot que motiva un DESARME ordenado (sí toca HL para cerrar/cancelar).
      const killed =
        !bot || !bot.active || bot.disarmPending === true || bot.simulationMode !== false ||
        bot.hlAccountId !== data.arm.hlAccountId;
      const wantDisarm = killed || data.arm.desiredState === "disarmed";
      const user = credential.tradingAccountAddress as `0x${string}`;
      const { info, exchange } = makeClients(decryptPrivateKey(credential), data.arm.network === "testnet");
      const { assetId, szDecimals, markPx } = await getAssetMeta(info, data.arm.asset.toUpperCase());
      const tickSize = hlPriceTick(markPx, szDecimals);

      // --- (P1) Relectura de fills de TODOS los cloids de entrada, SIEMPRE, antes de clasificar ---
      const entryRows = data.orders.filter((o: any) => o.role === "entry_upper" || o.role === "entry_lower" || o.role === "entry_market");
      if (entryRows.length === 0) return { skipped: "no_entries" };
      const marketRow = entryRows.find((o: any) => o.role === "entry_market");
      // Relee fills y netea con la corrección de lado para entry_market en long_short (el lado viene
      // del arm/topología, NUNCA del default) — aplicada en TODAS las relecturas (revisión PR3).
      const computeNet = async (): Promise<NetEntryFills> => {
        const fills: { upper?: { size: number; avgPx: number }; lower?: { size: number; avgPx: number }; market?: { size: number; avgPx: number } } = {};
        for (const row of entryRows) {
          const f = await fillsByCloid(info, user, row.cloid);
          if (f.size > 0 && f.avgPx > 0) {
            if (row.role === "entry_upper") fills.upper = f;
            else if (row.role === "entry_lower") fills.lower = f;
            else fills.market = f;
          }
        }
        let net = netEntryFills(data!.arm.direction as any, fills);
        if (net.kind === "single" && net.role === "entry_market" && data!.arm.direction === "long_short") {
          net = { ...net, side: (data!.arm.filledSide ?? (marketRow?.isBuy ? "Long" : "Short")) as any };
        }
        return net;
      };
      let net = await computeNet();
      let bothEntriesFilled = net.kind === "both";

      const posPhase = data.arm.status === "filled" || data.arm.status === "protecting" || data.arm.status === "protected";
      const anyFill = net.kind !== "none";

      // ===== PRE-FILL sin fill: disarm / muerte de entradas / espera =====
      if (!posPhase && !anyFill) {
        if (wantDisarm) {
          const ownAll = [...data.orders.map((o: any) => o.cloid), ...(data.arm.slPendingCloid ? [data.arm.slPendingCloid] : [])];
          const allDead = await ensureTradingOrdersDead(info, exchange, user, assetId, ownAll);
          if (!allDead) return { skipped: "orders_still_live" };
          // Re-confirmar fills de último momento en TODOS los cloids de entrada (P1).
          net = await computeNet();
          if (net.kind === "none") {
            const r = await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "disarmed" });
            return r.ok ? { result: "disarmed" } : { skipped: "disarm_not_applied" };
          }
          // Un fill ganó la carrera al disarm: a fase de posición con cierre ordenado (paso 7).
        } else {
          // Prueba de vida de las entradas + prueba negativa con GRACE y VETO por szi (decisión pura).
          let anyLiveOrFilling = false;
          for (const row of entryRows) {
            const sp: any = await info.orderStatus({ user, oid: row.cloid as `0x${string}` });
            const state = sp?.status === "order" ? sp.order?.status : undefined;
            if (await openByCloid(info, user, row.cloid)
              || state === "open" || state === "triggered" || state === "waitingForTrigger" || state === "waitingForFill" || state === "filled") {
              anyLiveOrFilling = true; break;
            }
          }
          const recoveryAt = data.arm.submittedAt ?? data.arm.updatedAt ?? data.arm.createdAt;
          const graceElapsed = Date.now() - recoveryAt > ORDER_SUBMIT_GRACE_MS;
          const ch: any = await info.clearinghouseState({ user });
          const p = (ch.assetPositions ?? []).find((x: any) => x.position?.coin === data.arm.asset.toUpperCase());
          const sziFlat = !p || isFlatOrDust(Number(p.position?.szi ?? 0), markPx);
          let allDead = false;
          if (!anyLiveOrFilling && graceElapsed && sziFlat) {
            allDead = await ensureTradingOrdersDead(info, exchange, user, assetId, entryRows.map((o: any) => o.cloid));
            if (allDead) net = await computeNet();
          }
          const outcome = decideDeadEntriesOutcome({
            anyLiveOrFilling, graceElapsed, sziFlat, allDead, refilledNetKind: net.kind,
          });
          if (outcome === "wait") return { result: anyLiveOrFilling ? "armed_waiting" : "entry_pending_grace" };
          if (outcome === "veto_position") return { skipped: "negative_proof_vetoed_szi" };
          if (outcome === "fail") {
            const priorErr = data.arm.error && /\[blocked_margin\]/.test(data.arm.error) ? "[blocked_margin]" : "[blocked_config]";
            const rf = await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "failed", error: `${priorErr} entradas no vivas en HL sin fill (rechazo/incierto)` });
            return rf.ok ? { result: "entry_dead_failed" } : { skipped: "entry_dead_quarantined" };
          }
          // outcome === "fill": cae a la transición de abajo.
        }
      }

      // ===== TRANSICIÓN a fase de posición (continúa EL MISMO TICK — plan PR3) =====
      if (!posPhase && net.kind !== "none") {
        const single = net.kind === "single";
        const side = single ? (net as any).side : (net as any).netSide;
        const fSize = single ? (net as any).size : (net as any).netSize;
        const fPx = (net as any).entryPx;
        const role = single ? (net as any).role
          : ((net as any).grossSize > 0 && entryRows.length === 2
            ? ((await fillsByCloid(info, user, entryRows.find((o: any) => o.role === "entry_upper")!.cloid)).size
              >= (await fillsByCloid(info, user, entryRows.find((o: any) => o.role === "entry_lower")!.cloid)).size
              ? "entry_upper" : "entry_lower")
            : "entry_upper");
        await ctx.runMutation(internal.tradingBots.settleTradingArm, {
          armId, token, status: "filled",
          filledSize: fSize > 0 ? fSize : undefined, entryPrice: fPx > 0 ? fPx : undefined,
          filledEntryRole: role, filledSide: side ?? undefined,
        });
        data = await ctx.runQuery(internal.tradingBots.getTradingArmInternal, { armId });
        if (!data) return { skipped: "not_found" };
      }

      let arm = data.arm;
      const orders = data.orders;
      const ownCloids = [...orders.map((o: any) => o.cloid), ...(arm.slPendingCloid ? [arm.slPendingCloid] : [])]
        .filter((c, i, a) => c && a.indexOf(c) === i);

      // ===== FASE DE POSICIÓN =====
      if (arm.status === "filled" || arm.status === "protecting" || arm.status === "protected") {
        const ch: any = await info.clearinghouseState({ user });
        const p = (ch.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
        const szi = p ? Number(p.position?.szi ?? 0) : 0;
        const flat = isFlatOrDust(szi, markPx);
        // LADO REAL de la posición: signo de szi manda (P1 — un neteo pudo invertir el lado).
        const side: "Long" | "Short" = !flat ? positionSideFromSzi(szi) : (arm.filledSide ?? "Long");
        const realSize = !flat ? Math.abs(szi) : (arm.filledSize ?? 0);
        const posEntryPx = (p && Number(p.position?.entryPx) > 0) ? Number(p.position.entryPx) : (arm.entryPrice ?? 0);
        let slOrder = orders.find((o: any) => o.role === "sl");
        const closeOrder = orders.find((o: any) => o.role === "close");

        // (1) ACTUALIZAR filledSize con el intent releído de fills (revisión PR3, bloqueante #2): un
        // remanente de la entrada que llena tarde crece la posición LEGÍTIMAMENTE — el drift jamás
        // debe compararse contra el snapshot stale (cancelaría el SL de una posición sana).
        const intentNow = net.kind === "single" ? (net as any).size
          : net.kind === "both" ? (net as any).netSize
          : (arm.filledSize ?? arm.size);
        if (intentNow > (arm.filledSize ?? 0)) {
          await ctx.runMutation(internal.tradingBots.setTradingFillData, {
            armId, token, filledSize: intentNow,
            entryPrice: (net as any).entryPx > 0 ? (net as any).entryPx : undefined,
          });
        }

        // Fills de TPs ANTES del drift (reducción legítima de la posición).
        const tpOrders = orders.filter((o: any) => o.role === "tp");
        let filledTpQty = 0;
        const filledTpIdx = new Set<number>();
        for (const tp of tpOrders) {
          const tf = await fillsByCloid(info, user, tp.cloid);
          if (tf.size > 0) {
            filledTpQty += tf.size;
            filledTpIdx.add(tp.tpIndex);
            if (tp.observedStatus !== "filled") {
              await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "tp", tpIndex: tp.tpIndex, observedStatus: "filled" });
            }
          }
        }

        // ¿SL ejecutado? (observed + fills + rotación slPendingCloid).
        let slConfirmed = slOrder?.observedStatus === "filled";
        if (!slConfirmed && slOrder) {
          const sf = await fillsByCloid(info, user, slOrder.cloid);
          if (sf.size > 0) slConfirmed = true;
        }
        if (!slConfirmed && arm.slPendingCloid) {
          const pf = await fillsByCloid(info, user, arm.slPendingCloid);
          if (pf.size > 0) slConfirmed = true;
        }

        if (flat) {
          if (arm.closeConfirmSince == null) {
            await ctx.runMutation(internal.tradingBots.setTradingCloseConfirm, { armId, token, value: Date.now() });
            return { skipped: "close_confirm_first_read" };
          }
          if (Date.now() - (arm.filledAt ?? arm.createdAt) <= CLOSE_CONFIRM_GRACE_MS
            || Date.now() - arm.closeConfirmSince <= CLOSE_CONFIRM_GRACE_MS) {
            return { skipped: "close_confirm_grace" };
          }
          const renew = await ctx.runMutation(internal.tradingBots.renewTradingReconcile, { armId, token });
          if (!renew.ok) return { skipped: "lease_lost" };
          const allDead = await ensureTradingOrdersDead(info, exchange, user, assetId, ownCloids);
          if (!allDead) return { skipped: "orders_still_live" };
          const tpTotalPct = (arm.tps ?? []).reduce((s: number, t: any) => s + t.closePct, 0);
          const tpClosedAll = tpTotalPct >= 100 - 1e-9 && filledTpIdx.size === (arm.tps ?? []).length && (arm.tps ?? []).length > 0;
          const closeReason = pickCloseReason({
            emergencyClosing: arm.emergencyClosing, bothEntriesFilled, wantDisarm,
            slConfirmed, tpClosedAll,
          });
          await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "closed", closeReason });
          return { result: "closed", closeReason };
        }
        if (arm.closeConfirmSince != null) {
          await ctx.runMutation(internal.tradingBots.setTradingCloseConfirm, { armId, token, value: null });
        }
        if (slConfirmed) {
          // El SL se ejecutó: la rama flat cerrará (grace). No colocar nada más.
          return { result: "sl_filled" };
        }

        // BE latch + anchor AVANZADO se computan UNA vez y alimentan TODAS las decisiones del tick
        // (revisión PR3, bloqueante #1: la colocación y la rotación deben ver el MISMO deseado — si
        // no, el paso 9 "mejora" sobre el paso 2 del mismo tick y cancela el SL recién puesto).
        const trailingEnabled = arm.trailingPct != null && arm.trailingPct > 0;
        const beMovedNow = arm.beMoved === true
          || beLatchReached({ side, entryPx: posEntryPx, markPx, breakevenPct: arm.breakevenPct, tp1Filled: filledTpIdx.has(0) });
        if (arm.beMoved !== true && beMovedNow) {
          await ctx.runMutation(internal.tradingBots.setTradingBeMoved, { armId, token });
        }
        const anchorNow = trailingEnabled ? nextTrailAnchor(side, arm.trailAnchorPx ?? posEntryPx, markPx) : (arm.trailAnchorPx ?? posEntryPx);
        if (trailingEnabled && anchorNow !== (arm.trailAnchorPx ?? posEntryPx)) {
          await ctx.runMutation(internal.tradingBots.setTradingTrailAnchor, { armId, token, anchorPx: anchorNow });
        }
        const desiredNow = posEntryPx > 0 ? computeDesiredSlTrigger({
          side, entryPx: posEntryPx, stopLossPct: arm.stopLossPct, beMoved: beMovedNow,
          trailingEnabled, trailAnchorPx: anchorNow, trailingPct: arm.trailingPct ?? 0,
          currentSlPx: undefined, markPx, tickSize,
        }) : 0;
        const sizeToProtect = floorToDecimals(realSize, szDecimals);

        // ROTACIÓN compartida place-antes-de-cancel vía slPendingCloid (revisión PR3: el resize/lado
        // usaba una recolocación plana que HUÉRFANABA el SL viejo vivo — fuera de tracking para
        // siempre). attempt SIEMPRE desde el arm FRESCO re-leído (jamás del snapshot del tick).
        // (JAV-179-C2) El trigger se recomputa DENTRO con `currentSlPx` del SL vivo del MISMO lado:
        // computeDesiredSlTrigger lo clampa monotónico ⇒ por construcción jamás se coloca un SL peor
        // para el mismo lado (incluye el path de resize, que no pasa por decideSlReplacement).
        const rotateSl = async (o: {
          oldCloid?: string; side: "Long" | "Short"; size: number;
          currentSlPxSameSide?: number; bare?: boolean;   // bare: solo SL base (3b — sin BE/trailing)
        }): Promise<"rotated" | "old_still_live" | "pending" | "lease_lost" | "collision"> => {
          const freshData = await ctx.runQuery(internal.tradingBots.getTradingArmInternal, { armId });
          if (!freshData) return "lease_lost";
          const newAttempt = (freshData.arm.slAttempts ?? 0) + 1;
          const newCloid = await toHlCloid(tradingCloidInput(String(armId), arm.generation, "sl", newAttempt));
          // Guard anti-colisión (bloqueante #1): si el cloid "nuevo" ES el SL vivo actual (attempt
          // stale), abortar — jamás cancelar el único SL creyendo que es el viejo.
          if (o.oldCloid && newCloid.toLowerCase() === o.oldCloid.toLowerCase()) return "collision";
          const trigger = computeDesiredSlTrigger({
            side: o.side, entryPx: posEntryPx, stopLossPct: arm.stopLossPct,
            beMoved: o.bare ? false : beMovedNow,
            trailingEnabled: o.bare ? false : trailingEnabled,
            trailAnchorPx: anchorNow, trailingPct: arm.trailingPct ?? 0,
            currentSlPx: o.currentSlPxSameSide, markPx, tickSize,
          });
          let placed = await openByCloid(info, user, newCloid);
          if (!placed) {
            const renewT = await ctx.runMutation(internal.tradingBots.renewTradingReconcile, { armId, token });
            if (!renewT.ok) return "lease_lost";
            await ctx.runMutation(internal.tradingBots.setTradingSlPendingCloid, { armId, token, cloid: newCloid });
            try {
              const rt = await placeStopLoss(exchange, assetId, szDecimals, o.side, o.size, posEntryPx, arm.stopLossPct, newCloid as `0x${string}`, trigger);
              placed = rt.state === "resting" || rt.state === "filled";
            } catch { placed = false; }
          }
          if (!placed) return "pending";   // slPendingCloid trackea el intento; reintento próximo ciclo
          if (o.oldCloid) {
            await cancelOwnByCloid(exchange, assetId, [o.oldCloid]);
            const oldDead = !(await openByCloid(info, user, o.oldCloid));
            if (!oldDead) return "old_still_live";   // el nuevo queda trackeado vía slPendingCloid
          }
          await ctx.runMutation(internal.tradingBots.recordTradingSlOrder, {
            armId, token, cloid: newCloid, triggerPx: trigger, size: o.size,
            isBuy: o.side === "Short", observedStatus: "open", markSubmitted: true, attempt: newAttempt,
          });
          await ctx.runMutation(internal.tradingBots.setTradingSlPendingCloid, { armId, token, cloid: null });
          // SL resting confirmado ⇒ ventana de protección CERRADA (deadline fuera).
          await ctx.runMutation(internal.tradingBots.setTradingProtectDeadline, { armId, token, value: null });
          return "rotated";
        };

        // (2) SL PRIMERO — dimensionado al realSize releído, LADO por signo del szi (P1).
        let slAlive = false, slProtected = false, slPlacedThisTick = false;
        if (slOrder) {
          if (await openByCloid(info, user, slOrder.cloid)) {
            slAlive = true;
            if (slOrder.observedStatus !== "open") {
              await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "sl", observedStatus: "open" });
            }
            // (CodeRabbit #145 Critical) slProtected SOLO si el SL vivo cubre lado Y tamaño reales: un
            // SL del lado equivocado o menor que la posición NO protege ⇒ no marcar protected ni cerrar
            // el deadline hasta que la rotación coloque el correcto.
            const wrongSide = slOrder.isBuy !== (side === "Short");
            const undersized = realSize > slOrder.size * 1.02;
            slProtected = !wrongSide && !undersized;
            // SL nunca menor que la posición ni del lado equivocado ⇒ ROTACIÓN place-antes-de-cancel
            // (jamás recolocación plana que huérfana al vivo — revisión PR3 high #2).
            if ((undersized || wrongSide) && desiredNow > 0) {
              // (C2) mismo lado ⇒ el trigger viejo entra como piso monotónico; lado invertido ⇒ no aplica.
              const r = await rotateSl({
                oldCloid: slOrder.cloid, side, size: sizeToProtect,
                currentSlPxSameSide: wrongSide ? undefined : slOrder.triggerPx,
              });
              if (r === "rotated") { slProtected = true; slPlacedThisTick = true; }
              else if (r === "lease_lost") return { skipped: "lease_lost" };
              // pending/old_still_live/collision: el SL correcto aún NO está resting ⇒ NO avanzar a
              // protected/TPs/3b este tick con un SL insuficiente vivo; reintento el próximo ciclo.
              else return { result: "sl_reprotecting" };
            }
          } else if (slOrder.observedStatus === "pending" && slOrder.submittedAt != null
            && Date.now() - slOrder.submittedAt <= ORDER_SUBMIT_GRACE_MS) {
            return { result: "sl_pending_grace" };
          } else {
            await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "sl", observedStatus: "canceled" });
          }
        }
        if (!slAlive) {
          // SIN SL vivo: ventana de protección (deadline) gobierna la escalada a emergencia — NUNCA
          // el contador de cloids (las rotaciones legítimas del trailing lo consumían: revisión PR3).
          if (arm.protectDeadline == null) {
            await ctx.runMutation(internal.tradingBots.setTradingProtectDeadline, { armId, token, value: Date.now() + SL_PROTECT_DEADLINE_MS });
          } else if (Date.now() > arm.protectDeadline) {
            // Deadline vencido sin protección: cierre de EMERGENCIA IOC (rol close, cloid determinista).
            await ctx.runMutation(internal.tradingBots.setTradingEmergencyClosing, { armId, token, value: "emergency" });
            const closeAttempt = closeOrder ? (closeOrder.attempt ?? 0) + 1 : 0;
            const closeCloid = await toHlCloid(tradingCloidInput(String(armId), arm.generation, "close", closeAttempt));
            const isBuy = side === "Short";
            const limitPx = aggressiveHlPriceStr(isBuy ? markPx * 1.02 : markPx * 0.98, szDecimals, isBuy);
            const pre = await ctx.runMutation(internal.tradingBots.recordTradingCloseOrder, {
              armId, token, cloid: closeCloid, isBuy, limitPx: Number(limitPx), size: sizeToProtect, observedStatus: "pending", attempt: closeAttempt,
            });
            if (!pre.ok) return { skipped: "close_prepare_failed" };
            const acC = abortAfter(HL_ORDER_TIMEOUT_MS);
            try {
              await exchange.order({
                orders: [{ a: assetId, b: isBuy, p: limitPx, s: String(sizeToProtect), r: true, t: { limit: { tif: "Ioc" } }, c: closeCloid as `0x${string}` }],
                grouping: "na",
              }, { signal: acC.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
              await ctx.runMutation(internal.tradingBots.recordTradingCloseOrder, { armId, token, cloid: closeCloid, isBuy, limitPx: Number(limitPx), size: sizeToProtect, observedStatus: "unknown", markSubmitted: true, attempt: closeAttempt });
            } catch { /* reintenta el próximo ciclo; reduceOnly no sobre-cierra */ } finally { acC.clear(); }
            return { result: "emergency_closing" };
          }
          if (desiredNow > 0) {
            const r = await rotateSl({ side, size: sizeToProtect });   // colocación fresca (sin viejo)
            if (r === "rotated") { slProtected = true; slPlacedThisTick = true; }
            else if (r === "lease_lost") return { skipped: "lease_lost" };
            else {
              await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "protecting" });
              return { result: "sl_placing_pending" };
            }
          } else {
            return { skipped: "awaiting_entry_price" };
          }
        }
        if ((slProtected || slAlive) && (arm.status === "filled" || arm.status === "protecting")) {
          await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "protected" });
        }
        if (slProtected && arm.protectDeadline != null) {
          await ctx.runMutation(internal.tradingBots.setTradingProtectDeadline, { armId, token, value: null });
        }

        // (3) OCO: cancelar hermana → confirmar muerta → RELEER fills post-cancel (decisión PURA:
        // reduce SOLO con relectura negativa — P1).
        if (!arm.ocoConfirmed && net.kind === "single" && entryRows.length === 2) {
          const filledRole = arm.filledEntryRole ?? (net as any).role;
          const sisterRow = entryRows.find((o: any) => o.role !== filledRole);
          if (sisterRow) {
            await cancelOwnByCloid(exchange, assetId, [sisterRow.cloid]);
            const sisterDead = !(await openByCloid(info, user, sisterRow.cloid));
            const sisterFill = sisterDead ? await fillsByCloid(info, user, sisterRow.cloid) : { size: 0, avgPx: 0 };
            const outcome = decideSisterOutcome({ sisterDead, sisterFillSize: sisterFill.size });
            if (outcome === "reduce") {
              await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: sisterRow.role, observedStatus: "canceled" });
              await ctx.runMutation(internal.tradingBots.reduceTradingReservation, { armId, token });
            } else if (outcome === "oco_race") {
              net = await computeNet();
              bothEntriesFilled = net.kind === "both";
            }
            // "wait": cancel no confirmado ⇒ ni reducir ni clasificar; próximo ciclo.
          }
        }

        // (3b) AMBAS entradas llenas: rutina única de oco_race sobre el szi FRESCO (revisión PR3: el
        // szi del tope del tick es pre-cancelación — releer antes de decidir/proteger/cerrar).
        if (net.kind === "both") {
          const ch2: any = await info.clearinghouseState({ user });
          const p2 = (ch2.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
          const szi2 = p2 ? Number(p2.position?.szi ?? 0) : 0;
          const flatEps = markPx > 0 ? 10 / markPx : 0;   // alineado con isFlatOrDust (~$10 nocional)
          const netForRace: NetEntryFills = isFlatOrDust(szi2, markPx)
            ? { kind: "both", netSide: null, netSize: 0, grossSize: (net as any).grossSize, entryPx: (net as any).entryPx }
            : { kind: "both", netSide: positionSideFromSzi(szi2), netSize: Math.abs(szi2), grossSize: (net as any).grossSize, entryPx: (net as any).entryPx };
          const res = resolveOcoRaceResolution(netForRace, flatEps);
          if (res.action === "close_flat_oco_race") {
            await cancelOwnByCloid(exchange, assetId, ownCloids);
            return { result: "oco_race_flat_pending_confirm" };   // la rama flat cierra con closeReason oco_race
          }
          // Residuo/2×: SL cubriendo el szi FRESCO (lado por signo) ANTES del IOC — plan 3b literal.
          const freshSlRow = (await ctx.runQuery(internal.tradingBots.getTradingArmInternal, { armId }))?.orders.find((o: any) => o.role === "sl");
          const slCovers = freshSlRow != null
            && freshSlRow.isBuy === (res.side === "Short")
            && freshSlRow.size >= res.size * 0.98
            && await openByCloid(info, user, freshSlRow.cloid);
          if (!slCovers) {
            // (CodeRabbit #145 Critical) Si el SL vivo NO cubre el residuo/lado FRESCO, JAMÁS avanzar
            // al IOC — aunque se haya colocado un SL este mismo tick (podría ser del size/lado viejos):
            // proteger primero, cerrar después. Sin esto, un IOC que falla deja la posición oco_race
            // con un SL insuficiente o del lado anterior.
            if (slPlacedThisTick) return { result: "oco_race_protecting" };
            // (C2) SL de PROTECCIÓN pura (bare: sin BE/trailing) al lado/size del szi FRESCO del 3b.
            const r = await rotateSl({
              oldCloid: freshSlRow?.cloid, side: res.side, size: floorToDecimals(res.size, szDecimals),
              currentSlPxSameSide: (freshSlRow && freshSlRow.isBuy === (res.side === "Short")) ? freshSlRow.triggerPx : undefined,
              bare: true,
            });
            if (r === "lease_lost") return { skipped: "lease_lost" };
            if (r !== "rotated") return { result: "oco_race_protecting" };   // primero proteger; IOC el próximo paso/ciclo
          }
          const closeAttempt = closeOrder ? (closeOrder.attempt ?? 0) + 1 : 0;
          if (closeAttempt > CLOSE_MAX_ATTEMPTS) {
            // IOC no logra flat: manual_intervention DEJANDO el SL resting (posición atribuible por
            // cloid propio — excepción documentada al patrón drift). Cancelar TPs/entradas propias.
            const slCloids = [freshSlRow?.cloid, arm.slPendingCloid].filter(Boolean) as string[];
            const nonSl = ownCloids.filter((c) => !slCloids.includes(c));
            await cancelOwnByCloid(exchange, assetId, nonSl);
            await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "manual_intervention", error: "[manual] oco_race: IOC de cierre no logró flat; SL resting cubre la posición" });
            return { result: "oco_race_manual_intervention" };
          }
          const closeCloid = await toHlCloid(tradingCloidInput(String(armId), arm.generation, "close", closeAttempt));
          const isBuy = res.side === "Short";
          const limitPx = aggressiveHlPriceStr(isBuy ? markPx * 1.02 : markPx * 0.98, szDecimals, isBuy);
          const szClose = floorToDecimals(res.size, szDecimals);
          const pre = await ctx.runMutation(internal.tradingBots.recordTradingCloseOrder, {
            armId, token, cloid: closeCloid, isBuy, limitPx: Number(limitPx), size: szClose, observedStatus: "pending", attempt: closeAttempt,
          });
          if (!pre.ok) return { skipped: "close_prepare_failed" };
          const acR = abortAfter(HL_ORDER_TIMEOUT_MS);
          try {
            await exchange.order({
              orders: [{ a: assetId, b: isBuy, p: limitPx, s: String(szClose), r: true, t: { limit: { tif: "Ioc" } }, c: closeCloid as `0x${string}` }],
              grouping: "na",
            }, { signal: acR.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
            await ctx.runMutation(internal.tradingBots.recordTradingCloseOrder, { armId, token, cloid: closeCloid, isBuy, limitPx: Number(limitPx), size: szClose, observedStatus: "unknown", markSubmitted: true, attempt: closeAttempt });
          } catch { /* SL resting protege; reintento próximo ciclo */ } finally { acR.clear(); }
          return { result: "oco_race_closing_total" };
        }

        // (5) drift: expected = intent RELEÍDO − TPs cerrados − cierres propios (rol close, por cloid).
        // Se OMITE con emergencyClosing activo (la reducción es NUESTRA: disarm/emergencia en curso).
        if (arm.emergencyClosing == null) {
          let closeQty = 0;
          if (closeOrder) {
            const cfq = await fillsByCloid(info, user, closeOrder.cloid);
            closeQty = cfq.size;
          }
          const intent = Math.max(intentNow, arm.filledSize ?? 0) || arm.size;
          const expected = Math.max(0, intent - filledTpQty - closeQty);
          const dust = (arm.size ?? intent) * DRIFT_TOL;
          const drifting = (expected > dust && Math.abs(realSize - expected) > expected * DRIFT_TOL)
            || (expected <= dust && realSize > dust);
          if (drifting) {
            if (arm.driftConfirmSince == null) {
              await ctx.runMutation(internal.tradingBots.setTradingDriftConfirm, { armId, token, value: Date.now() });
              return { skipped: "drift_confirm_first_read" };
            }
            if (Date.now() - arm.driftConfirmSince <= DRIFT_CONFIRM_GRACE_MS) return { skipped: "drift_confirm_grace" };
            await cancelOwnByCloid(exchange, assetId, ownCloids);
            await ctx.runMutation(internal.tradingBots.settleTradingArm, { armId, token, status: "manual_intervention", error: `[manual] drift: szi real ${realSize} vs esperado ${expected}` });
            return { result: "manual_intervention" };
          }
          if (arm.driftConfirmSince != null) {
            await ctx.runMutation(internal.tradingBots.setTradingDriftConfirm, { armId, token, value: null });
          }
        }

        // (7) wantDisarm con posición: IOC reduce-only PRIMERO (rol close, CLOID determinista —
        // revisión PR3: sin cloid, un fill parcial del cierre se leía como drift y cancelaba el SL),
        // SL vivo hasta flat.
        if (wantDisarm) {
          await ctx.runMutation(internal.tradingBots.setTradingEmergencyClosing, { armId, token, value: "disarm" });
          const renewC = await ctx.runMutation(internal.tradingBots.renewTradingReconcile, { armId, token });
          if (!renewC.ok) return { skipped: "lease_lost" };
          const closeAttempt = closeOrder ? (closeOrder.attempt ?? 0) + 1 : 0;
          const closeCloid = await toHlCloid(tradingCloidInput(String(armId), arm.generation, "close", closeAttempt));
          const isBuy = side === "Short";
          const closeLimitPx = aggressiveHlPriceStr(isBuy ? markPx * 1.02 : markPx * 0.98, szDecimals, isBuy);
          const pre = await ctx.runMutation(internal.tradingBots.recordTradingCloseOrder, {
            armId, token, cloid: closeCloid, isBuy, limitPx: Number(closeLimitPx), size: sizeToProtect, observedStatus: "pending", attempt: closeAttempt,
          });
          if (!pre.ok) return { skipped: "close_prepare_failed" };
          const acC = abortAfter(HL_ORDER_TIMEOUT_MS);
          try {
            await exchange.order({
              orders: [{ a: assetId, b: isBuy, p: closeLimitPx, s: String(sizeToProtect), r: true, t: { limit: { tif: "Ioc" } }, c: closeCloid as `0x${string}` }],
              grouping: "na",
            }, { signal: acC.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
            await ctx.runMutation(internal.tradingBots.recordTradingCloseOrder, { armId, token, cloid: closeCloid, isBuy, limitPx: Number(closeLimitPx), size: sizeToProtect, observedStatus: "unknown", markSubmitted: true, attempt: closeAttempt });
          } catch { /* SL sigue protegiendo; reintenta */ } finally { acC.clear(); }
          const ch3: any = await info.clearinghouseState({ user });
          const p3 = (ch3.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
          if (isFlatOrDust(p3 ? Number(p3.position?.szi ?? 0) : 0, markPx)) {
            await ensureTradingOrdersDead(info, exchange, user, assetId, ownCloids);
            return { result: "closed_flat_pending_confirm" };
          }
          return { result: "closing" };
        }

        if (!slProtected && !slAlive) return { result: "protecting_no_tp" };

        // (9) TRAILING: rotación con histéresis — nunca en el MISMO tick de una colocación (bloqueante
        // #1: colocación y rotación comparten desiredNow/anchorNow, y el guard de colisión de cloid en
        // rotateSl es la tercera red).
        if ((trailingEnabled || beMovedNow) && !slPlacedThisTick && desiredNow > 0) {
          const freshSl = (await ctx.runQuery(internal.tradingBots.getTradingArmInternal, { armId }))?.orders.find((o: any) => o.role === "sl");
          if (freshSl && freshSl.observedStatus === "open") {
            const dec = decideSlReplacement({ side, desiredPx: desiredNow, currentSlPx: freshSl.triggerPx, tickSize, lastSlReplaceAt: arm.lastSlReplaceAt, now: Date.now() });
            if (dec.replace) {
              const r = await rotateSl({ oldCloid: freshSl.cloid, side, size: sizeToProtect, currentSlPxSameSide: freshSl.triggerPx });
              if (r === "lease_lost") return { skipped: "lease_lost" };
              if (r === "rotated") return { result: "sl_ratcheted" };
              if (r === "old_still_live") return { result: "sl_rotation_old_still_live" };
              if (r === "pending") return { result: "sl_rotation_pending" };
              // collision: attempt stale — el próximo ciclo rota con el contador fresco.
            }
          }
        }

        // (10) TPs faltantes — SOLO con arm protected y OCO confirmado (size estable).
        if (arm.ocoConfirmed === true && (arm.tps ?? []).length > 0 && posEntryPx > 0 && (slProtected || slAlive)) {
          const levels = tpLevels({ side, entryPx: posEntryPx, filledSize: Math.max(intentNow, arm.filledSize ?? 0) || realSize, tps: arm.tps ?? [], szDecimals });
          for (const lv of levels) {
            const existing = tpOrders.find((o: any) => o.tpIndex === lv.tpIndex);
            if (filledTpIdx.has(lv.tpIndex) || existing?.observedStatus === "filled") continue;
            if (existing) {
              const sp: any = await info.orderStatus({ user, oid: existing.cloid as `0x${string}` });
              const spState = sp?.status === "order" ? sp.order?.status : undefined;
              const fOpen = await openByCloid(info, user, existing.cloid);
              const fFill = await fillsByCloid(info, user, existing.cloid);
              if (spState === "filled" || fFill.size > 0) {
                await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "tp", tpIndex: lv.tpIndex, observedStatus: "filled" });
                continue;
              }
              if (spState === "open" || fOpen) {
                if (existing.observedStatus !== "open") {
                  await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "tp", tpIndex: lv.tpIndex, observedStatus: "open" });
                }
                continue;
              }
              if (spState === "triggered") {
                if (existing.observedStatus !== "triggered") {
                  await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "tp", tpIndex: lv.tpIndex, observedStatus: "triggered" });
                }
                continue;
              }
              const recoveryAt = existing.submittedAt ?? existing.preparedAt;
              if (recoveryAt != null && Date.now() - recoveryAt <= ORDER_SUBMIT_GRACE_MS) continue;
              if (existing.observedStatus !== "canceled") {
                await ctx.runMutation(internal.tradingBots.setTradingOrderObserved, { armId, token, role: "tp", tpIndex: lv.tpIndex, observedStatus: "canceled" });
              }
            }
            const attempt = existing ? (existing.attempt ?? 0) + 1 : 0;
            const tpCloid = await toHlCloid(tradingCloidInput(String(armId), arm.generation, "tp", attempt, lv.tpIndex));
            const tpTriggerPx = roundHlPrice(lv.triggerPx, szDecimals, side === "Long" ? "ceil" : "floor");
            if (!(lv.size > 0) || !(tpTriggerPx > 0)) continue;
            const renewTp = await ctx.runMutation(internal.tradingBots.renewTradingReconcile, { armId, token });
            if (!renewTp.ok) return { skipped: "lease_lost" };
            const preTp = await ctx.runMutation(internal.tradingBots.recordTradingTpOrder, {
              armId, token, tpIndex: lv.tpIndex, cloid: tpCloid, triggerPx: tpTriggerPx, size: lv.size,
              isBuy: side === "Short", observedStatus: "pending", attempt,
            });
            if (!preTp.ok) return { skipped: "tp_prepare_failed" };
            const isBuyTp = side === "Short";
            const limitPx = aggressiveHlPriceStr(tpTriggerPx * (isBuyTp ? 1 + ENTRY_TRIGGER_SLIPPAGE : 1 - ENTRY_TRIGGER_SLIPPAGE), szDecimals, isBuyTp);
            const acT = abortAfter(HL_ORDER_TIMEOUT_MS);
            try {
              const respT: any = await exchange.order({
                orders: [{ a: assetId, b: isBuyTp, p: limitPx, s: String(lv.size), r: true,
                  t: { trigger: { isMarket: true, triggerPx: formatHlPrice(tpTriggerPx, szDecimals), tpsl: "tp" } }, c: tpCloid as `0x${string}` }],
                grouping: "na",
              }, { signal: acT.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
              const st = respT?.response?.data?.statuses?.[0];
              const obs = st?.filled?.oid != null ? "filled" : (st?.resting?.oid != null || st === "waitingForTrigger") ? "open" : st?.error ? "rejected" : "open";
              const oid = st?.resting?.oid != null ? String(st.resting.oid) : st?.filled?.oid != null ? String(st.filled.oid) : undefined;
              await ctx.runMutation(internal.tradingBots.recordTradingTpOrder, { armId, token, tpIndex: lv.tpIndex, cloid: tpCloid, triggerPx: tpTriggerPx, size: lv.size, isBuy: isBuyTp, observedStatus: obs, oid, attempt, markSubmitted: true });
            } catch (e) {
              const uncertain = e instanceof TransportError;
              await ctx.runMutation(internal.tradingBots.recordTradingTpOrder, {
                armId, token, tpIndex: lv.tpIndex, cloid: tpCloid, triggerPx: tpTriggerPx, size: lv.size, isBuy: isBuyTp, attempt,
                observedStatus: uncertain ? "pending" : "rejected", ...(uncertain ? { markSubmitted: true } : {}),
              });
            } finally { acT.clear(); }
          }
        }
        return { result: "position_reconciled" };
      }

      return { result: "reconciled_noop" };
    } finally {
      await ctx.runMutation(internal.tradingBots.releaseTradingReconcile, { armId, token });
    }
  },
});

// --- Cron 1/min: reconcilia TODOS los arms de trading vivos (try/catch por arm — JAV-122) -----------
export const reconcileAllTrading = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const ids = await ctx.runQuery(internal.tradingBots.listLiveTradingArmIdsInternal, {});
    let reconciled = 0;
    for (const armId of ids) {
      try { await ctx.runAction(internal.tradingEngine.reconcileTradingArm, { armId }); reconciled++; }
      catch (e) {
        const c = classifyTradingError(e);
        console.warn("[trading] reconcile arm failed:", c.kind, c.message.slice(0, 200));
      }
    }
    return { reconciled, total: ids.length };
  },
});

// --- Cron 1/min: auto-rearm durable del trading (política del plan: blocked_margin ACELERADO) -------
export const processTradingRearms = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const due = await ctx.runQuery(internal.tradingBots.listDueTradingRearmsInternal, {});
    let rearmed = 0;
    for (const botId of due) {
      // Anti-loop: si YA hay un arm vivo (reintento inmediato stale-retry que armó, o manual), el
      // rearm pendiente quedó obsoleto — limpiarlo en vez de reclamar y chocar con la unicidad.
      const live = await ctx.runQuery(internal.tradingBots.getLiveTradingArmInternal, { botId });
      if (live) {
        await ctx.runMutation(internal.tradingBots.clearTradingRearmIfArmedInternal, { botId });
        continue;
      }
      const claim = await ctx.runMutation(internal.triggerRearm.claimRearm, { botId });
      if (!claim.ok) continue;
      const botRow = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: botId });
      const attempts = botRow?.rearmAttempts ?? 0;
      try {
        const r: any = await ctx.runAction(internal.tradingEngine.armTradingInternal, { botId, rearmToken: claim.token });
        if (r?.ok === true) {
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, { botId, token: claim.token, outcome: "success" });
          rearmed++;
        } else {
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, {
            botId, token: claim.token, outcome: "transient", kind: "transient",
            error: `arm no colocado (${r?.status ?? "desconocido"})`, nextRearmAt: Date.now() + tradingRearmDelayMs("transient", attempts),
          });
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const kind = armErrorKind(msg);
        if (kind === "cancel") {
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, { botId, token: claim.token, outcome: "cancel", error: msg });
        } else if (kind === "blocked_margin" || kind === "blocked_cap" || kind === "blocked_config") {
          // (P6) blocked_margin = margen HL no liberado ⇒ ACELERADO 90s×3→5min (preocupación de
          // Javier). blocked_cap/blocked_config ⇒ 5 min SIN aceleración, jamás el backoff de margen.
          const delay = tradingRearmDelayMs(kind, attempts);
          if (kind === "blocked_margin" && attempts >= 20) {
            elog("trading", "blocked_margin_persistent", { botId: String(botId), attempts });
          }
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, {
            botId, token: claim.token, outcome: "blocked", kind, error: msg, nextRearmAt: Date.now() + delay,
          });
        } else {
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, {
            botId, token: claim.token, outcome: "transient", kind, error: msg, nextRearmAt: Date.now() + tradingRearmDelayMs(kind, attempts),
          });
        }
      }
    }
    return { rearmed, due: due.length };
  },
});
