// (JAV-179 / Bot Trading PR3) Núcleo PURO de decisión del reconcile del motor de trading.
// SIN dependencias de dominio ni "use node" (testeable directo — cierre de JAV-176-P8): el engine
// (tradingEngine.ts) es la cáscara I/O que lee HL y ejecuta lo que estas funciones DECIDEN. Toda
// carrera money-path (hermana tardía P1, topología stale V2-P1, closeReason, trailing, backoff del
// rearm) tiene su decisión aquí, ejercitada por tests con la SECUENCIA real.

import type { TradingDirection, TradingSide, EntryTopology } from "./tradingMath";
import { splitFilledSide } from "./tradingMath";

// --- Tick de precio HL (perps) ---------------------------------------------------------------------
// Espejo EXACTO de hlAllowedDecimals/roundHlPrice de hyperliquid.ts (5 cifras significativas y
// ≤ 6−szDecimals decimales). Duplicado a propósito: este módulo debe quedar libre de dependencias y
// hyperliquid.ts es "use node". NO divergir: un tick distinto desalinearía clamp/histéresis del SL.
export function hlPriceTick(price: number, szDecimals: number): number {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const intDigits = Math.floor(Math.log10(price)) + 1;
  const sigDecimals = 5 - intDigits;   // sin clamp a 0: permite tick > 1 en precios de ≥6 dígitos
  return 10 ** -Math.min(maxDecimals, sigDecimals);
}

// --- Fills de entrada: neteo con SIGNO (JAV-176-P1) --------------------------------------------------
// long_short: la pata superior es BUY (+) y la inferior SELL (−) → el neto puede INVERTIR el lado con
// un fill parcial + hermana completa. Modos solo: ambas patas del MISMO lado → suman. El LADO del SL
// SIEMPRE se deriva del signo del neto releído, jamás del filledSide previo.
export type EntryFill = { size: number; avgPx: number };
export type NetEntryFills =
  | { kind: "none" }
  | { kind: "single"; role: "entry_upper" | "entry_lower" | "entry_market"; side: TradingSide; size: number; entryPx: number }
  | { kind: "both"; netSide: TradingSide | null; netSize: number; grossSize: number; entryPx: number };

export function netEntryFills(
  direction: TradingDirection,
  fills: { upper?: EntryFill; lower?: EntryFill; market?: EntryFill },
): NetEntryFills {
  const u = fills.upper && fills.upper.size > 0 ? fills.upper : undefined;
  const l = fills.lower && fills.lower.size > 0 ? fills.lower : undefined;
  const m = fills.market && fills.market.size > 0 ? fills.market : undefined;
  if (m) {
    // entry_market es pata única (sin hermana): el lado viene del arm (filledSide/topología).
    const side = direction === "long" ? "Long" : direction === "short" ? "Short" : null;
    return { kind: "single", role: "entry_market", side: side ?? "Long", size: m.size, entryPx: m.avgPx };
  }
  if (u && l) {
    if (direction === "long" || direction === "short") {
      // Mismo lado: la exposición es la SUMA (2× del intent) — entry ponderado por tamaño.
      const grossSize = u.size + l.size;
      const entryPx = (u.size * u.avgPx + l.size * l.avgPx) / grossSize;
      return { kind: "both", netSide: direction === "long" ? "Long" : "Short", netSize: grossSize, grossSize, entryPx };
    }
    // long_short: BUY(upper) − SELL(lower), neteo con signo.
    const net = u.size - l.size;
    const grossSize = u.size + l.size;
    const netSide = net > 0 ? "Long" as const : net < 0 ? "Short" as const : null;
    const entryPx = netSide === "Long" ? u.avgPx : netSide === "Short" ? l.avgPx : 0;
    return { kind: "both", netSide, netSize: Math.abs(net), grossSize, entryPx };
  }
  if (u) return { kind: "single", role: "entry_upper", side: splitFilledSide(direction, "entry_upper"), size: u.size, entryPx: u.avgPx };
  if (l) return { kind: "single", role: "entry_lower", side: splitFilledSide(direction, "entry_lower"), size: l.size, entryPx: l.avgPx };
  return { kind: "none" };
}

// --- Rutina 3b: resolución oco_race con AMBAS entradas llenas (P1) -----------------------------------
// Invariante: NUNCA posición viva con SL menor que el realSize. flatEps = umbral de dust del caller.
export type OcoRaceResolution =
  | { action: "close_flat_oco_race" }                                        // neto ≈ 0 ⇒ cancelar propias y cerrar oco_race
  | { action: "protect_and_close_total"; side: TradingSide; size: number };  // residuo/2× ⇒ SL al total + IOC total ⇒ oco_race

