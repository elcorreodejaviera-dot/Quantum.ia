"use node";

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { decryptPrivateKey } from "./hlCredentialActions";
import { hlNetwork, hlIsTestnet, assertExpectedNetwork } from "./hlNetwork";
import {
  makeClients, getAssetMeta, ceilHlPrice, roundHlPrice, aggressiveHlPriceStr,
  floorToDecimals, formatHlPrice, fillsByCloid, abortAfter, placeStopLoss,
} from "./hyperliquid";
import { armCloid } from "./triggerArms";
import { TransportError } from "@nktkas/hyperliquid";

// --- JAV-44 Etapa 1: actions del motor (trigger nativo de entrada inferior, TESTNET) ---

const HL_ORDER_TIMEOUT_MS = 30_000;
// Banda agresiva del market al dispararse el trigger de entrada (venta). Gap > banda → puede no llenar.
const ENTRY_TRIGGER_SLIPPAGE = 0.02;
// Grace antes de declarar filled→closed (Fix #2): tras el fill, clearinghouseState puede dar szi==0
// transitoriamente por lag aunque la posición exista. Esperar este margen desde filledAt evita un
// closed prematuro que liberaría margen/credencial con la posición aún abierta.
const CLOSE_CONFIRM_GRACE_MS = 2 * 60_000;
// Política de fallo del SL (Codex #3): si el short queda sin SL `protected`, reintentar hasta estos
// límites; superados → CIERRE DE EMERGENCIA (reduceOnly market) para no dejar la posición desnuda.
const SL_MAX_ATTEMPTS = 3;
const SL_PROTECT_DEADLINE_MS = 4 * 60_000;
// Grace tras enviar el SL: antes de rotar el cloid (nuevo intento), confirmar por CLOID que el
// anterior NO está vivo (igual que JAV-43). Evita doble SL / SL huérfano.
const SL_SUBMIT_GRACE_MS = 60_000;

// ¿Hay una orden VIVA con este cloid en el book? (parte de la prueba negativa R3 — no liberar a ciegas).
async function openByCloid(info: any, user: `0x${string}`, cloid: string): Promise<boolean> {
  const oo: any[] = await info.frontendOpenOrders({ user });
  return oo.some((o) => typeof o?.cloid === "string" && o.cloid.toLowerCase() === cloid.toLowerCase());
}

// (Codex #2) Cancela cualquier trigger_order del arm que SIGA VIVO en el book y devuelve si TODOS
// están muertos (prueba negativa por CLOID). Se llama una vez en frontendOpenOrders y cancela los
// que sigan abiertos. Garantiza que un arm no alcance `closed` con una orden viva (anti-huérfano).
async function ensureOrdersDead(
  info: any, exchange: any, user: `0x${string}`, assetId: number, cloids: string[],
): Promise<boolean> {
  const oo: any[] = await info.frontendOpenOrders({ user });
  const liveSet = new Set(oo.map((o) => (typeof o?.cloid === "string" ? o.cloid.toLowerCase() : "")));
  let allDead = true;
  for (const c of cloids) {
    if (liveSet.has(c.toLowerCase())) {
      allDead = false;
      try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: c as `0x${string}` }] }); } catch { /* reintenta */ }
    }
  }
  return allDead;
}

