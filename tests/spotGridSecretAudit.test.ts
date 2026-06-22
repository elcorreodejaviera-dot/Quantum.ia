import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// (JAV-94) Guard automatizado: ninguna llamada `elog(...)` del módulo Spot Grid puede recibir un secreto
// (private key / firma / credencial cifrada). Las llamadas son de una sola línea → escaneo por línea.
// Si una regresión futura mete un secreto en un log, este test falla.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "convex");
const FILES = ["spotGridEngine.ts", "spotGridBots.ts", "spotGridActions.ts"];
// Identificadores prohibidos dentro del payload de un elog (variables que contienen material sensible).
const FORBIDDEN = /\b(privKey|privateKey|encryptedPrivateKey|signature|mnemonic|seedPhrase|secretKey|apiSecret)\b/;

describe("(JAV-94) auditoría de secretos en elog del Spot Grid", () => {
  for (const f of FILES) {
    it(`${f}: ninguna llamada elog filtra un secreto`, () => {
      const src = readFileSync(join(ROOT, f), "utf8");
      const offending = src
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes("elog(") && FORBIDDEN.test(line));
      expect(offending.map((o) => `${f}:${o.n} → ${o.line.trim()}`)).toEqual([]);
    });
  }
});
