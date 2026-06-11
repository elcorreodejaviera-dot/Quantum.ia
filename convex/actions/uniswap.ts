"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const SUBGRAPH: Record<string, string> = {
  Arbitrum: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-arbitrum",
  Optimism: "https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v3-optimism",
  Base: "https://api.thegraph.com/subgraphs/name/lynnshaoyu/uniswap-v3-base",
};

// pares base → tokens a buscar en el subgraph
const PAIR_TOKENS: Record<string, { base: string; quote: string }> = {
  "BTC/USDC": { base: "BTC", quote: "USDC" },
  "ETH/USDC": { base: "ETH", quote: "USDC" },
};

async function gql(endpoint: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const json = await res.json() as any;   // respuesta del subgraph (forma validada aguas abajo)
  return json?.data ?? null;
}

// Busca la dirección del pool con más TVL que coincida con el par.
async function findPoolAddress(endpoint: string, base: string, quote: string): Promise<string | null> {
  const query = `
    query FindPool($base: String!, $quote: String!) {
      a: pools(
        where: { token0_: { symbol_contains_nocase: $base }, token1_: { symbol_contains_nocase: $quote } }
        orderBy: totalValueLockedUSD orderDirection: desc first: 1
      ) { id totalValueLockedUSD }
      b: pools(
        where: { token1_: { symbol_contains_nocase: $base }, token0_: { symbol_contains_nocase: $quote } }
        orderBy: totalValueLockedUSD orderDirection: desc first: 1
      ) { id totalValueLockedUSD }
    }
  `;
  const data = await gql(endpoint, query, { base, quote });
  if (!data) return null;
  const candidates = [...(data.a ?? []), ...(data.b ?? [])];
  if (!candidates.length) return null;
  candidates.sort((a, b) => parseFloat(b.totalValueLockedUSD) - parseFloat(a.totalValueLockedUSD));
  return candidates[0].id as string;
}

async function fetchDailyData(endpoint: string, poolAddress: string) {
  const query = `
    query PoolData($id: ID!) {
      pool(id: $id) {
        totalValueLockedUSD
        poolDayData(first: 1, orderBy: date, orderDirection: desc) {
          volumeUSD feesUSD tvlUSD
        }
      }
    }
  `;
  const data = await gql(endpoint, query, { id: poolAddress });
  const pool = data?.pool;
  if (!pool) return null;
  const day = pool.poolDayData?.[0];
  return {
    volumeUsd1d: parseFloat(day?.volumeUSD ?? "0"),
    feesUsd1d: parseFloat(day?.feesUSD ?? "0"),
    tvlUsd: parseFloat(day?.tvlUSD ?? pool.totalValueLockedUSD ?? "0"),
  };
}

export const fetchUniswapSubgraphData = internalAction({
  args: {},
  // Promise<void>: corta el ciclo de inferencia (TS2589) sin perder type-safety — el handler no retorna.
  handler: async (ctx): Promise<void> => {
    const pools: Array<{
      _id: Id<"pools">;
      network: string;
      pair: string;
      poolAddress?: string;
    }> = await ctx.runQuery(internal.pools.listPoolsInternal);

    for (const pool of pools) {
      const endpoint = SUBGRAPH[pool.network];
      if (!endpoint) continue;

      let address = pool.poolAddress;

      // Descubrir dirección si no la tenemos
      if (!address) {
        const tokens = PAIR_TOKENS[pool.pair];
        if (!tokens) continue;
        try {
          address = (await findPoolAddress(endpoint, tokens.base, tokens.quote)) ?? undefined;
          if (address) {
            await ctx.runMutation(internal.pools.patchPoolAddress, {
              id: pool._id,
              poolAddress: address,
            });
          }
        } catch {
          continue;
        }
      }

      if (!address) continue;

      try {
        const data = await fetchDailyData(endpoint, address);
        if (!data) continue;
        await ctx.runMutation(internal.pools.patchPoolSubgraph, {
          id: pool._id,
          volumeUsd1d: data.volumeUsd1d,
          feesUsd1d: data.feesUsd1d,
          tvlUsd: data.tvlUsd,
        });
      } catch {
        continue;
      }
    }
  },
});
