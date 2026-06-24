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
import { armErrorKind, REARM_COOLDOWN_MS, REARM_RETRY_MS, REARM_BLOCKED_RECHECK_MS, STOP_ALERT_THRESHOLD } from "./triggerRearm";
import { TransportError } from "@nktkas/hyperliquid";
import { elog } from "./log";

// --- JAV-44 Etapa 1: actions del motor (trigger nativo de entrada inferior, TESTNET) ---

const HL_ORDER_TIMEOUT_MS = 30_000;
// Banda agresiva del market al dispararse el trigger de entrada (venta). Gap > banda → puede no llenar.
const ENTRY_TRIGGER_SLIPPAGE = 0.02;
// (JAV-61) Offset de PERFORACIÓN del borde inferior en armMode="reentry_coexist": entry_lower se
// arma estrictamente por debajo de lowerEdge para separarse del tp_final (que vive EN lowerEdge) y
// representar "el precio rompió el rango hacia abajo", no "lo tocó". POLÍTICA FIJADA: 0.1% del precio
// (≈ varios ticks en los activos operados: ETH/BTC). Garantía dura: reserveArm exige
// entryLowerTriggerPx < lowerEdge y lanza [blocked_config] si el redondeo no quedara estrictamente
// por debajo (activos donde 0.1% < 1 tick), evitando colisión silenciosa con el tp_final.
const LOWER_PERFORATION_OFFSET = 0.001;
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
// (JAV-66) Break-even: offset bajo la entrada al que se mueve el SL al alcanzar breakevenPct de
// ganancia. Para un Short, el SL queda un pelín BAJO la entrada → cubre las ~2 comisiones taker →
// break-even NETO (o ligeramente positivo). 0 = entrada exacta (BE bruto).
// INVARIANTE: BE_OFFSET_FRACTION < breakevenPct/100 (si no, el trigger quedaría ≤ mark al activar);
// con breakevenPct mínimo de UI 0.5% (=0.005), el colchón 0.0005 deja margen de sobra.
const BE_OFFSET_FRACTION = 0.0005;   // ~0.05% (decisión del usuario: BE neto cubriendo fees)
// Tolerancia relativa para considerar el SL "en el nivel deseado" (distingue entry+1% de BE, ~1% de
// separación, tolerando la deriva del entry medio entre ciclos).
const SL_TRIGGER_MATCH_TOL = 5e-4;
// (JAV-66) Tamaño de 1 tick de precio de un perp en HL: el MÁS restrictivo entre (a) los decimales
// permitidos (MAX_DECIMALS=6 para perps → 6−szDecimals) y (b) las 5 cifras significativas. Se usa para
// el guard anti-auto-disparo del BE (beTrigger > markPx + tick).
function hlTickSize(price: number, szDecimals: number): number {
  // (CodeRabbit) clamp del exponente: con szDecimals>6, (6−szDecimals) sería negativo y
  // Math.pow(10,−neg) inflaría el tick → guard de BE demasiado estricto. maxDecimals nunca < 0.
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const decimalsTick = Math.pow(10, -maxDecimals);
  const sigFigTick = price > 0 ? Math.pow(10, Math.floor(Math.log10(price)) - 4) : decimalsTick;
  return Math.max(decimalsTick, sigFigTick);
}

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

// Acción PÚBLICA: auth + ownership → delega el armado al núcleo interno (compartido con el auto-rearm).
export const armPoolBotEntry = action({
  args: { botId: v.id("bots"), expectedNetwork: v.string(), confirm: v.boolean() },
  // Promise<any>: corta el ciclo de inferencia (TS2589) — estas actions se invocan entre sí en el mismo
  // módulo (internal.triggerEngine.*). El cuerpo se sigue type-checkeando (caza referencias indefinidas).
  handler: async (ctx, args): Promise<any> => {
    // Red: el backend es la fuente de verdad. Mainnet habilitado ahora que hay SL post-fill que
    // protege la posición (cierre de emergencia garantiza que nunca quede un short desnudo).
    assertExpectedNetwork(args.expectedNetwork);
    if (!args.confirm) throw new Error("Armado requiere confirmación explícita.");
    const user = await ctx.runQuery(internal.users.getCurrentUserInternal, {});
    await ctx.runQuery(internal.users.assertTradeLiveInternal, {});
    // JAV-72 (P0): el armado MANUAL exige también canManageBots (espeja requireBotManager de
    // getOrCreatePoolBot). Sin esto, un usuario con canTradeLive pero canManageBots revocado podría
    // armar un bot suyo ya existente saltándose el gate. El auto-rearm (armBotInternal) NO lo exige.
    const canManage = await ctx.runQuery(internal.users.hasManageBotsForUserInternal, { userId: user._id });
    if (!canManage) throw new Error("Forbidden: requiere permiso canManageBots");
    const bot0 = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: args.botId });
    if (!bot0) throw new Error("Bot not found");
    if (bot0.userId !== user._id) throw new Error("Bot does not belong to this user");
    return await ctx.runAction(internal.triggerEngine.armBotInternal, { botId: args.botId, userId: user._id });
  },
});

// Núcleo del armado SIN auth de usuario (lo invocan armPoolBotEntry y el auto-rearm del cron). Revalida
// TODOS los gates contra userId (no la identidad): permiso live, switches, ownership, kind/dirección,
// pool, cuenta, sizing, reserva OCC y colocación. Coloca el trigger inferior (+ superior si aplica).
// (JAV-53) Clasifica un rechazo DETERMINISTA de updateLeverage en un [kind] de auto-rearm y lo
// prefija al mensaje persistido. Default [blocked_config] (config/leverage/activo/credencial corregible);
// [blocked_margin] si el rechazo expresa margen. NUNCA [cancel] (eso es pausa/kill/pool cerrado).
function classifyLeverageError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const low = msg.toLowerCase();
  const kind = (low.includes("margin") || low.includes("margen") || low.includes("insufficient"))
    ? "blocked_margin" : "blocked_config";
  return `[${kind}] updateLeverage rechazado: ${msg.slice(0, 200)}`;
}

