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

/**
 * Cloid determinista de una orden de spot grid. El input incluye `generation` y `cycleId` para que
 * la reposición de un mismo nivel NUNCA colisione con órdenes/fills de ciclos anteriores (Codex #1).
 */
export function spotGridCloidInput(
  botId: string,
  generation: number,
  cycleId: number,
  level: number,
  side: "buy" | "sell",
): string {
  return `${botId}:${generation}:${cycleId}:${level}:${side}`;
}
