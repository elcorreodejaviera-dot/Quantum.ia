"use node";

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlNetwork, hlIsTestnet } from "./hlNetwork";
import {
  makeClients, getAssetMeta, ceilHlPrice, roundHlPrice, aggressiveHlPriceStr,
  floorToDecimals, formatHlPrice, fillsByCloid, abortAfter,
} from "./hyperliquid";
import { TransportError } from "@nktkas/hyperliquid";

// --- JAV-44 Etapa 1: actions del motor (trigger nativo de entrada inferior, TESTNET) ---

const HL_ORDER_TIMEOUT_MS = 30_000;
// Banda agresiva del market al dispararse el trigger de entrada (venta). Gap > banda → puede no llenar.
const ENTRY_TRIGGER_SLIPPAGE = 0.02;
// Grace antes de declarar filled→closed (Fix #2): tras el fill, clearinghouseState puede dar szi==0
// transitoriamente por lag aunque la posición exista. Esperar este margen desde filledAt evita un
// closed prematuro que liberaría margen/credencial con la posición aún abierta.
const CLOSE_CONFIRM_GRACE_MS = 2 * 60_000;

// ¿Hay una orden VIVA con este cloid en el book? (parte de la prueba negativa R3 — no liberar a ciegas).
async function openByCloid(info: any, user: `0x${string}`, cloid: string): Promise<boolean> {
  const oo: any[] = await info.frontendOpenOrders({ user });
  return oo.some((o) => typeof o?.cloid === "string" && o.cloid.toLowerCase() === cloid.toLowerCase());
}

