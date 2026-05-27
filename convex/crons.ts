import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "fetch DeFiLlama APY",
  { minutes: 5 },
  internal.actions.defillama.fetchAndUpdateApys,
);

export default crons;
