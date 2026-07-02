// (JAV-177 / Bot Trading PR1) Matemática PURA del motor de trading breakout sobre rango LP.
// SIN dependencias de dominio (no _generated, no SDK, no "use node"): la importan el engine node
// (PR3) y las mutations non-node (PR2), y vitest la testea directo (patrón spotGridEngine).
// Fuente ÚNICA de: triggers de entrada, mapeo OCO por dirección, decisión de topología (bifurcación
// inicial Y revalidación fresca pre-RPC — JAV-176-V2-P1), ratchet del SL (BE + trailing), niveles de
// TP y clasificación de la lectura estricta del nocional LP.

export type TradingDirection = "long_short" | "long" | "short";
export type TradingSide = "Long" | "Short";
export type TradingEntryRole = "entry_upper" | "entry_lower" | "entry_market";

// --- Constantes CERRADAS (plan JAV-176, P7) ---
// Banda agresiva del limitPx de las entradas trigger Y término de slippage del rango mínimo.
// MISMO valor que las module-local de triggerEngine.ts/spotDefenseEngine.ts (no se tocan en esta
// fase). ENTRY_IOC_SLIPPAGE de hyperliquid.ts es OTRA constante (camino market-entry).
export const ENTRY_TRIGGER_SLIPPAGE = 0.02;
// Factor del rango mínimo: el ancho del rango debe cubrir al menos k×(SL + slippage) — mitiga el
// double-fill OCO por whipsaw en rangos angostos.
export const RANGE_MIN_K = 2;
// Offset del break-even: el SL se mueve al lado en-ganancia de la entrada (~0.05%), espejo del
// BE_OFFSET_FRACTION del bot de defensa spot (spotDefenseEngine.ts).
export const BE_OFFSET_FRACTION = 0.0005;

function assertFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`tradingMath: ${name} debe ser un número finito (recibido ${value}).`);
  }
}

// --- Triggers de entrada -------------------------------------------------------------------------
// Pre-trigger como % del ANCHO del rango (0% = bordes exactos): desplaza AMBOS triggers hacia
// DENTRO para disparar antes de tocar el borde. Devuelve precios crudos; la normalización al tick
// (redondeo direccional) es del caller (engine, con szDecimals reales).
export function computeEntryTriggers(
  lowerEdge: number, upperEdge: number, preTriggerPct: number,
): { lowerTriggerPx: number; upperTriggerPx: number } {
  assertFinite("lowerEdge", lowerEdge);
  assertFinite("upperEdge", upperEdge);
  assertFinite("preTriggerPct", preTriggerPct);
  if (lowerEdge <= 0 || upperEdge <= 0 || upperEdge <= lowerEdge) {
    throw new Error(`tradingMath: rango inválido (lowerEdge=${lowerEdge}, upperEdge=${upperEdge}).`);
  }
  if (preTriggerPct < 0) {
    throw new Error(`tradingMath: preTriggerPct debe ser ≥ 0 (recibido ${preTriggerPct}).`);
  }
  // Cota matemática dura: con ≥ 50% del ancho por lado los triggers se cruzan/colapsan y el par
  // pierde sentido (la config de producto se capa a ≤10 en bots.ts — PR2 —, pero la función pura
  // falla cerrada por sí misma: una config degenerada JAMÁS produce un par invertido silencioso).
  if (preTriggerPct >= 50) {
    throw new Error(`tradingMath: preTriggerPct debe ser < 50 — con ${preTriggerPct}% el pre-trigger colapsa o invierte el rango.`);
  }
  const width = upperEdge - lowerEdge;
  const inset = (preTriggerPct / 100) * width;
  return { lowerTriggerPx: lowerEdge + inset, upperTriggerPx: upperEdge - inset };
}

// Separación mínima entre triggers tras el redondeo direccional: < 1 tick = pre-trigger que
// colapsó/invirtió el rango ⇒ [blocked_config] en la reserva (PR2).
export function triggerSeparationOk(lowerTriggerPx: number, upperTriggerPx: number, tickSize: number): boolean {
  assertFinite("lowerTriggerPx", lowerTriggerPx);
  assertFinite("upperTriggerPx", upperTriggerPx);
  assertFinite("tickSize", tickSize);
  if (tickSize <= 0) throw new Error(`tradingMath: tickSize debe ser > 0 (recibido ${tickSize}).`);
  return upperTriggerPx - lowerTriggerPx >= tickSize - 1e-12;
}

