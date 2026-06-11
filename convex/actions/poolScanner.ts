"use node";

import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

const NFT_MANAGER: Record<string, string> = {
  Ethereum: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  Arbitrum: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  Optimism: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  Base:     "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
};

const REVERT_VAULT: Record<string, string> = {
  Ethereum: "0xa2754543f69dC036764bBfad16d2A74F5cD15667",
  Base:     "0x36aeae0e411a1e28372e0d66f02e57744ebe7599",
  Arbitrum: "0x74e6afef5705beb126c6d3bf46f8fad8f3e07825",
};

const FACTORY: Record<string, string> = {
  Ethereum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Arbitrum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Optimism: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Base:     "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
};

const RPC: Record<string, string[]> = {
  Ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  Arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  Optimism: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
  Base:     ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
};

const STABLES = new Set(["USDC", "USDT", "DAI", "BUSD", "FRAX", "LUSD", "USDC.e", "USDbC"]);
const NORMALIZE: Record<string, string> = { WETH: "ETH", WBTC: "BTC" };
function norm(sym: string): string { return NORMALIZE[sym] ?? sym; }

const RPC_TIMEOUT_MS = 8_000;

// El contrato respondió y revirtió la ejecución (p.ej. tokenId inexistente).
// Distinto de un fallo de transporte (timeout, 5xx, red caída): un revert es
// una respuesta determinista de la cadena, no una indisponibilidad del RPC.
class RpcRevertError extends Error {}

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
    const json = await res.json() as { result?: string; error?: { message?: string; code?: number } };
    if (json.error) {
      const msg = json.error.message ?? "";
      // Solo un revert de ejecución (code 3 / "execution reverted") es determinista.
      // Rate-limits (-32005/-32016/429), errores internos (-32603), etc. son
      // indisponibilidad transitoria del RPC: NO deben concluir que el token no existe.
      const isRevert = json.error.code === 3 || /execution reverted/i.test(msg);
      if (isRevert) throw new RpcRevertError(`eth_call error: ${msg}`);
      throw new Error(`eth_call error (${json.error.code ?? "?"}): ${msg}`);
    }
    return json.result ?? "0x";
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`RPC timeout (${RPC_TIMEOUT_MS}ms): ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCallWithFallback(urls: string[], to: string, data: string): Promise<string> {
  let lastErr: unknown;
  let revertErr: RpcRevertError | undefined;
  for (const url of urls) {
    try { return await rpcCall(url, to, data); }
    catch (e) {
      lastErr = e;
      // Un revert es determinista (todos los endpoints darían lo mismo); tiene
      // prioridad sobre errores de transporte para clasificar el resultado.
      if (e instanceof RpcRevertError) revertErr = e;
    }
  }
  throw revertErr ?? lastErr;
}

// Estado on-chain de una posición LP, discriminado para el cron de cierre.
// active: liquidez > 0 · empty: existe pero liquidez 0 (reversible)
// not_found: el NFT no existe / fue quemado · unavailable: todos los RPC fallaron
type PositionStatus = "active" | "empty" | "not_found" | "unavailable";

async function readPositionStatusOnce(rpcs: string[], nft: string, tokenId: number): Promise<PositionStatus> {
  let posRaw: string;
  try {
    // positions(uint256) = 0x99fbab88
    posRaw = (await rpcCallWithFallback(rpcs, nft, "0x99fbab88" + pad(BigInt(tokenId)))).slice(2);
  } catch (e) {
    // El contrato revirtió → el token no existe (quemado/invalid). Cualquier otro
    // error es indisponibilidad de RPC: NO concluir cierre (evita falso positivo).
    if (e instanceof RpcRevertError) return "not_found";
    return "unavailable";
  }
  // Respuesta anómala (corta/malformada) → no concluir cierre; tratar como indisponible.
  if (posRaw.length < 64 * 12) return "unavailable";
  try {
    return uintAt(posRaw, 7) === 0n ? "empty" : "active";
  } catch {
    // Hex inválido / decodificación fallida → no concluir cierre.
    return "unavailable";
  }
}

// Lectura con confirmación: un estado destructivo (empty/not_found pausa bots y
// marca cierre) se confirma con una segunda lectura independiente. Si difieren,
// se trata como indisponible para no pausar bots por un fallo intermitente de RPC.
async function readPositionStatus(rpcs: string[], nft: string, tokenId: number): Promise<PositionStatus> {
  const first = await readPositionStatusOnce(rpcs, nft, tokenId);
  if (first === "empty" || first === "not_found") {
    // Confirmación INDEPENDIENTE: consultar únicamente el segundo proveedor (rpcs[1]),
    // sin fallback al primero. Si solo hay 1 RPC o rpcs[1] falla → no concluir cierre.
    if (rpcs.length < 2) return "unavailable";
    const second = await readPositionStatusOnce([rpcs[1]], nft, tokenId);
    if (second !== first) return "unavailable";
  }
  return first;
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

    const rpcs = RPC[network];
    const nft = NFT_MANAGER[network];
    const factory = FACTORY[network];
    if (!rpcs || !nft) throw new Error(`Red no soportada: ${network}`);

    // positions(uint256) = 0x99fbab88
    const posRaw = (await rpcCallWithFallback(rpcs, nft, "0x99fbab88" + pad(BigInt(tokenId)))).slice(2);
    if (posRaw.length < 64 * 12) throw new Error("Posición no encontrada. Verifica el Token ID y la red.");

    const token0addr = addrAt(posRaw, 2);
    const token1addr = addrAt(posRaw, 3);
    const fee       = Number(uintAt(posRaw, 4));
    const tickLower = Number(intAt(posRaw, 5));
    const tickUpper = Number(intAt(posRaw, 6));
    const liquidity = uintAt(posRaw, 7);

    if (liquidity === 0n) throw new Error("Posición cerrada (liquidez = 0).");

    const [t0, t1] = await Promise.all([
      tokenInfo(rpcs[0], token0addr),
      tokenInfo(rpcs[0], token1addr),
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
      const poolRaw = (await rpcCallWithFallback(rpcs, factory, getPoolData)).slice(2);
      const poolAddr = "0x" + poolRaw.slice(24);
      if (poolAddr !== "0x0000000000000000000000000000000000000000") {
        poolAddress = poolAddr.toLowerCase();
        // slot0() = 0x3850c7bd → sqrtPriceX96
        const s0 = (await rpcCallWithFallback(rpcs, poolAddress, "0x3850c7bd")).slice(2);
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

export const fetchPositionLiquidity = action({
  args: { tokenId: v.number(), network: v.string(), priceUsd: v.number(), poolAddress: v.optional(v.string()) },
  handler: async (_ctx, { tokenId, network, priceUsd, poolAddress: knownPoolAddress }) => {
    const rpcs = RPC[network];
    const nft  = NFT_MANAGER[network];
    const factory = FACTORY[network];
    if (!rpcs || !nft || !factory) return { liquidityUsd: 0, exposure: 0 };
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { liquidityUsd: 0, exposure: 0 };

    let posRaw: string;
    try {
      posRaw = (await rpcCallWithFallback(rpcs, nft, "0x99fbab88" + pad(BigInt(tokenId)))).slice(2);
    } catch { return { liquidityUsd: 0, exposure: 0 }; }
    if (posRaw.length < 64 * 12) return { liquidityUsd: 0, exposure: 0 };

    const token0addr = addrAt(posRaw, 2);
    const token1addr = addrAt(posRaw, 3);
    const fee        = Number(uintAt(posRaw, 4));
    const tickLower  = Number(intAt(posRaw, 5));
    const tickUpper  = Number(intAt(posRaw, 6));
    const liqRaw     = uintAt(posRaw, 7);

    if (liqRaw === 0n) return { liquidityUsd: 0, exposure: 0 };

    let t0: { symbol: string; decimals: number };
    let t1: { symbol: string; decimals: number };
    try {
      [t0, t1] = await Promise.all([tokenInfo(rpcs[0], token0addr), tokenInfo(rpcs[0], token1addr)]);
    } catch { return { liquidityUsd: 0, exposure: 0 }; }

    // Usar poolAddress ya conocido para evitar la llamada al factory (ahorra 1 RPC)
    let sp: number;
    try {
      let poolAddr = knownPoolAddress?.toLowerCase();
      if (!poolAddr) {
        const getPoolData = "0x1698ee82" +
          token0addr.slice(2).padStart(64, "0") +
          token1addr.slice(2).padStart(64, "0") +
          pad(BigInt(fee));
        const poolRaw = (await rpcCallWithFallback(rpcs, factory, getPoolData)).slice(2);
        poolAddr = ("0x" + poolRaw.slice(24)).toLowerCase();
      }
      if (poolAddr === "0x0000000000000000000000000000000000000000") return { liquidityUsd: 0, exposure: 0 };
      const s0 = (await rpcCallWithFallback(rpcs, poolAddr, "0x3850c7bd")).slice(2);
      sp = Number(uintAt(s0, 0)) / 2 ** 96;
    } catch { return { liquidityUsd: 0, exposure: 0 }; }

    if (!Number.isFinite(sp) || sp <= 0) return { liquidityUsd: 0, exposure: 0 };

    // Sqrt prices at tick bounds (raw, not decimal-adjusted — same units as sp)
    const sa = Math.sqrt(Math.pow(1.0001, tickLower));
    const sb = Math.sqrt(Math.pow(1.0001, tickUpper));
    if (sa >= sb) return { liquidityUsd: 0, exposure: 0 };

    const L = Number(liqRaw);

    // Uniswap V3 amounts in raw (smallest) token units
    let amount0_raw = 0, amount1_raw = 0;
    if (sp <= sa) {
      amount0_raw = L * (sb - sa) / (sa * sb);
    } else if (sp >= sb) {
      amount1_raw = L * (sb - sa);
    } else {
      amount0_raw = L * (sb - sp) / (sp * sb);
      amount1_raw = L * (sp - sa);
    }

    const amount0 = amount0_raw / Math.pow(10, t0.decimals);
    const amount1 = amount1_raw / Math.pow(10, t1.decimals);

    const invert = STABLES.has(t0.symbol);
    // invert=true: token0 is stable (USDC), token1 is base (WETH/WBTC)
    const liquidityUsd = invert
      ? amount0 + amount1 * priceUsd
      : amount0 * priceUsd + amount1;

    if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return { liquidityUsd: 0, exposure: 0 };

    const baseValue = invert ? amount1 * priceUsd : amount0 * priceUsd;
    const exposure = Math.min(1, Math.max(0, baseValue / liquidityUsd));

    // Check Revert Finance Lend: ownerOf → loanInfo
    let borrowHealth = 0;
    let leverageRevert = 0;
    let healthFactor = 0;
    let amountToRepay = 0;
    let liquidationThreshold = 0;
    let availableToBorrow = 0;
    const vaultAddr = REVERT_VAULT[network];
    if (vaultAddr) {
      try {
        // ownerOf(uint256) = 0x6352211e
        const ownerRaw = (await rpcCallWithFallback(rpcs, nft, "0x6352211e" + pad(BigInt(tokenId)))).slice(2);
        const owner = "0x" + ownerRaw.slice(24).toLowerCase();
        if (owner === vaultAddr.toLowerCase()) {
          // loanInfo(uint256) = 0x8349d6be → (debt, fullValue, collateralValue, liquidationCost, liquidationValue)
          const loanRaw = (await rpcCallWithFallback(rpcs, vaultAddr, "0x8349d6be" + pad(BigInt(tokenId)))).slice(2);
          if (loanRaw.length >= 64 * 3) {
            const debt       = uintAt(loanRaw, 0);
            const fullValue  = uintAt(loanRaw, 1);
            const collateral = uintAt(loanRaw, 2);
            if (debt > 0n && collateral > 0n && fullValue > 0n) {
              const hf = Number(collateral) / Number(debt);
              borrowHealth   = Math.max(0, Math.min(100, Math.round((hf - 1) * 100)));
              healthFactor   = Math.round(hf * 100) / 100;
              amountToRepay  = Math.round(Number(debt) / 1e6 * 100) / 100;
              // liquidationThreshold = LP value at which collateral = debt
              liquidationThreshold = Math.round(Number(debt) * Number(fullValue) / Number(collateral) / 1e6 * 100) / 100;
              // available to borrow ≈ collateral × 95% safety buffer − debt
              availableToBorrow = Math.max(0, Math.round((Number(collateral) * 0.95 - Number(debt)) / 1e6 * 100) / 100);
              // LTV = debt / fullValue (loan-to-value, more honest than leverage)
              leverageRevert = Math.round(Number(debt) / Number(fullValue) * 1000) / 10;
            }
          }
        }
      } catch {
        // Not in vault or oracle failure — no borrow data
      }
    }

    return {
      liquidityUsd: Math.round(liquidityUsd * 100) / 100,
      exposure: Math.round(exposure * 1000) / 1000,
      borrowHealth,
      leverageRevert,
      healthFactor,
      amountToRepay,
      liquidationThreshold,
      availableToBorrow,
    };
  },
});

// Cron de detección de cierre de posiciones LP (JAV-35).
// Recorre todos los pools con tokenId, lee su estado on-chain y persiste el
// resultado de forma atómica. El caso crítico es el cierre EXTERNO (el usuario
// cierra en Uniswap/Revert y el portal no se entera por otra vía).
export const checkAllPoolClosures = internalAction({
  args: {},
  // Promise<any>: corta el ciclo de inferencia de tipos (TS2589) del grafo de funciones internas.
  handler: async (ctx): Promise<any> => {
    const pools = await ctx.runQuery(internal.pools.listPoolsInternal);
    let closed = 0, reopened = 0, unavailable = 0, skipped = 0, errored = 0;

    for (const pool of pools) {
      if (!pool.tokenId) { skipped++; continue; }
      const rpcs = RPC[pool.network];
      const nft = NFT_MANAGER[pool.network];
      if (!rpcs || !nft) { skipped++; continue; }

      // Aislar cada pool: un fallo no debe abortar el chequeo del resto.
      try {
        const status = await readPositionStatus(rpcs, nft, pool.tokenId);

        if (status === "unavailable") {
          // RPC caído: no concluir nada, solo registrar que se intentó.
          await ctx.runMutation(internal.pools.touchPoolChecked, { id: pool._id });
          unavailable++;
        } else if (status === "empty" || status === "not_found") {
          await ctx.runMutation(internal.pools.markPoolClosedAndPauseBots, { id: pool._id, reason: status });
          closed++;
        } else {
          // active: si estaba marcado como cerrado, reabrir (posición re-fondeada).
          await ctx.runMutation(internal.pools.reopenPoolIfClosed, { id: pool._id });
          reopened++;
        }
      } catch (e) {
        errored++;
        console.error(`checkAllPoolClosures: fallo en pool ${pool._id}`, e);
      }
    }

    return { total: pools.length, closed, reopened, unavailable, skipped, errored };
  },
});
