"use node";

import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { requireAuth } from "../helpers";   // (JAV-38 #8) exigir auth en las actions públicas

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

// (JAV-117) Alchemy SOLO para eth_getLogs (histórico de eventos). El eth_call en tiempo real sigue en
// los RPC públicos de arriba. Subdominio por red; la MISMA API key (ALCHEMY_API_KEY) sirve para todas.
const ALCHEMY_SUBDOMAIN: Record<string, string> = {
  Ethereum: "eth-mainnet",
  Arbitrum: "arb-mainnet",
  Optimism: "opt-mainnet",
  Base:     "base-mainnet",
};

// topic0 de los eventos del NonfungiblePositionManager (tokenId es indexed = topic1 en los tres).
// En los tres, data = [ (liquidity|recipient), amount0, amount1 ] → amount0 en word 1, amount1 en word 2.
const TOPIC_INCREASE = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f"; // IncreaseLiquidity(uint256,uint128,uint256,uint256)
const TOPIC_DECREASE = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4"; // DecreaseLiquidity(uint256,uint128,uint256,uint256)
const TOPIC_COLLECT  = "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01"; // Collect(uint256,address,uint256,uint256)
const TOPIC_TO_TYPE: Record<string, "increase" | "decrease" | "collect"> = {
  [TOPIC_INCREASE]: "increase",
  [TOPIC_DECREASE]: "decrease",
  [TOPIC_COLLECT]:  "collect",
};

// Margen anti-reorg por red: bloques desde el head que NO consideramos finalizados. L2s reorganizan;
// se re-escanea una ventana y se borran/recalculan los logs >= fromBlock antes de reinsertar.
const CONFIRMATIONS: Record<string, number> = {
  Ethereum: 12,
  Arbitrum: 20,
  Optimism: 20,
  Base:     20,
};

// Alchemy Free limita eth_getLogs a rangos de 10 bloques. Chunking + presupuesto duro por corrida; lo
// no alcanzado queda `stale` y continúa el próximo ciclo (decisión C). PAYG admite rangos mayores.
const ALCHEMY_GETLOGS_MAX_RANGE = 10;
const GETLOGS_MAX_CHUNKS_PER_RUN = 40;   // presupuesto: ≤40 requests/posición/corrida (≈400 bloques)

const STABLES = new Set(["USDC", "USDT", "DAI", "BUSD", "FRAX", "LUSD", "USDC.e", "USDbC"]);
const NORMALIZE: Record<string, string> = { WETH: "ETH", WBTC: "BTC" };
function norm(sym: string): string { return NORMALIZE[sym] ?? sym; }

const RPC_TIMEOUT_MS = 8_000;

// El contrato respondió y revirtió la ejecución (p.ej. tokenId inexistente).
// Distinto de un fallo de transporte (timeout, 5xx, red caída): un revert es
// una respuesta determinista de la cadena, no una indisponibilidad del RPC.
class RpcRevertError extends Error {}

async function rpcCall(url: string, to: string, data: string, from?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    // `from` opcional: necesario para simular collect() (guard isAuthorizedForToken con msg.sender).
    const callObj = from ? { to, data, from } : { to, data };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [callObj, "latest"], id: 1 }),
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

async function rpcCallWithFallback(urls: string[], to: string, data: string, from?: string): Promise<string> {
  let lastErr: unknown;
  let revertErr: RpcRevertError | undefined;
  for (const url of urls) {
    try { return await rpcCall(url, to, data, from); }
    catch (e) {
      lastErr = e;
      // Un revert es determinista (todos los endpoints darían lo mismo); tiene
      // prioridad sobre errores de transporte para clasificar el resultado.
      if (e instanceof RpcRevertError) revertErr = e;
    }
  }
  throw revertErr ?? lastErr;
}

// (JAV-117) URL de Alchemy por red desde ALCHEMY_API_KEY. null si falta la key o la red no está mapeada
// (la feature degrada a estado `no_key`, sin romper el scanner). SOLO para eth_getLogs.
function alchemyUrl(network: string): string | null {
  const key = process.env.ALCHEMY_API_KEY;
  const sub = ALCHEMY_SUBDOMAIN[network];
  if (!key || !sub) return null;
  return `https://${sub}.g.alchemy.com/v2/${key}`;
}

type RpcLog = { transactionHash: string; logIndex: string; blockNumber: string; blockHash: string; topics: string[]; data: string };