// Coloca/observa órdenes trigger por CLOID. Política de COLOCACIÓN: todos los gates + hard-gate testnet.
export const armPoolBotEntry = action({
  args: { botId: v.id("bots"), expectedNetwork: v.string(), confirm: v.boolean() },
  handler: async (ctx, args) => {
    // Red: el backend es la fuente de verdad. Mainnet habilitado ahora que hay SL post-fill que
    // protege la posición (cierre de emergencia garantiza que nunca quede un short desnudo).
    assertExpectedNetwork(args.expectedNetwork);
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
    if (bot.stopLossPct === undefined || !Number.isFinite(bot.stopLossPct) || bot.stopLossPct <= 0 || bot.stopLossPct >= 100) {
      throw new Error("Bot sin stopLossPct válido (0–100) — necesario para el SL post-fill");
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
    // TPs sobre el búfer: la posición se abre con pool + búfer. Total = hedge*(1+bufferPct/100).
    // El SL es full-size (protege todo); los TPs cierran SOLO la fracción del búfer (validado abajo).
    const bufferPct = (bot.bufferPct !== undefined && Number.isFinite(bot.bufferPct) && bot.bufferPct > 0) ? bot.bufferPct : 0;
    const tps = bufferPct > 0 ? (bot.tps ?? []) : [];
    if (tps.length > 0) {
      for (const t of tps) {
        if (!(t.gainPct > 0) || !(t.closePct > 0)) throw new Error("TP inválido (gainPct/closePct > 0)");
      }
      const sumClose = tps.reduce((s, t) => s + t.closePct, 0);
      if (sumClose > 100) throw new Error("Σ closePct de los TPs no puede superar 100 (% del búfer).");
    }
    const totalNotional = bot.hedgeNotionalUsd * (1 + bufferPct / 100);
    const notionalCapPx = ceilHlPrice(triggerPxNorm * (1 + ENTRY_TRIGGER_SLIPPAGE), szDecimals);
    const size = floorToDecimals(totalNotional / notionalCapPx, szDecimals);
    if (size <= 0) throw new Error("Size redondea a cero");
    const orderNotional = size * notionalCapPx;          // nocional de UNA entrada (límite por orden)
    const orderMargin = orderNotional / appliedLeverage;

    // 2ª entrada (borde superior) si el bot lo permite Y el precio está por DEBAJO del borde superior
    // (el trigger debe dispararse al SUBIR). entry_upper = SELL trigger ABOVE maxRange, tpsl:"tp".
    const upperEdgeNorm = roundHlPrice(pool.maxRange, szDecimals, "ceil");
    const twoEntries = bot.allowReentryFromAbove === true && Number.isFinite(pool.maxRange)
      && pool.maxRange > 0 && markPx < upperEdgeNorm;
    // (Codex #1) Con DOS entradas, reservar el PEOR CASO 2× (doble-fill); se reduce a 1× tras el OCO.
    const factor = twoEntries ? 2 : 1;
    const reservedNotional = orderNotional * factor;
    const marginRequired = orderMargin * factor;

    // Colateral USDC spot libre (sin doble conteo; reserveArm descuenta el comprometido de ambos motores).
    const spotState = await info.spotClearinghouseState({ user: tradingAccount });
    const availableCollateral = (spotState.balances ?? [])
      .filter((b: any) => b.coin === "USDC")
      .reduce((s: number, b: any) => s + Math.max(0, parseFloat(b.total ?? "0") - parseFloat(b.hold ?? "0")), 0);

    // Reserva OCC (generación, unicidad, margen/daily compartidos) — crea arm(arming)+order(pending).
    const reservation = await ctx.runMutation(internal.triggerArms.reserveArm, {
      botId: bot._id, userId: user._id, hlAccountId: bot.hlAccountId, poolId: bot.poolId,
      asset, network: hlNetwork(), triggerPx: triggerPxNorm, size, appliedLeverage,
      orderNotional, reservedNotional, marginReserved: marginRequired, lowerEdge: pool.minRange,
      upperEdge: twoEntries ? upperEdgeNorm : undefined,
      allowReentryFromAbove: twoEntries ? true : undefined,
      stopLossPct: bot.stopLossPct, bufferPct, tps, availableCollateral,
    });
    const { armId, cloid, cloidUpper } = reservation;

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

    // Colocar las entradas (SELL, reduceOnly:false). entry_lower: trigger BELOW minRange, tpsl:"sl".
    // entry_upper (si twoEntries): trigger ABOVE maxRange, tpsl:"tp". Banda agresiva floor (venta).
    const entries: { role: "entry_lower" | "entry_upper"; cloid: string; triggerPx: number; tpsl: "sl" | "tp" }[] = [
      { role: "entry_lower", cloid, triggerPx: triggerPxNorm, tpsl: "sl" },
    ];
    if (cloidUpper) entries.push({ role: "entry_upper", cloid: cloidUpper, triggerPx: upperEdgeNorm, tpsl: "tp" });

    let anyFilled = false, anyPlaced = false, filledSize = 0, entryPrice = 0;
    let hardError: string | undefined, transportUncertain = false;
    for (const en of entries) {
      const enLimitPx = aggressiveHlPriceStr(en.triggerPx * (1 - ENTRY_TRIGGER_SLIPPAGE), szDecimals, false);
      const acE = abortAfter(HL_ORDER_TIMEOUT_MS);
      try {
        const respE: any = await exchange.order({
          orders: [{ a: assetId, b: false, p: enLimitPx, s: String(size), r: false,
            t: { trigger: { isMarket: true, triggerPx: formatHlPrice(en.triggerPx, szDecimals), tpsl: en.tpsl } },
            c: en.cloid as `0x${string}` }],
          grouping: "na",
        }, { signal: acE.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
        const stE = respE?.response?.data?.statuses?.[0];
        if (stE?.resting?.oid != null) {
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: en.role, observedStatus: "open", oid: String(stE.resting.oid) });
          anyPlaced = true;
        } else if (stE?.filled?.oid != null) {
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: en.role, observedStatus: "filled", oid: String(stE.filled.oid) });
          const fS = Number(stE.filled.totalSz), fP = Number(stE.filled.avgPx);
          if (fS > 0 && fP > 0) { anyFilled = true; filledSize = fS; entryPrice = fP; }
        } else if (stE === "waitingForTrigger") {
          anyPlaced = true;   // observed sigue pending; reconcile lo confirma por CLOID
        } else if (stE?.error) {
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: en.role, observedStatus: "rejected" });
          hardError = String(stE.error);
        } else { anyPlaced = true; }   // ambiguo → reconcile
      } catch (e) {
        if (e instanceof TransportError) { transportUncertain = true; }   // incierto, pudo enviarse
        else { hardError = String((e as Error)?.message ?? e); }   // definitivo (firma/validación)
      } finally { acE.clear(); }
    }

    // Resolver el estado del arm. Prioridad: fill > colocado/incierto > error.
    if (anyFilled) {
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize, entryPrice });
    } else if (anyPlaced || transportUncertain) {
      // Al menos una entrada colocada (o envío incierto) → armed/unknown reconciliable; el reconcile
      // confirma por CLOID y, si una entrada falló definitivamente, la reintenta o reduce a 1×.
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: transportUncertain && !anyPlaced ? "unknown" : "armed", error: hardError });
    } else if (hardError) {
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: hardError });
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
      return { ok: false, status: "rejected", armId };
    } else {
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "unknown", error: "respuesta ambigua" });
    }

    // (N5 defensa) Tras enviar, si nos pausaron, cancelar AMBAS entradas que acabamos de poner.
    const fresh = await ctx.runQuery(internal.triggerArms.getArmInternal, { armId });
    if (fresh && fresh.desiredState === "disarmed") {
      for (const en of entries) {
        try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: en.cloid as `0x${string}` }] }); } catch { /* el cron reconcilia */ }
      }
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

      // Kill switch / pausa (Fix #4 + N4 mainnet): cualquier condición de apagado convierte el arm a
      // desarmado. La red AUTORITATIVA es la del arm (arm.network), no el HL_NETWORK actual: si el
      // deploy cambió de red bajo un arm, hay que desarmar.
      const [tradingConfig, simConfig] = await Promise.all([
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
        ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
      ]);
      const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: arm.poolId });
      const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: arm.botId });
      const canLive = await ctx.runQuery(internal.users.hasTradeLiveForUserInternal, { userId: arm.userId });
      const killed =
        tradingConfig?.value !== true || simConfig?.value === true ||
        pool?.closed === true || hlNetwork() !== arm.network ||
        !bot || !bot.active || bot.simulationMode === true ||
        bot.hlAccountId !== arm.hlAccountId || bot.poolId !== arm.poolId || !canLive;
      if (killed && arm.desiredState !== "disarmed") {
        await ctx.runMutation(internal.triggerArms.requestDisarmAndDeactivate, { botId: arm.botId });
      }
      const wantDisarm = killed || arm.desiredState === "disarmed";

      // ===== FASE DE POSICIÓN (la entrada ya se llenó): gestionar SL post-fill + cierre =====
      if (arm.status === "filled" || arm.status === "protecting" || arm.status === "protected") {
        // (Fix #2a) Exigir filledSize positivo confirmado antes de tocar SL/cierre.
        if (!(arm.filledSize && arm.filledSize > 0 && arm.entryPrice && arm.entryPrice > 0)) {
          const f = await fillsByCloid(info, user, order.cloid);
          if (f.size > 0 && f.avgPx > 0) {
            await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: f.size, entryPrice: f.avgPx });
          }
          return { skipped: "filled_awaiting_fill_data" };
        }
        const filledSize = arm.filledSize, entryPrice = arm.entryPrice;
        const slOrder = await ctx.runQuery(internal.triggerArms.getArmOrderByRole, { armId, role: "sl_upper" });
        const allOrders = await ctx.runQuery(internal.triggerArms.getArmOrdersInternal, { armId });
        const allCloids = allOrders.map((o) => o.cloid);

        // (1) Detección de CIERRE (posición flat) — grace + doble lectura (Fix #2). Además (Codex #2)
        // NO declarar `closed` mientras quede una orden VIVA en el book (cancelarla primero): un
        // trigger resido podría dispararse sobre un arm ya cerrado (huérfano).
        const ch: any = await info.clearinghouseState({ user });
        const p = (ch.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
        const szi = p ? Number(p.position?.szi ?? 0) : 0;
        const flat = Math.abs(szi) === 0;
        // (OCO doble-fill) El SL/TPs usan el tamaño REAL de la posición (szi) y su entryPx medio, no
        // arm.filledSize: si ambas entradas llenaron (2x), el SL full-size cubre el tamaño real.
        const realSize = Math.abs(szi) > 0 ? Math.abs(szi) : filledSize;
        const posEntryPx = (p && Number(p.position?.entryPx) > 0) ? Number(p.position.entryPx) : entryPrice;

        // (Codex #1) Reducir reserva 2×→1× SOLO ahora que la posición está abierta: confirmar por CLOID
        // que las entradas hermanas MURIERON (ensureOrdersDead) y que la posición es de 1× (no doble-
        // fill: szi ≈ una sola entrada). Nunca liberar margen con una hermana aún viva.
        if (arm.allowReentryFromAbove && !arm.reservationReduced) {
          const entryCloidsP = allOrders.filter((o) => o.role === "entry_lower" || o.role === "entry_upper").map((o) => o.cloid);
          if (Math.abs(szi) > 0 && Math.abs(szi) <= arm.size * 1.5 && (await ensureOrdersDead(info, exchange, user, assetId, entryCloidsP))) {
            await ctx.runMutation(internal.triggerArms.reduceArmReservation, { armId, token, reservedNotional: arm.reservedNotional / 2, marginReserved: arm.marginReserved / 2 });
          }
        }
        if (flat) {
          if (Date.now() - (arm.filledAt ?? arm.createdAt) <= CLOSE_CONFIRM_GRACE_MS) return { skipped: "close_confirm_grace" };
          const renewC = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
          if (!renewC.ok) return { skipped: "lease_lost" };
          if (!(await ensureOrdersDead(info, exchange, user, assetId, allCloids))) {
            return { skipped: "closing_cancel_live_orders" };   // había una orden viva → cancelada; reintentar
          }
          if (arm.closeConfirmSince == null) {
            await ctx.runMutation(internal.triggerArms.setArmCloseConfirm, { armId, token, value: Date.now() });
            return { skipped: "close_first_flat" };
          }
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "closed" });
          return { result: "closed" };
        }
        if (arm.closeConfirmSince != null) await ctx.runMutation(internal.triggerArms.setArmCloseConfirm, { armId, token, value: null });

        // (2) ¿Hay que CERRAR DE EMERGENCIA? (Codex #3) disarm/kill con posición abierta, o el SL no
        // logró protegerla a tiempo (deadline o demasiados intentos sin `protected`).
        const deadlinePassed = arm.protectDeadline != null && Date.now() > arm.protectDeadline;
        const tooManyAttempts = (arm.slAttempts ?? 0) >= SL_MAX_ATTEMPTS;
        const mustEmergencyClose = wantDisarm || ((deadlinePassed || tooManyAttempts) && arm.status !== "protected");
        if (mustEmergencyClose) {
          const renew = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
          if (!renew.ok) return { skipped: "lease_lost" };
          // (Codex #2) Cancelar TODO trigger_order vivo y CONFIRMAR por CLOID que murieron antes de
          // dar por cerrado (el `closed` se gatea en (1) con ensureOrdersDead). Aquí cancelamos.
          await ensureOrdersDead(info, exchange, user, assetId, allCloids);
          // Cierre reduceOnly MARKET (IOC agresivo, comprar para cerrar el short). cloid determinista
          // por generación → idempotente; reduceOnly impide sobre-cerrar aunque se repita.
          const closeCloid = await armCloid(arm.botId, arm.generation, "close");
          const closeLimitPx = aggressiveHlPriceStr(assetMeta.markPx * (1 + 0.02), szDecimals, true);
          const ac2 = abortAfter(HL_ORDER_TIMEOUT_MS);
          try {
            await exchange.order({
              orders: [{ a: assetId, b: true, p: closeLimitPx, s: String(floorToDecimals(Math.abs(szi), szDecimals)), r: true, t: { limit: { tif: "Ioc" } }, c: closeCloid as `0x${string}` }],
              grouping: "na",
            }, { signal: ac2.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
          } catch { /* el siguiente ciclo reintenta; szi==0 + órdenes muertas → closed */ } finally { ac2.clear(); }
          return { result: "emergency_close_sent" };
        }

        // (2.5) TPs sobre el BÚFER (solo cuando ya hay SL → status protected). Cada TP es Take Profit
        // Market reduceOnly (BUY, tpsl:"tp", trigger ABAJO del entry = el short gana al caer). Σ tamaños
        // ≤ búfer → el pool nunca lo cierran los TPs (sigue bajo el SL full-size). Coloca/confirma con
        // el patrón del SL (confirmar-antes-de-rotar por TP). Una colocación por ciclo (acota el lease).
        if (arm.status === "protected") {
          const tps = arm.tps ?? [];
          const bufferPct = arm.bufferPct ?? 0;
          if (tps.length === 0 || bufferPct <= 0) return { skipped: "no_tps" };
          const bufferSize = floorToDecimals((realSize * bufferPct) / (100 + bufferPct), szDecimals);
          for (let i = 0; i < tps.length; i++) {
            const tpSize = floorToDecimals((bufferSize * tps[i].closePct) / 100, szDecimals);
            if (tpSize <= 0) continue;   // (Codex #2) redondea a 0 → omitir (queda como pool bajo el SL)
            const tpOrder = await ctx.runQuery(internal.triggerArms.getArmTpOrder, { armId, tpIndex: i });
            if (tpOrder && (tpOrder.observedStatus !== "pending" || tpOrder.submittedAt != null)) {
              const ts: any = await info.orderStatus({ user, oid: tpOrder.cloid as `0x${string}` });
              const tState = ts?.status === "order" ? ts.order?.status : undefined;
              const tOpen = await openByCloid(info, user, tpOrder.cloid);
              const tFill = await fillsByCloid(info, user, tpOrder.cloid);
              if (tState === "filled" || tFill.size > 0) { await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "filled" }); continue; }
              if (tState === "open" || tOpen) { await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "open", oid: tpOrder.oid }); continue; }
              if (tState === "triggered") { await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "triggered" }); continue; }
              if (tpOrder.submittedAt && Date.now() - tpOrder.submittedAt < SL_SUBMIT_GRACE_MS) continue;  // grace (lag)
              await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "canceled" });  // muerto → recolocar
            }
            // Colocar este TP (uno por ciclo).
            const tpTrigger = roundHlPrice(posEntryPx * (1 - tps[i].gainPct / 100), szDecimals, "floor");
            if (!(tpTrigger > 0)) continue;
            const renewT = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
            if (!renewT.ok) return { skipped: "lease_lost" };
            const prepT = await ctx.runMutation(internal.triggerArms.prepareTpAttempt, { armId, token, tpIndex: i, triggerPx: tpTrigger, size: tpSize });
            if (!prepT.ok) return { skipped: "tp_prep_race" };
            const tpLimitPx = aggressiveHlPriceStr(tpTrigger * (1 + ENTRY_TRIGGER_SLIPPAGE), szDecimals, true);  // BUY ceil
            const acT = abortAfter(HL_ORDER_TIMEOUT_MS);
            try {
              const respT: any = await exchange.order({
                orders: [{ a: assetId, b: true, p: tpLimitPx, s: String(tpSize), r: true, t: { trigger: { isMarket: true, triggerPx: formatHlPrice(tpTrigger, szDecimals), tpsl: "tp" } }, c: prepT.cloid as `0x${string}` }],
                grouping: "na",
              }, { signal: acT.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
              const stT = respT?.response?.data?.statuses?.[0];
              if (stT?.resting?.oid != null) await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "open", oid: String(stT.resting.oid), markSubmitted: true });
              else if (stT?.filled?.oid != null) await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "filled", oid: String(stT.filled.oid), markSubmitted: true });
              else if (stT === "waitingForTrigger" || stT === "waitingForFill") await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "pending", markSubmitted: true });
              else if (stT?.error) await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "rejected" });
              else await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "pending", markSubmitted: true });
            } catch (e) {
              // TransportError (incierto, pudo enviarse) → marcar submitted (confirma por CLOID luego).
              // Rechazo definitivo → dejar pending sin submitted; reintenta. El SL cubre la posición igual.
              if (e instanceof TransportError) await ctx.runMutation(internal.triggerArms.setTpObserved, { armId, token, tpIndex: i, observedStatus: "pending", markSubmitted: true });
            } finally { acT.clear(); }
            return { result: `tp_${i}_handled` };   // una colocación por ciclo
          }
          return { result: "protected_tps_ok" };
        }

        // (3) ARMADO dentro del deadline: CONFIRMAR el SL existente (sin rotar) o colocar uno nuevo.
        // (Codex #1) Si el SL ya se observó vivo O se envió (slSubmittedAt), confirmar por CLOID y NO
        // rotar el cloid hasta probar que el anterior murió (grace + prueba negativa) → anti-doble-SL.
        if (slOrder && (slOrder.observedStatus !== "pending" || arm.slSubmittedAt != null)) {
          const slStatus: any = await info.orderStatus({ user, oid: slOrder.cloid as `0x${string}` });
          const slState = slStatus?.status === "order" ? slStatus.order?.status : undefined;
          const slOpen = await openByCloid(info, user, slOrder.cloid);
          const slFill = await fillsByCloid(info, user, slOrder.cloid);
          if (slState === "filled" || slFill.size > 0) {
            await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "filled" });
            return { skipped: "sl_fired_awaiting_flat" };   // szi==0 en el próximo ciclo → closed
          }
          if (slState === "open" || slOpen) {
            await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "open", oid: slOrder.oid });
            if (arm.status !== "protected") await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "protected" });
            return { result: "protected" };
          }
          if (slState === "triggered") {
            await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "triggered" });
            return { skipped: "sl_triggered_pending" };
          }
          // No vivo, sin fills, no triggered: si está dentro del grace desde el envío → esperar (lag).
          if (arm.slSubmittedAt && Date.now() - arm.slSubmittedAt < SL_SUBMIT_GRACE_MS) {
            return { skipped: "sl_submit_grace" };
          }
          // Grace vencido + prueba negativa (no en book, sin fills) → el intento murió → rotar (abajo).
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "canceled" });
        }
        // Colocar un NUEVO intento de SL (no hay order, nunca enviado, o el anterior se confirmó muerto).
        if ((arm.slAttempts ?? 0) >= SL_MAX_ATTEMPTS) return { skipped: "sl_max_attempts" };   // (2) escala a emergencia
        if (arm.status === "filled") await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "protecting" });
        const prep = await ctx.runMutation(internal.triggerArms.prepareSlAttempt, { armId, token, protectDeadlineMs: SL_PROTECT_DEADLINE_MS });
        if (!prep.ok) return { skipped: "sl_prep_race" };
        const renew = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
        if (!renew.ok) return { skipped: "lease_lost" };
        try {
          const sl = await placeStopLoss(exchange, assetId, szDecimals, "Short", realSize, posEntryPx, arm.stopLossPct, prep.cloid as `0x${string}`);
          if (sl.state === "resting") {
            await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "open", oid: sl.oid });
            await ctx.runMutation(internal.triggerArms.markArmSlSubmitted, { armId, token });
            await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "protected" });
            return { result: "protected_placed" };
          }
          if (sl.state === "filled") {
            await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "filled", oid: sl.oid });
            await ctx.runMutation(internal.triggerArms.markArmSlSubmitted, { armId, token });
            return { skipped: "sl_fired_immediately" };
          }
          // pending/timeout: marcar slSubmittedAt → el próximo ciclo CONFIRMA por CLOID, NO rota (anti-doble-SL).
          await ctx.runMutation(internal.triggerArms.markArmSlSubmitted, { armId, token });
          return { skipped: "sl_pending" };
        } catch {
          // Rechazo DEFINITIVO (no TransportError): el SL no se colocó. NO marcar slSubmittedAt → el
          // siguiente ciclo puede rotar (prueba negativa inmediata). slAttempts ya subió; deadline/max
          // escala a cierre de emergencia.
          return { skipped: "sl_place_error" };
        }
      }

      // ===== FASE PRE-FILL (ninguna entrada llena aún): gestionar entrada(s) + OCO =====
      const entryOrders = (await ctx.runQuery(internal.triggerArms.getArmOrdersInternal, { armId }))
        .filter((o) => o.role === "entry_lower" || o.role === "entry_upper");
      const entryCloids = entryOrders.map((o) => o.cloid);

      // (A) OCO: si CUALQUIER entrada llenó → filled + cancelar las hermanas (+ reducir reserva a 1×
      // si ninguna hermana llenó). El SL/cierre usan el tamaño REAL (szi) → doble-fill cubierto.
      for (const eo of entryOrders) {
        const os: any = await info.orderStatus({ user, oid: eo.cloid as `0x${string}` });
        const oState = os?.status === "order" ? os.order?.status : undefined;
        const f = await fillsByCloid(info, user, eo.cloid);
        if (oState === "filled" || f.size > 0) {
          if (!(f.size > 0 && f.avgPx > 0)) return { skipped: "fill_data_pending" };
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "filled", oid: eo.oid });
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: f.size, entryPrice: f.avgPx });
          // Cancelar las OTRAS entradas (OCO). La REDUCCIÓN de reserva 2×→1× NO se hace aquí: se hace
          // en la fase de posición SOLO tras confirmar (ensureOrdersDead) que las hermanas murieron y
          // que la posición es de 1× (no doble-fill) — evita liberar margen con una hermana aún viva.
          for (const other of entryOrders) {
            if (other._id === eo._id) continue;
            try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: other.cloid as `0x${string}` }] }); } catch { /* cron */ }
          }
          return { result: "filled_oco" };
        }
      }

      // (B) DEFENSIVO (desarmar/cancelar): cancelar TODAS las entradas y confirmar muertas (prueba
      // negativa por CLOID) antes de declarar disarmed.
      if (wantDisarm) {
        const renewD = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
        if (!renewD.ok) return { skipped: "lease_lost" };
        if (!(await ensureOrdersDead(info, exchange, user, assetId, entryCloids))) {
          return { skipped: "disarm_pending_confirmation" };
        }
        for (const eo of entryOrders) await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "canceled" });
        const r = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "disarmed" });
        return { result: r.ok ? "disarmed" : "disarm_quarantined" };
      }

      // (C) ARMADO: confirmar cada entrada por CLOID. Vivo (open/triggered) → cuenta como armado.
      let anyAlive = false;
      for (const eo of entryOrders) {
        const os: any = await info.orderStatus({ user, oid: eo.cloid as `0x${string}` });
        const oState = os?.status === "order" ? os.order?.status : undefined;
        if (oState === "open") { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "open", oid: eo.oid }); anyAlive = true; }
        else if (oState === "triggered") { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "triggered", oid: eo.oid }); anyAlive = true; }
        else if (await openByCloid(info, user, eo.cloid)) { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "open" }); anyAlive = true; }  // lag de unknownOid
        else { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "canceled" }); }  // muerta (terminal/unknownOid sin book)
      }
      if (anyAlive) {
        if (arm.status !== "armed") await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed" });
        // (Fix #2) Si quedó UNA sola entrada viva (la otra confirmada muerta), ya no hay doble-fill
        // posible → reducir reserva a 1×. Con datos FRESCOS (re-query, no el array obsoleto) y
        // confirmando muertas las no-vivas por CLOID (ensureOrdersDead las cancela y prueba).
        if (arm.allowReentryFromAbove && !arm.reservationReduced && entryOrders.length > 1) {
          const fresh = (await ctx.runQuery(internal.triggerArms.getArmOrdersInternal, { armId }))
            .filter((o) => o.role === "entry_lower" || o.role === "entry_upper");
          const liveRoles = fresh.filter((o) => o.observedStatus === "open" || o.observedStatus === "triggered" || o.observedStatus === "pending");
          const deadCloids = fresh.filter((o) => !liveRoles.includes(o)).map((o) => o.cloid);
          if (liveRoles.length <= 1 && (await ensureOrdersDead(info, exchange, user, assetId, deadCloids))) {
            await ctx.runMutation(internal.triggerArms.reduceArmReservation, { armId, token, reservedNotional: arm.reservedNotional / 2, marginReserved: arm.marginReserved / 2 });
          }
        }
        return { result: "armed" };
      }
      // Ninguna entrada viva ni llena → prueba negativa → failed (cuarentena N6 lo retiene si toca).
      const rF = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: "entradas muertas (prueba negativa)" });
      return { result: rF.ok ? "failed_negative_proof" : "failed_quarantined" };
    } finally {
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
    }
  },
});
