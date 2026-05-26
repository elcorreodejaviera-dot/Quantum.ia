import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

const DEFILLAMA_URL = "https://yields.llama.fi/pools";
const CHAINS = ["Arbitrum", "Base", "Optimism"];

function matchesPair(symbol: string, pair: string): boolean {
  const [base] = pair.split("/");
  const upper = symbol.toUpperCase();
  return upper.includes(base.toUpperCase()) && upper.includes("USDC");
}

function estimateFees1d(pool: {
  volumeUsd1d?: number;
  feeTier?: number;
  tvlUsd?: number;
  apy?: number;
}): number | undefined {
  if (pool.volumeUsd1d != null && pool.feeTier != null) {
    return pool.volumeUsd1d * pool.feeTier / 1_000_000;
  }
  if (pool.tvlUsd != null && pool.apy != null) {
    return pool.tvlUsd * pool.apy / 100 / 365;
  }
  return undefined;
}

export const fetchAndUpdateApys = internalAction({
  args: {},
  handler: async (ctx) => {
    let data: { data: unknown[] };
    try {
      const res = await fetch(DEFILLAMA_URL);
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }

    const pools = data.data as Array<{
      chain: string;
      project: string;
      symbol: string;
      apy?: number;
      tvlUsd?: number;
      volumeUsd1d?: number;
      feeTier?: number;
      pool: string;
    }>;

    const candidates = pools.filter(
      (p) => p.project === "uniswap-v3" && CHAINS.includes(p.chain)
    );

    const convexPools: Array<{ _id: string; pair: string; network: string }> =
      await ctx.runQuery(internal.pools.listPoolsInternal);

    for (const cp of convexPools) {
      const matches = candidates.filter(
        (p) => p.chain === cp.network && matchesPair(p.symbol, cp.pair)
      );
      if (matches.length === 0) continue;

      const best = matches.reduce((a, b) => (b.tvlUsd ?? 0) > (a.tvlUsd ?? 0) ? b : a);

      await ctx.runMutation(internal.actions.defillama.patchPoolApy, {
        id: cp._id as string,
        apy: best.apy ?? 0,
        tvl: best.tvlUsd,
        fees1d: estimateFees1d(best),
        defillamaId: best.pool,
      });
    }
  },
});

export const patchPoolApy = internalMutation({
  args: {
    id: v.string(),
    apy: v.number(),
    tvl: v.optional(v.number()),
    fees1d: v.optional(v.number()),
    defillamaId: v.optional(v.string()),
  },
  handler: async (ctx, { id, apy, tvl, fees1d, defillamaId }) => {
    const patch: Record<string, unknown> = { apy, apyUpdatedAt: Date.now() };
    if (tvl !== undefined) patch.tvl = tvl;
    if (fees1d !== undefined) patch.fees1d = fees1d;
    if (defillamaId !== undefined) patch.defillamaId = defillamaId;
    await ctx.db.patch(id as unknown as import("../_generated/dataModel").Id<"pools">, patch);
  },
});
