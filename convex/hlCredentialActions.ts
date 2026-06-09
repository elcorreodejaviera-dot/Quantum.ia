"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { privateKeyToAccount } from "viem/accounts";

function encryptionKey(): Buffer {
  const secret = process.env.HL_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("HL_CREDENTIALS_ENCRYPTION_KEY is not configured");
  return createHash("sha256").update(secret).digest();
}

function normalizePrivateKey(value: string): `0x${string}` {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed as `0x${string}` : `0x${trimmed}`;
}

function encryptPrivateKey(privateKey: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return {
    encryptedPrivateKey: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptPrivateKey(record: {
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
}): `0x${string}` {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
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

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

// Consulta el rol de una dirección en Hyperliquid (Info endpoint).
async function fetchUserRole(address: string): Promise<{ role: string; data?: { user?: string } }> {
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userRole", user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid info respondió ${res.status}`);
  return await res.json() as { role: string; data?: { user?: string } };
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
