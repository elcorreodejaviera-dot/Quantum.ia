"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlNetwork, hlIsTestnet } from "./hlNetwork";
import { makeClients, getAssetMeta, roundHlPrice, aggressiveHlPriceStr, formatHlPrice, abortAfter, placeStopLoss, fillsByCloid } from "./hyperliquid";
import { spotDefenseCloidInput, toHlCloid } from "./cloids";
import { TransportError } from "@nktkas/hyperliquid";
import { elog } from "./log";

// --- JAV-107 Fase 3: motor live del bot de defensa SPOT (un solo trigger SELL que dispara al CAER) ---
// Espejo recortado de triggerEngine (single-entry, sin pool/rango/reentrada). El sizing/margen/cap son
// fuente de verdad de reserveSpotDefenseArm (Fase 2); aquí se LEE HL, se reserva, se pasa el CAS y se
// coloca UNA orden trigger. Reconcile (SL/BE/TP/drift/auto-rearm) + stop + cron = Fase 3c.

const HL_ORDER_TIMEOUT_MS = 30_000;
const ENTRY_TRIGGER_SLIPPAGE = 0.02;   // banda agresiva del market al dispararse el trigger (venta)
// Grace antes de declarar closed (clearinghouse puede dar szi==0 transitorio por lag tras un fill).
const CLOSE_CONFIRM_GRACE_MS = 2 * 60_000;
// Tolerancia relativa del detector de drift: si la posición REAL difiere del tamaño esperado del arm
// más que esto, hay intervención manual sobre el coin neto → manual_intervention (sin market close).
const DRIFT_TOL = 0.02;
// Un arm `arming` que nunca llegó al CAS (submittedAt==null) más viejo que esto = abandonado → failed.
const ARMING_RECOVER_GRACE_MS = 3 * 60_000;
// Grace de un SL `pending` ENVIADO (ambiguo de HL): hasta confirmarlo por CLOID, se da este margen
// antes de recolocarlo (evita doble-SL por un waitingForTrigger que aún no aparece en open orders).
const SL_SUBMIT_GRACE_MS = 60_000;

// ¿El CLOID sigue VIVO en el book de HL? (prueba positiva por CLOID, no por estado local).
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

