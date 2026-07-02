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
// (JAV-107) Motor de defensa SPOT: reconcilia SL/cierre/drift de los arms vivos (money-path) bajo lease.
crons.interval(
  "reconcile spot defense",
  { minutes: 1 },
  internal.cronHealth.reconcileSpotDefenseWithHealth,
);

// (JAV-107 3c-3b) Auto-rearm del bot de defensa SPOT (reabre tras cierre por SL si autoRearm).
crons.interval(
  "process spot defense rearms",
  { minutes: 1 },
  internal.cronHealth.processSpotDefenseRearmsWithHealth,
);

// (JAV-117) Refresco lifetime de fees por eventos on-chain (Alchemy Free + incremental). NO money-path:
// la mayoría de las corridas no piden logs (solo avanzan cursor si la señal estructural no cambió).
crons.interval(
  "refresh pool lifetimes",
  { hours: 1 },
  internal.cronHealth.refreshPoolLifetimesWithHealth,
);

// (JAV-120) Snapshot de fees por posición → "Fees 24h" REAL = Δ(feesAccum) entre snapshots.
// NO money-path; independiente del de lifetime (lee cobrable live por RPC público, sin Alchemy).
// Cadencia 5 min (antes 1h): la cifra "Fees 24h" se refresca casi en vivo sin gastar cuota Alchemy
// (RPC público) ni acelerar el warming-up inicial de 24h. Retención (~10d) lo absorbe sin tocar nada.
crons.interval(
  "snapshot pool fees",
  { minutes: 5 },
  internal.cronHealth.snapshotPoolFeesWithHealth,
);

crons.interval(
  "prune engine events",
  { hours: 24 },
  internal.cronHealth.pruneEngineEventsWithHealth,
);

// (JAV-179) 4º motor money-path (Bot Trading): reconcile por arm (lease/fencing) + rearm durable.
crons.interval(
  "reconcile trading arms",
  { minutes: 1 },
  internal.cronHealth.reconcileTradingArmsWithHealth,
);

crons.interval(
  "process trading rearms",
  { minutes: 1 },
  internal.cronHealth.processTradingRearmsWithHealth,
);

export default crons;
