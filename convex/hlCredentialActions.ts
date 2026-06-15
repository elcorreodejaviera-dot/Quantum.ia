"use node";

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { privateKeyToAccount } from "viem/accounts";
import { hlInfoUrl } from "./hlNetwork";

// --- (JAV-63) Keyring de cifrado con versión de clave + rotación ---
// Formato (a): HL_CREDENTIALS_ENCRYPTION_KEY = clave LEGACY (id "legacy", sin cambios). Opcional:
// HL_CREDENTIALS_KEYRING = JSON {"v2":"secreto2",...} con claves adicionales, y
// HL_CREDENTIALS_ACTIVE_KEY_ID = id con el que se CIFRA lo nuevo (default "legacy").
// Cada secreto pasa por sha256 → 32 bytes (igual que antes). Por DEFAULT (sin keyring/active) el
// comportamiento es IDÉNTICO al actual: registros sin keyId se cifran/descifran con la clave legacy.
const LEGACY_KEY_ID = "legacy";

function legacyKey(): Buffer {
  const secret = process.env.HL_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("HL_CREDENTIALS_ENCRYPTION_KEY is not configured");
  return createHash("sha256").update(secret).digest();
}

// Mapa id → clave de 32 bytes. SIEMPRE incluye la legacy.
function keyring(): Record<string, Buffer> {
  const ring: Record<string, Buffer> = { [LEGACY_KEY_ID]: legacyKey() };
  const raw = process.env.HL_CREDENTIALS_KEYRING;
  if (raw && raw.trim()) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw); } catch { throw new Error("HL_CREDENTIALS_KEYRING no es JSON válido."); }
    for (const [id, secret] of Object.entries(parsed)) {
      if (id === LEGACY_KEY_ID) throw new Error("HL_CREDENTIALS_KEYRING no puede redefinir el id 'legacy'.");
      if (typeof secret !== "string" || !secret) throw new Error(`HL_CREDENTIALS_KEYRING: secreto inválido para '${id}'.`);
      ring[id] = createHash("sha256").update(secret).digest();
    }
  }
  return ring;
}

// Id de la clave con la que se CIFRA lo nuevo (default "legacy" → compat con hoy).
function activeKeyId(): string {
  const id = process.env.HL_CREDENTIALS_ACTIVE_KEY_ID;
  return id && id.trim() ? id.trim() : LEGACY_KEY_ID;
}

// Resuelve la clave por id (ausente/null → legacy, para registros previos sin keyId).
function resolveKey(keyId: string | undefined | null): Buffer {
  const id = keyId ?? LEGACY_KEY_ID;
  const key = keyring()[id];
  if (!key) throw new Error(`Clave de cifrado '${id}' no disponible (¿falta en HL_CREDENTIALS_KEYRING?).`);
  return key;
}

function normalizePrivateKey(value: string): `0x${string}` {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed as `0x${string}` : `0x${trimmed}`;
}

function encryptPrivateKey(privateKey: string) {
  const keyId = activeKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resolveKey(keyId), iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return {
    encryptedPrivateKey: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    // En modo default (active = legacy) NO se guarda keyId → registro idéntico a los previos.
    keyId: keyId === LEGACY_KEY_ID ? undefined : keyId,
  };
}