// Rango mínimo (P7, unidades: % del mark, sobre triggers YA normalizados):
//   rangeWidthPct ≥ RANGE_MIN_K × (stopLossPct + ENTRY_TRIGGER_SLIPPAGE×100)
// Un rango invertido/colapsado (width ≤ 0) NUNCA pasa.
export function rangeWidthOk(
  lowerTriggerPx: number, upperTriggerPx: number, mark: number, stopLossPct: number,
): boolean {
  assertFinite("lowerTriggerPx", lowerTriggerPx);
  assertFinite("upperTriggerPx", upperTriggerPx);
  assertFinite("mark", mark);
  assertFinite("stopLossPct", stopLossPct);
  if (mark <= 0 || stopLossPct <= 0) return false;
  const widthPct = ((upperTriggerPx - lowerTriggerPx) / mark) * 100;
  return widthPct >= RANGE_MIN_K * (stopLossPct + ENTRY_TRIGGER_SLIPPAGE * 100);
}

// --- Mapeo OCO por dirección (verificado on-chain, docs/analisis-bot-trading-avaro-hl.md) --------
// long_short: buy-stop arriba + sell-stop abajo (ambas tpsl:"sl" = stop de ruptura).
// long: ruptura BUY arriba (tpsl:"sl") + reversión BUY abajo (tpsl:"tp" — dispara al CAER al borde).
// short: ruptura SELL abajo (tpsl:"sl") + reversión SELL arriba (tpsl:"tp" — dispara al SUBIR).
export type EntryOrderSpec = { role: "entry_upper" | "entry_lower"; isBuy: boolean; tpsl: "sl" | "tp" };

export function entryOrderSpecs(direction: TradingDirection): EntryOrderSpec[] {
  switch (direction) {
    case "long_short":
      return [
        { role: "entry_upper", isBuy: true, tpsl: "sl" },
        { role: "entry_lower", isBuy: false, tpsl: "sl" },
      ];
    case "long":
      return [
        { role: "entry_upper", isBuy: true, tpsl: "sl" },
        { role: "entry_lower", isBuy: true, tpsl: "tp" },
      ];
    case "short":
      return [
        { role: "entry_lower", isBuy: false, tpsl: "sl" },
        { role: "entry_upper", isBuy: false, tpsl: "tp" },
      ];
  }
}

// Lado de la posición según qué entrada llenó. entry_market lleva el lado decidido por la topología.
export function splitFilledSide(direction: TradingDirection, role: TradingEntryRole): TradingSide {
  if (direction === "long") return "Long";
  if (direction === "short") return "Short";
  // long_short: el lado lo define el borde. entry_market no es válido aquí sin lado explícito:
  // la topología (resolveEntryTopology) ya lo resolvió y viaja en el arm (filledSide).
  if (role === "entry_upper") return "Long";
  if (role === "entry_lower") return "Short";
  throw new Error("tradingMath: splitFilledSide(long_short, entry_market) requiere el lado de la topología (filledSide del arm).");
}

// --- Decisión de topología (decisión 6 + JAV-176-V2-P1) ------------------------------------------
// Fuente ÚNICA de la bifurcación OCO-vs-mercado: la usan la bifurcación inicial de armTradingInternal
// Y la revalidación fresca pre-RPC (mismatch ⇒ aborto pre-orden sin HL). Bordes EXACTOS cuentan como
// FUERA: un trigger en el mark nacería disparado.
export type EntryTopology = { kind: "oco" } | { kind: "market"; side: TradingSide };

export function resolveEntryTopology(
  mark: number, lowerTriggerPx: number, upperTriggerPx: number, direction: TradingDirection,
): EntryTopology {
  assertFinite("mark", mark);
  assertFinite("lowerTriggerPx", lowerTriggerPx);
  assertFinite("upperTriggerPx", upperTriggerPx);
  // Par degenerado/invertido: NUNCA elegir topología (el "dentro" sería insatisfacible y todo mark
  // caería a market con lado arbitrario — dinero real bajo config inválida). El caller lo mapea a
  // [blocked_config], igual que las validaciones de rango de la reserva.
  if (!(lowerTriggerPx < upperTriggerPx)) {
    throw new Error(`tradingMath: par de triggers degenerado/invertido (lower=${lowerTriggerPx}, upper=${upperTriggerPx}) — sin topología válida.`);
  }
  if (mark > lowerTriggerPx && mark < upperTriggerPx) return { kind: "oco" };
  if (direction === "long") return { kind: "market", side: "Long" };
  if (direction === "short") return { kind: "market", side: "Short" };
  // long_short: el lado lo define el borde superado (abajo = la ruptura short ya corrió; arriba = long).
  return { kind: "market", side: mark <= lowerTriggerPx ? "Short" : "Long" };
}