// eth_getLogs vía Alchemy. fromBlock/toBlock en número decimal (se convierten a hex). Filtra por
// address (NFT manager) + topic0 (los 3 eventos como OR) + topic1 (tokenId indexed) → trae solo los
// eventos de esa posición. Lanza en fallo de transporte; el caller decide stale/error.
async function rpcGetLogs(url: string, address: string, tokenIdTopic: string, fromBlock: number, toBlock: number): Promise<RpcLog[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const body = {
      jsonrpc: "2.0", method: "eth_getLogs", id: 1,
      params: [{
        address,
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
        topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdTopic],
      }],
    };
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    // (CodeRabbit seguridad) NUNCA incluir `url` en errores/logs: contiene ALCHEMY_API_KEY.
    if (!res.ok) throw new Error(`getLogs respondió ${res.status} ${res.statusText}`);
    const json = await res.json() as { result?: RpcLog[]; error?: { message?: string; code?: number } };
    if (json.error) throw new Error(`eth_getLogs error (${json.error.code ?? "?"}): ${json.error.message ?? ""}`);
    return json.result ?? [];
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`getLogs timeout (${RPC_TIMEOUT_MS}ms)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Bloque actual de la cadena (eth_blockNumber) vía RPC público (no consume Alchemy).
async function getLatestBlock(rpcs: string[]): Promise<number | null> {
  for (const url of rpcs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", id: 1 }), signal: controller.signal,
        });
        if (!res.ok) continue;
        const json = await res.json() as { result?: string };
        if (json.result) { const n = Number(BigInt(json.result)); if (Number.isFinite(n) && n > 0) return n; }
      } finally { clearTimeout(timer); }
    } catch { /* siguiente RPC */ }
  }
  return null;
}

// =====================================================================================
// (JAV-119) Back-fill GRATIS: getLogs por RPC público de archivo + range-halving + timestamp→bloque.
// =====================================================================================

// (JAV-119 v2) Proveedor de getLogs del BACK-FILL = Blockscout REST (gratis, SIN API key). Los RPC
// públicos sin key ya gatean eth_getLogs de archivo (drpc/publicnode), y Alchemy/Blast Free capan a 10
// bloques. Blockscout sirve los logs INDEXADOS y, clave, **filtra por topic1=tokenId** → aísla la posición
// aunque el owner sea una wallet custodial/compartida (lo que alchemy_getAssetTransfers no podía atribuir).
// NO se usa en el cron incremental (sigue con Alchemy). El `rpcUrl` opcional del back-fill mantiene el
// camino eth_getLogs clásico (p. ej. Alchemy PAYG) como escape manual.
const LOGS_BLOCKSCOUT: Record<string, string> = {
  Ethereum: "https://eth.blockscout.com",
  Arbitrum: "https://arbitrum.blockscout.com",
  Optimism: "https://optimism.blockscout.com",
  Base:     "https://base.blockscout.com",
};

// topic0 del evento Transfer ERC721 (tokenId = topic3 indexed). Sirve para hallar el bloque de mint real.
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Blockscout es más lento que un RPC (índice): ventana amplia puede tardar varios s → timeout más holgado.
const BLOCKSCOUT_TIMEOUT_MS = 25_000;

// El RPC rechazó el rango por demasiado amplio / demasiados resultados (no es un fallo de transporte):
// se resuelve partiendo el rango a la mitad y reintentando.
class GetLogsRangeTooLargeError extends Error {}

function isRangeTooLargeMsg(msg: string): boolean {
  return /range|too many results|too large|exceed|more than .* results|limit exceeded|query timeout|response size/i.test(msg);
}

// getLogs contra un proveedor concreto (sin key). Clasifica "rango muy grande" como
// GetLogsRangeTooLargeError para que el caller lo divida; el resto se propaga como error de transporte.
async function rawGetLogs(url: string, address: string, tokenIdTopic: string, fromBlock: number, toBlock: number): Promise<RpcLog[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const body = {
      jsonrpc: "2.0", method: "eth_getLogs", id: 1,
      params: [{
        address,
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
        topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdTopic],
      }],
    };
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!res.ok) {
      // (CodeRabbit) NO clasificar TODO 400 como rango grande: un 400 por params inválidos/método no
      // soportado haría bisecar hasta agotar presupuesto sin converger. Solo 413, o 400 cuyo body lo indica.
      let bodyText = "";
      try { bodyText = await res.text(); } catch { /* sin body */ }
      if (res.status === 413 || (res.status === 400 && isRangeTooLargeMsg(bodyText))) {
        throw new GetLogsRangeTooLargeError(`HTTP ${res.status}`);
      }
      throw new Error(`getLogs respondió ${res.status}`);   // sin url ni body (pueden llevar secretos)
    }
    const json = await res.json() as { result?: RpcLog[]; error?: { message?: string; code?: number } };
    if (json.error) {
      const msg = json.error.message ?? "";
      if (isRangeTooLargeMsg(msg)) throw new GetLogsRangeTooLargeError(msg);
      throw new Error(`eth_getLogs error (${json.error.code ?? "?"}): ${msg}`);
    }
    return json.result ?? [];
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") throw new GetLogsRangeTooLargeError(`timeout ${RPC_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Intenta un rango contra varios proveedores. Devuelve los logs si ALGUNO responde; "range" si todos lo
// rechazaron por tamaño (→ el caller parte el rango); o lanza si todos fallan por transporte.
async function getLogsRangeMulti(urls: string[], address: string, tokenIdTopic: string, from: number, to: number): Promise<{ ok: true; logs: RpcLog[] } | { ok: "range" }> {
  let sawRange = false;
  let lastErr: unknown;
  for (const url of urls) {
    try { return { ok: true, logs: await rawGetLogs(url, address, tokenIdTopic, from, to) }; }
    catch (e) {
      if (e instanceof GetLogsRangeTooLargeError) { sawRange = true; continue; }
      lastErr = e;
    }
  }
  if (sawRange) return { ok: "range" };
  throw lastErr ?? new Error("getLogs: todos los proveedores fallaron");
}

// Resultado de leer una ventana: logs leídos, o "range" si hay que partirla (rango muy grande / timeout).
type RangeResult = { ok: true; logs: RpcLog[] } | { ok: "range" };
type RangeFetcher = (lo: number, hi: number) => Promise<RangeResult>;

// Recorre [from, to] con una pila de subrangos: si `fetchRange` pide partir ("range"), lo divide a la
// mitad; acumula todos los logs. Acotado por un presupuesto de requests (one-off). Devuelve los logs y si
// se completó (false = se agotó el presupuesto → el caller NO certifica). Un error de transporte/proveedor
// (que no sea "range") se propaga → el caller NO muta. Genérico sobre el proveedor (eth RPC o Blockscout).
async function getLogsAdaptive(fetchRange: RangeFetcher, from: number, to: number, initialSpan: number, budget: number): Promise<{ logs: RpcLog[]; complete: boolean }> {
  const out: RpcLog[] = [];
  // Pila de [lo, hi] pendientes, en trozos de initialSpan (de mayor a menor bloque para procesar antes lo reciente).
  const stack: Array<[number, number]> = [];
  for (let lo = from; lo <= to; lo += initialSpan) stack.push([lo, Math.min(lo + initialSpan - 1, to)]);
  let calls = 0;
  while (stack.length) {
    if (calls >= budget) return { logs: out, complete: false };
    const [lo, hi] = stack.pop()!;
    calls++;
    const r = await fetchRange(lo, hi);
    if (r.ok === true) { for (const l of r.logs) out.push(l); continue; }
    // Rango rechazado: partir a la mitad (si ya es 1 bloque y aun así lo rechaza, no es por rango → abortar).
    if (hi <= lo) throw new Error(`getLogs rechaza un solo bloque ${lo}; no es problema de rango`);
    const mid = Math.floor((lo + hi) / 2);
    stack.push([mid + 1, hi]);
    stack.push([lo, mid]);
  }
  return { logs: out, complete: true };
}

// ===== Blockscout REST: getLogs indexado por tokenId + mint + estado de indexación + relleno de blockHash =====

// Una página de getLogs vía Blockscout REST (Etherscan-compatible). Devuelve logs (blockHash="" se rellena
// después). status:"0" con "No records found" ⇒ []; otro status:0 ⇒ Error (no mutar). HTTP 429/403/401/5xx
// ⇒ Error (abortar, NO halving). timeout ⇒ GetLogsRangeTooLargeError (→ halving).
async function blockscoutLogsPage(baseUrl: string, params: Record<string, string>): Promise<RpcLog[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLOCKSCOUT_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({ module: "logs", action: "getLogs", ...params }).toString();
    const res = await fetch(`${baseUrl}/api?${qs}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`blockscout HTTP ${res.status}`);   // 429/403/5xx/deprecación → abortar
    const json = await res.json() as { status?: string; message?: string; result?: any };
    if (json.status === "1" && Array.isArray(json.result)) {
      return json.result.map((l: any): RpcLog => ({
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
        blockNumber: l.blockNumber,
        blockHash: "",                       // la API legacy NO lo trae → se rellena vía eth_getBlockByNumber
        topics: (l.topics ?? []).filter((t: string | null) => t != null),
        data: l.data ?? "0x",
      }));
    }
    // status "0": vacío SOLO si "No records found"; cualquier otro es error (no mutar).
    if (json.status === "0" && /no records found/i.test(json.message ?? "")) return [];
    throw new Error(`blockscout getLogs status=${json.status} msg=${json.message ?? ""}`);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") throw new GetLogsRangeTooLargeError(`blockscout timeout ${BLOCKSCOUT_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Lee TODOS los logs de la posición en [from,to] (paginando). Camino primario: filtrar SOLO por
// topic1=tokenId (1 request/ventana) y descartar topic0 desconocidos localmente. Fallback: 3 requests
// (una por topic0) si el camino primario falla por params (no por timeout/HTTP duro).
async function blockscoutGetLogsWindow(baseUrl: string, address: string, tokenIdTopic: string, from: number, to: number): Promise<RpcLog[]> {
  const base = { address, fromBlock: String(from), toBlock: String(to), offset: "1000" };
  const paged = async (extra: Record<string, string>): Promise<RpcLog[]> => {
    const acc: RpcLog[] = [];
    for (let page = 1; page <= 50; page++) {           // tope duro anti-runaway (50k logs/ventana)
      const got = await blockscoutLogsPage(baseUrl, { ...base, ...extra, page: String(page) });
      acc.push(...got);
      if (got.length < 1000) return acc;               // última página
    }
    throw new Error("blockscout: paginación excede el tope (50 páginas)");   // no truncar en silencio
  };
  const known = new Set([TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT]);
  try {
    const logs = await paged({ topic1: tokenIdTopic });                      // primario: topic1-solo
    return logs.filter(l => known.has((l.topics?.[0] ?? "").toLowerCase()));
  } catch (e) {
    if (e instanceof GetLogsRangeTooLargeError) throw e;                      // timeout → halving
    if (e instanceof Error && /HTTP \d+/.test(e.message)) throw e;           // 429/403/5xx → abortar
    // (CodeRabbit) El fallback a 3×topic0 es SOLO para el caso "Blockscout exige topic0"; cualquier otro
    // error status:0 (rate limit, backend, params) NO debe enmascararse → se relanza (no mutar).
    const requiresTopic0 = e instanceof Error && /(topic0|topic.*required|required.*topic|invalid.*topic|unsupported.*filter)/i.test(e.message);
    if (!requiresTopic0) throw e;
    // Fallback: 3 llamadas por topic0 (algunos Blockscout exigen topic0).
    const out: RpcLog[] = [];
    for (const t0 of [TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT]) {
      out.push(...await paged({ topic0: t0, topic1: tokenIdTopic, topic0_1_opr: "and" }));
    }
    return out;
  }
}

// Fetcher para getLogsAdaptive sobre Blockscout: timeout ⇒ "range" (partir); el resto se propaga (no mutar).
function blockscoutFetcher(baseUrl: string, address: string, tokenIdTopic: string): RangeFetcher {
  return async (lo, hi) => {
    try { return { ok: true, logs: await blockscoutGetLogsWindow(baseUrl, address, tokenIdTopic, lo, hi) }; }
    catch (e) { if (e instanceof GetLogsRangeTooLargeError) return { ok: "range" }; throw e; }
  };
}

// Bloque de MINT real del tokenId desde el índice de Blockscout (transfers de la instancia NFT). El Transfer
// `from 0x0` es el origen on-chain → arrancar ahí certifica histórico y acota el escaneo (1 llamada). null
// si no se puede determinar (red sin Blockscout, error) → el caller cae a start=0 o no certifica.
async function findMintBlock(baseUrl: string, nft: string, tokenId: number): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLOCKSCOUT_TIMEOUT_MS);
  try {
    let url: string | null = `${baseUrl}/api/v2/tokens/${nft}/instances/${tokenId}/transfers`;
    for (let page = 0; page < 50 && url; page++) {        // pagina hasta hallar el mint (o agotar)
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const json = await res.json() as { items?: any[]; next_page_params?: any };
      for (const t of json.items ?? []) {
        const from = (t.from?.hash ?? "").toLowerCase();
        if (from === "0x0000000000000000000000000000000000000000" && typeof t.block_number === "number") {
          return t.block_number;
        }
      }
      const np = json.next_page_params;
      url = np ? `${baseUrl}/api/v2/tokens/${nft}/instances/${tokenId}/transfers?${new URLSearchParams(np).toString()}` : null;
    }
    return null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// ¿Blockscout terminó de indexar bloques? Solo se CERTIFICA (ok/backfilledAt) si está completo; si no, NO
// se muta. true ⟺ finished_indexing_blocks o indexed_blocks_ratio === "1". Ante error/duda ⇒ false (no mutar).
async function blockscoutFullyIndexed(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/v2/main-page/indexing-status`, { signal: controller.signal });
    if (!res.ok) return false;
    const json = await res.json() as { finished_indexing_blocks?: boolean; indexed_blocks_ratio?: string };
    // (CodeRabbit) El booleano explícito MANDA: si viene false, NO permitir que indexed_blocks_ratio lo
    // sobreescriba (mutaría sobre índice incompleto). Solo se usa el ratio cuando el booleano no está.
    if (typeof json.finished_indexing_blocks === "boolean") return json.finished_indexing_blocks === true;
    return json.indexed_blocks_ratio === "1";
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// Hash de un bloque vía eth_getBlockByNumber (RPC público, sin key). null si ningún proveedor responde.
async function getBlockHashByNumber(rpcs: string[], blockNumber: number): Promise<string | null> {
  for (const url of rpcs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["0x" + blockNumber.toString(16), false], id: 1 }),
        signal: controller.signal,
      });
      if (res.ok) {
        const json = await res.json() as { result?: { hash?: string } };
        const hash = json.result?.hash;
        if (hash) return hash;
      }
    } catch { /* siguiente RPC */ }
    finally { clearTimeout(timer); }
  }
  return null;
}

// Rellena blockHash (ausente en la API legacy de Blockscout) por bloque DISTINTO. Devuelve los logs con su
// blockHash real, o null si ALGÚN bloque no se pudo resolver (⇒ logs incompletos ⇒ el caller NO certifica/NO muta).
async function fillBlockHashes(rpcs: string[], logs: RpcLog[]): Promise<RpcLog[] | null> {
  const distinct = [...new Set(logs.map(l => Number(BigInt(l.blockNumber))))];
  const byBlock = new Map<number, string>();
  for (const bn of distinct) {
    const hash = await getBlockHashByNumber(rpcs, bn);
    if (!hash) return null;
    byBlock.set(bn, hash);
  }
  return logs.map(l => ({ ...l, blockHash: byBlock.get(Number(BigInt(l.blockNumber)))! }));
}

// (JAV-117) Snapshot estructural de positions(): liquidity + feeGrowthInside0/1Last + tokensOwed0/1
// ALMACENADOS (slots 7..11). Estos solo cambian al modificar la posición (Increase/Decrease/Collect),
// NO con la acumulación pasiva de fees → key igual ⟺ no hubo evento desde el último ciclo.
async function readPositionSnapshotKey(rpcs: string[], nft: string, tokenId: number): Promise<string | null> {
  let posRaw: string;
  try {
    posRaw = (await rpcCallWithFallback(rpcs, nft, "0x99fbab88" + pad(BigInt(tokenId)))).slice(2);
  } catch { return null; }
  if (posRaw.length < 64 * 12) return null;
  try {
    const liquidity = uintAt(posRaw, 7);
    const fg0 = uintAt(posRaw, 8);
    const fg1 = uintAt(posRaw, 9);
    const owed0 = uintAt(posRaw, 10);
    const owed1 = uintAt(posRaw, 11);
    return `${liquidity}|${fg0}|${fg1}|${owed0}|${owed1}`;
  } catch { return null; }
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

// `ok` = símbolo Y decimals leídos de forma fiable (no el default silencioso "???"/18). Los
// callers de liquidez ignoran `ok` (comportamiento intacto); el cálculo de fees lo exige true
// para no convertir a USD con metadata inventada (Codex: sin defaults silenciosos).
async function tokenInfo(rpc: string, addr: string): Promise<{ symbol: string; decimals: number; ok: boolean }> {
  let symbol = "???";
  let decimals = 18;
  let symbolOk = false;
  let decimalsOk = false;
  try {
    const raw = (await rpcCall(rpc, addr, "0x95d89b41")).slice(2);
    if (raw.length >= 128) {
      const s = hexToUtf8(raw, 0);
      if (s) { symbol = s; symbolOk = true; }
    } else if (raw.length === 64) {
      // bytes32 fallback for old tokens
      const bytes: number[] = [];
      for (let i = 0; i < 32; i++) {
        const b = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
        if (b === 0) break;
        bytes.push(b);
      }
      const s = new TextDecoder().decode(new Uint8Array(bytes)).trim();
      if (s) { symbol = s; symbolOk = true; }
    }
  } catch {}
  try {
    const d = parseInt((await rpcCall(rpc, addr, "0x313ce567")).slice(2), 16);
    if (Number.isInteger(d) && d >= 0 && d <= 36) { decimals = d; decimalsOk = true; }
  } catch {}
  return { symbol, decimals, ok: symbolOk && decimalsOk };
}

function tickPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

// Núcleo de escaneo de una posición V3 SIN auth (lectura on-chain): par, rango, precio actual, pool.
// Lo usa la action pública scanPoolByTokenId (con requireAuth) y el cron de auto-curado (interno, sin auth).
// No consume cuota sin control: el cron lo gatea a pools que faltan; la action exige auth.
async function scanPositionCore(network: string, tokenId: number) {
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
}

export const scanPoolByTokenId = action({
  args: { tokenId: v.number(), network: v.string() },
  handler: async (ctx, { tokenId, network }) => {
    await requireAuth(ctx);   // (JAV-38 #8) no consumir RPC/cuota sin auth
    if (!Number.isFinite(tokenId) || !Number.isInteger(tokenId) || tokenId <= 0 || tokenId > Number.MAX_SAFE_INTEGER)
      throw new Error("Token ID inválido. Debe ser un entero positivo.");
    return await scanPositionCore(network, tokenId);
  },
});

// --- F1: fees acumulados SIN COBRAR de la posición (real-time) ---
const MAX_U128 = (1n << 128n) - 1n;

// (JAV-117 MED #1) Valuación USD de un par de cantidades raw de fees (uint128) con la MISMA lógica
// invert que liquidityUsd (token0 estable → base = token1). Compartida por uncollected y lifetime.
// Devuelve USD o null (metadata dudosa / invert ambiguo / no finito → null, nunca inventa).
function valueFeesUsd(
  amount0Raw: bigint, amount1Raw: bigint,
  t0: { symbol: string; decimals: number; ok: boolean },
  t1: { symbol: string; decimals: number; ok: boolean },
  priceUsd: number,
): number | null {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  if (!t0.ok || !t1.ok) return null;
  const stable0 = STABLES.has(t0.symbol);
  const stable1 = STABLES.has(t1.symbol);
  if (stable0 === stable1) return null;   // exactamente UNO debe ser stable
  const invert = stable0;
  const fees0 = Number(amount0Raw) / Math.pow(10, t0.decimals);
  const fees1 = Number(amount1Raw) / Math.pow(10, t1.decimals);
  if (!Number.isFinite(fees0) || !Number.isFinite(fees1)) return null;
  const feesUsd = invert ? fees0 + fees1 * priceUsd : fees0 * priceUsd + fees1;
  if (!Number.isFinite(feesUsd) || feesUsd < 0) return null;
  return Math.round(feesUsd * 100) / 100;
}

// (JAV-117 MED #1) Cantidades RAW (uint128) de fees cobrables AHORA (tokensOwed live) vía collect()
// simulado. collect() con liquidez hace pool.burn(...,0) (poke) → relee feeGrowthInside → devuelve el
// cobrable ACTUAL, no un checkpoint viejo. Simulación sin persistencia (from=owner para el guard).
// Devuelve {amount0Raw, amount1Raw} o null (fallo RPC/decodificación/corrupto → null, nunca 0 inventado).
async function fetchUncollectedFeesRaw(
  rpcs: string[], nft: string, tokenId: number,
): Promise<{ amount0Raw: bigint; amount1Raw: bigint } | null> {
  try {
    const ownerRaw = (await rpcCallWithFallback(rpcs, nft, "0x6352211e" + pad(BigInt(tokenId)))).slice(2);
    if (ownerRaw.length < 64) return null;
    const owner = "0x" + ownerRaw.slice(24);

    // collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) = 0xfc6f7865.
    const data = "0xfc6f7865"
      + pad(BigInt(tokenId))
      + owner.slice(2).padStart(64, "0")
      + pad(MAX_U128)
      + pad(MAX_U128);
    const res = (await rpcCallWithFallback(rpcs, nft, data, owner)).slice(2);
    if (res.length < 128) return null;
    const amount0Raw = uintAt(res, 0);
    const amount1Raw = uintAt(res, 1);
    // Cota natural: caben en uint128. Fuera de [0, 2^128) = dato corrupto.
    if (amount0Raw > MAX_U128 || amount1Raw > MAX_U128) return null;
    return { amount0Raw, amount1Raw };
  } catch {
    return null; // cualquier fallo de RPC/decodificación → sin dato (no 0)
  }
}

// Wrapper de compatibilidad: USD de fees sin cobrar (consumidores existentes intactos).
async function fetchUncollectedFeesUsd(
  rpcs: string[], nft: string, tokenId: number,
  t0: { symbol: string; decimals: number; ok: boolean },
  t1: { symbol: string; decimals: number; ok: boolean },
  priceUsd: number,
): Promise<number | null> {
  const raw = await fetchUncollectedFeesRaw(rpcs, nft, tokenId);
  if (!raw) return null;
  return valueFeesUsd(raw.amount0Raw, raw.amount1Raw, t0, t1, priceUsd);
}

// --- G3 (sizing de CAPITAL REAL): metadata ESTRICTA y lectura que FALLA CERRADO ---
// Lee symbol+decimals con FALLBACK real entre RPCs y devuelve null si NO se obtienen AMBOS de forma
// fiable (sin defaults silenciosos 18/"???"). Para dimensionar capital real un decimals errado daría
// un nocional 10^N veces mal; mejor no armar que armar con un tamaño dudoso.
async function tokenMetaStrict(rpcs: string[], addr: string): Promise<{ symbol: string; decimals: number } | null> {
  let symbol: string | null = null;
  try {
    const raw = (await rpcCallWithFallback(rpcs, addr, "0x95d89b41")).slice(2);
    if (raw.length >= 128) {
      const s = hexToUtf8(raw, 0);
      if (s) symbol = s;
    } else if (raw.length === 64) {
      const bytes: number[] = [];
      for (let i = 0; i < 32; i++) {
        const b = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
        if (b === 0) break;
        bytes.push(b);
      }
      const s = new TextDecoder().decode(new Uint8Array(bytes)).trim();
      if (s) symbol = s;
    }
  } catch { return null; }
  if (!symbol) return null;
  let decimals: number | null = null;
  try {
    const d = parseInt((await rpcCallWithFallback(rpcs, addr, "0x313ce567")).slice(2), 16);
    if (Number.isInteger(d) && d >= 0 && d <= 36) decimals = d;
  } catch { return null; }
  if (decimals === null) return null;
  return { symbol, decimals };
}

// Nocional USD AUTORITATIVO de la posición LP para dimensionar la cobertura. FALLA CERRADO: cualquier
// fallo de lectura / metadata dudosa / invert ambiguo → null (el llamador NO arma). Reutiliza la
// misma matemática V3 que fetchPositionLiquidity pero con metadata estricta y fallback entre RPCs.
// reason (CodeRabbit #4): distingue fallos TRANSITORIOS (RPC) de DETERMINISTAS (empty/unsupported)
// para que el motor NO reintente para siempre un LP vacío o no soportado.
//  - "ok": liquidityUsd válido.  - "empty": el LP no tiene liquidez (no hay cobertura que dimensionar).
//  - "unsupported": pool/metadata/par no dimensionables de forma fiable (config, no reintentar).
//  - "transient": fallo de lectura RPC (reintentable).
type NotionalResult = { liquidityUsd: number; reason: "ok" | "empty" | "unsupported" | "transient" };

export const fetchPositionNotionalStrict = internalAction({
  args: { tokenId: v.number(), network: v.string(), priceUsd: v.number(), poolAddress: v.optional(v.string()) },
  handler: async (_ctx, { tokenId, network, priceUsd, poolAddress: knownPoolAddress }): Promise<NotionalResult> => {
    const rpcs = RPC[network];
    const nft  = NFT_MANAGER[network];
    const factory = FACTORY[network];
    if (!rpcs || !nft || !factory) return { liquidityUsd: 0, reason: "unsupported" };
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { liquidityUsd: 0, reason: "unsupported" };

    let posRaw: string;
    try {
      posRaw = (await rpcCallWithFallback(rpcs, nft, "0x99fbab88" + pad(BigInt(tokenId)))).slice(2);
    } catch { return { liquidityUsd: 0, reason: "transient" }; }
    if (posRaw.length < 64 * 12) return { liquidityUsd: 0, reason: "transient" };

    const token0addr = addrAt(posRaw, 2);
    const token1addr = addrAt(posRaw, 3);
    const fee        = Number(uintAt(posRaw, 4));
    const tickLower  = Number(intAt(posRaw, 5));
    const tickUpper  = Number(intAt(posRaw, 6));
    const liqRaw     = uintAt(posRaw, 7);
    if (liqRaw === 0n) return { liquidityUsd: 0, reason: "empty" };   // sin liquidez = nada que dimensionar

    // Metadata ESTRICTA (fail-closed) de ambos tokens.
    const [m0, m1] = await Promise.all([tokenMetaStrict(rpcs, token0addr), tokenMetaStrict(rpcs, token1addr)]);
    if (!m0 || !m1) return { liquidityUsd: 0, reason: "unsupported" };
    // invert ESTRICTO: exactamente UN token es stable (si no, no se puede saber el activo base).
    const stable0 = STABLES.has(m0.symbol);
    const stable1 = STABLES.has(m1.symbol);
    if (stable0 === stable1) return { liquidityUsd: 0, reason: "unsupported" };
    const invert = stable0;

    // (CodeRabbit #1) Pool CANÓNICO desde el factory (autoritativo) — NO confiar en knownPoolAddress
    // para dimensionar capital real. Si el address guardado no coincide → unsupported (no reintentar).
    let sp: number;
    try {
      const getPoolData = "0x1698ee82" +
        token0addr.slice(2).padStart(64, "0") + token1addr.slice(2).padStart(64, "0") + pad(BigInt(fee));
      const poolRaw = (await rpcCallWithFallback(rpcs, factory, getPoolData)).slice(2);
      const poolAddr = ("0x" + poolRaw.slice(24)).toLowerCase();
      if (poolAddr === "0x0000000000000000000000000000000000000000") return { liquidityUsd: 0, reason: "unsupported" };
      if (knownPoolAddress && knownPoolAddress.toLowerCase() !== poolAddr) {
        console.error(`fetchPositionNotionalStrict: poolAddress no coincide con el del factory (${knownPoolAddress} vs ${poolAddr})`);
        return { liquidityUsd: 0, reason: "unsupported" };
      }
      const s0 = (await rpcCallWithFallback(rpcs, poolAddr, "0x3850c7bd")).slice(2);
      sp = Number(uintAt(s0, 0)) / 2 ** 96;
    } catch { return { liquidityUsd: 0, reason: "transient" }; }
    if (!Number.isFinite(sp) || sp <= 0) return { liquidityUsd: 0, reason: "transient" };

    const sa = Math.sqrt(Math.pow(1.0001, tickLower));
    const sb = Math.sqrt(Math.pow(1.0001, tickUpper));
    if (sa >= sb) return { liquidityUsd: 0, reason: "unsupported" };
    const L = Number(liqRaw);

    let amount0_raw = 0, amount1_raw = 0;
    if (sp <= sa) { amount0_raw = L * (sb - sa) / (sa * sb); }
    else if (sp >= sb) { amount1_raw = L * (sb - sa); }
    else { amount0_raw = L * (sb - sp) / (sp * sb); amount1_raw = L * (sp - sa); }

    const amount0 = amount0_raw / Math.pow(10, m0.decimals);
    const amount1 = amount1_raw / Math.pow(10, m1.decimals);
    const liquidityUsd = invert ? amount0 + amount1 * priceUsd : amount0 * priceUsd + amount1;
    if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) return { liquidityUsd: 0, reason: "unsupported" };
    if (liquidityUsd === 0) return { liquidityUsd: 0, reason: "empty" };
    return { liquidityUsd: Math.round(liquidityUsd * 100) / 100, reason: "ok" };
  },
});

export const fetchPositionLiquidity = action({
  // (JAV-58 Fase D) entryPriceUsd opcional: con la MISMA lectura de L/rango se hace una 2ª valuación
  // al precio de entrada para el PNL. Read-only; no toca ejecución/margen.
  // (JAV-117) Agregados lifetime cacheados (raw) opcionales: si vienen, se devuelve feesLifetimeUsd =
  // valuar(feesCollectedRaw + max(0, tokensOwedLive − principalDebt)) a precio spot. Solo display.
  args: {
    tokenId: v.number(), network: v.string(), priceUsd: v.number(),
    poolAddress: v.optional(v.string()), entryPriceUsd: v.optional(v.number()),
    feesCollectedRaw0: v.optional(v.string()), feesCollectedRaw1: v.optional(v.string()),
    principalDebt0: v.optional(v.string()), principalDebt1: v.optional(v.string()),
  },
  handler: async (ctx, { tokenId, network, priceUsd, poolAddress: knownPoolAddress, entryPriceUsd,
    feesCollectedRaw0, feesCollectedRaw1, principalDebt0, principalDebt1 }) => {
    await requireAuth(ctx);   // (JAV-38 #8) no consumir RPC/cuota sin auth
    const rpcs = RPC[network];
    const nft  = NFT_MANAGER[network];
    const factory = FACTORY[network];
    if (!rpcs || !nft || !factory) return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd: null };
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd: null };

    let posRaw: string;
    try {
      posRaw = (await rpcCallWithFallback(rpcs, nft, "0x99fbab88" + pad(BigInt(tokenId)))).slice(2);
    } catch { return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd: null }; }
    if (posRaw.length < 64 * 12) return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd: null };

    const token0addr = addrAt(posRaw, 2);
    const token1addr = addrAt(posRaw, 3);
    const fee        = Number(uintAt(posRaw, 4));
    const tickLower  = Number(intAt(posRaw, 5));
    const tickUpper  = Number(intAt(posRaw, 6));
    const liqRaw     = uintAt(posRaw, 7);

    // Metadata (compartida por liquidez y fees). tokenInfo nunca lanza (captura internamente);
    // el try/catch es defensa. Se hace ANTES del early-return de liquidez-cero para que el
    // bloque de fees pueda ejecutarse igual (una posición con liquidez 0 puede tener fees).
    let t0: { symbol: string; decimals: number; ok: boolean };
    let t1: { symbol: string; decimals: number; ok: boolean };
    try {
      [t0, t1] = await Promise.all([tokenInfo(rpcs[0], token0addr), tokenInfo(rpcs[0], token1addr)]);
    } catch { return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd: null }; }

    // Bloque INDEPENDIENTE de fees: no depende del flujo/early-returns de la liquidez ni del
    // orden de su cálculo. Su propio try/catch interno → null si algo falla (no degrada liquidez).
    // (JAV-117) Una sola lectura raw del cobrable live sirve para uncollected USD y lifetime USD.
    const owedRaw = await fetchUncollectedFeesRaw(rpcs, nft, tokenId);
    const feesUncollectedUsd = owedRaw ? valueFeesUsd(owedRaw.amount0Raw, owedRaw.amount1Raw, t0, t1, priceUsd) : null;

    // (JAV-117) Total generado = Σ fees cobrados (cache) + sin cobrar live, descontando el principal
    // pendiente del live (tokensOwed live incluye principal liberado por Decrease aún no cobrado).
    let feesLifetimeUsd: number | null = null;
    // (CodeRabbit) Exigir los CUATRO agregados cacheados: con parciales (default "0") se subcontaría
    // el total. Sin los cuatro → null (la UI muestra "—").
    const hasLifetimeAggregates =
      feesCollectedRaw0 != null && feesCollectedRaw1 != null &&
      principalDebt0 != null && principalDebt1 != null;
    if (owedRaw && hasLifetimeAggregates) {
      try {
        const debt0 = BigInt(principalDebt0);
        const debt1 = BigInt(principalDebt1);
        const unc0 = owedRaw.amount0Raw > debt0 ? owedRaw.amount0Raw - debt0 : 0n;
        const unc1 = owedRaw.amount1Raw > debt1 ? owedRaw.amount1Raw - debt1 : 0n;
        const life0 = BigInt(feesCollectedRaw0) + unc0;
        const life1 = BigInt(feesCollectedRaw1) + unc1;
        feesLifetimeUsd = valueFeesUsd(life0, life1, t0, t1, priceUsd);
      } catch { feesLifetimeUsd = null; }
    }

    if (liqRaw === 0n) return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd, feesLifetimeUsd };

    // Usar poolAddress ya conocido para evitar la llamada al factory (ahorra 1 RPC)
    let sp: number;
    let poolActiveLiq = 0;   // (fee APR concentrado) liquidez ACTIVA en-rango del pool (liquidity())
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
      if (poolAddr === "0x0000000000000000000000000000000000000000") return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd, feesLifetimeUsd };
      const s0 = (await rpcCallWithFallback(rpcs, poolAddr, "0x3850c7bd")).slice(2);
      sp = Number(uintAt(s0, 0)) / 2 ** 96;
      // (Fee APR concentrado) liquidity() = 0x1a686502 → liquidez activa en-rango. OPCIONAL: si falla
      // queda 0 → feeShareRatio null → el front cae al fee APR pool-wide (no rompe la valuación).
      try {
        const liqActiveRaw = (await rpcCallWithFallback(rpcs, poolAddr, "0x1a686502")).slice(2);
        poolActiveLiq = Number(uintAt(liqActiveRaw, 0));
      } catch { /* sin liquidez activa → fee APR pool-wide */ }
    } catch { return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd, feesLifetimeUsd }; }

    if (!Number.isFinite(sp) || sp <= 0) return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd, feesLifetimeUsd };

    // Sqrt prices at tick bounds (raw, not decimal-adjusted — same units as sp)
    const sa = Math.sqrt(Math.pow(1.0001, tickLower));
    const sb = Math.sqrt(Math.pow(1.0001, tickUpper));
    if (sa >= sb) return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd, feesLifetimeUsd };

    const L = Number(liqRaw);
    // (Fee APR concentrado) Fracción de la liquidez ACTIVA del pool que es de esta posición → el front
    // computa fees1d · feeShareRatio / valor · 365 · 100. SOLO si la posición está EN RANGO (sp entre
    // sa y sb): fuera de rango su L no aporta a la liquidez activa ni gana fees actuales → null (no
    // inflar el APR). Clamp ≤1: L forma parte de la liquidez activa, el ratio no puede superar 1;
    // >1 = lectura inconsistente → null. (Codex: edge fuera de rango.)
    // (Codex) Estado EXPLÍCITO para que el front no dependa de su propio pool.status (precio live,
    // otra fuente/latencia): el backend decide in-range desde el MISMO slot0 on-chain.
    //   "ok" → usar feeShareRatio · "out_of_range"/"inconsistent" → mostrar '—' (no inflar)
    //   "unavailable" → no se pudo leer liquidity() → el front puede caer al fee APR pool-wide.
    const inRange = sp > sa && sp < sb;
    let feeShareRatio: number | null = null;
    let feeShareStatus: "ok" | "out_of_range" | "inconsistent" | "unavailable";
    if (!(Number.isFinite(poolActiveLiq) && poolActiveLiq > 0)) {
      feeShareStatus = "unavailable";
    } else if (!inRange) {
      feeShareStatus = "out_of_range";
    } else if (!(Number.isFinite(L) && L > 0 && L <= poolActiveLiq)) {
      feeShareStatus = "inconsistent";
    } else {
      feeShareRatio = L / poolActiveLiq;
      feeShareStatus = "ok";
    }

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

    if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return { liquidityUsd: 0, exposure: 0, feesUncollectedUsd, feesLifetimeUsd };

    const baseValue = invert ? amount1 * priceUsd : amount0 * priceUsd;
    const exposure = Math.min(1, Math.max(0, baseValue / liquidityUsd));

    // (JAV-58 Fase D) Valor V3 de la posición al PRECIO DE ENTRADA (misma L/rango) → PNL = capital
    // ganado + fees. Requiere EXACTAMENTE un token stable para identificar base/quote y derivar el
    // sqrtPrice de entrada (sp en unidades raw token1/token0). Si no, null (no inventar PNL).
    let valueAtEntryUsd: number | null = null;
    const t0Stable = STABLES.has(t0.symbol), t1Stable = STABLES.has(t1.symbol);
    if (t0Stable !== t1Stable && Number.isFinite(entryPriceUsd) && (entryPriceUsd ?? 0) > 0) {
      const dexp = t1.decimals - t0.decimals;   // dec1 − dec0
      // invert=true (token0 stable, token1 base): rawRatio = (1/px)·10^dexp
      // invert=false (token1 stable, token0 base): rawRatio = px·10^dexp ; spAtEntry = sqrt(rawRatio)
      const rawRatioEntry = invert
        ? (1 / (entryPriceUsd as number)) * Math.pow(10, dexp)
        : (entryPriceUsd as number) * Math.pow(10, dexp);
      const spE = Math.sqrt(rawRatioEntry);
      if (Number.isFinite(spE) && spE > 0) {
        // Mismas fórmulas de amounts V3 que arriba, evaluadas en spE.
        let a0r = 0, a1r = 0;
        if (spE <= sa) a0r = L * (sb - sa) / (sa * sb);
        else if (spE >= sb) a1r = L * (sb - sa);
        else { a0r = L * (sb - spE) / (spE * sb); a1r = L * (spE - sa); }
        const a0 = a0r / Math.pow(10, t0.decimals);
        const a1 = a1r / Math.pow(10, t1.decimals);
        const vEntry = invert ? a0 + a1 * (entryPriceUsd as number) : a0 * (entryPriceUsd as number) + a1;
        if (Number.isFinite(vEntry) && vEntry > 0) valueAtEntryUsd = Math.round(vEntry * 100) / 100;
      }
    }

    // Check Revert Finance Lend: ownerOf → loanInfo
    let borrowHealth = 0;
    let leverageRevert = 0;
    let healthFactor = 0;
    let amountToRepay = 0;
    let liquidationThreshold = 0;
    let availableToBorrow = 0;
    // (revertVaultActive) NFT pertenece al vault de Revert. (revertLoanKnown) loanInfo se decodificó con
    // éxito (true aunque debt=0 = deuda conocida 0). Sirven para distinguir en la UI "en Revert sin deuda"
    // de "deuda desconocida (loanInfo falló)" y de "LP spot (no en vault)". Solo display; no afectan cálculos.
    let revertVaultActive = false;
    let revertLoanKnown = false;
    const vaultAddr = REVERT_VAULT[network];
    if (vaultAddr) {
      try {
        // ownerOf(uint256) = 0x6352211e
        const ownerRaw = (await rpcCallWithFallback(rpcs, nft, "0x6352211e" + pad(BigInt(tokenId)))).slice(2);
        const owner = "0x" + ownerRaw.slice(24).toLowerCase();
        if (owner === vaultAddr.toLowerCase()) {
          revertVaultActive = true;
          // loanInfo(uint256) = 0x8349d6be → (debt, fullValue, collateralValue, liquidationCost, liquidationValue)
          const loanRaw = (await rpcCallWithFallback(rpcs, vaultAddr, "0x8349d6be" + pad(BigInt(tokenId)))).slice(2);
          if (loanRaw.length >= 64 * 3) {
            const debt       = uintAt(loanRaw, 0);
            const fullValue  = uintAt(loanRaw, 1);
            const collateral = uintAt(loanRaw, 2);
            // revertLoanKnown SOLO si la deuda es interpretable: debt===0 (sin préstamo) o debt>0 con
            // collateral/fullValue válidos. Si debt>0 pero faltan → no fiable → false ("deuda: —"), no "sin deuda".
            if (debt === 0n) {
              revertLoanKnown = true;
            } else if (debt > 0n && collateral > 0n && fullValue > 0n) {
              revertLoanKnown = true;
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
      feesUncollectedUsd,
      feesLifetimeUsd,   // (JAV-117) total generado (cobrado + sin cobrar) o null si faltan agregados
      valueAtEntryUsd,   // (JAV-58 Fase D) para el PNL; null si no aplica
      feeShareRatio,     // (Fee APR concentrado) L_posición / L_activa del pool; solo si feeShareStatus==="ok"
      feeShareStatus,    // (Codex) "ok" | "out_of_range" | "inconsistent" | "unavailable"
      borrowHealth,
      leverageRevert,
      healthFactor,
      amountToRepay,
      liquidationThreshold,
      availableToBorrow,
      revertVaultActive,
      revertLoanKnown,
    };
  },
});

// Cron de detección de cierre de posiciones LP (JAV-35).
// Recorre todos los pools con tokenId, lee su estado on-chain y persiste el
// resultado de forma atómica. El caso crítico es el cierre EXTERNO (el usuario
// cierra en Uniswap/Revert y el portal no se entera por otra vía).
// (JAV-40 #13) Concurrencia máxima del chequeo de cierres: a lo sumo N RPC simultáneos por lote,
// para no superar el límite de ejecución de la action con muchos pools (RPC hasta 8s c/u).
const POOL_SCAN_CONCURRENCY = 5;
// (CodeRabbit) "active" (no "reopened"): esta rama cuenta TODOS los pools activos verificados, no
// solo las transiciones closed→open reales — esas se registran como eventos en `pool_events`.
type PoolScanCategory = "closed" | "active" | "unavailable" | "skipped" | "errored";

// (JAV-84 subtarea) Auto-curado de `initialLiquidityUsd`: si el pool tiene posición viva pero el campo
// falta, lo captura on-chain (precio slot0 + lectura AUTORITATIVA fetchPositionNotionalStrict, la MISMA que
// usa el motor) y lo persiste con patchPoolInitialLiquidity (idempotente). NOTA: para pools antiguos este
// valor es el PRIMER capturado por el sistema, no el valor al alta original. AISLADO: cualquier fallo
// devuelve "failed" sin lanzar → nunca rompe el chequeo de cierre del cron. ctx:any corta TS2589 del grafo.
async function backfillOneInitialLiquidity(ctx: any, pool: any): Promise<"filled" | "skipped" | "failed"> {
  if (!pool.tokenId || pool.initialLiquidityUsd != null) return "skipped";
  if (!RPC[pool.network] || !NFT_MANAGER[pool.network] || !FACTORY[pool.network]) return "skipped";
  try {
    const core = await scanPositionCore(pool.network, pool.tokenId);
    if (core.currentPrice == null || !(core.currentPrice > 0)) return "failed";
    const r = await ctx.runAction(internal.actions.poolScanner.fetchPositionNotionalStrict, {
      tokenId: pool.tokenId, network: pool.network, priceUsd: core.currentPrice, poolAddress: core.poolAddress,
    });
    if (r.reason !== "ok" || !Number.isFinite(r.liquidityUsd) || !(r.liquidityUsd > 0)) return "failed";
    await ctx.runMutation(internal.pools.patchPoolInitialLiquidity, {
      id: pool._id, initialLiquidityUsd: r.liquidityUsd, initialLiquidityAt: Date.now(),
    });
    return "filled";
  } catch (e) {
    console.error(`backfillOneInitialLiquidity: fallo en pool ${pool._id}`, e);
    return "failed";
  }
}

export const checkAllPoolClosures = internalAction({
  args: {},
  // Promise<any>: corta el ciclo de inferencia de tipos (TS2589) del grafo de funciones internas.
  handler: async (ctx): Promise<any> => {
    const pools = await ctx.runQuery(internal.pools.listPoolsInternal);

    // Worker por pool: AISLADO (su fallo no aborta al resto) y DEVUELVE una categoría — el caller
    // agrega los contadores secuencialmente (no se mutan contadores compartidos desde paralelas).
    const processPool = async (pool: typeof pools[number]): Promise<PoolScanCategory> => {
      if (!pool.tokenId) return "skipped";
      const rpcs = RPC[pool.network];
      const nft = NFT_MANAGER[pool.network];
      if (!rpcs || !nft) return "skipped";
      try {
        const status = await readPositionStatus(rpcs, nft, pool.tokenId);
        if (status === "unavailable") {
          // RPC caído: no concluir nada, solo registrar que se intentó.
          await ctx.runMutation(internal.pools.touchPoolChecked, { id: pool._id });
          return "unavailable";
        } else if (status === "empty" || status === "not_found") {
          await ctx.runMutation(internal.pools.markPoolClosedAndPauseBots, { id: pool._id, reason: status });
          return "closed";
        }
        // active: si estaba marcado como cerrado, reabrir (posición re-fondeada). reopenPoolIfClosed
        // solo registra el evento "reopened" si realmente venía cerrado (transición); aquí contamos activos.
        await ctx.runMutation(internal.pools.reopenPoolIfClosed, { id: pool._id });
        // Auto-curar initialLiquidityUsd solo si falta (coste puntual). AISLADO dentro del helper: su
        // fallo NO altera la categoría "active" del chequeo de cierre.
        if (pool.initialLiquidityUsd == null) await backfillOneInitialLiquidity(ctx, pool);
        return "active";
      } catch (e) {
        console.error(`checkAllPoolClosures: fallo en pool ${pool._id}`, e);
        return "errored";
      }
    };

    const counts: Record<PoolScanCategory, number> = { closed: 0, active: 0, unavailable: 0, skipped: 0, errored: 0 };
    // Lotes de concurrencia limitada: a lo sumo POOL_SCAN_CONCURRENCY RPC simultáneos.
    for (let i = 0; i < pools.length; i += POOL_SCAN_CONCURRENCY) {
      const batch = pools.slice(i, i + POOL_SCAN_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(processPool));
      for (const r of results) {
        if (r.status === "fulfilled") counts[r.value]++;
        else { counts.errored++; console.error("checkAllPoolClosures: worker rechazado", r.reason); }
      }
    }

    return { total: pools.length, ...counts };
  },
});

// =====================================================================================
// (JAV-117) Cron de refresco LIFETIME de fees — incremental con Alchemy Free + presupuesto + stale.
// =====================================================================================

// Decodifica un log de evento del NFT manager → fila de pool_fee_events. amount0 = word1, amount1 = word2
// (en los 3 eventos el word0 es liquidity/recipient). Devuelve null si el topic0 no es de los 3 o el
// data está malformado.
function decodePoolFeeLog(log: RpcLog): {
  txHash: string; logIndex: number; blockNumber: number; blockHash: string;
  eventType: "increase" | "decrease" | "collect"; amount0Raw: string; amount1Raw: string;
} | null {
  try {
    const topic0 = (log.topics?.[0] ?? "").toLowerCase();
    const eventType = TOPIC_TO_TYPE[topic0];
    if (!eventType) return null;
    const data = log.data?.startsWith("0x") ? log.data.slice(2) : (log.data ?? "");
    if (data.length < 64 * 3) return null;
    return {
      txHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      blockNumber: Number(BigInt(log.blockNumber)),
      blockHash: log.blockHash,
      eventType,
      amount0Raw: uintAt(data, 1).toString(),
      amount1Raw: uintAt(data, 2).toString(),
    };
  } catch { return null; }
}

type LifetimeCategory = "skipped" | "nochange" | "updated" | "stale" | "initialized" | "unavailable" | "errored" | "no_key";

// Worker AISLADO por pool. Decide entre: (a) avanzar cursor SIN getLogs si la señal estructural no
// cambió; (b) escanear incremental (chunked + presupuesto) ante cambio; (c) inicializar cursor si es
// la primera vez (el histórico lo rellena el back-fill externo, decisión A). ctx:any corta TS2589.
async function refreshOnePoolLifetime(ctx: any, pool: any): Promise<LifetimeCategory> {
  if (!pool.tokenId) return "skipped";
  const rpcs = RPC[pool.network];
  const nft = NFT_MANAGER[pool.network];
  if (!rpcs || !nft) return "skipped";

  const url = alchemyUrl(pool.network);
  if (!url) {
    if (pool.feesLifetimeStatus !== "no_key") {
      await ctx.runMutation(internal.pools.patchPoolLifetimeMeta, { poolId: pool._id, status: "no_key" });
    }
    return "no_key";
  }

  const currentKey = await readPositionSnapshotKey(rpcs, nft, pool.tokenId);
  if (currentKey == null) return "unavailable";   // RPC caído / no decodificable → no concluir
  const latest = await getLatestBlock(rpcs);
  if (latest == null) return "unavailable";
  const conf = CONFIRMATIONS[pool.network] ?? 20;
  const safeHead = latest - conf;
  if (safeHead <= 0) return "skipped";

  const cursor: number | null = pool.feesLifetimeCursorBlock ?? null;
  const storedKey: string | null = pool.lifetimeSnapshotKey ?? null;
  // (ALTO-2) status "ok" SOLO si el histórico está cubierto (back-fill completo). Sin él → como mucho "stale":
  // el incremental no prueba que existan los eventos anteriores al cursor inicial.
  const hasBackfill: boolean = pool.feesLifetimeBackfilledAt != null;
  const okOrStale = hasBackfill ? "ok" : "stale";

  // Primera vez: no intentamos back-fill amplio con Free (rango enorme). Inicializamos el cursor en el
  // safe head y marcamos `stale` (el total cobrado histórico lo rellena backfillPoolLifetime, decisión A).
  if (cursor == null) {
    await ctx.runMutation(internal.pools.patchPoolLifetimeMeta, {
      poolId: pool._id, cursorBlock: safeHead, snapshotKey: currentKey, status: "stale",
    });
    return "initialized";
  }

  // Sin cambio estructural → avanzar cursor sin pedir logs (camino barato, la mayoría de las corridas).
  // (ALTO-2) NO marcar "ok" si no hay back-fill: conservar "stale" para no presentar un total incompleto
  // como confiable.
  if (storedKey != null && currentKey === storedKey) {
    if (cursor < safeHead) {
      await ctx.runMutation(internal.pools.patchPoolLifetimeMeta, {
        poolId: pool._id, cursorBlock: safeHead, snapshotKey: currentKey, status: okOrStale,
      });
    }
    return "nochange";
  }

  // Cambio estructural (o key desconocida) → escanear incremental, chunked por rango + presupuesto.
  // (ALTO-1) STAGING: acumulamos los logs de la ventana contigua leída con ÉXITO y SOLO al final
  // reemplazamos atómicamente. Ante fallo de getLogs NO tocamos la tabla ni los agregados.
  const margin = conf;   // re-escaneo anti-reorg de una ventana corta
  const startBlock = Math.max(0, cursor + 1 - margin);
  const tokenIdTopic = "0x" + pad(BigInt(pool.tokenId));
  const staged: any[] = [];
  let fromBlock = startBlock;
  let scannedTo = startBlock - 1;
  let chunks = 0;
  let failed = false;
  while (fromBlock <= safeHead && chunks < GETLOGS_MAX_CHUNKS_PER_RUN) {
    const toBlock = Math.min(fromBlock + ALCHEMY_GETLOGS_MAX_RANGE - 1, safeHead);
    let logs: RpcLog[];
    try {
      logs = await rpcGetLogs(url, nft, tokenIdTopic, fromBlock, toBlock);
    } catch (e) {
      console.error(`refreshOnePoolLifetime: getLogs falló pool ${pool._id}`, e);
      failed = true;
      break;   // no romper la contigüidad; aplicamos solo lo leído OK
    }
    for (const ev of logs.map(decodePoolFeeLog)) { if (ev != null) staged.push(ev); }
    scannedTo = toBlock;
    fromBlock = toBlock + 1;
    chunks++;
  }

  // No se leyó NADA con éxito (falló el primer chunk): no mutar tabla; solo marcar error conservando todo.
  if (scannedTo < startBlock) {
    await ctx.runMutation(internal.pools.patchPoolLifetimeMeta, { poolId: pool._id, status: "error" });
    return "errored";
  }

  // Reemplazo atómico de la ventana contigua leída [startBlock, scannedTo] (borra+inserta+recompute).
  const reachedHead = !failed && scannedTo >= safeHead;
  await ctx.runMutation(internal.pools.applyPoolFeeEventsWindow, {
    poolId: pool._id,
    fromBlock: startBlock,
    toBlock: scannedTo,
    events: staged,
    cursorBlock: scannedTo,
    status: failed ? "error" : (reachedHead ? okOrStale : "stale"),
    // snapshotKey solo al ponerse al día sin fallos (si no, el próximo ciclo continúa el barrido pendiente).
    ...(reachedHead ? { snapshotKey: currentKey } : {}),
  });
  return failed ? "errored" : (reachedHead ? "updated" : "stale");
}

export const refreshAllPoolLifetimes = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const pools = await ctx.runQuery(internal.pools.listPoolsInternal);
    const targets = pools.filter((p: any) => p.tokenId && RPC[p.network] && NFT_MANAGER[p.network]);
    const counts: Record<LifetimeCategory, number> = {
      skipped: 0, nochange: 0, updated: 0, stale: 0, initialized: 0, unavailable: 0, errored: 0, no_key: 0,
    };
    for (let i = 0; i < targets.length; i += POOL_SCAN_CONCURRENCY) {
      const batch = targets.slice(i, i + POOL_SCAN_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((p: any) => refreshOnePoolLifetime(ctx, p)));
      for (const r of results) {
        if (r.status === "fulfilled") counts[r.value]++;
        else { counts.errored++; console.error("refreshAllPoolLifetimes: worker rechazado", r.reason); }
      }
    }
    return { total: targets.length, ...counts };
  },
});

// (JAV-117 decisión A · JAV-119 v2) Back-fill HISTÓRICO puntual: reconstruye el total cobrado leyendo TODOS
// los eventos de la posición. Por defecto GRATIS vía Blockscout (indexado, sin API key, filtra por tokenId →
// sirve para wallets custodiales). Arranca en el MINT real (Transfer from 0x0 desde el índice) → certifica
// histórico y acota el escaneo. `rpcUrl` opcional usa el camino eth_getLogs clásico (p. ej. Alchemy PAYG).
// Solo CERTIFICA/MUTA si: mint verificado + logs completos + blockHash completo + paginación completa +
// Blockscout fully indexed (Codex). Se dispara a MANO o vía backfillAllPoolLifetimes. Idempotente.
const BACKFILL_CALL_BUDGET = 2_000;   // tope de getLogs por pool (one-off, guard anti-runaway)
export const backfillPoolLifetime = internalAction({
  args: { poolId: v.id("pools"), fromBlock: v.optional(v.number()), rpcUrl: v.optional(v.string()) },
  handler: async (ctx, { poolId, fromBlock, rpcUrl }): Promise<any> => {
    const state: any = await ctx.runQuery(internal.pools.getPoolLifetimeStateInternal, { id: poolId });
    if (!state || state.tokenId == null) return { ok: false, reason: "pool sin tokenId" };
    const rpcs = RPC[state.network];
    const nft = NFT_MANAGER[state.network];
    if (!rpcs || !nft) return { ok: false, reason: "red no soportada" };
    const baseUrl = LOGS_BLOCKSCOUT[state.network];
    if (!rpcUrl && !baseUrl) return { ok: false, reason: "sin Blockscout para la red" };

    const latest = await getLatestBlock(rpcs);
    if (latest == null) return { ok: false, reason: "no se pudo leer latestBlock" };
    const conf = CONFIRMATIONS[state.network] ?? 20;
    const safeHead = latest - conf;
    if (safeHead <= 0) return { ok: false, reason: "cadena demasiado nueva" };

    // (Codex v2) Gate de indexación: si Blockscout NO terminó de indexar, NO mutar (totales serían
    // erróneos). No aplica al camino rpcUrl (proveedor eth propio). Se chequea ANTES de leer/mutar.
    if (!rpcUrl && !(await blockscoutFullyIndexed(baseUrl))) {
      return { ok: false, reason: "blockscout_indexing_incomplete", start: null };   // no mutar
    }

    // Origen: con rpcUrl (camino eth clásico), `fromBlock` explícito o 0. Sin rpcUrl, el MINT real desde
    // Blockscout (certifica y acota). (CodeRabbit) Si NO se puede verificar el mint → NO mutar: caer a 0 y
    // certificar sería marcar backfilledAt sin haber confirmado el origen. Se busca el mint SIEMPRE (también
    // con fromBlock) para poder validar la cobertura.
    const tokenId: number = state.tokenId;
    const mintBlock = rpcUrl ? null : await findMintBlock(baseUrl, nft, tokenId);
    if (!rpcUrl && mintBlock == null) {
      return { ok: false, reason: "mint no verificado en Blockscout", start: null };   // no mutar
    }
    const start = Math.max(0, fromBlock ?? mintBlock ?? 0);
    if (start > safeHead) return { ok: false, reason: "start > safeHead (nada que escanear)" };

    // (Codex v2 · CodeRabbit) Certifica histórico SOLO con origen verificado. rpcUrl: start===0 (eth clásico).
    // Blockscout: arrancar EN o ANTES del mint real (start<=mintBlock) cubre todos los eventos. Un fromBlock
    // > mint NO certifica → stale. O ya había backfill completo previo.
    const originVerified = rpcUrl ? start === 0 : (mintBlock != null && start <= mintBlock);
    const coversHistory = originVerified || state.backfilledAt != null;

    // Lectura adaptativa de [start, safeHead] vía Blockscout (o eth si rpcUrl). Si pide partir el rango se
    // bisecta (BACKFILL_CALL_BUDGET); un error de proveedor se propaga → NO mutar.
    const tokenIdTopic = "0x" + pad(BigInt(tokenId));
    const fetcher: RangeFetcher = rpcUrl
      ? (lo, hi) => getLogsRangeMulti([rpcUrl], nft, tokenIdTopic, lo, hi)
      : blockscoutFetcher(baseUrl, nft, tokenIdTopic);
    let scan: { logs: RpcLog[]; complete: boolean };
    try {
      scan = await getLogsAdaptive(fetcher, start, safeHead, safeHead - start + 1, BACKFILL_CALL_BUDGET);
    } catch (e) {
      console.error(`backfillPoolLifetime: getLogs falló pool ${poolId}`, e);
      return { ok: false, reason: "getLogs falló (transporte)", start };   // no mutar: cache previo intacto
    }
    // Cobertura PARCIAL (presupuesto agotado) → NO mutar (evita huecos no contiguos); reintentar o subir budget.
    if (!scan.complete) {
      return { ok: false, reason: "presupuesto de getLogs agotado; reintenta", start, budget: BACKFILL_CALL_BUDGET };
    }

    // (Codex v2) Blockscout legacy NO trae blockHash → rellenar por bloque distinto. Si ALGUNO no resuelve,
    // los logs están incompletos → NO mutar.
    let logs = scan.logs;
    if (!rpcUrl) {
      const filled = await fillBlockHashes(rpcs, logs);
      if (filled == null) return { ok: false, reason: "no se pudo resolver blockHash de todos los bloques", start };
      logs = filled;
    }

    // (Codex v2) Decodificación ESTRICTA en el back-fill histórico: NO descartar en silencio. Si un log con
    // topic0 relevante (Increase/Decrease/Collect) no decodifica, los eventos de la ventana están
    // incompletos → subcontaríamos y marcaríamos ok/backfilledAt erróneo ⇒ ok:false SIN mutar. Los topic0
    // no relevantes (no debería haberlos: ya se filtran al leer) se ignoran.
    const RELEVANT_TOPIC0 = new Set([TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT]);
    const staged: NonNullable<ReturnType<typeof decodePoolFeeLog>>[] = [];
    for (const log of logs) {
      const decoded = decodePoolFeeLog(log);
      if (decoded != null) { staged.push(decoded); continue; }
      const topic0 = (log.topics?.[0] ?? "").toLowerCase();
      if (RELEVANT_TOPIC0.has(topic0)) {
        console.error(`backfillPoolLifetime: log relevante no decodificable pool ${poolId}`, { blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex });
        return { ok: false, reason: "log relevante no decodificable (backfill estricto)", start };   // no mutar
      }
      // topic0 no relevante → ignorar
    }
    const currentKey = await readPositionSnapshotKey(rpcs, nft, tokenId);
    await ctx.runMutation(internal.pools.applyPoolFeeEventsWindow, {
      poolId,
      fromBlock: start,
      toBlock: safeHead,
      events: staged,
      cursorBlock: safeHead,
      status: coversHistory ? "ok" : "stale",
      ...(coversHistory ? { backfilledAt: Date.now() } : {}),
      ...(currentKey ? { snapshotKey: currentKey } : {}),
    });
    return { ok: true, complete: true, coversHistory, totalEvents: staged.length, start, mintBlock, cursorBlock: safeHead };
  },
});

// (JAV-119) UN BOTÓN: back-fill de TODOS los pools (pocos por usuario). Secuencial (suave con los RPC
// públicos) y acotado por `limit`. Cada pool autodetecta su inicio. Idempotente (re-ejecutar no duplica).
export const backfillAllPoolLifetimes = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<any> => {
    const all = await ctx.runQuery(internal.pools.listPoolsInternal);
    // (CodeRabbit) Procesar primero los pools AÚN sin back-fill (backfilledAt == null) → corridas
    // sucesivas con `limit` avanzan sobre el resto en vez de reprocesar siempre el mismo prefijo.
    const targets = all
      .filter((p: any) => p.tokenId && LOGS_BLOCKSCOUT[p.network] && NFT_MANAGER[p.network])
      .sort((a: any, b: any) =>
        Number(a.feesLifetimeBackfilledAt != null) - Number(b.feesLifetimeBackfilledAt != null));
    const cap = Math.max(1, Math.min(limit ?? 50, 100));
    const slice = targets.slice(0, cap);
    const results: any[] = [];
    for (const p of slice) {
      try {
        const r: any = await ctx.runAction(internal.actions.poolScanner.backfillPoolLifetime, { poolId: p._id });
        results.push({ poolId: p._id, pair: p.pair, ...r });
      } catch (e) {
        results.push({ poolId: p._id, pair: p.pair, ok: false, reason: String(e).slice(0, 200) });
      }
    }
    return { considered: targets.length, processed: results.length, ok: results.filter(r => r.ok).length, results };
  },
});

// (JAV-84 subtarea) Disparo MANUAL inmediato del auto-curado (sin esperar al cron). Acotado: `limit`
// (tope de pools a procesar por ejecución, máx 100) + misma concurrencia que el escaneo. Solo CLI/interno.
export const backfillMissingInitialLiquidity = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<any> => {
    const cap = Math.max(1, Math.min(limit ?? 50, 100));
    const all = await ctx.runQuery(internal.pools.listPoolsInternal);
    // Solo los que faltan y son procesables, hasta el tope.
    const targets = all
      .filter((p: any) => p.tokenId && p.initialLiquidityUsd == null && !p.closed)
      .slice(0, cap);
    const counts = { filled: 0, skipped: 0, failed: 0 };
    for (let i = 0; i < targets.length; i += POOL_SCAN_CONCURRENCY) {
      const batch = targets.slice(i, i + POOL_SCAN_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((p: any) => backfillOneInitialLiquidity(ctx, p)));
      for (const r of results) {
        if (r.status === "fulfilled") counts[r.value]++;
        else { counts.failed++; console.error("backfillMissingInitialLiquidity: worker rechazado", r.reason); }
      }
    }
    return { considered: targets.length, ...counts };
  },
});