// Coloca/observa órdenes trigger por CLOID. Política de COLOCACIÓN: todos los gates + hard-gate testnet.
export const armPoolBotEntry = action({
  args: { botId: v.id("bots"), expectedNetwork: v.string(), confirm: v.boolean() },
  handler: async (ctx, args) => {
    // Hard-gate de red para COLOCAR (la cancelación defensiva NO usa esto — ver reconcileArm).
    if (hlNetwork() !== "testnet") throw new Error("Etapa 1: solo testnet (HL_NETWORK).");
    if (args.expectedNetwork !== "testnet") throw new Error("expectedNetwork debe ser testnet.");
    if (!args.confirm) throw new Error("Armado requiere confirmación explícita.");

    const user = await ctx.runQuery(internal.users.getCurrentUserInternal, {});
    await ctx.runQuery(internal.users.assertTradeLiveInternal, {});
    const [tradingConfig, simConfig] = await Promise.all([
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
    ]);
    if (tradingConfig?.value !== true) throw new Error("Live trading is disabled");
    if (simConfig?.value !== false) throw new Error("Simulation mode is active");

    const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: args.botId });
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id) throw new Error("Bot does not belong to this user");
    if (bot.kind !== "il") throw new Error("Solo bots IL (cobertura) en Etapa 1");
    if (bot.direction !== "short") throw new Error("El bot IL debe ser short");
    if (!bot.active) throw new Error("Bot is not active");
    if (bot.disarmPending) throw new Error("Bot pausándose (disarmPending): no se puede armar");
    if (bot.simulationMode) throw new Error("Bot en simulación");
    if (!bot.hlAccountId) throw new Error("Bot sin cuenta HL");
    if (!bot.poolId) throw new Error("Bot sin pool");
    if (!bot.baseAsset) throw new Error("Bot sin baseAsset");
    if (bot.hedgeNotionalUsd === undefined || !Number.isFinite(bot.hedgeNotionalUsd) || bot.hedgeNotionalUsd <= 0) {
      throw new Error("Bot sin hedgeNotionalUsd válido (> 0)");
    }

    const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: bot.poolId });
    if (!pool) throw new Error("Pool no encontrado");
    if (pool.closed) throw new Error("Pool cerrado");
    if (!Number.isFinite(pool.minRange) || pool.minRange <= 0) throw new Error("minRange inválido");

    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: bot.hlAccountId });
    if (!credential) throw new Error("Cuenta HL no encontrada");
    if (credential.userId !== user._id) throw new Error("La cuenta no pertenece a este usuario");

    const effLev = (!bot.autoLeverage && bot.leverage !== undefined) ? bot.leverage : 1;
    if (!Number.isFinite(effLev) || effLev < 1 || effLev > 25) throw new Error("leverage inválido");
    const appliedLeverage = Math.round(effLev);

    const asset = bot.baseAsset.toUpperCase();
    const { info, exchange } = makeClients(decryptPrivateKey(credential), hlIsTestnet());
    const { assetId, szDecimals, markPx } = await getAssetMeta(info, asset);
    const tradingAccount = credential.tradingAccountAddress as `0x${string}`;

    // (CodeRabbit) Paridad con executePerpMarketOrder: exigir cuenta en modo unified ANTES de
    // reservar margen (el snapshot de colateral spot solo es válido en unified).
    const abstraction = await info.userAbstraction({ user: tradingAccount });
    if (abstraction !== "unifiedAccount") {
      throw new Error("La cuenta HL no está en modo unified; armado bloqueado por seguridad.");
    }

    // (H4) Precondición flat: posición neta cero del activo.
    const chState = await info.clearinghouseState({ user: tradingAccount });
    const pos = (chState.assetPositions ?? []).find((p: any) => p.position?.coin === asset);
    if (pos && Math.abs(Number(pos.position?.szi ?? 0)) > 0) {
      throw new Error("Ya existe posición abierta en el activo: armado bloqueado (precondición flat).");
    }
    // (Fix #7 / H4) Sin órdenes abiertas incompatibles en el activo (un trigger/orden previo dejaría
    // la cobertura en un estado ambiguo). En Etapa 1, cualquier orden abierta del activo bloquea.
    const openOrders: any[] = await info.frontendOpenOrders({ user: tradingAccount });
    if (openOrders.some((o) => o?.coin === asset)) {
      throw new Error("Hay órdenes abiertas en el activo: armado bloqueado (sin órdenes incompatibles).");
    }

    // (R6) Trigger normalizado al tick (floor) y gate mark > triggerPxNormalized SOBRE el valor enviado.
    const triggerPxNorm = roundHlPrice(pool.minRange, szDecimals, "floor");
    if (!(markPx > triggerPxNorm)) {
      throw new Error(`mark (${markPx}) ≤ triggerPx normalizado (${triggerPxNorm}): no se arma (precio ya en/bajo el rango).`);
    }

    // (H12 + Fix #4) Sizing desde hedgeNotionalUsd. AVISO: para una VENTA NO existe cota dura del
    // nocional — el límite SELL es un SUELO (triggerPx*(1−slip)), no un techo, así que un fill por
    // encima del trigger PUEDE superar el nocional/margen/diario reservados (mismo caso que el Short
    // de JAV-43, aceptado conscientemente). `triggerPx*(1+slip)` es solo una ESTIMACIÓN conservadora
    // que reduce el tamaño; el residuo de sobre-ejecución queda acotado por: aislamiento TESTNET,
    // el MARGIN_SAFETY_BUFFER (10%) del colateral, y que el trigger dispara en CAÍDA (fill ≈ triggerPx,
    // no por encima salvo rebote sub-segundo). NO es una garantía.
    const notionalCapPx = ceilHlPrice(triggerPxNorm * (1 + ENTRY_TRIGGER_SLIPPAGE), szDecimals);
    const size = floorToDecimals(bot.hedgeNotionalUsd / notionalCapPx, szDecimals);
    if (size <= 0) throw new Error("Size redondea a cero");
    const reservedNotional = size * notionalCapPx;
    const marginRequired = reservedNotional / appliedLeverage;

    // Colateral USDC spot libre (sin doble conteo; reserveArm descuenta el comprometido de ambos motores).
    const spotState = await info.spotClearinghouseState({ user: tradingAccount });
    const availableCollateral = (spotState.balances ?? [])
      .filter((b: any) => b.coin === "USDC")
      .reduce((s: number, b: any) => s + Math.max(0, parseFloat(b.total ?? "0") - parseFloat(b.hold ?? "0")), 0);

    // Reserva OCC (generación, unicidad, margen/daily compartidos) — crea arm(arming)+order(pending).
    const reservation = await ctx.runMutation(internal.triggerArms.reserveArm, {
      botId: bot._id, userId: user._id, hlAccountId: bot.hlAccountId, poolId: bot.poolId,
      asset, network: hlNetwork(), triggerPx: triggerPxNorm, size, appliedLeverage,
      reservedNotional, marginReserved: marginRequired, lowerEdge: pool.minRange, availableCollateral,
    });
    const { armId, cloid } = reservation;

    // (N1/N5) CAS pre-envío: arming→submitting + submittedAt (cuarentena). Si falla → abortar SIN enviar.
    const sub = await ctx.runMutation(internal.triggerArms.markArmSubmitting, { armId });
    if (!sub.ok) return { ok: false, status: "aborted", armId, reason: sub.reason };
    const token = sub.token;

    // Apalancamiento entero en HL (isolated).
    await exchange.updateLeverage({ asset: assetId, isCross: false, leverage: appliedLeverage });

    // (Fix #1) Gate ATÓMICO justo antes del envío: updateLeverage pudo tardar y un kill switch/pausa/
    // revocación ocurrir en esa ventana (desiredState no lo refleja). Revalidar TODO bajo el lease.
    const gate = await ctx.runMutation(internal.triggerArms.gateArmBeforeOrder, { armId, token });
    if (!gate.ok) {
      // No se envió. Dejar el arm reconciliable: el cron verá unknownOid → prueba negativa → failed
      // (tras cuarentena) o, si hay kill switch, el camino defensivo. Liberar el lease.
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
      return { ok: false, status: "gated", armId };
    }

    // Colocar el trigger nativo de ENTRADA: SELL (abre short), reduceOnly:false, stop-market que
    // dispara al CAER a triggerPx (tpsl:"sl"); banda agresiva floor para venta.
    const limitPx = aggressiveHlPriceStr(triggerPxNorm * (1 - ENTRY_TRIGGER_SLIPPAGE), szDecimals, false);
    const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
    let resp: unknown;
    try {
      resp = await exchange.order({
        orders: [{
          a: assetId, b: false, p: limitPx, s: String(size), r: false,
          t: { trigger: { isMarket: true, triggerPx: formatHlPrice(triggerPxNorm, szDecimals), tpsl: "sl" } },
          c: cloid as `0x${string}`,
        }],
        grouping: "na",
      }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
    } catch (e) {
      // TransportError (incierto, pudo enviarse) → unknown (cuarentena impide terminalizar pronto).
      // Definitivo (ApiRequestError/Validation) → failed (settleArm aplica la cuarentena N6).
      if (e instanceof TransportError) {
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "unknown", error: String((e as Error)?.message ?? e) });
      } else {
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: String((e as Error)?.message ?? e) });
      }
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
      return { ok: false, status: "send_error", armId };
    } finally {
      ac.clear();
    }

    const st = (resp as any)?.response?.data?.statuses?.[0];
    if (st?.resting?.oid != null) {
      // El oid va en el trigger_order (el arm no tiene campo oid).
      await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "open", oid: String(st.resting.oid) });
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed" });
    } else if (st?.filled?.oid != null) {
      // (Fix #2) Fill inmediato: extraer tamaño/precio reales. Si vienen → filled CON datos; si no,
      // → unknown (reconcile confirma por fills): nunca un filled sin filledSize que permita closed.
      await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "filled", oid: String(st.filled.oid) });
      const fSize = Number(st.filled.totalSz), fPx = Number(st.filled.avgPx);
      if (fSize > 0 && fPx > 0) {
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: fSize, entryPrice: fPx });
      } else {
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "unknown", error: "fill inmediato sin datos" });
      }
    } else if (st === "waitingForTrigger") {
      // Trigger aceptado a la espera del cruce → armed; se confirma por CLOID en la reconciliación.
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed" });
    } else if (st?.error) {
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: String(st.error) });
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
      return { ok: false, status: "rejected", armId };
    } else {
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "unknown", error: "respuesta ambigua" });
    }

    // (N5 defensa) Tras enviar, re-leer la intención: si nos pausaron, cancelar lo que acabamos de poner.
    const fresh = await ctx.runQuery(internal.triggerArms.getArmInternal, { armId });
    if (fresh && fresh.desiredState === "disarmed") {
      try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: cloid as `0x${string}` }] }); } catch { /* el cron reconcilia */ }
    }
    await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
    // La reconciliación completa la hace el cron (claim limpio); aquí devolvemos el estado inicial.
    return { ok: true, status: "armed", armId };
  },
});

