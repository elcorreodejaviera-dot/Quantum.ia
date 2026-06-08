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

export default crons;
