import { convexTest } from "convex-test";
import schema from "../convex/schema";

// (Fase 4 PR2, Codex MEDIO#1) Registro de módulos POSITIVO para convex-test. import.meta.glob recibe
// un ARRAY de rutas literales: SOLO el cierre mutation-safe + el directorio `_generated` (requerido por
// convex-test para localizar la raíz del backend; código generado, sin funciones de usuario). NUNCA se
// listan módulos "use node" (hyperliquid/hlCredentialActions) ni actions/crons (triggerEngine/adminLive/
// crons/cronHealth/*Cron): quedan FUERA del alcance de PR2. Los tests no ejecutan rutas con scheduler/
// internal action. El guard ALLOWLIST EXACTA lanza si se colara CUALQUIER módulo fuera de esta lista
// (excepto `_generated`, infra), cumpliendo exactamente lo documentado (Codex BAJO).
const EXPECTED = new Set([
  "../convex/executions.ts",
  "../convex/triggerArms.ts",
  "../convex/triggerRearm.ts",
  "../convex/coverageUsage.ts",
  "../convex/leverage.ts",
  "../convex/log.ts",
  "../convex/engineEvents.ts",
  "../convex/helpers.ts",
  "../convex/plans.ts",
  "../convex/hlNetwork.ts",
  "../convex/spotGridBots.ts",
  "../convex/spotDefenseBots.ts",
  "../convex/spot_positions.ts",
  "../convex/migrations.ts",
  "../convex/bots.ts",
  "../convex/hlCredentials.ts",
]);

export function makeConvexTest() {
  const modules = import.meta.glob([
    "../convex/_generated/*.js",
    "../convex/executions.ts",
    "../convex/triggerArms.ts",
    "../convex/triggerRearm.ts",
    "../convex/coverageUsage.ts",
    "../convex/leverage.ts",
    "../convex/log.ts",
    "../convex/engineEvents.ts",
    "../convex/helpers.ts",
    "../convex/plans.ts",
    "../convex/hlNetwork.ts",
    "../convex/spotGridBots.ts",
    "../convex/spotDefenseBots.ts",
    "../convex/spot_positions.ts",
    "../convex/migrations.ts",
    "../convex/bots.ts",
    "../convex/hlCredentials.ts",
  ]);
  for (const k of Object.keys(modules)) {
    if (k.includes("/_generated/")) continue;   // infra de convex-test, requerida
    if (!EXPECTED.has(k)) throw new Error(`[convexHarness] módulo fuera de la allowlist mutation-safe: ${k}`);
  }
  return convexTest(schema, modules);
}