// Cron: reconcilia todos los arms no terminales (convergencia + kill switch + pausa + recuperación).
export const reconcileStaleArms = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids = await ctx.runQuery(internal.triggerArms.listReconcilableArmsInternal, { limit: 50 });
    let reconciled = 0;
    for (const id of ids) {
      try { await ctx.runAction(internal.triggerEngine.reconcileArm, { armId: id }); reconciled++; }
      catch { /* el siguiente ciclo reintenta */ }
    }
    return { reconciled };
  },
});

// Reconciliación de un arm: converge a desiredState. Política DEFENSIVA (cancelar) NO depende de los
// gates de colocación; usa SIEMPRE arm.network (inmutable) para construir el cliente.
export const reconcileArm = internalAction({
  args: { armId: v.id("trigger_arms") },
  handler: async (ctx, { armId }) => {
    const claim = await ctx.runMutation(internal.triggerArms.claimArmReconcile, { armId });
    if (!claim.claimed) return { skipped: claim.reason };
    const token = claim.token;
    try {
      const arm = await ctx.runQuery(internal.triggerArms.getArmInternal, { armId });
      if (!arm) return { skipped: "not_found" };
      const order = await ctx.runQuery(internal.triggerArms.getArmOrderInternal, { armId });
      if (!order) return { skipped: "no_order" };

      // Recuperación N7: arming abandonado pre-CAS (jamás envió) → failed sin cuarentena.
      if (arm.status === "arming" && arm.submittedAt == null) {
        const r = await ctx.runMutation(internal.triggerArms.recoverAbandonedArming, { armId, token });
        return { result: r.ok ? "arming_recovered" : "arming_too_recent" };
      }

      // Cliente SIEMPRE desde arm.network (testnet) — independiente del HL_NETWORK actual (N4).
      const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: arm.hlAccountId });
      if (!credential) return { skipped: "no_credential" };  // R4: no se pudo borrar hasta terminal
      const user = credential.tradingAccountAddress as `0x${string}`;
      const { info, exchange } = makeClients(decryptPrivateKey(credential), arm.network === "testnet");
      const assetMeta = await getAssetMeta(info, arm.asset.toUpperCase());
      const assetId = assetMeta.assetId;

      // (R2) filled → closed solo tras confirmar szi==0 (cierre manual en Etapa 1). Libera margen/
      // generación/credencial. Mientras la posición siga abierta, queda en filled (alerta operativa).
      if (arm.status === "filled") {
        // (Fix #2a) Exigir filledSize POSITIVO confirmado antes de poder cerrar. Si no lo tenemos
        // (p.ej. fill inmediato sin datos), reconciliar la entrada por fills primero; nunca cerrar
        // sin saber que la posición se abrió.
        if (!(arm.filledSize && arm.filledSize > 0)) {
          const f = await fillsByCloid(info, user, order.cloid);
          if (f.size > 0 && f.avgPx > 0) {
            await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: f.size, entryPrice: f.avgPx });
          }
          return { skipped: "filled_awaiting_fill_data" };
        }
        // (Fix #2b) Grace desde filledAt — fallback a createdAt, NO updatedAt (el claim lo bumpea cada
        // ciclo y reiniciaría el grace para siempre).
        if (Date.now() - (arm.filledAt ?? arm.createdAt) <= CLOSE_CONFIRM_GRACE_MS) {
          return { skipped: "close_confirm_grace" };
        }
        const ch: any = await info.clearinghouseState({ user });
        const p = (ch.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
        const flat = !p || Math.abs(Number(p.position?.szi ?? 0)) === 0;
        if (!flat) {
          if (arm.closeConfirmSince != null) await ctx.runMutation(internal.triggerArms.setArmCloseConfirm, { armId, token, value: null });
          return { skipped: "filled_position_open" };
        }
        // (Fix #2c) Doble lectura anti single-transient: exigir DOS lecturas szi==0 en ciclos
        // distintos antes de declarar closed (una lectura transitoria por lag no basta).
        if (arm.closeConfirmSince == null) {
          await ctx.runMutation(internal.triggerArms.setArmCloseConfirm, { armId, token, value: Date.now() });
          return { skipped: "close_first_flat" };
        }
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "closed" });
        return { result: "closed" };
      }

      // Kill switch / pausa (Fix #4): cualquier condición de apagado convierte el arm a desarmado y
      // fuerza la cancelación del trigger vivo. Incluye: switches globales, simulación, pool cerrado,
      // HL_NETWORK ya NO testnet (N4: el global se movió a mainnet), bot desactivado/en simulación,
      // cambio de cuenta o pool bajo el arm, y revocación de canTradeLive.
      const [tradingConfig, simConfig] = await Promise.all([
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
      ]);
      const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: arm.poolId });
      const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: arm.botId });
      const canLive = await ctx.runQuery(internal.users.hasTradeLiveForUserInternal, { userId: arm.userId });
      const killed =
        tradingConfig?.value !== true || simConfig?.value === true ||
        pool?.closed === true || hlNetwork() !== "testnet" ||
        !bot || !bot.active || bot.simulationMode === true ||
        bot.hlAccountId !== arm.hlAccountId || bot.poolId !== arm.poolId || !canLive;
      if (killed && arm.desiredState !== "disarmed") {
        await ctx.runMutation(internal.triggerArms.requestDisarmAndDeactivate, { botId: arm.botId });
      }
      const wantDisarm = killed || arm.desiredState === "disarmed";

      const statusByCloid: any = await info.orderStatus({ user, oid: order.cloid as `0x${string}` });
      const orderState: string | undefined = statusByCloid?.status === "order" ? statusByCloid.order?.status : undefined;
      const isUnknownOid = statusByCloid?.status === "unknownOid";
      const fill = await fillsByCloid(info, user, order.cloid);

      // ---- Camino DEFENSIVO (desarmar/cancelar) ----
      if (wantDisarm) {
        // Si ya se llenó → posición abierta, NO declarar disarmed (alerta; pasa a filled/closed).
        if (orderState === "filled" || fill.size > 0) {
          // (Fix #2) orderStatus filled pero userFills vacío (lag) → NO persistir filledSize=0; reintentar.
          if (!(fill.size > 0 && fill.avgPx > 0)) return { skipped: "fill_data_pending" };
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "filled", oid: order.oid });
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: fill.size, entryPrice: fill.avgPx });
          return { result: "disarm_but_filled" };
        }
        // (Fix #2) Un arm `triggered` también intenta cancelar (no retornar antes): aunque al
        // dispararse puede que ya no se pueda cancelar, hay que intentarlo y reconfirmar — si quedó
        // vivo/triggered seguirá en disarm_pending_confirmation, si llenó pasa a filled.
        // Intentar cancelar (idempotente).
        try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: order.cloid as `0x${string}` }] }); } catch { /* reintentar siguiente ciclo */ }
        const after: any = await info.orderStatus({ user, oid: order.cloid as `0x${string}` });
        const afterState = after?.status === "order" ? after.order?.status : undefined;
        const afterFill = await fillsByCloid(info, user, order.cloid);
        if (afterState === "filled" || afterFill.size > 0) {
          if (!(afterFill.size > 0 && afterFill.avgPx > 0)) return { skipped: "fill_data_pending" };
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: afterFill.size, entryPrice: afterFill.avgPx });
          return { result: "disarm_but_filled" };
        }
        // (Fix #1 / R3) Prueba negativa COMPLETA antes de declarar disarmed: (a) ausente del book,
        // (b) sin fills, (c) orderStatus no la muestra viva (open/triggered). NO confiar en que el
        // cancel "no lanzó" — eso no demuestra ausencia. Sin las tres → seguir disarming.
        const stillOpen = await openByCloid(info, user, order.cloid);
        const liveState = afterState === "open" || afterState === "triggered";
        if (!stillOpen && afterFill.size === 0 && !liveState) {
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "canceled" });
          // settleArm aplica la cuarentena N6: no terminaliza si aún está dentro del plazo.
          const r = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "disarmed" });
          return { result: r.ok ? "disarmed" : "disarm_quarantined" };
        }
        return { skipped: "disarm_pending_confirmation" };
      }

      // ---- Camino ARMADO (converger a armed) ----
      if (orderState === "filled" || fill.size > 0) {
        // (Fix #2) orderStatus filled pero userFills vacío (lag) → NO persistir filledSize=0; reintentar.
        if (!(fill.size > 0 && fill.avgPx > 0)) return { skipped: "fill_data_pending" };
        await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "filled", oid: order.oid });
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: fill.size, entryPrice: fill.avgPx });
        // filled→closed solo tras szi==0 + grace (cierre manual en Etapa 1) — lo evalúa el siguiente ciclo.
        return { result: "filled" };
      }
      if (orderState === "open") {
        await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "open", oid: order.oid });
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed" });
        return { result: "armed" };
      }
      if (orderState === "triggered") {
        await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "triggered", oid: order.oid });
        return { skipped: "triggered_pending" };
      }
      if (orderState && orderState !== "open" && orderState !== "triggered") {
        // Terminal sin fill (canceled/*Rejected/*Canceled). settleArm aplica cuarentena N6.
        await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "canceled" });
        const r = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: `orden terminal: ${orderState}` });
        return { result: r.ok ? "failed_terminal" : "terminal_quarantined" };
      }
      if (isUnknownOid) {
        // (Fix #1 / R3) Prueba negativa COMPLETA por CLOID antes de fallar; la cuarentena N6 la
        // refuerza en settleArm. unknownOid en orderStatus puede ser LAG: si la orden está en el
        // book (frontendOpenOrders) está VIVA → tratarla como armed, no fallar.
        const stillOpen = await openByCloid(info, user, order.cloid);
        if (stillOpen) {
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "open" });
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed" });
          return { result: "armed_lagged" };
        }
        const reFill = await fillsByCloid(info, user, order.cloid);
        if (reFill.size > 0) {
          // (CodeRabbit) Igual que los otros caminos de fill: exigir avgPx>0 para no persistir un
          // entryPrice inválido si userFills da el tamaño antes que el precio.
          if (!(reFill.avgPx > 0)) return { skipped: "fill_data_pending" };
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: reFill.size, entryPrice: reFill.avgPx });
          return { result: "filled_late" };
        }
        // Ausente del book + sin fills + orderStatus unknownOid → prueba negativa → failed (cuarentena).
        const r = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: "unknownOid (prueba negativa)" });
        return { result: r.ok ? "failed_negative_proof" : "unknown_quarantined" };
      }
      return { skipped: "no_change" };
    } finally {
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
    }
  },
});