// (Codex 3c-1 NO-GO #2) Prueba negativa por CLOID: lee las órdenes abiertas reales, cancela las propias
// que sigan vivas y devuelve true SOLO si ninguna estaba viva. No se terminaliza el arm hasta que esto
// confirme que el book quedó limpio (evita un trigger huérfano disparándose sobre un arm ya cerrado).
async function ensureSpotDefenseOrdersDead(
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

// --- Fase 3c-1: reconcile (confirma fill → coloca SL → close-confirm; + detector de drift) ----------
// Single-entry. BE/TPs y el cierre activo (stop) se añaden en 3c-2. Bajo claim/lease + fencing.
export const reconcileSpotDefenseArm = internalAction({
  args: { armId: v.id("spot_defense_arms") },
  handler: async (ctx, { armId }): Promise<any> => {
    const claim = await ctx.runMutation(internal.spotDefenseBots.claimSpotDefenseReconcile, { armId });
    if (!claim.claimed) return { skipped: claim.reason };
    const token = claim.token!;
    try {
      const data = await ctx.runQuery(internal.spotDefenseBots.getSpotDefenseArmInternal, { armId });
      if (!data) return { skipped: "not_found" };
      const { arm, orders } = data;
      const entry = orders.find((o: any) => o.role === "entry");
      if (!entry) return { skipped: "no_entry" };

      // Recuperación: arming que nunca CAS'd (submittedAt==null) y viejo → abandonado → failed.
      if (arm.status === "arming" && arm.submittedAt == null) {
        if (Date.now() - arm.createdAt > ARMING_RECOVER_GRACE_MS) {
          await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "failed", error: "[blocked_config] arming abandonado (sin envío)" });
          return { result: "arming_recovered" };
        }
        return { skipped: "arming_too_recent" };
      }

      // Cliente SIEMPRE desde arm.network (no del HL_NETWORK actual).
      const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: arm.hlAccountId });
      if (!credential) return { skipped: "no_credential" };
      const user = credential.tradingAccountAddress as `0x${string}`;
      const { info, exchange } = makeClients(decryptPrivateKey(credential), arm.network === "testnet");
      const assetMeta = await getAssetMeta(info, arm.asset.toUpperCase());
      const { assetId, szDecimals, markPx } = assetMeta;

      // Kill-switch / pausa / red / permiso / GATE MAINNET → desarmar.
      const [tradingConfig, simConfig] = await Promise.all([
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
      ]);
      const bot = await ctx.runQuery(internal.spotDefenseBots.getSpotDefenseBotInternal, { botId: arm.botId });
      const canLive = await ctx.runQuery(internal.users.hasTradeLiveForUserInternal, { userId: arm.userId });
      // (Codex 3c-1 NO-GO #5) Gate dedicado de mainnet: si está cerrado, NO colocar/cancelar en mainnet.
      const mainnetGate = await ctx.runQuery(internal.spotDefenseBots.getMainnetSpotDefenseApprovedInternal, {});
      const killed =
        tradingConfig?.value !== true || simConfig?.value === true ||
        !bot || !bot.active || bot.status !== "running" || bot.disarmPending === true ||
        hlNetwork() !== arm.network || (bot && bot.hlAccountId !== arm.hlAccountId) ||
        !canLive || credential.userId !== arm.userId ||
        (arm.network === "mainnet" && !mainnetGate.approved);
      const wantDisarm = killed || arm.desiredState === "disarmed";

      const ownCloids = orders.map((o: any) => o.cloid);

      // ===== FASE DE POSICIÓN (la entrada ya llenó): SL + cierre + drift =====
      if (arm.status === "filled" || arm.status === "protecting" || arm.status === "protected") {
        // Confirmar datos de fill si faltan.
        if (!(arm.filledSize && arm.filledSize > 0 && arm.entryPrice && arm.entryPrice > 0)) {
          const f = await fillsByCloid(info, user, entry.cloid);
          if (f.size > 0 && f.avgPx > 0) {
            await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "filled", filledSize: f.size, entryPrice: f.avgPx });
          }
          return { skipped: "filled_awaiting_fill_data" };
        }
        const ch: any = await info.clearinghouseState({ user });
        const p = (ch.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
        const szi = p ? Number(p.position?.szi ?? 0) : 0;
        const flat = Math.abs(szi) === 0;
        const realSize = Math.abs(szi) > 0 ? Math.abs(szi) : arm.filledSize;
        const posEntryPx = (p && Number(p.position?.entryPx) > 0) ? Number(p.position.entryPx) : arm.entryPrice;
        const slOrder = orders.find((o: any) => o.role === "sl");

        // (Codex r2 #2) Detector de DRIFT: la posición es NETA por coin; si el usuario abrió/cerró manual
        // el mismo activo, el tamaño real ≠ el esperado del arm → cancelar SOLO lo propio, marcar
        // manual_intervention y NUNCA market close ciego.
        const expected = arm.size;
        if (!flat && Math.abs(realSize - expected) > expected * DRIFT_TOL) {
          await cancelOwnByCloid(exchange, assetId, ownCloids);
          await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "manual_intervention", error: `[manual] drift: szi real ${realSize} vs esperado ${expected}` });
          elog("spot_defense", "drift", { armId: String(armId), realSize, expected });
          return { result: "manual_intervention" };
        }

        if (flat) {
          // (Codex 3c-1 NO-GO #4) Doble lectura: 1ª flat → fija closeConfirmSince; cierre real solo tras
          // grace desde filledAt Y desde la 1ª lectura flat. Si reaparece posición se limpia más abajo.
          if (arm.closeConfirmSince == null) {
            await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseCloseConfirm, { armId, token, value: Date.now() });
            return { skipped: "close_confirm_first_read" };
          }
          if (Date.now() - (arm.filledAt ?? arm.createdAt) <= CLOSE_CONFIRM_GRACE_MS
            || Date.now() - arm.closeConfirmSince <= CLOSE_CONFIRM_GRACE_MS) {
            return { skipped: "close_confirm_grace" };
          }
          const renew = await ctx.runMutation(internal.spotDefenseBots.renewSpotDefenseReconcile, { armId, token });
          if (!renew.ok) return { skipped: "lease_lost" };
          // ¿El SL llenó? (observed + fills). Determina closeReason (gobierna el auto-rearm en 3c-2).
          let slConfirmed = slOrder?.observedStatus === "filled";
          if (!slConfirmed && slOrder) {
            const sf = await fillsByCloid(info, user, slOrder.cloid);
            if (sf.size > 0) slConfirmed = true;
          }
          // (Codex 3c-1 NO-GO #2) NO terminalizar hasta confirmar por prueba negativa que NINGUNA orden
          // propia sigue viva en el book (un trigger residuo podría dispararse sobre un arm ya cerrado).
          const allDead = await ensureSpotDefenseOrdersDead(info, exchange, user, assetId, ownCloids);
          if (!allDead) return { skipped: "orders_still_live" };
          await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "closed", closeReason: slConfirmed ? "sl" : "manual" });
          return { result: "closed" };
        }
        // Posición viva: si había una lectura flat previa, era transitoria → limpiarla.
        if (arm.closeConfirmSince != null) {
          await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseCloseConfirm, { armId, token, value: null });
        }

        // Posición abierta y SIN pausa: asegurar el SL (Short → Buy por encima de la entrada).
        if (!wantDisarm) {
          // (Codex 3c-1 r3 #1) NO confiar solo en el estado local: confirmar el SL en HL por CLOID. Un SL
          // cancelado/rechazado a mano dejaría la DB en `open` y la posición sin protección real.
          let slAlive = false;
          if (slOrder) {
            const slFill = await fillsByCloid(info, user, slOrder.cloid);
            if (slFill.size > 0) {
              // El SL se ejecutó → marcar filled; la rama flat (próximo ciclo, ya con grace) cerrará.
              await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseOrderObserved, { armId, token, role: "sl", observedStatus: "filled" });
              return { result: "sl_filled" };
            }
            if (await openByCloid(info, user, slOrder.cloid)) {
              slAlive = true;   // vivo en HL → mantener protección
              if (slOrder.observedStatus !== "open") {
                await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseOrderObserved, { armId, token, role: "sl", observedStatus: "open" });
              }
            } else if (slOrder.observedStatus === "pending" && slOrder.submittedAt != null
              && Date.now() - slOrder.submittedAt <= SL_SUBMIT_GRACE_MS) {
              // pending ENVIADO dentro del grace: aún puede aparecer (waitingForTrigger) → esperar, no recolocar.
              return { result: "sl_pending_grace" };
            } else {
              // Ni vivo ni lleno (cancelado/rechazado a mano, o pending vencido) → marcar muerto y recolocar.
              await ctx.runMutation(internal.spotDefenseBots.setSpotDefenseOrderObserved, { armId, token, role: "sl", observedStatus: "canceled" });
            }
          }
          if (!slAlive) {
            // (Codex 3c-1 #3) Cloid determinista. Persistir el intento `pending` (PREPARADO, sin
            // submittedAt) ANTES del RPC + renovar lease → un SL aceptado por HL nunca queda sin tracking.
            const attempt = (arm.slAttempts ?? 0) + 1;
            const slCloid = await toHlCloid(spotDefenseCloidInput(String(armId), arm.generation, "sl", attempt));
            const slTriggerPx = posEntryPx * (1 + arm.stopLossPct / 100);
            const pre = await ctx.runMutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, {
              armId, token, cloid: slCloid, triggerPx: slTriggerPx, size: realSize, observedStatus: "pending", attempt,
            });
            const renewSl = await ctx.runMutation(internal.spotDefenseBots.renewSpotDefenseReconcile, { armId, token });
            if (!pre.ok || !renewSl.ok) return { skipped: "sl_prepare_failed" };
            let r: { state: "resting" | "filled"; oid: string } | { state: "pending" };
            try {
              r = await placeStopLoss(exchange, assetId, szDecimals, "Short", realSize, posEntryPx, arm.stopLossPct, slCloid);
            } catch (e) {
              // Error DETERMINISTA (placeStopLoss lanza; TransportError ya lo traduce a pending): marcar
              // `rejected` → el próximo ciclo NO lo trata como vivo y reintenta. NO fingir protección.
              await ctx.runMutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, {
                armId, token, cloid: slCloid, triggerPx: slTriggerPx, size: realSize, observedStatus: "rejected",
              });
              await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "protecting", error: String((e as Error)?.message ?? e) });
              return { skipped: "sl_rejected" };
            }
            const obs = r.state === "resting" ? "open" : r.state === "filled" ? "filled" : "pending";
            // markSubmitted: el RPC SE ENVIÓ (resting/filled, o pending=ambiguo de HL) → ahora sí cuenta.
            const rec = await ctx.runMutation(internal.spotDefenseBots.recordSpotDefenseSlOrder, {
              armId, token, cloid: slCloid, oid: r.state === "pending" ? undefined : r.oid,
              triggerPx: slTriggerPx, size: realSize, observedStatus: obs, markSubmitted: true,
            });
            // Solo declarar protected si el SL quedó resting/filled Y se persistió; si no, protecting.
            await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: rec.ok && r.state !== "pending" ? "protected" : "protecting" });
          }
          // BE/TP → Fase 3c-2.
          void markPx;
        }
        return { result: "position_reconciled" };
      }

      // ===== FASE PRE-FILL (armed/submitting/unknown): confirmar FILL antes de desarmar =====
      // (Codex 3c-1 r2 #1) Una entrada pudo llenarse incluso bajo wantDisarm. Si hay fill, pasar a
      // `filled` (fase de posición) — NUNCA desarmar dejando un SHORT real sin arm/SL/seguimiento.
      const f = await fillsByCloid(info, user, entry.cloid);
      if (f.size > 0 && f.avgPx > 0) {
        await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "filled", filledSize: f.size, entryPrice: f.avgPx });
        return { result: "filled" };
      }
      if (wantDisarm) {
        // Prueba negativa de muerte de órdenes propias antes de declarar disarmed.
        const allDead = await ensureSpotDefenseOrdersDead(info, exchange, user, assetId, ownCloids);
        if (!allDead) return { skipped: "orders_still_live" };
        // Re-confirmar que la cancelación no dejó pasar un fill de último momento.
        const f2 = await fillsByCloid(info, user, entry.cloid);
        if (f2.size > 0 && f2.avgPx > 0) {
          await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "filled", filledSize: f2.size, entryPrice: f2.avgPx });
          return { result: "filled" };
        }
        const r = await ctx.runMutation(internal.spotDefenseBots.settleSpotDefenseArm, { armId, token, status: "disarmed", closeReason: "disarm" });
        return r.ok ? { result: "disarmed" } : { skipped: "disarm_not_applied" };
      }
      return { result: "armed_waiting" };
    } finally {
      await ctx.runMutation(internal.spotDefenseBots.releaseSpotDefenseReconcile, { armId, token });
    }
  },
});