// --- Trailing: anchor DIRECCIONAL (JAV-176-P4) ----------------------------------------------------
// Long: el anchor favorable SUBE (max); Short: BAJA (min). El caller pasa `oldAnchor = persistido ??
// entry` (seed = entry; la coalescencia vive en el caller). Pura y total: un rebote adverso devuelve
// el anchor viejo intacto (jamás retrocede el avance).
export function nextTrailAnchor(side: TradingSide, oldAnchor: number, mark: number): number {
  assertFinite("oldAnchor", oldAnchor);
  assertFinite("mark", mark);
  return side === "Long" ? Math.max(oldAnchor, mark) : Math.min(oldAnchor, mark);
}

// --- Ratchet del SL (fuente única: SL base + BE latch + trailing + SL actual) ---------------------
// Long: desired = max(entry·(1−slPct), beMoved ? entry·(1+off) : −∞, trailing ? anchor·(1−trailPct) : −∞)
// clampeado a ≥1 tick del mark (anti-auto-disparo) y NUNCA por debajo del SL actual (monótono).
// Short: espejo con min / anchor·(1+trailPct) / clamp por encima del mark / nunca por encima del actual.
// El caller decide el replace con su histéresis (≥2 ticks/0.1% y ≥60s) comparando contra el actual.
export function computeDesiredSlTrigger(params: {
  side: TradingSide;
  entryPx: number;
  stopLossPct: number;
  beMoved: boolean;
  trailingEnabled: boolean;
  trailAnchorPx?: number;
  trailingPct?: number;
  currentSlPx?: number;
  markPx: number;
  tickSize: number;
}): number {
  const { side, entryPx, stopLossPct, beMoved, trailingEnabled, trailAnchorPx, trailingPct, currentSlPx, markPx, tickSize } = params;
  assertFinite("entryPx", entryPx);
  assertFinite("stopLossPct", stopLossPct);
  assertFinite("markPx", markPx);
  assertFinite("tickSize", tickSize);
  if (entryPx <= 0 || stopLossPct <= 0 || markPx <= 0 || tickSize <= 0) {
    throw new Error("tradingMath: computeDesiredSlTrigger requiere entryPx/stopLossPct/markPx/tickSize > 0.");
  }
  if (trailingEnabled) {
    assertFinite("trailAnchorPx", trailAnchorPx as number);
    assertFinite("trailingPct", trailingPct as number);
  }
  if (currentSlPx !== undefined) assertFinite("currentSlPx", currentSlPx);

  if (side === "Long") {
    let desired = entryPx * (1 - stopLossPct / 100);
    if (beMoved) desired = Math.max(desired, entryPx * (1 + BE_OFFSET_FRACTION));
    if (trailingEnabled) desired = Math.max(desired, (trailAnchorPx as number) * (1 - (trailingPct as number) / 100));
    desired = Math.min(desired, markPx - tickSize);          // clamp: jamás nace disparado
    if (currentSlPx !== undefined) desired = Math.max(desired, currentSlPx);   // monótono
    return desired;
  }
  let desired = entryPx * (1 + stopLossPct / 100);
  if (beMoved) desired = Math.min(desired, entryPx * (1 - BE_OFFSET_FRACTION));
  if (trailingEnabled) desired = Math.min(desired, (trailAnchorPx as number) * (1 + (trailingPct as number) / 100));
  desired = Math.max(desired, markPx + tickSize);
  if (currentSlPx !== undefined) desired = Math.min(desired, currentSlPx);
  return desired;
}

// --- Niveles de TP --------------------------------------------------------------------------------
// TP parciales reduce-only sobre el filledSize REAL. Precio: Long entry·(1+gain), Short entry·(1−gain).
// El reparto de sizes se hace en TICKS ENTEROS (unidades de szDecimals): la aritmética del residuo es
// EXACTA (nada de re-floorear floats acumulados) y el ÚLTIMO TP absorbe el residuo, de modo que
// Σ sizes == totalTicks SIEMPRE (con Σ closePct = 100 ⇒ Σ == filledSize, tick a tick) y ningún TP
// reduce-only puede quedar dimensionado por ENCIMA de la posición restante.
export type TpLevel = { tpIndex: number; triggerPx: number; size: number };

