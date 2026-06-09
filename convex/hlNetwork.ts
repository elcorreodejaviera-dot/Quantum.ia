// Red HL explícita (JAV-37, hallazgo de red). `HL_NETWORK` SIN default: un deploy mal
// configurado NO debe poder operar — manejamos dinero real. Backend = fuente de verdad.

export type HlNetwork = "mainnet" | "testnet";

export function hlNetwork(): HlNetwork {
  const n = process.env.HL_NETWORK;
  if (n !== "mainnet" && n !== "testnet") {
    throw new Error("HL_NETWORK no configurada (debe ser 'mainnet' o 'testnet').");
  }
  return n;
}

export function hlIsTestnet(): boolean {
  return hlNetwork() === "testnet";
}

export function hlInfoUrl(): string {
  return hlIsTestnet()
    ? "https://api.hyperliquid-testnet.xyz/info"
    : "https://api.hyperliquid.xyz/info";
}

// Rechaza si la red esperada por el frontend no coincide con la del backend.
// Nunca permitir que una prueba destinada a testnet llegue a mainnet (o viceversa).
export function assertExpectedNetwork(expected: string): void {
  const actual = hlNetwork();
  if (expected !== actual) {
    throw new Error(`Red HL incompatible: frontend espera '${expected}', backend es '${actual}'.`);
  }
}
