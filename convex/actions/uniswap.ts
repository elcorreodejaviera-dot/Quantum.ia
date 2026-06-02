"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const SUBGRAPH: Record<string, string> = {
  Arbitrum: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-arbitrum",
  Optimism: "https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v3-optimism",
  Base: "https://api.thegraph.com/subgraphs/name/lynnshaoyu/uniswap-v3-base",
};

const POOL_QUERY = `
  query PoolData($id: ID!) {
    pool(id: $id) {
      totalValueLockedUSD
      volumeUSD
      feesUSD
      poolDayData(first: 1, orderBy: date, orderDirection: desc) {
        volumeUSD
        feesUSD
        tvlUSD
      }
    }
  }
`;

async function querySubgraph(
  endpoint: string,
  poolAddress: string
): Promise<{ volumeUsd1d: number; feesUsd1d: number; tvlUsd: number } | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: POOL_QUERY, variables: { id: poolAddress } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pool = json?.data?.pool;
    if (!pool) return null;
    const day = pool.poolDayData?.[0];
    return {
      volumeUsd1d: parseFloat(day?.volumeUSD ?? "0"),
      feesUsd1d: parseFloat(day?.feesUSD ?? "0"),
      tvlUsd: parseFloat(day?.tvlUSD ?? pool.totalValueLockedUSD ?? "0"),
    };
  } catch {
    return null;
  }
}

export const fetchUniswapSubgraphData = internalAction({
  args: {},
  handler: async (ctx) => {
    const pools: Array<{
      _id: Id<"pools">;
      network: string;
      poolAddress?: string;
    }> = await ctx.runQuery(internal.pools.listPoolsInternal);

    for (const pool of pools) {
      const endpoint = SUBGRAPH[pool.network];
      if (!endpoint || !pool.poolAddress) continue;

      const data = await querySubgraph(endpoint, pool.poolAddress);
      if (!data) continue;

      await ctx.runMutation(internal.pools.patchPoolSubgraph, {
        id: pool._id,
        volumeUsd1d: data.volumeUsd1d,
        feesUsd1d: data.feesUsd1d,
        tvlUsd: data.tvlUsd,
      });
    }
  },
});
