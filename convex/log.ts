// (OBS-3) Logging estructurado del motor money-path.
//
// Módulo HOJA (sin funciones Convex) para no arrastrar el grafo `api` (evita TS2589).
//
// SEGURIDAD (auditoría Codex, OBS-3 ALTO #1/MEDIO #2):
// - `elog` SOLO acepta CAMPOS ESCALARES → es imposible pasar un objeto, una credencial o un payload.
// - PROHIBIDO loguear: privateKey, encryptedPrivateKey, iv, authTag, credential, tradingAccountAddress,
//   agentAddress, ni request/response crudos del SDK. Pasar solo ids/estados/valores no sensibles.
// - Para errores: usar SIEMPRE `safeError(e)` (mensaje corto, sin stack ni payload), NUNCA `e` crudo
//   (un error de SDK/exchange puede traer datos sensibles).

type Scalar = string | number | boolean | null | undefined;

// Emite UNA línea JSON por transición (no por iteración de bucle). Campos = solo escalares.
// BEST-EFFORT (Codex BAJO): el logging NUNCA debe lanzar y romper a su caller (se llama desde código
// money-path-adjacent). Si JSON.stringify fallara, se traga con un warn mínimo.
export function elog(scope: string, event: string, fields: Record<string, Scalar> = {}) {
  try {
    console.log(JSON.stringify({ scope, event, ...fields, ts: Date.now() }));
  } catch {
    console.warn(`[elog] serialization failed: ${scope}/${event}`);
  }
}

// Mensaje de error truncado y sin payload, para loguear excepciones de forma segura.
export function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 300);
}
