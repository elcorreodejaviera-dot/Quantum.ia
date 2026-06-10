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

    // (H4) Precondición flat: posición neta cero del activo.
    const chState = await info.clearinghouseState({ user: tradingAccount });
    const pos = (chState.assetPositions ?? []).find((p: any) => p.position?.coin === asset);
    if (pos && Math.abs(Number(pos.position?.szi ?? 0)) > 0) {
      throw new Error("Ya existe posición abierta en el activo: armado bloqueado (precondición flat).");
    }

    // (R6) Trigger normalizado al tick (floor) y gate mark > triggerPxNormalized SOBRE el valor enviado.
    const triggerPxNorm = roundHlPrice(pool.minRange, szDecimals, "floor");
    if (!(markPx > triggerPxNorm)) {
      throw new Error(`mark (${markPx}) ≤ triggerPx normalizado (${triggerPxNorm}): no se arma (precio ya en/bajo el rango).`);
    }

    // (H12) Sizing desde hedgeNotionalUsd (backend), cota superior conservadora del precio de fill.
    const notionalCapPx = ceilHlPrice(triggerPxNorm, szDecimals);
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
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed", oid: String(st.resting.oid) });
    } else if (st?.filled?.oid != null) {
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", oid: String(st.filled.oid) });
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
        await ctx.runMutation(internal.triggerArms.recoverAbandonedArming, { armId });
        return { result: "arming_recovered" };
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
        const ch: any = await info.clearinghouseState({ user });
        const p = (ch.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
        const flat = !p || Math.abs(Number(p.position?.szi ?? 0)) === 0;
        if (flat) {
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "closed" });
          return { result: "closed" };
        }
        return { skipped: "filled_position_open" };
      }

      // Kill switch / pausa: si hay condición de apagado y aún no se está desarmando, convertir a disarm.
      const [tradingConfig, simConfig] = await Promise.all([
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
      ]);
      const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: arm.poolId });
      const killed = tradingConfig?.value !== true || simConfig?.value === true || pool?.closed === true || arm.network !== "testnet";
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
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "filled", oid: order.oid });
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: fill.size, entryPrice: fill.avgPx });
          return { result: "disarm_but_filled" };
        }
        if (orderState === "triggered") return { skipped: "disarm_triggered_pending" };
        // Intentar cancelar (idempotente). Luego confirmar por CLOID (prueba negativa R3).
        try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: order.cloid as `0x${string}` }] }); } catch { /* reintentar siguiente ciclo */ }
        const after: any = await info.orderStatus({ user, oid: order.cloid as `0x${string}` });
        const afterState = after?.status === "order" ? after.order?.status : undefined;
        const afterUnknown = after?.status === "unknownOid";
        const afterFill = await fillsByCloid(info, user, order.cloid);
        if (afterState === "filled" || afterFill.size > 0) {
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: afterFill.size, entryPrice: afterFill.avgPx });
          return { result: "disarm_but_filled" };
        }
        const canceledConfirmed = afterState === "canceled" || (afterUnknown && afterFill.size === 0);
        if (canceledConfirmed) {
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "canceled" });
          // settleArm aplica la cuarentena N6: no terminaliza si aún está dentro del plazo.
          const r = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "disarmed" });
          return { result: r.ok ? "disarmed" : "disarm_quarantined" };
        }
        return { skipped: "disarm_pending_confirmation" };
      }

      // ---- Camino ARMADO (converger a armed) ----
      if (orderState === "filled" || fill.size > 0) {
        await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "filled", oid: order.oid });
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: fill.size, entryPrice: fill.avgPx });
        // filled→closed solo tras szi==0 (cierre manual en Etapa 1) — lo evalúa el siguiente ciclo.
        return { result: "filled" };
      }
      if (orderState === "open") {
        await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, observedStatus: "open", oid: order.oid });
        await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed", oid: order.oid });
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
        // (R3) Prueba negativa por CLOID antes de fallar; la cuarentena N6 la refuerza en settleArm.
        const cancelTried = await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: order.cloid as `0x${string}` }] }).then(() => true).catch(() => true);
        const recheck: any = await info.orderStatus({ user, oid: order.cloid as `0x${string}` });
        const stillUnknown = recheck?.status === "unknownOid";
        const reFill = await fillsByCloid(info, user, order.cloid);
        if (reFill.size > 0) {
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: reFill.size, entryPrice: reFill.avgPx });
          return { result: "filled_late" };
        }
        if (cancelTried && stillUnknown) {
          const r = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: "unknownOid (prueba negativa)" });
          return { result: r.ok ? "failed_negative_proof" : "unknown_quarantined" };
        }
        return { skipped: "unknown_pending" };
      }
      return { skipped: "no_change" };
    } finally {
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
    }
  },
});
