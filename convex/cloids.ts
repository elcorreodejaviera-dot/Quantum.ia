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
