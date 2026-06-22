"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlNetwork, hlIsTestnet } from "./hlNetwork";
import { makeClients, getAssetMeta, roundHlPrice, aggressiveHlPriceStr, formatHlPrice, abortAfter } from "./hyperliquid";
import { TransportError } from "@nktkas/hyperliquid";
import { elog } from "./log";

// --- JAV-107 Fase 3: motor live del bot de defensa SPOT (un solo trigger SELL que dispara al CAER) ---
// Espejo recortado de triggerEngine (single-entry, sin pool/rango/reentrada). El sizing/margen/cap son
// fuente de verdad de reserveSpotDefenseArm (Fase 2); aquí se LEE HL, se reserva, se pasa el CAS y se
// coloca UNA orden trigger. Reconcile (SL/BE/TP/drift/auto-rearm) + stop + cron = Fase 3c.

const HL_ORDER_TIMEOUT_MS = 30_000;
const ENTRY_TRIGGER_SLIPPAGE = 0.02;   // banda agresiva del market al dispararse el trigger (venta)

// Arma el bot: lee HL (flat + sin órdenes del coin), reserva (margen/cap/sizing capado), CAS, y coloca
// UNA orden trigger SELL (tpsl:"sl" → dispara al bajar). Los throws con prefijo [kind] los mapea el
// auto-rearm (Fase 3c). Lo invocan el arranque del bot y el cron de rearm (sin auth de usuario).
export const armSpotDefenseInternal = internalAction({
  args: { botId: v.id("spot_defense_bots"), rearmToken: v.optional(v.string()) },
  handler: async (ctx, { botId }): Promise<any> => {
    const bot = await ctx.runQuery(internal.spotDefenseBots.getSpotDefenseBotInternal, { botId });
    if (!bot) throw new Error("[cancel] Bot de defensa no encontrado");
    if (!bot.active || bot.status !== "running" || bot.disarmPending) throw new Error("[cancel] Bot no activo/running");
    if (bot.network !== hlNetwork()) throw new Error("[cancel] Red del bot distinta a la del backend");

    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: bot.hlAccountId });
    if (!credential) throw new Error("[blocked_config] Cuenta HL no encontrada");
    if (credential.userId !== bot.userId) throw new Error("[blocked_config] La cuenta no pertenece al dueño del bot");

    const asset = bot.asset.toUpperCase();
    const { info, exchange } = makeClients(decryptPrivateKey(credential), hlIsTestnet());
    const { assetId, szDecimals, markPx, maxLeverage } = await getAssetMeta(info, asset);
    const tradingAccount = credential.tradingAccountAddress as `0x${string}`;

    // Cuenta en modo unified (el colateral spot solo es válido ahí), igual que el motor de pool.
    const abstraction = await info.userAbstraction({ user: tradingAccount });
    if (abstraction !== "unifiedAccount") {
      throw new Error("[blocked_config] La cuenta HL no está en modo unified; armado bloqueado.");
    }
    // (Codex r1 #2) Precondición FLAT: posición neta cero del activo (la posición perp es neta por coin).
    const chState = await info.clearinghouseState({ user: tradingAccount });
    const pos = (chState.assetPositions ?? []).find((p: any) => p.position?.coin === asset);
    if (pos && Math.abs(Number(pos.position?.szi ?? 0)) > 0) {
      throw new Error("[retry_incompatible] Ya hay posición abierta en el activo: armado bloqueado (flat).");
    }
    // (Codex r1 #2) Sin órdenes abiertas del coin (un trigger/orden previo dejaría estado ambiguo).
    const openOrders: any[] = await info.frontendOpenOrders({ user: tradingAccount });
    if (openOrders.some((o) => o?.coin === asset)) {
      throw new Error("[retry_incompatible] Hay órdenes abiertas en el activo: armado bloqueado.");
    }

    // (Codex r1 #3) Trigger normalizado al tick (floor). Gate mark > triggerPx → un SELL trigger de bajada
    // NO puede nacer disparado (cubre el DCA por encima del precio). [transient]: el precio ya está ≤ trigger.
    const triggerPxNorm = roundHlPrice(bot.triggerPrice, szDecimals, "floor");
    if (!(markPx > triggerPxNorm)) {
      throw new Error(`[transient] mark (${markPx}) ≤ trigger (${triggerPxNorm}): no se arma (el trigger nacería disparado).`);
    }

    // Colateral USDC spot libre (reserveSpotDefenseArm descuenta el comprometido de todos los motores).
    const spotState = await info.spotClearinghouseState({ user: tradingAccount });
    const availableCollateral = (spotState.balances ?? [])
      .filter((b: any) => b.coin === "USDC")
      .reduce((s: number, b: any) => s + Math.max(0, parseFloat(b.total ?? "0") - parseFloat(b.hold ?? "0")), 0);

    // Reserva OCC (gates live + margen real + cap namespaced + sizing capado) → crea arm(arming)+entry(pending).
    const reservation = await ctx.runMutation(internal.spotDefenseBots.reserveSpotDefenseArm, {
      botId: bot._id, triggerPx: triggerPxNorm, availableCollateral, assetMaxLeverage: maxLeverage, szDecimals,
    });
    const { armId, cloid, appliedLeverage, size } = reservation;

    // CAS pre-envío: arming→submitting (revalida live + cap). Si falla → abortar SIN enviar.
    const sub = await ctx.runMutation(internal.spotDefenseBots.markArmSubmitting, { armId });
    if (!sub.ok) return { ok: false, status: "aborted", armId, reason: sub.reason };
    const token = sub.token;

    // updateLeverage (isolated) ANTES de la orden: si lanza, no hay entrada enviada → no hay posición.
    try {
      await exchange.updateLeverage({ asset: assetId, isCross: false, leverage: appliedLeverage });
    } catch (e) {
      if (e instanceof TransportError) {
        // INCIERTO: liberar el lease y dejar reconciliable (Fase 3c lo limpia por prueba negativa).
        await ctx.runMutation(internal.spotDefenseBots.releaseSpotDefenseReconcile, { armId, token });
        return { ok: false, status: "gated", armId, reason: "updateLeverage_transport" };
      }
      // DETERMINISTA: cerrar YA (prueba de no-envío) → libera margen sin esperar cuarentena.
      const msg = String((e as Error)?.message ?? e);
      const failed = await ctx.runMutation(internal.spotDefenseBots.failSpotDefensePreOrder, { armId, token, error: `[blocked_config] updateLeverage: ${msg}` });
      if (!failed.ok) await ctx.runMutation(internal.spotDefenseBots.releaseSpotDefenseReconcile, { armId, token });
      throw new Error(`[blocked_config] updateLeverage rechazado: ${msg}`);
    }

    // Gate atómico justo antes del envío (kill-switch/pausa/revocación en la ventana de updateLeverage).
    const gate = await ctx.runMutation(internal.spotDefenseBots.gateArmBeforeOrder, { armId, token });
    if (!gate.ok) {
      await ctx.runMutation(internal.spotDefenseBots.releaseSpotDefenseReconcile, { armId, token });
      return { ok: false, status: "gated", armId };
    }

    // Colocar UNA orden trigger SELL (b:false), reduceOnly:false, isMarket al dispararse, tpsl:"sl"
    // (dispara al BAJAR el precio hasta triggerPx). Banda agresiva floor para que el market llene.
    const limitPx = aggressiveHlPriceStr(triggerPxNorm * (1 - ENTRY_TRIGGER_SLIPPAGE), szDecimals, false);
    let anyFilled = false, anyPlaced = false, filledSize = 0, entryPrice = 0, hardError: string | undefined, transportUncertain = false;
    const ac = abortAfter(HL_ORDER_TIMEOUT_MS);
    try {
      const resp: any = await exchange.order({
        orders: [{ a: assetId, b: false, p: limitPx, s: String(size), r: false,
          t: { trigger: { isMarket: true, triggerPx: formatHlPrice(triggerPxNorm, szDecimals), tpsl: "sl" } },
          c: cloid as `0x${string}` }],
        grouping: "na",
      }, { signal: ac.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
      const st = resp?.response?.data?.statuses?.[0];
      if (st?.resting?.oid != null) {
        await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseOrderObserved, { armId, token, role: "entry", observedStatus: "open", oid: String(st.resting.oid) });
        anyPlaced = true;
      } else if (st?.filled?.oid != null) {
        await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseOrderObserved, { armId, token, role: "entry", observedStatus: "filled", oid: String(st.filled.oid) });
        const fS = Number(st.filled.totalSz), fP = Number(st.filled.avgPx);
        if (fS > 0 && fP > 0) { anyFilled = true; filledSize = fS; entryPrice = fP; }
      } else if (st === "waitingForTrigger") {
        anyPlaced = true;   // observed sigue pending; el reconcile lo confirma por CLOID
      } else if (st?.error) {
        await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseOrderObserved, { armId, token, role: "entry", observedStatus: "rejected" });
        hardError = String(st.error);
      } else { anyPlaced = true; }   // ambiguo → reconcile
    } catch (e) {
      if (e instanceof TransportError) transportUncertain = true;
      else hardError = String((e as Error)?.message ?? e);
    } finally { ac.clear(); }

    elog("spot_defense", "entry_sent", { armId: String(armId), anyFilled, anyPlaced, transportUncertain, hadError: !!hardError });

    if (anyFilled) {
      await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "filled", filledSize, entryPrice });
    } else if (anyPlaced || transportUncertain) {
      await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: transportUncertain && !anyPlaced ? "unknown" : "armed", error: hardError });
    } else if (hardError) {
      await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "failed", error: hardError });
      await ctx.runMutation(internal.spotDefenseBots.releaseSpotDefenseReconcile, { armId, token });
      return { ok: false, status: "rejected", armId };
    } else {
      await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "unknown", error: "respuesta ambigua" });
    }

    // Defensa post-envío: si nos pausaron mientras enviábamos, cancelar la entrada recién colocada.
    const fresh = await ctx.runQuery(internal.spotDefenseBots.getSpotDefenseArmInternal, { armId });
    if (fresh && fresh.arm.desiredState === "disarmed") {
      try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: cloid as `0x${string}` }] }); } catch { /* el reconcile (3c) lo limpia */ }
    }
    await ctx.runMutation(internal.spotDefenseBots.releaseSpotDefenseReconcile, { armId, token });
    return { ok: true, status: anyFilled ? "filled" : "armed", armId };
  },
});