// Espejo EXACTO del floorToDecimals fail-closed de hyperliquid.ts:48-51 ("trunca hacia abajo — nunca
// por encima del nocional reservado"). Duplicado a propósito: tradingMath debe quedar libre de
// dependencias y hyperliquid.ts es "use node". NO añadir epsilon: divergir del canónico produciría
// sizes 1 tick más grandes que los del engine.
export function floorToDecimals(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f) / f;
}

export function tpLevels(params: {
  side: TradingSide;
  entryPx: number;
  filledSize: number;
  tps: Array<{ gainPct: number; closePct: number }>;
  szDecimals: number;
}): TpLevel[] {
  const { side, entryPx, filledSize, tps, szDecimals } = params;
  assertFinite("entryPx", entryPx);
  assertFinite("filledSize", filledSize);
  if (entryPx <= 0 || filledSize <= 0) return [];
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new Error(`tradingMath: szDecimals debe ser entero ≥ 0 (recibido ${szDecimals}).`);
  }
  const totalPct = tps.reduce((s, t) => s + t.closePct, 0);
  if (totalPct > 100 + 1e-9) {
    throw new Error(`tradingMath: Σ closePct de los TPs no puede superar 100 (recibido ${totalPct}).`);
  }
  const f = 10 ** szDecimals;
  // filledSize viene de fills de HL ya en unidades de szDecimals: round solo corrige el error de
  // representación float, no cambia el valor.
  const filledTicks = Math.round(filledSize * f);
  if (filledTicks <= 0) return [];
  // Guarda de representación (+1e-9) SOLO aquí: un producto realmente entero (p.ej. ×100/100) no
  // debe perder 1 tick por float. Capado a filledTicks: jamás repartir más que la posición.
  const totalTicks = Math.min(filledTicks, Math.floor(filledTicks * (totalPct / 100) + 1e-9));
  const out: TpLevel[] = [];
  let assignedTicks = 0;
  for (let i = 0; i < tps.length; i++) {
    const t = tps[i];
    assertFinite(`tps[${i}].gainPct`, t.gainPct);
    assertFinite(`tps[${i}].closePct`, t.closePct);
    if (t.gainPct <= 0 || t.closePct <= 0) {
      throw new Error(`tradingMath: tps[${i}] requiere gainPct/closePct > 0.`);
    }
    // Un Short con gainPct ≥ 100 produciría triggerPx ≤ 0 (HL lo rechaza en loop): fail-closed acá.
    if (side === "Short" && t.gainPct >= 100) {
      throw new Error(`tradingMath: tps[${i}].gainPct debe ser < 100 en Short (trigger ≤ 0 con ${t.gainPct}).`);
    }
    const triggerPx = side === "Long" ? entryPx * (1 + t.gainPct / 100) : entryPx * (1 - t.gainPct / 100);
    const isLast = i === tps.length - 1;
    const remaining = totalTicks - assignedTicks;
    // No-últimos: floor SIN epsilon (fail-closed por TP; el residuo fluye al último), capado al
    // remanente. Último: absorbe el remanente exacto (enteros ⇒ Σ == totalTicks garantizado).
    const sizeTicks = isLast
      ? Math.max(0, remaining)
      : Math.min(Math.floor(filledTicks * (t.closePct / 100)), Math.max(0, remaining));
    assignedTicks += sizeTicks;
    if (sizeTicks > 0) out.push({ tpIndex: i, triggerPx, size: sizeTicks / f });
  }
  return out;
}

// --- Lectura estricta del nocional LP (JAV-176-P3) ------------------------------------------------
// Mapeo fail-closed del `reason` de fetchPositionNotionalStrict, consumido por armTradingInternal
// (PR3). Pura para que el mapeo tenga test unitario aunque la node action no entre al harness.
export type LpReadClassification =
  | { ok: true }
  | { ok: false; error: string };

export function classifyLpRead(reason: string): LpReadClassification {
  if (reason === "ok") return { ok: true };
  if (reason === "transient") {
    return { ok: false, error: "[transient] No se pudo leer el nocional del LP on-chain (reintento)." };
  }
  // empty / unsupported / cualquier reason desconocido: fail-closed como config.
  return { ok: false, error: `[blocked_config] Nocional del LP no cuantificable on-chain (reason=${reason}).` };
}
