import { defineConfig } from "vitest/config";

// Tests unitarios de helpers puros (sin red ni Convex runtime). Acotado a tests/ para no interferir
// con el type-check de Convex (convex/tsconfig.json).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
