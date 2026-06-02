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

export const save = action({
  args: { privateKey: v.string() },
  handler: async (ctx, { privateKey }) => {
    const user = await ctx.runQuery(internal.users.getCurrentUserInternal, {});
    const normalized = normalizePrivateKey(privateKey);
    const account = privateKeyToAccount(normalized);
    const encrypted = encryptPrivateKey(normalized);
    await ctx.runMutation(internal.hlCredentials.upsertInternal, {
      userId: user._id,
      agentAddress: account.address.toLowerCase(),
      ...encrypted,
    });
    return { connected: true, agentAddress: account.address.toLowerCase() };
  },
});