export function decryptPrivateKey(record: {
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
  keyId?: string;
}): `0x${string}` {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    resolveKey(record.keyId),
    Buffer.from(record.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.encryptedPrivateKey, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return normalizePrivateKey(decrypted);
}

// `save` (cuenta única legacy) eliminado: reemplazado por connectAccount (multi-cuenta, con
// verificación userRole + unicidad global + tradingAccountAddress obligatorio).

// --- Multi-cuenta (Fase 1) ---

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

// Consulta el rol de una dirección en Hyperliquid (Info endpoint, red según HL_NETWORK).
async function fetchUserRole(address: string): Promise<{ role: string; data?: { user?: string } }> {
  // Timeout: sin él, una HL lenta/no disponible colgaría la action indefinidamente (CodeRabbit).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(hlInfoUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "userRole", user: address }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Hyperliquid info respondió ${res.status}`);
    return await res.json() as { role: string; data?: { user?: string } };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Conecta una cuenta HL (wallet EVM principal + su API wallet firmante).
// Verifica en Hyperliquid que el agente está autorizado para esa cuenta principal.
export const connectAccount = action({
  args: {
    privateKey: v.string(),              // clave privada de la API wallet (NO la de MetaMask/Rabby)
    tradingAccountAddress: v.string(),   // dirección de la cuenta principal (MetaMask/Rabby) en HL
    label: v.optional(v.string()),
  },
  handler: async (ctx, { privateKey, tradingAccountAddress, label }) => {
    const user = await ctx.runQuery(internal.users.getCurrentUserInternal, {});
    const normalized = normalizePrivateKey(privateKey);
    const agentAddress = privateKeyToAccount(normalized).address.toLowerCase();
    const tradingAddr = tradingAccountAddress.trim().toLowerCase();

    if (!EVM_RE.test(tradingAddr)) throw new Error("La dirección de la cuenta principal no es válida.");
    if (agentAddress === tradingAddr) {
      throw new Error("La API wallet no puede ser igual a la cuenta principal.");
    }

    // El agente debe estar autorizado por esa cuenta principal en Hyperliquid.
    const agentRole = await fetchUserRole(agentAddress);
    if (agentRole.role !== "agent" || (agentRole.data?.user ?? "").toLowerCase() !== tradingAddr) {
      throw new Error("La API wallet no está autorizada para esa cuenta en Hyperliquid.");
    }
    // La cuenta principal debe ser una cuenta de usuario real en Hyperliquid.
    const acctRole = await fetchUserRole(tradingAddr);
    if (acctRole.role !== "user") {
      throw new Error("La dirección indicada no es una cuenta principal de Hyperliquid.");
    }

    const encrypted = encryptPrivateKey(normalized);
    const id = await ctx.runMutation(internal.hlCredentials.insertAccountInternal, {
      userId: user._id,
      label,
      agentAddress,
      tradingAccountAddress: tradingAddr,
      ...encrypted,
    });
    return { id, agentAddress, tradingAccountAddress: tradingAddr };
  },
});

// (JAV-63) Re-cifra las credenciales que NO estén en la clave activa, descifrando con la clave de
// cada registro y re-cifrando con la activa. Idempotente (salta las que ya están en la activa) y
// por lotes. Pensado para la rotación: el admin lo corre por CLI tras provisionar la clave nueva en
// HL_CREDENTIALS_KEYRING + HL_CREDENTIALS_ACTIVE_KEY_ID. No expuesto a clientes (internalAction).
export const reencryptCredentials = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<any> => {
    const active = activeKeyId();
    const all = await ctx.runQuery(internal.hlCredentials.listAllInternal, {});
    const cap = limit ?? 100;
    let reencrypted = 0, skipped = 0, failed = 0;
    for (const c of all) {
      if (reencrypted >= cap) break;
      const currentId = c.keyId ?? LEGACY_KEY_ID;
      if (currentId === active) { skipped++; continue; }   // ya en la clave activa
      try {
        const plain = decryptPrivateKey(c);   // descifra con la clave del record (su keyId)
        const enc = encryptPrivateKey(plain);  // re-cifra con la clave ACTIVA
        await ctx.runMutation(internal.hlCredentials.updateCipherInternal, {
          id: c._id,
          encryptedPrivateKey: enc.encryptedPrivateKey, iv: enc.iv, authTag: enc.authTag, keyId: enc.keyId,
        });
        reencrypted++;
      } catch (e) {
        failed++;
        console.error(`reencryptCredentials: fallo en ${c._id}`, e);
      }
    }
    return { total: all.length, reencrypted, skipped, failed, activeKeyId: active };
  },
});
