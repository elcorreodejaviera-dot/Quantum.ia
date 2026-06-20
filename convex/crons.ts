import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// (OBS-2) Cada cron apunta a un wrapper de cronHealth.ts que registra salud (best-effort) y llama al
// cron real vía runAction. Los cuerpos money-path quedan intactos; el error real se re-lanza siempre.

crons.interval(
  "fetch DeFiLlama APY",
  { minutes: 5 },
  internal.cronHealth.fetchDefiLlamaApyWithHealth,
);

crons.interval(
  "fetch Uniswap V3 subgraph",
  { minutes: 30 },
  internal.cronHealth.fetchUniswapSubgraphWithHealth,
);

crons.interval(
  "check pool closures",
  { minutes: 10 },
  internal.cronHealth.checkPoolClosuresWithHealth,
);

crons.interval(
  "reconcile HL executions",
  { minutes: 1 },
  internal.cronHealth.reconcileExecutionsWithHealth,
);

// JAV-44 Etapa 1: convergencia de los trigger_arms (kill switch que cancela, pausa, recuperación).
crons.interval(
  "reconcile pool arms",
  { minutes: 1 },
  internal.cronHealth.reconcileArmsWithHealth,
);

// JAV-44 auto-rearm durable: reabre la cobertura tras un cierre por SL (reintento forzado, política de
// errores de Codex). Procesa los bots con rearm pendiente/blocked/recuperable.
crons.interval(
  "process bot rearms",
  { minutes: 1 },
  internal.cronHealth.processRearmsWithHealth,
);

// (JAV-92) Motor Spot Grid: reconcilia/coloca/mantiene órdenes LIMIT reales (money-path) bajo lease.
crons.interval(
  "reconcile spot grid",
  { minutes: 1 },
  internal.cronHealth.reconcileSpotGridWithHealth,
);

// (OBS-3b) Poda de engine_events una vez al día (retención 30d, por lotes). Best-effort.
crons.interval(
  "prune engine events",
  { hours: 24 },
  internal.cronHealth.pruneEngineEventsWithHealth,
);

export default crons;
