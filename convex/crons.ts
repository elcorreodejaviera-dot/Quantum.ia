import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "fetch DeFiLlama APY",
  { minutes: 5 },
  internal.actions.defillama.fetchAndUpdateApys,
);

crons.interval(
  "fetch Uniswap V3 subgraph",
  { minutes: 30 },
  internal.actions.uniswap.fetchUniswapSubgraphData,
);

crons.interval(
  "check pool closures",
  { minutes: 10 },
  internal.actions.poolScanner.checkAllPoolClosures,
);

crons.interval(
  "reconcile HL executions",
  { minutes: 1 },
  internal.executionsCron.reconcileStaleExecutions,
);

// JAV-44 Etapa 1: convergencia de los trigger_arms (kill switch que cancela, pausa, recuperación).
crons.interval(
  "reconcile pool arms",
  { minutes: 1 },
  internal.triggerEngine.reconcileStaleArms,
);

export default crons;