export function resolveOcoRaceResolution(net: NetEntryFills, flatEps: number): OcoRaceResolution {
  if (net.kind !== "both") {
    throw new Error("tradingReconcileCore: resolveOcoRaceResolution requiere ambas entradas con fill.");
  }
  if (net.netSide === null || net.netSize <= flatEps) return { action: "close_flat_oco_race" };
  return { action: "protect_and_close_total", side: net.netSide, size: net.netSize };
}

// --- Revalidación FRESCA pre-RPC (JAV-176-V2-P1) -----------------------------------------------------
// La topología reservada (OCO o market:side) debe COINCIDIR con la recomputada sobre el mark fresco
// justo antes del RPC; mismatch o fallo de relectura ⇒ abortar pre-orden SIN HL y reconstruir.
export type ReservedTopology = { kind: "oco" } | { kind: "market"; side: TradingSide };

export function revalidateTopology(
  reserved: ReservedTopology,
  fresh: EntryTopology | null,   // null = la relectura del mark FALLÓ
): { ok: true } | { ok: false; error: string } {
  if (fresh === null) {
    return { ok: false, error: "[transient] mark fresco no disponible antes del envío (reintento con topología fresca)." };
  }
  if (reserved.kind === "oco" && fresh.kind === "oco") return { ok: true };
  if (reserved.kind === "market" && fresh.kind === "market" && fresh.side === reserved.side) return { ok: true };
  const desc = reserved.kind === "oco"
    ? `el mark salió del rango (ahora market ${fresh.kind === "market" ? fresh.side : "?"})`
    : fresh.kind === "oco"
      ? "el mark volvió DENTRO del rango (ahora corresponde OCO)"
      : `el lado del breakout cambió (${(reserved as any).side} → ${(fresh as any).side})`;
  return { ok: false, error: `[transient] topología stale antes del envío: ${desc} — reconstrucción con mark fresco.` };
}

// --- Entrada IOC a mercado (decisión 6): clasificación del resultado ---------------------------------
// ESPEJO COMPLETO del patrón de las ejecuciones, incluida la incertidumbre: resultado incierto ⇒
// `unknown` (JAMÁS failed el mismo tick — una IOC abortada que en realidad llenó dejaría posición
// viva sin SL); rechazo determinista ⇒ candidato a failed SOLO tras prueba negativa con grace + veto
// szi≠0 (la resuelve el reconcile). Fill parcial ⇒ filled con el filledSize REAL.
export type IocOutcome =
  | { kind: "filled"; size: number; avgPx: number }
  | { kind: "rejected"; error: string }
  | { kind: "unknown" };

export function classifyEntryIocStatus(st: any, transportUncertain: boolean): IocOutcome {
  if (transportUncertain) return { kind: "unknown" };
  if (st?.filled?.oid != null) {
    const size = Number(st.filled.totalSz), avgPx = Number(st.filled.avgPx);
    if (size > 0 && avgPx > 0) return { kind: "filled", size, avgPx };
    return { kind: "unknown" };   // filled sin datos coherentes = ambiguo
  }
  if (st?.error) return { kind: "rejected", error: String(st.error) };
  // resting/waitingForTrigger no aplican a una IOC (muere en el tick), y cualquier otra forma es
  // ambigua: unknown (el reconcile resuelve por cloid + fills + grace + veto szi≠0).
  return { kind: "unknown" };
}

// --- closeReason con PRIORIDAD (plan PR3 paso 6) -----------------------------------------------------
// emergencia > oco_race (ambas entradas con fill) > disarm (wantDisarm activo) > sl (incl. rotación
// slPendingCloid) > tp (ΣTP ≈ 100%) > manual.
export function pickCloseReason(flags: {
  emergencyClosing?: "emergency" | "disarm";
  bothEntriesFilled: boolean;
  wantDisarm: boolean;
  slConfirmed: boolean;
  tpClosedAll: boolean;
}): "emergency" | "oco_race" | "disarm" | "sl" | "tp" | "manual" {
  if (flags.emergencyClosing === "emergency") return "emergency";
  if (flags.bothEntriesFilled) return "oco_race";
  if (flags.emergencyClosing === "disarm" || flags.wantDisarm) return "disarm";
  if (flags.slConfirmed) return "sl";
  if (flags.tpClosedAll) return "tp";
  return "manual";
}

// --- BE latch (plan PR3 paso 8): ganancia ≥ breakevenPct Ó TP1 filled --------------------------------
export function beLatchReached(params: {
  side: TradingSide; entryPx: number; markPx: number; breakevenPct?: number; tp1Filled: boolean;
}): boolean {
  const { side, entryPx, markPx, breakevenPct, tp1Filled } = params;
  if (tp1Filled) return true;
  if (breakevenPct == null || breakevenPct <= 0 || !(entryPx > 0)) return false;
  const profitFrac = side === "Long" ? (markPx - entryPx) / entryPx : (entryPx - markPx) / entryPx;
  return profitFrac >= breakevenPct / 100;
}