export const armBotInternal = internalAction({
  args: { botId: v.id("bots"), userId: v.id("users"), rearmToken: v.optional(v.string()) },
  handler: async (ctx, { botId, userId, rearmToken }): Promise<any> => {
    // Los throws llevan prefijo [kind] (auto-rearm): el cron los mapea a la política de Codex —
    // [cancel] aborta el rearm; [blocked_config]/[blocked_margin] → blocked reevaluable; [retry_incompatible]
    // y sin-prefijo → transient (reintento indefinido). Ver REARM_ERROR_KINDS / armErrorKind.
    // Permiso de trading live del DUEÑO del bot (sin identidad — válido para el auto-rearm del cron).
    const canLive = await ctx.runQuery(internal.users.hasTradeLiveForUserInternal, { userId });
    if (!canLive) throw new Error("[blocked_config] Usuario sin permiso de trading live");
    const [tradingConfig, simConfig] = await Promise.all([
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "tradingEnabled" }),
      ctx.runQuery(internal.systemConfig.getConfigInternal, { key: "simulationMode" }),
    ]);
    if (tradingConfig?.value !== true) throw new Error("[cancel] Live trading is disabled");
    if (simConfig?.value !== false) throw new Error("[cancel] Simulation mode is active");

    const bot = await ctx.runQuery(internal.bots.getBotByIdInternal, { id: botId });
    if (!bot) throw new Error("[cancel] Bot not found");
    if (bot.userId !== userId) throw new Error("[cancel] Bot does not belong to this user");
    if (bot.kind !== "il") throw new Error("[blocked_config] Solo bots IL (cobertura) en Etapa 1");
    if (bot.direction !== "short") throw new Error("[blocked_config] El bot IL debe ser short");
    if (!bot.active) throw new Error("[cancel] Bot is not active");
    if (bot.disarmPending) throw new Error("[cancel] Bot pausándose (disarmPending): no se puede armar");
    if (bot.simulationMode) throw new Error("[cancel] Bot en simulación");
    if (!bot.hlAccountId) throw new Error("[blocked_config] Bot sin cuenta HL");
    if (!bot.poolId) throw new Error("[blocked_config] Bot sin pool");
    if (!bot.baseAsset) throw new Error("[blocked_config] Bot sin baseAsset");
    // (G3) hedgeNotionalUsd YA NO viene del cliente: se DERIVA on-chain abajo, tras leer markPx.
    if (bot.stopLossPct === undefined || !Number.isFinite(bot.stopLossPct) || bot.stopLossPct <= 0 || bot.stopLossPct >= 100) {
      throw new Error("[blocked_config] Bot sin stopLossPct válido (0–100) — necesario para el SL post-fill");
    }

    const pool = await ctx.runQuery(internal.pools.getPoolByIdInternal, { id: bot.poolId });
    if (!pool) throw new Error("[cancel] Pool no encontrado");
    if (pool.closed) throw new Error("[cancel] Pool cerrado");
    if (!Number.isFinite(pool.minRange) || pool.minRange <= 0) throw new Error("[blocked_config] minRange inválido");
    if (pool.tokenId === undefined || pool.tokenId === null) throw new Error("[blocked_config] Pool sin tokenId (no se puede leer el LP para dimensionar)");

    const credential = await ctx.runQuery(internal.hlCredentials.getAccountByIdInternal, { id: bot.hlAccountId });
    if (!credential) throw new Error("[blocked_config] Cuenta HL no encontrada");
    if (credential.userId !== userId) throw new Error("[blocked_config] La cuenta no pertenece a este usuario");

    // El leverage (auto/manual) lo resuelve reserveArm con el helper compartido, atómico con el
    // margen comprometido de la cuenta. Aquí solo se transporta la config del bot.
    const asset = bot.baseAsset.toUpperCase();
    const { info, exchange } = makeClients(decryptPrivateKey(credential), hlIsTestnet());
    const { assetId, szDecimals, markPx, maxLeverage } = await getAssetMeta(info, asset);
    const tradingAccount = credential.tradingAccountAddress as `0x${string}`;

    // (CodeRabbit) Paridad con executePerpMarketOrder: exigir cuenta en modo unified ANTES de
    // reservar margen (el snapshot de colateral spot solo es válido en unified).
    const abstraction = await info.userAbstraction({ user: tradingAccount });
    if (abstraction !== "unifiedAccount") {
      throw new Error("[blocked_config] La cuenta HL no está en modo unified; armado bloqueado por seguridad.");
    }

    // (H4) Precondición flat: posición neta cero del activo. [retry_incompatible]: estado externo/residual,
    // reintentar + alertar (Codex #5) — puede ser una posición que se cerrará o un residuo a limpiar.
    const chState = await info.clearinghouseState({ user: tradingAccount });
    const pos = (chState.assetPositions ?? []).find((p: any) => p.position?.coin === asset);
    if (pos && Math.abs(Number(pos.position?.szi ?? 0)) > 0) {
      throw new Error("[retry_incompatible] Ya existe posición abierta en el activo: armado bloqueado (precondición flat).");
    }
    // (Fix #7 / H4) Sin órdenes abiertas incompatibles en el activo (un trigger/orden previo dejaría
    // la cobertura en un estado ambiguo). En Etapa 1, cualquier orden abierta del activo bloquea.
    const openOrders: any[] = await info.frontendOpenOrders({ user: tradingAccount });
    if (openOrders.some((o) => o?.coin === asset)) {
      throw new Error("[retry_incompatible] Hay órdenes abiertas en el activo: armado bloqueado (sin órdenes incompatibles).");
    }

    // (R6) Trigger normalizado al tick (floor). El sizing SIEMPRE usa triggerPxNorm (no markPx).
    const triggerPxNorm = roundHlPrice(pool.minRange, szDecimals, "floor");
    // (Benjamin) Si el precio YA está en/bajo el borde inferior (p.ej. un desplome que lo atravesó de
    // un salto), el trigger de entrada dispararía solo: en vez de bloquear con [transient] y dejar la
    // cobertura SIN armar justo en la caída, abrimos la entry_lower A MERCADO (IOC agresivo) de
    // inmediato. El fill ocurre a markPx < triggerPxNorm → nocional REAL ≤ reservado (conservador
    // respecto al margen; mismo espíritu que la nota JAV-43). En este modo NO se coloca entry_upper
    // (por deducción el precio ya está abajo: una 2ª entrada de breakout arriba no aplica).
    const entryLowerImmediate = !(markPx > triggerPxNorm);

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
        if (!(t.gainPct > 0) || !(t.closePct > 0)) throw new Error("[blocked_config] TP inválido (gainPct/closePct > 0)");
      }
      const sumClose = tps.reduce((s, t) => s + t.closePct, 0);
      if (sumClose > 100) throw new Error("[blocked_config] Σ closePct de los TPs no puede superar 100 (% del búfer).");
    }
    // (G3) Tamaño AUTORITATIVO: el backend lee el nocional REAL del LP on-chain (NO el cliente).
    // Helper estricto (fail-closed): metadata fiable con fallback entre RPCs; null ante cualquier
    // duda. Precio = markPx de HL (pares */USDC). hedgeNotionalUsd = liquidez del LP EN CRUDO; el
    // buffer se aplica UNA vez abajo en totalNotional.
    const notionalRead = await ctx.runAction(internal.actions.poolScanner.fetchPositionNotionalStrict, {
      tokenId: pool.tokenId, network: pool.network, priceUsd: markPx, poolAddress: pool.poolAddress ?? undefined,
    });
    // (CodeRabbit #4) Distinguir fallo TRANSITORIO (reintentar) de DETERMINISTA (bloquear, no reintentar
    // para siempre): un LP vacío o un par no soportado NO se resuelven reintentando.
    if (notionalRead.reason === "transient") {
      throw new Error("[retry_incompatible] Lectura on-chain del nocional del LP no disponible (RPC): reintento.");
    }
    if (notionalRead.reason === "empty") {
      throw new Error("[blocked_config] El LP no tiene liquidez: nada que cubrir (fondea la posición LP).");
    }
    if (notionalRead.reason !== "ok" || !Number.isFinite(notionalRead.liquidityUsd) || notionalRead.liquidityUsd <= 0) {
      throw new Error("[blocked_config] No se puede dimensionar la cobertura de este LP (par/metadata no soportados).");
    }
    const hedgeNotionalUsd = notionalRead.liquidityUsd;
    const totalNotional = hedgeNotionalUsd * (1 + bufferPct / 100);
    const notionalCapPx = ceilHlPrice(triggerPxNorm * (1 + ENTRY_TRIGGER_SLIPPAGE), szDecimals);
    const size = floorToDecimals(totalNotional / notionalCapPx, szDecimals);
    if (size <= 0) throw new Error("[blocked_config] Size redondea a cero");
    const orderNotional = size * notionalCapPx;          // nocional de UNA entrada (límite por orden)

    // (JAV-61) 2ª entrada (borde superior), dos modos según la posición del precio:
    //  - precio DENTRO del rango (markPx < upperEdge): "breakout_up" — SELL trigger ARRIBA del borde,
    //    dispara al SUBIR (tpsl:"tp"). OCO clásico (al llenar una se cancela la hermana, reduce 2×→1×).
    //  - precio POR ENCIMA (markPx > upperEdge): "reentry_down" — SELL trigger EN el borde superior,
    //    dispara al BAJAR/reentrar (tpsl:"sl"). Coexistencia (reentry_coexist): NO se cancela
    //    entry_lower ni se reduce la reserva; tras el TP-final el arm pasa a `armed_lower_only`.
    //  - markPx == upperEdge exacto (borde): NO se coloca entry_upper (evita un trigger que dispara solo).
    const upperEdgeNorm = roundHlPrice(pool.maxRange, szDecimals, "ceil");
    // (Benjamin) En entrada inmediata a mercado NO hay 2ª entrada: el precio ya está abajo, así que un
    // breakout/reentry superior no aplica (factor=1, sin OCO ni pata superior en reposo).
    const upperValid = !entryLowerImmediate && bot.allowReentryFromAbove === true && Number.isFinite(pool.maxRange) && pool.maxRange > 0;
    const reentryFromAbove = upperValid && markPx > upperEdgeNorm;
    const breakoutUp = upperValid && markPx < upperEdgeNorm;
    const twoEntries = reentryFromAbove || breakoutUp;
    const entryUpperMode: "breakout_up" | "reentry_down" = reentryFromAbove ? "reentry_down" : "breakout_up";
    const armMode: "oco" | "reentry_coexist" = reentryFromAbove ? "reentry_coexist" : "oco";
    // (JAV-61) En reentry_coexist, entry_lower dispara solo por PERFORACIÓN: triggerPx estrictamente
    // bajo el borde inferior (separado del tp_final que vive EN lowerEdge). En OCO = borde inferior.
    const entryLowerTriggerPx = reentryFromAbove
      ? roundHlPrice(pool.minRange * (1 - LOWER_PERFORATION_OFFSET), szDecimals, "floor")
      : triggerPxNorm;
    // (Codex #1) Con DOS entradas, reservar el PEOR CASO 2× (doble-fill). En OCO se reduce a 1× tras el
    // OCO; en reentry_coexist se MANTIENE 2× (ambas patas conviven). reserveArm dimensiona margen/auto.
    const factor = twoEntries ? 2 : 1;
    const reservedNotional = orderNotional * factor;

    // Colateral USDC spot libre (sin doble conteo; reserveArm descuenta el comprometido de ambos motores).
    const spotState = await info.spotClearinghouseState({ user: tradingAccount });
    const availableCollateral = (spotState.balances ?? [])
      .filter((b: any) => b.coin === "USDC")
      .reduce((s: number, b: any) => s + Math.max(0, parseFloat(b.total ?? "0") - parseFloat(b.hold ?? "0")), 0);

    // Reserva OCC (generación, unicidad, margen/daily compartidos) — crea arm(arming)+order(pending).
    const reservation = await ctx.runMutation(internal.triggerArms.reserveArm, {
      botId: bot._id, userId: userId, hlAccountId: bot.hlAccountId, poolId: bot.poolId,
      asset, network: hlNetwork(), triggerPx: triggerPxNorm, size,
      autoLeverage: bot.autoLeverage === true, manualLeverage: bot.leverage,
      assetMaxLeverage: maxLeverage,
      orderNotional, reservedNotional, hedgeNotionalUsd, lowerEdge: pool.minRange,
      upperEdge: twoEntries ? upperEdgeNorm : undefined,
      allowReentryFromAbove: twoEntries ? true : undefined,
      // (JAV-61) modo de coexistencia + semántica del entry_upper + perforación del entry_lower.
      armMode, entryUpperMode: twoEntries ? entryUpperMode : undefined,
      entryLowerTriggerPx: reentryFromAbove ? entryLowerTriggerPx : undefined,
      stopLossPct: bot.stopLossPct, bufferPct, tps, availableCollateral,
      // (JAV-66) Break-even: validar/desactivar AQUÍ (snapshot). undefined → BE off (legacy intacto).
      // No bloquea el armado: si está configurado pero es inválido, se desactiva con un warning.
      breakevenPct: ((): number | undefined => {
        const be = bot.breakevenPct;
        if (be == null) return undefined;
        if (!(be > 0 && be <= 50 && BE_OFFSET_FRACTION < be / 100)) {
          console.warn(`[JAV-66] breakeven desactivado para bot ${bot._id}: breakevenPct=${be} inválido (>0, ≤50, y BE_OFFSET<be/100).`);
          return undefined;
        }
        return be;
      })(),
      rearmToken,   // (Codex #2) si es un re-armado, la reserva consume el trabajo atómicamente
    });
    const { armId, cloid, cloidUpper, appliedLeverage } = reservation;

    // (N1/N5) CAS pre-envío: arming→submitting + submittedAt (cuarentena). Si falla → abortar SIN enviar.
    const sub = await ctx.runMutation(internal.triggerArms.markArmSubmitting, { armId });
    if (!sub.ok) return { ok: false, status: "aborted", armId, reason: sub.reason };
    const token = sub.token;

    // Apalancamiento entero en HL (isolated). (JAV-53) updateLeverage corre ANTES de colocar entradas:
    // si lanza, NUNCA se envió la orden → no hay posición.
    try {
      await exchange.updateLeverage({ asset: assetId, isCross: false, leverage: appliedLeverage });
    } catch (e) {
      if (e instanceof TransportError) {
        // INCIERTO (timeout/red/5xx): HL pudo aplicar el leverage, pero no hay entrada enviada. NO
        // terminalizar a failed: liberar el lease y dejar reconciliable (el cron: unknownOid → prueba
        // negativa → failed tras cuarentena). Mismo patrón que el gate fallido.
        await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
        return { ok: false, status: "gated", armId, reason: "updateLeverage_transport" };
      }
      // DETERMINISTA: cerrar el arm YA (libera margen sin esperar la cuarentena) probando sin-envío.
      const prefixed = classifyLeverageError(e);
      const res = await ctx.runMutation(internal.triggerArms.failArmPreOrder, {
        armId, token, reason: "update_leverage_rejected", error: prefixed,
      });
      // (Codex rev.2, BAJO) Si algún guard NO se cumplió (cron tomó el lease, o —defensivo— una entrada
      // ya salió) → NO reportar failed: liberar lease (best-effort) y abortar para el camino normal.
      if (!res.ok) {
        await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
        return { ok: false, status: "aborted", armId, reason: "updateLeverage_failed_guard" };
      }
      // Terminalizado: lanzar el error [kind] → el cron de auto-rearm lo mapea (blocked reevaluable) y
      // el armado MANUAL lo surfacea al usuario. (invariante 5 del plan.)
      throw new Error(prefixed);
    }

    // (Fix #1) Gate ATÓMICO justo antes del envío: updateLeverage pudo tardar y un kill switch/pausa/
    // revocación ocurrir en esa ventana (desiredState no lo refleja). Revalidar TODO bajo el lease.
    const gate = await ctx.runMutation(internal.triggerArms.gateArmBeforeOrder, { armId, token });
    if (!gate.ok) {
      // No se envió. Dejar el arm reconciliable: el cron verá unknownOid → prueba negativa → failed
      // (tras cuarentena) o, si hay kill switch, el camino defensivo. Liberar el lease.
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
      return { ok: false, status: "gated", armId };
    }

    // (Codex Alto-1) Entrada inmediata a mercado: releer el mark FRESCO justo antes de enviar. La ventana
    // desde la lectura inicial incluye fetchNotional+reserveArm+updateLeverage (segundos); un rebote ahí
    // dejaría el SELL IOC llenando por ENCIMA de notionalCapPx (excede lo reservado). Acotamos el nocional
    // así: solo se entra a mercado si el precio SIGUE en/bajo el borde (freshMark ≤ triggerPxNorm <
    // notionalCapPx ⇒ avgPx del IOC ≤ reservado, con la holgura del 2% de ENTRY_TRIGGER_SLIPPAGE).
    // (CodeRabbit Major #1+#2) AQUÍ todavía NO se llamó a exchange.order. La topología (sin pata superior/
    // OCO, factor=1) se fijó con el mark inicial y NO puede restaurarse en este arm. Por eso, si el mark
    // fresco REBOTÓ sobre el borde (modo inmediato ya no aplica) o la lectura fresca FALLÓ, NO se coloca un
    // trigger en reposo degradado: se ABORTA como pre-orden (sin petición HL en vuelo) con
    // failArmPreOrder → libera el margen YA y reprograma el rearm, que reconstruye la topología COMPLETA
    // con un mark fresco. Solo se procede al IOC si el precio sigue en/bajo el borde.
    let immediateMarkPx = markPx;
    if (entryLowerImmediate) {
      let freshMarkPx: number | undefined;
      try { freshMarkPx = (await getAssetMeta(info, asset)).markPx; } catch { /* RPC: abortar pre-orden */ }
      if (freshMarkPx === undefined || freshMarkPx > triggerPxNorm) {
        const pf = await ctx.runMutation(internal.triggerArms.failArmPreOrder, {
          armId, token, reason: "immediate_recheck_failed",
          error: freshMarkPx === undefined
            ? "[transient] mark fresco no disponible al rearmar (reintento)"
            : "[transient] precio rebotó sobre el borde antes del envío (reintento con topología completa)",
        });
        if (!pf.ok) await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
        return { ok: false, status: pf.ok ? "rejected" : "gated", armId, reason: "immediate_recheck" };
      }
      immediateMarkPx = freshMarkPx;
    }

    // Colocar las entradas (SELL, reduceOnly:false). Banda agresiva floor (venta).
    // entry_lower: SELL trigger que dispara al BAJAR (tpsl:"sl"); en reentry_coexist su triggerPx es la
    //   PERFORACIÓN (bajo lowerEdge), en OCO es el borde inferior (triggerPxNorm).
    // entry_upper (JAV-61): "breakout_up" → trigger ARRIBA del borde, dispara al subir (tpsl:"tp");
    //   "reentry_down" → trigger EN el borde superior, dispara al BAJAR/reentrar (tpsl:"sl").
    const entries: { role: "entry_lower" | "entry_upper"; cloid: string; triggerPx: number; tpsl: "sl" | "tp" }[] = [
      { role: "entry_lower", cloid, triggerPx: entryLowerTriggerPx, tpsl: "sl" },
    ];
    if (cloidUpper) entries.push({
      role: "entry_upper", cloid: cloidUpper, triggerPx: upperEdgeNorm,
      tpsl: reentryFromAbove ? "sl" : "tp",
    });

    let anyFilled = false, anyPlaced = false, filledSize = 0, entryPrice = 0;
    let filledRole: "entry_lower" | "entry_upper" | undefined;   // (JAV-61) qué entrada llenó (para tp_final)
    let hardError: string | undefined, transportUncertain = false;
    let explicitReject = false;   // (Codex Alto-2) HL devolvió stE.error → prueba dura de "sin orden viva"
    let immediatePartial = false; // (Codex Medio) IOC inmediato llenó < size esperado → sub-hedge
    for (const en of entries) {
      // (Benjamin) entry_lower inmediata: el precio ya perforó el borde → venta IOC a MERCADO (banda
      // agresiva floor contra el mark FRESCO ya revalidado arriba), en lugar del trigger en reposo.
      const immediate = entryLowerImmediate && en.role === "entry_lower";
      const enLimitPx = immediate
        ? aggressiveHlPriceStr(immediateMarkPx * (1 - ENTRY_TRIGGER_SLIPPAGE), szDecimals, false)
        : aggressiveHlPriceStr(en.triggerPx * (1 - ENTRY_TRIGGER_SLIPPAGE), szDecimals, false);
      const enTSpec = immediate
        ? { limit: { tif: "Ioc" as const } }
        : { trigger: { isMarket: true, triggerPx: formatHlPrice(en.triggerPx, szDecimals), tpsl: en.tpsl } };
      const acE = abortAfter(HL_ORDER_TIMEOUT_MS);
      try {
        const respE: any = await exchange.order({
          orders: [{ a: assetId, b: false, p: enLimitPx, s: String(size), r: false,
            t: enTSpec,
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
          // (JAV-61) Preferir entry_upper como filledRole (gobierna el tp_final) si ambas llenaran.
          if (fS > 0 && fP > 0) { anyFilled = true; filledSize = fS; entryPrice = fP; if (en.role === "entry_upper" || filledRole === undefined) filledRole = en.role; }
          // (Codex Medio) IOC inmediato que llena solo una fracción del size (liquidez fina en la caída):
          // el reconcile protege con SL sobre el szi REAL, pero la cobertura queda materialmente sub-hedged
          // frente al LP → registrar para alerta/seguimiento (no se reintenta el remanente en este ciclo).
          if (immediate && fS > 0 && fS < size * 0.99) immediatePartial = true;
          // (Codex R2, condición residual) Telemetría post-fill: el cap se acota antes de enviar (solo se
          // entra con freshMark ≤ triggerPxNorm < notionalCapPx), pero confirmamos el avgPx REAL: si por un
          // salto sub-segundo superó notionalCapPx, el nocional excedió lo reservado → alertar.
          if (immediate && fP > notionalCapPx) {
            elog("arm", "immediate_avgpx_over_cap", { armId: String(armId), avgPx: fP, notionalCapPx });
          }
        } else if (stE === "waitingForTrigger") {
          anyPlaced = true;   // observed sigue pending; reconcile lo confirma por CLOID
        } else if (stE?.error) {
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: en.role, observedStatus: "rejected" });
          hardError = String(stE.error);
          explicitReject = true;
        } else { anyPlaced = true; }   // ambiguo → reconcile
      } catch (e) {
        if (e instanceof TransportError) { transportUncertain = true; }   // incierto, pudo enviarse
        else { hardError = String((e as Error)?.message ?? e); }   // definitivo (firma/validación)
      } finally { acE.clear(); }
    }

    // (OBS-3) Clasificación del envío de entradas a HL (engine-level; el settleArm de abajo registra la
    // transición resultante). Solo booleans/size: `hadError` es booleano — NO se loguea el string crudo
    // del SDK (puede traer payload sensible; eso es PR3/hyperliquid.ts).
    elog("arm", "entries_sent", {
      armId: String(armId), anyFilled, anyPlaced, transportUncertain,
      hadError: !!hardError, filledSize: anyFilled ? filledSize : 0,
    });
    // (Codex Medio) Alerta de sub-hedge: el IOC inmediato llenó menos del size reservado (liquidez fina).
    if (immediatePartial) {
      elog("arm", "immediate_partial_fill", { armId: String(armId), filledSize, expectedSize: size });
    }
    // Resolver el estado del arm. Prioridad: fill > colocado/incierto > error.
    if (anyFilled) {
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize, entryPrice });
      // (JAV-61) Registrar la entrada que llenó (el tp_final solo aplica si fue entry_upper). Si llenó
      // en el armado inicial, NO pasaría por la rama OCO de reconcile que lo setea.
      if (filledRole) await ctx.runMutation(internal.triggerArms.setArmFilledEntryRole, { armId, token, role: filledRole });
    } else if (anyPlaced || transportUncertain) {
      // Al menos una entrada colocada (o envío incierto) → armed/unknown reconciliable; el reconcile
      // confirma por CLOID y, si una entrada falló definitivamente, la reintenta o reduce a 1×.
      await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: transportUncertain && !anyPlaced ? "unknown" : "armed", error: hardError });
    } else if (hardError) {
      // (Codex Alto-2) Rechazo EXPLÍCITO de HL (stE.error) = prueba dura de que ninguna entrada quedó viva
      // ni llenó (no es un timeout en vuelo). Terminalizar SIN esperar la cuarentena N6 (que solo cubre
      // peticiones en vuelo ambiguas): libera el margen YA y reprograma el rearm reevaluable. Si el guard
      // no se cumple (algo salió vivo) cae a la vía estándar (settleArm, sujeto a cuarentena).
      if (explicitReject) {
        const immFail = await ctx.runMutation(internal.triggerArms.failArmEntryRejected, { armId, token, error: hardError });
        if (immFail.ok) {
          await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
          return { ok: false, status: "rejected", armId };
        }
      }
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
  handler: async (ctx): Promise<any> => {
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
  handler: async (ctx, { armId }): Promise<any> => {
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
      const { assetId, szDecimals } = assetMeta;   // (CodeRabbit) szDecimals se usa en SL/emergencia/TPs

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
        // (CodeRabbit) Defensa: una pausa pendiente fuerza wantDisarm en TODOS los caminos (incl.
        // reentry_coexist/armed_lower_only), aunque desiredState aún no refleje el disarmed.
        bot.disarmPending === true ||
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

        // (JAV-66) Trigger DESEADO del SL (Short): si el BE ya se activó (latch beMoved) → entrada
        // (break-even); si no → entry + stopLossPct% (comportamiento actual). Todas las colocaciones de
        // SL de la fase de posición (inicial, resize, BE) usan ESTA fuente única → un solo nivel de
        // verdad. Sin beMoved el valor es idéntico al de hoy (cero regresión).
        const markPx = assetMeta.markPx;   // (JAV-66) mark fresco del ciclo (getAssetMeta) para el gate BE
        const beTrigger = posEntryPx * (1 - BE_OFFSET_FRACTION);
        const desiredSlTrigger = arm.beMoved
          ? beTrigger
          : posEntryPx * (1 + arm.stopLossPct / 100);

        // (Codex #1) Reducir reserva 2×→1× SOLO ahora que la posición está abierta: confirmar por CLOID
        // que las entradas hermanas MURIERON (ensureOrdersDead) y que la posición es de 1× (no doble-
        // fill: szi ≈ una sola entrada). Nunca liberar margen con una hermana aún viva.
        // (JAV-61) En reentry_coexist NO se reduce ni se cancela la hermana: las dos patas conviven
        // (entry_lower sigue armada para la perforación). El margen 2× se mantiene a propósito.
        if (arm.armMode !== "reentry_coexist" && arm.allowReentryFromAbove && !arm.reservationReduced) {
          const entryCloidsP = allOrders.filter((o) => o.role === "entry_lower" || o.role === "entry_upper").map((o) => o.cloid);
          if (Math.abs(szi) > 0 && Math.abs(szi) <= arm.size * 1.5 && (await ensureOrdersDead(info, exchange, user, assetId, entryCloidsP))) {
            await ctx.runMutation(internal.triggerArms.reduceArmReservation, { armId, token, reservedNotional: arm.reservedNotional / 2, marginReserved: arm.marginReserved / 2 });
          }
        }
        if (flat) {
          if (Date.now() - (arm.filledAt ?? arm.createdAt) <= CLOSE_CONFIRM_GRACE_MS) return { skipped: "close_confirm_grace" };
          const renewC = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
          if (!renewC.ok) return { skipped: "lease_lost" };
          // (Codex #1) ¿El SL realmente llenó? (orderStatus + fills, no solo el observed persistido).
          // (JAV-61 fix P0#2) Se evalúa ANTES del carve-out: un cierre por SL del short de arriba NO es
          // un TP-final → debe ir al cierre normal (cuenta whipsaw/consecutiveStops + rearma el esquema
          // completo), NUNCA transicionar silenciosamente a armed_lower_only.
          let slConfirmed = slOrder?.observedStatus === "filled";
          if (!slConfirmed && slOrder) {
            const ss: any = await info.orderStatus({ user, oid: slOrder.cloid as `0x${string}` });
            const sState = ss?.status === "order" ? ss.order?.status : undefined;
            const sFill = await fillsByCloid(info, user, slOrder.cloid);
            if (sState === "filled" || sFill.size > 0) slConfirmed = true;
          }
          // (JAV-61) reentry_coexist: SOLO si el cierre NO fue por SL (es decir TP-final/parciales) y
          // entry_lower sigue armada → armed_lower_only (no cerrar ni cancelarla; cancelar SOLO las
          // órdenes del short de arriba). Si fue por SL → cae al cierre normal de abajo (rearma upper).
          if (!slConfirmed && arm.armMode === "reentry_coexist" && !wantDisarm) {
            const lowerOrder = allOrders.find((o) => o.role === "entry_lower");
            if (lowerOrder && (await openByCloid(info, user, lowerOrder.cloid))) {
              if (arm.closeConfirmSince == null) {
                await ctx.runMutation(internal.triggerArms.setArmCloseConfirm, { armId, token, value: Date.now() });
                return { skipped: "armed_lower_only_first_flat" };
              }
              const nonLowerCloids = allOrders.filter((o) => o.role !== "entry_lower").map((o) => o.cloid);
              if (!(await ensureOrdersDead(info, exchange, user, assetId, nonLowerCloids))) {
                return { skipped: "armed_lower_only_cancel_live" };   // SL/TP del short de arriba aún vivo → reintentar
              }
              // (JAV-96) muertas confirmadas → marcar canceled SOLO las del short de arriba (NUNCA entry_lower, sigue armada).
              await ctx.runMutation(internal.triggerArms.markArmOrdersCanceled, { armId, token, cloids: nonLowerCloids });
              const tr = await ctx.runMutation(internal.triggerArms.transitionToArmedLowerOnly, { armId, token });
              return { result: tr.ok ? "armed_lower_only" : "armed_lower_only_failed" };
            }
          }
          if (!(await ensureOrdersDead(info, exchange, user, assetId, allCloids))) {
            return { skipped: "closing_cancel_live_orders" };   // había una orden viva → cancelada; reintentar
          }
          if (arm.closeConfirmSince == null) {
            await ctx.runMutation(internal.triggerArms.setArmCloseConfirm, { armId, token, value: Date.now() });
            return { skipped: "close_first_flat" };
          }
          // (Codex #2) Prioridad SEGURA: emergencyClosing > SL confirmado > manual. NUNCA rearmar un
          // ciclo cuyo mecanismo protector falló (cierre de emergencia) ni un cierre externo del usuario.
          const closeReason: "sl" | "emergency" | "disarm" | "manual" =
            arm.emergencyClosing ?? (slConfirmed ? "sl" : "manual");
          // (JAV-96) ensureOrdersDead(allCloids)===true arriba (gate ~575) → las open/pending que queden
          // están MUERTAS en HL: marcarlas canceled para no dejar `open` rancio que dispare orphan_orders.
          await ctx.runMutation(internal.triggerArms.markArmOrdersCanceled, { armId, token, cloids: allCloids });
          // (Codex #1) Cerrar el arm + contar el stop + programar el rearm en UNA transacción atómica
          // (sin ventana entre cerrar y programar). La mutation conserva fencing/transición/cuarentena
          // y solo programa rearm si closeReason="sl" + config válida.
          const cres = await ctx.runMutation(internal.triggerArms.closeArmAndScheduleRearm, {
            armId, token, closeReason, nextRearmAt: Date.now() + REARM_COOLDOWN_MS,
          });
          if (!cres.ok) return { skipped: "close_failed" };
          // (Codex #4) La alerta de whipsaw la dispara SOLO el cron (processRearms busca los niveles
          // pendientes) → fuente única + Idempotency-Key, sin riesgo de email duplicado por dos actions.
          return { result: cres.rearmScheduled ? "closed_rearm_scheduled" : "closed" };
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
          // (auto-rearm + Codex #5) Marcar el ORIGEN del cierre ANTES del market close. Si la mutación
          // falla (lease perdido / no persistió) ABORTAR: no cerrar sin haber fijado el origen, o el
          // closeReason podría clasificarse como "sl" y rearmar tras un cierre de emergencia.
          const meMark = await ctx.runMutation(internal.triggerArms.markEmergencyClosing, { armId, token, reason: wantDisarm ? "disarm" : "emergency" });
          if (!meMark.ok) return { skipped: "emergency_mark_failed" };
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

        // (2.4) (JAV-61 fix P0#1/#2/#3) Redimensión del SL en reentry_coexist cuando el szi creció (2ª
        // entrada llenó / gap): el SL viejo (1×) no cubre la posición real. Respeta anti-doble-SL:
        //  - si el SL viejo llenó → marcar filled (flat lo cerrará);
        //  - si sigue VIVO → cancelar y CONFIRMAR muerte el próximo ciclo (NO rotar todavía);
        //  - si está CONFIRMADO muerto → recolocar full-size (realSize) en ESTE mismo claim (sin ventana extra).
        if (arm.armMode === "reentry_coexist" && slOrder && realSize > slOrder.size * 1.02
            && (arm.status === "protected" || arm.status === "protecting")) {
          const slFillR = await fillsByCloid(info, user, slOrder.cloid);
          if (slFillR.size > 0) {
            await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "filled" });
            return { skipped: "sl_filled_during_resize" };
          }
          if (await openByCloid(info, user, slOrder.cloid)) {
            const renewRz = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
            if (!renewRz.ok) return { skipped: "lease_lost" };
            try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: slOrder.cloid as `0x${string}` }] }); } catch { /* el próximo ciclo reintenta */ }
            return { skipped: "sl_resize_cancel_sent" };   // confirmar muerte antes de rotar (anti-doble-SL)
          }
          // SL viejo CONFIRMADO muerto (no en book, sin fills): rotar + recolocar full-size YA.
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "canceled" });
          if ((arm.slAttempts ?? 0) >= SL_MAX_ATTEMPTS) return { skipped: "sl_resize_max_attempts" };
          const prepRz = await ctx.runMutation(internal.triggerArms.prepareSlAttempt, { armId, token, protectDeadlineMs: SL_PROTECT_DEADLINE_MS, size: floorToDecimals(realSize, szDecimals), triggerPx: desiredSlTrigger });
          if (!prepRz.ok) return { skipped: "sl_resize_prep_race" };
          const renewRz2 = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
          if (!renewRz2.ok) return { skipped: "lease_lost" };
          try {
            // (JAV-66) recolocar al trigger DESEADO: si el BE ya estaba activo, el SL redimensionado
            // se coloca en break-even (no vuelve a +1%).
            const slR = await placeStopLoss(exchange, assetId, szDecimals, "Short", realSize, posEntryPx, arm.stopLossPct, prepRz.cloid as `0x${string}`, desiredSlTrigger);
            if (slR.state === "resting") {
              await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "open", oid: slR.oid });
              await ctx.runMutation(internal.triggerArms.markArmSlSubmitted, { armId, token });
              return { result: "sl_resized_full" };
            }
            if (slR.state === "filled") {
              await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "sl_upper", observedStatus: "filled", oid: slR.oid });
              await ctx.runMutation(internal.triggerArms.markArmSlSubmitted, { armId, token });
              return { skipped: "sl_resized_fired" };
            }
            await ctx.runMutation(internal.triggerArms.markArmSlSubmitted, { armId, token });
            return { skipped: "sl_resized_pending" };
          } catch { return { skipped: "sl_resize_place_error" }; }
        }

        // (2.45) (JAV-66) BREAK-EVEN — ACTIVACIÓN. Al alcanzar `breakevenPct` de ganancia, marcar el
        // latch y DEGRADAR a `protecting`: la ROTACIÓN del SL la ejecuta el bloque (3) de abajo (ya
        // auditado: confirma por CLOID, recoloca al `desiredSlTrigger`=BE y escala a emergencia si no lo
        // logra a tiempo). Aplica a CUALQUIER arm (ambos bordes Short). Guard anti-auto-disparo SOLO
        // aquí: `beTrigger > markPx + 1 tick` (el SL inicial/resize NO lo llevan: deben poder devolver
        // `filled` si el trigger ya está cruzado). NO se cancela el SL viejo (+1%) aquí: sigue vivo hasta
        // que el bloque (3) lo confirme y rote. Si el CAS falla, el SL viejo protege; se reintenta.
        if (arm.status === "protected" && slOrder && !arm.beMoved
            && arm.breakevenPct != null && arm.breakevenPct > 0
            && markPx <= posEntryPx * (1 - arm.breakevenPct / 100)        // ganancia alcanzada
            && beTrigger > markPx + hlTickSize(markPx, szDecimals)) {     // guard: BE colocable (> mark+tick)
          const renewBe = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
          if (!renewBe.ok) return { skipped: "lease_lost" };
          const beAct = await ctx.runMutation(internal.triggerArms.activateBreakeven, { armId, token, protectDeadlineMs: SL_PROTECT_DEADLINE_MS });
          if (!beAct.ok) return { skipped: "be_activate_failed" };   // SL viejo intacto; reintenta
          return { result: "be_activated" };   // status→protecting; el bloque (3) rota al BE el próximo ciclo
        }

        // (2.5) TPs sobre el BÚFER (solo cuando ya hay SL → status protected). Cada TP es Take Profit
        // Market reduceOnly (BUY, tpsl:"tp", trigger ABAJO del entry = el short gana al caer). Σ tamaños
        // ≤ búfer → el pool nunca lo cierran los TPs (sigue bajo el SL full-size). Coloca/confirma con
        // el patrón del SL (confirmar-antes-de-rotar por TP). Una colocación por ciclo (acota el lease).
        if (arm.status === "protected") {
          const tps = arm.tps ?? [];
          const bufferPct = arm.bufferPct ?? 0;
          // (JAV-61 fix P1#4) NO retornar si no hay TP parciales: el TP-final debe colocarse igual.
          // El loop de parciales solo corre si hay TPs y búfer (bufferSize>0); si no, se va al TP-final.
          const bufferSize = (tps.length > 0 && bufferPct > 0) ? floorToDecimals((realSize * bufferPct) / (100 + bufferPct), szDecimals) : 0;
          for (let i = 0; bufferSize > 0 && i < tps.length; i++) {
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
          // (JAV-61) TP-final: SOLO si el short abrió por ARRIBA (reentry). BUY reduceOnly trigger en el
          // borde INFERIOR → cierra lo que QUEDE del short al llegar al fondo del rango. reduceOnly =
          // residual dinámico (lo ya cerrado por los parciales no se re-cierra). Al llenarse → flat →
          // armed_lower_only (entry_lower sigue armada). Confirmar-antes-de-rotar (grace anti-doble).
          // NOTA semántica: los parciales cierran fracción del BÚFER; el TP-final (reduceOnly, tamaño =
          // posición real) cierra el remanente real del short al llegar al borde inferior.
          if (arm.armMode === "reentry_coexist" && arm.filledEntryRole === "entry_upper") {
            // (JAV-61 fix P0#1) Si la pata INFERIOR también llenó (doble-fill / gap), el tp_final NO se
            // coloca: cerraría parte del short inferior. El SL full-size (redimensionado en 2.4) protege
            // ambos. Detectar por observed de entry_lower o por szi materialmente > UN short. Cancelar un
            // tp_final resting previo para que no dispare sobre el short inferior.
            const lowerOrd = await ctx.runQuery(internal.triggerArms.getArmOrderByRole, { armId, role: "entry_lower" });   // entry_lower explícito (CodeRabbit)
            const lowerFilled = lowerOrd?.observedStatus === "filled" || realSize > arm.size * 1.5;
            if (lowerFilled) {
              const tpfOld = await ctx.runQuery(internal.triggerArms.getArmOrderByRole, { armId, role: "tp_final" });
              if (tpfOld && (tpfOld.oid != null || tpfOld.observedStatus === "open")) {
                try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: tpfOld.cloid as `0x${string}` }] }); } catch { /* reintenta */ }
                await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "canceled" });
              }
              return { result: "tp_final_skipped_double_fill" };
            }
            // (JAV-61 fix P1#5) Σ closePct ≥ 100 → los parciales ya cierran todo el búfer configurado;
            // no se coloca TP-final (spec: TP-final % = 100 − Σ closePct).
            const sumClose = tps.reduce((s, t) => s + (t.closePct ?? 0), 0);
            const tpfTrigger = roundHlPrice(arm.lowerEdge, szDecimals, "floor");
            // (JAV-61 fix P0#1) Tamaño = UN short (arm.size), NO realSize: cierra solo lo atribuible al
            // short superior; reduceOnly acota a lo que reste tras los parciales.
            const tpfSize = floorToDecimals(arm.size, szDecimals);
            if (sumClose < 100 && tpfTrigger > 0 && tpfSize > 0) {
              const tpf = await ctx.runQuery(internal.triggerArms.getArmOrderByRole, { armId, role: "tp_final" });
              if (tpf && (tpf.observedStatus !== "pending" || tpf.submittedAt != null)) {
                const fs: any = await info.orderStatus({ user, oid: tpf.cloid as `0x${string}` });
                const fState = fs?.status === "order" ? fs.order?.status : undefined;
                const fOpen = await openByCloid(info, user, tpf.cloid);
                const fFill = await fillsByCloid(info, user, tpf.cloid);
                if (fState === "filled" || fFill.size > 0) { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "filled" }); return { skipped: "tp_final_fired_awaiting_flat" }; }
                if (fState === "open" || fOpen) { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "open", oid: tpf.oid }); return { result: "tp_final_resting" }; }
                if (fState === "triggered") { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "triggered" }); return { skipped: "tp_final_triggered" }; }
                if (tpf.submittedAt && Date.now() - tpf.submittedAt < SL_SUBMIT_GRACE_MS) return { skipped: "tp_final_grace" };
                await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "canceled" });
              }
              const renewF = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
              if (!renewF.ok) return { skipped: "lease_lost" };
              const prepF = await ctx.runMutation(internal.triggerArms.prepareTpFinalOrder, { armId, token, triggerPx: tpfTrigger, size: tpfSize });
              if (!prepF.ok) return { skipped: "tp_final_prep_race" };
              const tpfLimitPx = aggressiveHlPriceStr(tpfTrigger * (1 + ENTRY_TRIGGER_SLIPPAGE), szDecimals, true);  // BUY ceil
              const acF = abortAfter(HL_ORDER_TIMEOUT_MS);
              try {
                const respF: any = await exchange.order({
                  orders: [{ a: assetId, b: true, p: tpfLimitPx, s: String(tpfSize), r: true, t: { trigger: { isMarket: true, triggerPx: formatHlPrice(tpfTrigger, szDecimals), tpsl: "tp" } }, c: prepF.cloid as `0x${string}` }],
                  grouping: "na",
                }, { signal: acF.signal, expiresAfter: Date.now() + HL_ORDER_TIMEOUT_MS });
                const stF = respF?.response?.data?.statuses?.[0];
                if (stF?.resting?.oid != null) await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "open", oid: String(stF.resting.oid), markSubmitted: true });
                else if (stF?.filled?.oid != null) await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "filled", oid: String(stF.filled.oid), markSubmitted: true });
                else if (stF === "waitingForTrigger" || stF === "waitingForFill") await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "pending", markSubmitted: true });
                else if (stF?.error) await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "rejected" });
                else await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "pending", markSubmitted: true });
              } catch (e) {
                if (e instanceof TransportError) await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: "tp_final", observedStatus: "pending", markSubmitted: true });
              } finally { acF.clear(); }
              return { result: "tp_final_handled" };
            }
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
            // (JAV-66) Si el SL vivo está en un nivel DISTINTO al deseado (p. ej. el viejo +1% tras
            // activar el break-even), ROTARLO: cancelar (confirmar-antes-de-rotar) en vez de re-proteger
            // en el nivel viejo. `triggerPx > 0` excluye filas legacy (sin triggerPx persistido) → no
            // rotación espuria. La recolocación al `desiredSlTrigger` la hace el placement de abajo.
            if (slOrder.triggerPx > 0
                && Math.abs(slOrder.triggerPx - desiredSlTrigger) > desiredSlTrigger * SL_TRIGGER_MATCH_TOL) {
              const renewRot = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
              if (!renewRot.ok) return { skipped: "lease_lost" };
              try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: slOrder.cloid as `0x${string}` }] }); } catch { /* el próximo ciclo reintenta */ }
              return { skipped: "sl_stale_cancel_sent" };   // confirmar muerte antes de recolocar en BE
            }
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
        const prep = await ctx.runMutation(internal.triggerArms.prepareSlAttempt, { armId, token, protectDeadlineMs: SL_PROTECT_DEADLINE_MS, size: floorToDecimals(realSize, szDecimals), triggerPx: desiredSlTrigger });
        if (!prep.ok) return { skipped: "sl_prep_race" };
        const renew = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
        if (!renew.ok) return { skipped: "lease_lost" };
        try {
          // (JAV-66) desiredSlTrigger aquí es entry+stopLossPct% (beMoved es false en el SL inicial,
          // pre-protected) → idéntico al comportamiento previo; persiste el triggerPx para auditoría.
          const sl = await placeStopLoss(exchange, assetId, szDecimals, "Short", realSize, posEntryPx, arm.stopLossPct, prep.cloid as `0x${string}`, desiredSlTrigger);
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
      // (JAV-61) En armed_lower_only el short de ARRIBA ya se consumió (abrió y cerró por TP-final):
      // solo se vigila entry_lower (perforación). Excluir entry_upper para no releer su fill viejo
      // (que dispararía la rama de "llenado" sobre una entrada ya consumida).
      const relevantEntries = arm.status === "armed_lower_only"
        ? entryOrders.filter((o) => o.role === "entry_lower")
        : entryOrders;

      // (A) OCO: si CUALQUIER entrada llenó → filled + cancelar las hermanas (+ reducir reserva a 1×
      // si ninguna hermana llenó). El SL/cierre usan el tamaño REAL (szi) → doble-fill cubierto.
      for (const eo of relevantEntries) {
        const os: any = await info.orderStatus({ user, oid: eo.cloid as `0x${string}` });
        const oState = os?.status === "order" ? os.order?.status : undefined;
        const f = await fillsByCloid(info, user, eo.cloid);
        if (oState === "filled" || f.size > 0) {
          if (!(f.size > 0 && f.avgPx > 0)) return { skipped: "fill_data_pending" };
          await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "filled", oid: eo.oid });
          await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "filled", filledSize: f.size, entryPrice: f.avgPx });
          // (JAV-61) Registrar QUÉ entrada llenó: el tp_final solo se coloca si llenó entry_upper.
          await ctx.runMutation(internal.triggerArms.setArmFilledEntryRole, { armId, token, role: eo.role });
          // (JAV-61) En reentry_coexist NO se cancela la hermana: entry_lower debe seguir armada para la
          // perforación. En OCO sí se cancela. La REDUCCIÓN 2×→1× (solo OCO) se hace en la fase de
          // posición tras confirmar por CLOID que las hermanas murieron (no liberar margen con una viva).
          if (arm.armMode !== "reentry_coexist") {
            for (const other of entryOrders) {
              if (other._id === eo._id) continue;
              try { await exchange.cancelByCloid({ cancels: [{ asset: assetId, cloid: other.cloid as `0x${string}` }] }); } catch { /* cron */ }
            }
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
      // (JAV-61) En armed_lower_only solo se confirma entry_lower (relevantEntries).
      let anyAlive = false;
      for (const eo of relevantEntries) {
        const os: any = await info.orderStatus({ user, oid: eo.cloid as `0x${string}` });
        const oState = os?.status === "order" ? os.order?.status : undefined;
        if (oState === "open") { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "open", oid: eo.oid }); anyAlive = true; }
        else if (oState === "triggered") { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "triggered", oid: eo.oid }); anyAlive = true; }
        else if (await openByCloid(info, user, eo.cloid)) { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "open" }); anyAlive = true; }  // lag de unknownOid
        else { await ctx.runMutation(internal.triggerArms.setArmOrderObserved, { armId, token, role: eo.role, observedStatus: "canceled" }); }  // muerta (terminal/unknownOid sin book)
      }
      if (anyAlive) {
        // (JAV-61) armed_lower_only se MANTIENE (no transiciona a "armed": el short de arriba ya pasó).
        if (arm.status !== "armed" && arm.status !== "armed_lower_only") await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "armed" });
        // (Fix #2) Si quedó UNA sola entrada viva (la otra confirmada muerta), ya no hay doble-fill
        // posible → reducir reserva a 1×. (JAV-61) NO en reentry_coexist: las dos patas conviven (2×).
        if (arm.armMode !== "reentry_coexist" && arm.allowReentryFromAbove && !arm.reservationReduced && entryOrders.length > 1) {
          const fresh = (await ctx.runQuery(internal.triggerArms.getArmOrdersInternal, { armId }))
            .filter((o) => o.role === "entry_lower" || o.role === "entry_upper");
          const liveRoles = fresh.filter((o) => o.observedStatus === "open" || o.observedStatus === "triggered" || o.observedStatus === "pending");
          const deadCloids = fresh.filter((o) => !liveRoles.includes(o)).map((o) => o.cloid);
          if (liveRoles.length <= 1 && (await ensureOrdersDead(info, exchange, user, assetId, deadCloids))) {
            await ctx.runMutation(internal.triggerArms.reduceArmReservation, { armId, token, reservedNotional: arm.reservedNotional / 2, marginReserved: arm.marginReserved / 2 });
          }
        }
        return { result: arm.status === "armed_lower_only" ? "armed_lower_only" : "armed" };
      }
      // (JAV-61 fix P1#6) armed_lower_only sin entry_lower viva: el short de arriba ya completó su ciclo
      // (TP-final). NO es "prueba negativa" (hubo posición). Política: confirmar FLAT (sin posición) +
      // muerte sostenida (grace, anti-lectura-transitoria) → cerrar limpio y, si aplica, reprogramar una
      // generación nueva (esquema completo) para no dejar el bot activo sin cobertura.
      if (arm.status === "armed_lower_only") {
        const chN: any = await info.clearinghouseState({ user });
        const pN = (chN.assetPositions ?? []).find((x: any) => x.position?.coin === arm.asset.toUpperCase());
        if (pN && Math.abs(Number(pN.position?.szi ?? 0)) > 0) {
          return { skipped: "armed_lower_only_position_live" };   // hay posición → el fill se detectará; no cerrar
        }
        if (arm.closeConfirmSince == null) {
          await ctx.runMutation(internal.triggerArms.setArmCloseConfirm, { armId, token, value: Date.now() });
          return { skipped: "armed_lower_only_dead_first" };
        }
        if (Date.now() - arm.closeConfirmSince < CLOSE_CONFIRM_GRACE_MS) return { skipped: "armed_lower_only_dead_grace" };
        const renewE = await ctx.runMutation(internal.triggerArms.renewArmReconcile, { armId, token });
        if (!renewE.ok) return { skipped: "lease_lost" };
        // (JAV-61 fix P1#4) Solo cerrar con PRUEBA NEGATIVA completa: si ensureOrdersDead no confirma
        // que entry_lower murió (orden viva en book o cancel incierto), reintentar — no cerrar huérfano.
        if (!(await ensureOrdersDead(info, exchange, user, assetId, entryCloids))) {
          return { skipped: "armed_lower_only_cancel_pending" };
        }
        // (JAV-96) entry_lower confirmada muerta → marcar canceled antes de cerrar (sin `open` rancio).
        await ctx.runMutation(internal.triggerArms.markArmOrdersCanceled, { armId, token, cloids: entryCloids });
        const ce = await ctx.runMutation(internal.triggerArms.closeArmLowerOnlyExpired, { armId, token });
        return { result: ce.ok ? (ce.rearmScheduled ? "armed_lower_only_closed_rearm" : "armed_lower_only_closed") : "armed_lower_only_close_failed" };
      }
      // Ninguna entrada viva ni llena → prueba negativa → failed (cuarentena N6 lo retiene si toca).
      const rF = await ctx.runMutation(internal.triggerArms.settleArm, { armId, token, status: "failed", error: "entradas muertas (prueba negativa)" });
      return { result: rF.ok ? "failed_negative_proof" : "failed_quarantined" };
    } finally {
      await ctx.runMutation(internal.triggerArms.releaseArmReconcile, { armId, token });
    }
  },
});

