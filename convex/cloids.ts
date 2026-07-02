// (QSG / JAV-90) Helper HOJA para CLOIDs de Hyperliquid. SIN dependencias de dominio:
// NO importa triggerArms.ts / hyperliquid.ts / _generated (Codex #2-r4: evita arrastrar el grafo
// money-path/perp al connector spot). Misma regla de formato que armCloid: "0x" + 32 hex (16 bytes).
//
// Formato HL: el cloid debe ser EXACTAMENTE "0x" + 32 hex chars (16 bytes). Enviar el SHA-256
// completo (64 hex) hace que Hyperliquid RECHACE la orden. Por eso truncamos a 16 bytes.
//
// Determinista: el mismo `input` produce siempre el mismo cloid → idempotencia en reintentos.
// Web Crypto (crypto.subtle), disponible en el runtime de Convex (igual que triggerArms.armCloid).

/** Convierte un string lógico de identidad en un cloid HL válido ("0x" + 32 hex). */
export async function toHlCloid(input: string): Promise<`0x${string}`> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `0x${hex}`;
}

// (JAV-103) ROL de la orden dentro del namespace de cloid. `grid` = órdenes normales del grid (BUY/SELL
// pareadas y reposiciones); `seed` = compra de inventario inicial y sus SELL sembradas; `liquidation` =
// venta de la bolsa al detener con liquidación. Separar por rol evita que una SELL sembrada (level k,
// cycle 0) colisione por `by_cloid` con una SELL grid del mismo nivel/ciclo.
export type SpotGridCloidKind = "grid" | "seed" | "liquidation";

/**
 * Cloid determinista de una orden de spot grid. El input incluye `generation` y `cycleId` para que
 * la reposición de un mismo nivel NUNCA colisione con órdenes/fills de ciclos anteriores (Codex #1).
 * `tranche` (JAV-92) distingue múltiples SELL del MISMO BUY cuando se llena por partes ≥ min-notional
 * (sin él, dos SELL de tranches del mismo nivel/ciclo colisionarían). Las BUY usan tranche 0.
 *
 * (JAV-103) `kind` da NAMESPACE por rol. **Legacy-safe:** `kind="grid"` (default) produce EXACTAMENTE el
 * mismo string que antes → los cloids de los grids ya vivos no cambian. `seed`/`liquidation` se PREFIJAN
 * → namespace disjunto, imposible colisión por `by_cloid` con las órdenes grid.
 */
export function spotGridCloidInput(
  botId: string,
  generation: number,
  cycleId: number,
  level: number,
  side: "buy" | "sell",
  tranche: number = 0,
  kind: SpotGridCloidKind = "grid",
): string {
  const base = `${botId}:${generation}:${cycleId}:${level}:${side}:${tranche}`;
  return kind === "grid" ? base : `${kind}:${base}`;
}

// (JAV-107) ROL de la orden del bot de defensa SPOT. `entry` = la única orden trigger SELL que abre el
// short de cobertura; `sl` = stop loss post-fill; `tp` = take-profits parciales (reduceOnly). Mismo
// patrón que el motor de triggers de pool, pero con UNA sola entrada.
export type SpotDefenseCloidKind = "entry" | "sl" | "tp";

/**
 * Cloid determinista de una orden del bot de defensa spot. El input incluye `generation` (sube por
 * arranque/re-arm) para que un re-arm NUNCA colisione por `by_cloid` con órdenes del arm anterior.
 * `tpIndex` solo aplica a `kind="tp"` (0..N-1) → unicidad por TP individual; `attempt` rota el cloid al
 * recolocar SL/TP (confirmar-antes-de-rotar, anti-doble). Namespace prefijado por `kind` (disjunto del
 * spot grid y del motor de pool).
 *
 * (Codex Fase 1 NO-GO) Endurecido para TPs: `kind="tp"` EXIGE `tpIndex` entero ≥ 0 — sin él dos TPs
 * colisionarían por `by_cloid`; y `tpIndex` en un rol no-TP es un error (evita ignorarlo en silencio).
 * `generation`/`attempt` deben ser enteros ≥ 0.
 */
export function spotDefenseCloidInput(
  botId: string,
  generation: number,
  kind: SpotDefenseCloidKind,
  attempt: number = 0,
  tpIndex?: number,
): string {
  if (kind === "tp") {
    if (tpIndex === undefined || !Number.isInteger(tpIndex) || tpIndex < 0) {
      throw new Error(`spotDefenseCloidInput: role "tp" requiere tpIndex entero ≥ 0 (recibido ${tpIndex}).`);
    }
  } else if (tpIndex !== undefined) {
    throw new Error(`spotDefenseCloidInput: tpIndex solo aplica a role "tp" (recibido para "${kind}").`);
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(`spotDefenseCloidInput: generation debe ser entero ≥ 0 (recibido ${generation}).`);
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`spotDefenseCloidInput: attempt debe ser entero ≥ 0 (recibido ${attempt}).`);
  }
  const idx = kind === "tp" ? `:${tpIndex}` : "";
  return `spot-defense:${botId}:${generation}:${kind}${idx}:${attempt}`;
}

// (JAV-177) ROL de la orden del bot de TRADING (breakout OCO sobre rango LP). `entry_upper`/
// `entry_lower` = par OCO de triggers; `entry_market` = entrada IOC a mercado cuando el mark ya está
// fuera del rango (decisión 6, espejo JAV-111); `sl` = stop loss post-fill (rota por attempt vía
// slPendingCloid); `tp` = take-profits parciales; `close` = cierre IOC reduce-only (emergencia /
// oco_race / disarm) — con cloid determinista, mejora vs spot defense.
export type TradingCloidKind = "entry_upper" | "entry_lower" | "entry_market" | "sl" | "tp" | "close";

/**
 * Cloid determinista de una orden del bot de trading. Namespace `trading:` DISJUNTO de los otros
 * motores (spot-defense:/grid/pool). El input incluye `armId` + `generation` (sube por re-arm) para
 * que un re-arm nunca colisione por `by_cloid` con órdenes del arm anterior; `attempt` rota SL/TP/
 * close al recolocar (confirmar-antes-de-rotar); `tpIndex` solo con `kind="tp"` (unicidad por TP),
 * con el mismo endurecimiento que spotDefenseCloidInput.
 */
export function tradingCloidInput(
  armId: string,
  generation: number,
  kind: TradingCloidKind,
  attempt: number = 0,
  tpIndex?: number,
): string {
  if (kind === "tp") {
    if (tpIndex === undefined || !Number.isInteger(tpIndex) || tpIndex < 0) {
      throw new Error(`tradingCloidInput: role "tp" requiere tpIndex entero ≥ 0 (recibido ${tpIndex}).`);
    }
  } else if (tpIndex !== undefined) {
    throw new Error(`tradingCloidInput: tpIndex solo aplica a role "tp" (recibido para "${kind}").`);
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(`tradingCloidInput: generation debe ser entero ≥ 0 (recibido ${generation}).`);
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`tradingCloidInput: attempt debe ser entero ≥ 0 (recibido ${attempt}).`);
  }
  const idx = kind === "tp" ? `:${tpIndex}` : "";
  return `trading:${armId}:${generation}:${kind}${idx}:${attempt}`;
}
