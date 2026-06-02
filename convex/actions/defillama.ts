"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

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

    if (!Array.isArray(data.data)) return;

    const pools = data.data as Array<{
      chain: string;
      project: string;
      symbol: string;
      apy?: number;
      tvlUsd?: number;
      volumeUsd1d?: number;
      volumeUsd7d?: number;
      feeTier?: number;
      poolMeta?: string;
      pool: string;
      underlyingTokens?: string[];
    }>;

    const candidates = pools.filter(
      (p) => p.project === "uniswap-v3" && CHAINS.includes(p.chain)
    );

    const convexPools: Array<{ _id: Id<"pools">; pair: string; network: string }> =
      await ctx.runQuery(internal.pools.listPoolsInternal);

    for (const cp of convexPools) {
      const matches = candidates.filter(
        (p) => p.chain === cp.network && matchesPair(p.symbol, cp.pair)
      );
      if (matches.length === 0) continue;

      const best = matches.reduce((a, b) => (b.tvlUsd ?? 0) > (a.tvlUsd ?? 0) ? b : a);

      // DeFiLlama pool IDs for Uniswap V3 use format "0xADDRESS:chain" or plain "0xADDRESS"
      const rawId = best.pool ?? '';
      const poolAddress = rawId.startsWith('0x')
        ? rawId.split(':')[0].toLowerCase()
        : undefined;

      // poolMeta contiene el fee tier como "0.05%" — convertir a bps (500)
      const feeTierBps = best.poolMeta
        ? Math.round(parseFloat(best.poolMeta) * 100)
        : undefined;

      await ctx.runMutation(internal.pools.patchPoolApy, {
        id: cp._id,
        apy: best.apy ?? 0,
        tvl: best.tvlUsd,
        fees1d: estimateFees1d(best),
        volume1d: best.volumeUsd1d,
        volume7d: best.volumeUsd7d,
        feeTier: feeTierBps,
        defillamaId: best.pool,
        poolAddress,
      });
    }
  },
});