// Cron: auto-rearm DURABLE (JAV-44). Procesa los bots con rearm pendiente/blocked/recuperable. Reclama
// con lease, intenta reabrir la cobertura (armBotInternal) y aplica la política de errores de Codex:
// transitorio → reintento forzado cada 5 min (nunca abandona); pausa/kill/pool cerrado → cancela;
// margen/config → blocked reevaluable; posición/órdenes incompatibles → reintento.
export const processRearms = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const ids = await ctx.runQuery(internal.triggerRearm.listRearmReadyBots, { limit: 25 });
    let rearmed = 0;
    for (const botId of ids) {
      const claim = await ctx.runMutation(internal.triggerRearm.claimRearm, { botId });
      if (!claim.ok) continue;
      try {
        // (Codex #2/#3) Pasa el lease token: reserveArm CONSUME el rearm al crear la generación. Tras
        // eso, recordRearmOutcome es no-op (el token ya no coincide) → idempotente: no re-registra ni
        // reintenta un arm ya creado; el cron de arms se encarga aunque la action muera después.
        const r: any = await ctx.runAction(internal.triggerEngine.armBotInternal, { botId, userId: claim.userId, rearmToken: claim.token });
        if (r?.ok) {
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, { botId, token: claim.token, outcome: "success" });
          rearmed++;
        } else {
          // gated/aborted/rejected: un gate ATÓMICO o timing impidió colocar → reintento transitorio.
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, {
            botId, token: claim.token, outcome: "transient", kind: "transient",
            error: `arm no colocado (${r?.status ?? "desconocido"})`, nextRearmAt: Date.now() + REARM_RETRY_MS,
          });
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const kind = armErrorKind(msg);
        if (kind === "cancel") {
          // pausa/kill/pool cerrado → el bot no debe operar: cancelar definitivamente el rearm.
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, { botId, token: claim.token, outcome: "cancel", error: msg });
        } else if (kind === "blocked_margin" || kind === "blocked_config") {
          // bloqueo corregible (margen/config/credencial): blocked, reevaluable + alerta visible.
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, {
            botId, token: claim.token, outcome: "blocked", kind, error: msg, nextRearmAt: Date.now() + REARM_BLOCKED_RECHECK_MS,
          });
        } else {
          // transient | retry_incompatible → reintento FORZADO cada 5 min (nunca desprotegido por error).
          await ctx.runMutation(internal.triggerRearm.recordRearmOutcome, {
            botId, token: claim.token, outcome: "transient", kind, error: msg, nextRearmAt: Date.now() + REARM_RETRY_MS,
          });
        }
      }
    }
    // (Codex #6) Reintento DURABLE de alertas de stop: buscar EXPLÍCITAMENTE los bots con
    // consecutiveStops − lastStopAlertLevel ≥ THRESHOLD (una alerta fallida en Resend se reintenta aquí
    // cada ciclo, sin esperar al siguiente SL). sendStopAlert revalida y solo sube el nivel si Resend OK.
    const alertIds = await ctx.runQuery(internal.triggerRearm.listStopAlertPendingBots, { limit: 25 });
    for (const botId of alertIds) {
      await ctx.scheduler.runAfter(0, internal.triggerEngine.sendStopAlert, { botId });
    }
    return { processed: ids.length, rearmed, alertsTriggered: alertIds.length };
  },
});

