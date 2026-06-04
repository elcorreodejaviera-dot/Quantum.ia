"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";

const NFT_MANAGER: Record<string, string> = {
  Arbitrum: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  Optimism: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  Base:     "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
};

const FACTORY: Record<string, string> = {
  Arbitrum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Optimism: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Base:     "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
};

const RPC: Record<string, string> = {
  Arbitrum: "https://arb1.arbitrum.io/rpc",
  Optimism: "https://mainnet.optimism.io",
  Base:     "https://mainnet.base.org",
};

const STABLES = new Set(["USDC", "USDT", "DAI", "BUSD", "FRAX", "LUSD", "USDC.e", "USDbC"]);
const NORMALIZE: Record<string, string> = { WETH: "ETH", WBTC: "BTC" };
function norm(sym: string): string { return NORMALIZE[sym] ?? sym; }

const RPC_TIMEOUT_MS = 8_000;

async function rpcCall(url: string, to: string, data: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC ${url} respondió ${res.status} ${res.statusText}`);
    const json = await res.json() as { result?: string; error?: { message: string } };
    if (json.error) throw new Error(`eth_call error: ${json.error.message}`);
    return json.result ?? "0x";
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`RPC timeout (${RPC_TIMEOUT_MS}ms): ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function pad(n: bigint): string { return n.toString(16).padStart(64, "0"); }

function slot(hex: string, i: number): string { return hex.slice(i * 64, i * 64 + 64); }

function addrAt(hex: string, i: number): string { return "0x" + slot(hex, i).slice(24); }

function uintAt(hex: string, i: number): bigint { return BigInt("0x" + slot(hex, i)); }

function intAt(hex: string, i: number): bigint {
  const raw = uintAt(hex, i);
  return raw >= 2n ** 255n ? raw - 2n ** 256n : raw;
}

function hexToUtf8(hexData: string, offset: number): string {
  const len = Number(uintAt(hexData, offset + 1));
  if (len === 0 || len > 200) return "";
  const bytes = new Uint8Array(len);
  const strHex = hexData.slice((offset + 2) * 64, (offset + 2) * 64 + len * 2);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes).replace(/\0/g, "").trim();
}

async function tokenInfo(rpc: string, addr: string): Promise<{ symbol: string; decimals: number }> {
  let symbol = "???";
  let decimals = 18;
  try {
    const raw = (await rpcCall(rpc, addr, "0x95d89b41")).slice(2);
    if (raw.length >= 128) {
      symbol = hexToUtf8(raw, 0) || symbol;
    } else if (raw.length === 64) {
      // bytes32 fallback for old tokens
      const bytes: number[] = [];
      for (let i = 0; i < 32; i++) {
        const b = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
        if (b === 0) break;
        bytes.push(b);
      }
      symbol = new TextDecoder().decode(new Uint8Array(bytes)).trim();
    }
  } catch {}
  try {
    const d = parseInt((await rpcCall(rpc, addr, "0x313ce567")).slice(2), 16);
    if (Number.isFinite(d) && d >= 0 && d <= 36) decimals = d;
  } catch {}
  return { symbol, decimals };
}

function tickPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

export const scanPoolByTokenId = action({
  args: { tokenId: v.number(), network: v.string() },
  handler: async (_ctx, { tokenId, network }) => {
    if (!Number.isFinite(tokenId) || !Number.isInteger(tokenId) || tokenId <= 0 || tokenId > Number.MAX_SAFE_INTEGER)
      throw new Error("Token ID inválido. Debe ser un entero positivo.");

    const rpc = RPC[network];
    const nft = NFT_MANAGER[network];
    const factory = FACTORY[network];
    if (!rpc || !nft) throw new Error(`Red no soportada: ${network}`);

    // positions(uint256) = 0x99fbab88
    const posRaw = (await rpcCall(rpc, nft, "0x99fbab88" + pad(BigInt(tokenId)))).slice(2);
    if (posRaw.length < 64 * 12) throw new Error("Posición no encontrada. Verifica el Token ID y la red.");

    const token0addr = addrAt(posRaw, 2);
    const token1addr = addrAt(posRaw, 3);
    const fee       = Number(uintAt(posRaw, 4));
    const tickLower = Number(intAt(posRaw, 5));
    const tickUpper = Number(intAt(posRaw, 6));
    const liquidity = uintAt(posRaw, 7);

    if (liquidity === 0n) throw new Error("Posición cerrada (liquidez = 0).");

    const [t0, t1] = await Promise.all([
      tokenInfo(rpc, token0addr),
      tokenInfo(rpc, token1addr),
    ]);

    // Prices at range bounds
    const pLower = tickPrice(tickLower, t0.decimals, t1.decimals);
    const pUpper = tickPrice(tickUpper, t0.decimals, t1.decimals);
    const invert = STABLES.has(t0.symbol);

    const minRange = invert ? Math.min(1 / pLower, 1 / pUpper) : Math.min(pLower, pUpper);
    const maxRange = invert ? Math.max(1 / pLower, 1 / pUpper) : Math.max(pLower, pUpper);
    const pair     = invert ? `${norm(t1.symbol)}/${norm(t0.symbol)}` : `${norm(t0.symbol)}/${norm(t1.symbol)}`;

    // Pool address + current price via factory + slot0
    let poolAddress: string | undefined;
    let currentPrice: number | null = null;
    try {
      // getPool(token0,token1,fee) = 0x1698ee82
      const getPoolData = "0x1698ee82" +
        token0addr.slice(2).padStart(64, "0") +
        token1addr.slice(2).padStart(64, "0") +
        pad(BigInt(fee));
      const poolRaw = (await rpcCall(rpc, factory, getPoolData)).slice(2);
      const poolAddr = "0x" + poolRaw.slice(24);
      if (poolAddr !== "0x0000000000000000000000000000000000000000") {
        poolAddress = poolAddr.toLowerCase();
        // slot0() = 0x3850c7bd → sqrtPriceX96
        const s0 = (await rpcCall(rpc, poolAddress, "0x3850c7bd")).slice(2);
        const sqrtP96 = uintAt(s0, 0);
        const sqrtF = Number(sqrtP96) / 2 ** 96;
        const raw = sqrtF * sqrtF * Math.pow(10, t0.decimals - t1.decimals);
        currentPrice = Number.isFinite(raw) && raw > 0
          ? (invert ? 1 / raw : raw)
          : null;
      }
    } catch {}

    const status = currentPrice == null ? "Sin datos"
      : (currentPrice < minRange || currentPrice > maxRange) ? "Fuera de rango"
      : "En rango";

    return { tokenId, network, pair, feeTier: fee, minRange, maxRange, currentPrice, status, poolAddress };
  },
});