// --- Trailing: decisión de REPLACE del SL (plan PR3 paso 9) ------------------------------------------
// Anti-spam: rotar SOLO si el deseado mejora al actual en ≥ max(2 ticks, 0.1% del precio) Y pasaron
// ≥60s desde el último replace (máx 1 rotación/tick del cron). "Mejora" es DIRECCIONAL: Long sube,
// Short baja — el ratchet de computeDesiredSlTrigger ya garantiza que desired nunca retrocede.
export const SL_REPLACE_MIN_INTERVAL_MS = 60_000;

export function decideSlReplacement(params: {
  side: TradingSide; desiredPx: number; currentSlPx: number | undefined;
  tickSize: number; lastSlReplaceAt?: number; now: number;
}): { replace: boolean; reason: string } {
  const { side, desiredPx, currentSlPx, tickSize, lastSlReplaceAt, now } = params;
  if (currentSlPx === undefined) return { replace: true, reason: "sin SL vivo" };
  const improvement = side === "Long" ? desiredPx - currentSlPx : currentSlPx - desiredPx;
  const threshold = Math.max(2 * tickSize, desiredPx * 0.001);
  if (improvement < threshold) return { replace: false, reason: "mejora < umbral" };
  if (lastSlReplaceAt != null && now - lastSlReplaceAt < SL_REPLACE_MIN_INTERVAL_MS) {
    return { replace: false, reason: "histéresis 60s" };
  }
  return { replace: true, reason: "ratchet avanza" };
}

// --- Lado REAL de la posición: el SIGNO del szi manda (P1) -------------------------------------------
// Un neteo por fill tardío puede INVERTIR el lado: el SL jamás se deriva del filledSide previo.
export function positionSideFromSzi(szi: number): TradingSide {
  return szi >= 0 ? "Long" : "Short";
}

// --- Resolución de la HERMANA post-cancelación (P1: el ORDEN es el invariante) -----------------------
// La reducción 2×→1× SOLO procede con la hermana CONFIRMADA muerta Y la relectura de sus fills
// NEGATIVA. Cualquier fill tardío detectado en esa relectura ⇒ rutina 3b (oco_race), jamás reducir.
export function decideSisterOutcome(input: { sisterDead: boolean; sisterFillSize: number }):
  "wait" | "reduce" | "oco_race" {
  if (!input.sisterDead) return "wait";                 // cancel aún no confirmado ⇒ ni reducir ni clasificar
  if (input.sisterFillSize > 0) return "oco_race";      // fill tardío ⇒ ambas llenas ⇒ 3b
  return "reduce";                                      // muerta + relectura negativa ⇒ reducción segura
}

// --- Muerte de entradas sin fill (pre-fill): prueba negativa con GRACE y VETO por szi ----------------
// failed SOLO con: nada vivo/llenándose, grace vencido, posición FLAT (veto szi≠0 — jamás liberar la
// reserva con posición nuestra viva), órdenes confirmadas muertas y relectura de fills NEGATIVA.
export function decideDeadEntriesOutcome(input: {
  anyLiveOrFilling: boolean; graceElapsed: boolean; sziFlat: boolean; allDead: boolean;
  refilledNetKind: "none" | "single" | "both";
}): "wait" | "veto_position" | "fill" | "fail" {
  if (input.anyLiveOrFilling) return "wait";
  if (!input.graceElapsed) return "wait";
  if (!input.sziFlat) return "veto_position";
  if (!input.allDead) return "wait";
  if (input.refilledNetKind !== "none") return "fill";
  return "fail";
}

// --- Política de backoff del rearm (plan PR3; JAV-176-P6) --------------------------------------------
// blocked_margin (margen HL no liberado — la preocupación de Javier) ⇒ ACELERADO 90s×3 → 5 min
// indefinido. blocked_cap (tope de plan) y blocked_config ⇒ 5 min SIN aceleración. transient/
// retry_incompatible ⇒ 5 min. `attempts` = reintentos YA registrados antes de este fallo.
export const TR_REARM_ACCEL_MS = 90_000;
export const TR_REARM_NORMAL_MS = 5 * 60_000;

export function tradingRearmDelayMs(
  kind: "transient" | "blocked_margin" | "blocked_cap" | "blocked_config" | "retry_incompatible",
  attempts: number,
): number {
  if (kind === "blocked_margin") return attempts < 3 ? TR_REARM_ACCEL_MS : TR_REARM_NORMAL_MS;
  return TR_REARM_NORMAL_MS;
}