// Email de alerta de whipsaw (5 SL consecutivos). Resend vía HTTP. Sin RESEND_API_KEY → registra y no
// rompe (el auto-rearm no depende de esto). El bot SIGUE operando; es solo aviso al usuario.
export const sendStopAlert = internalAction({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }): Promise<any> => {
    const d = await ctx.runQuery(internal.triggerRearm.getStopAlertContext, { botId });
    if (!d) return { sent: false, reason: "no_context" };
    // (Codex #5) Alertar el SIGUIENTE múltiplo pendiente (lastStopAlertLevel + THRESHOLD), no el
    // contador actual: si saltó de 0 a 12, alerta 5 y luego 10 sin saltarse niveles.
    const pendingLevel = (d.lastStopAlertLevel ?? 0) + STOP_ALERT_THRESHOLD;
    if (d.consecutiveStops < pendingLevel) return { sent: false, reason: "nothing_pending" };
    if (!d.email) return { sent: false, reason: "no_email" };
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM ?? "Quantum.ia <onboarding@resend.dev>";
    if (!apiKey) {
      console.warn(`[stop-alert] RESEND_API_KEY no configurada; no enviado (bot ${botId}, nivel ${pendingLevel})`);
      return { sent: false, reason: "no_api_key" };
    }
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        // (CodeRabbit) Timeout: sin él, un fetch colgado mantiene viva la action y, como el cron la
        // reencola cada minuto mientras el nivel siga pendiente, apilaría duplicados y quemaría scheduler.
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json",
          // (Codex #4) Dedup estable por (botId, nivel): aunque dos actions coincidan, Resend manda 1 email.
          "Idempotency-Key": `stop-alert-${botId}-${pendingLevel}`,
        },
        body: JSON.stringify({
          from, to: [d.email],
          subject: `⚠️ ${pendingLevel} stops seguidos en ${d.pair}`,
          text:
            `Tu bot de cobertura "${d.botName}" en ${d.pair} (${d.network}) ha cerrado por Stop Loss ` +
            `${pendingLevel} veces consecutivas.\n\n` +
            `Esto suele indicar que el precio oscila en el borde del rango (whipsaw). El bot sigue ` +
            `operando y reabriendo la cobertura automáticamente; revisa si conviene ajustar el rango, ` +
            `el stop o pausar la cobertura.\n\n— Quantum.ia`,
        }),
      });
      if (!resp.ok) {
        console.error(`[stop-alert] Resend respondió ${resp.status}`);
        return { sent: false, reason: `http_${resp.status}` };   // no sube el nivel → el cron reintenta
      }
      // (Codex #7) Subir el nivel SOLO tras respuesta OK de Resend, al nivel-múltiplo alertado.
      await ctx.runMutation(internal.triggerRearm.markStopAlertSent, { botId, level: pendingLevel });
      return { sent: true };
    } catch (e) {
      console.error("[stop-alert] error enviando", e);
      return { sent: false, reason: "exception" };
    }
  },
});
