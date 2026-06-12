import { useState, useEffect, useRef } from 'react';
import { createWalletClient, custom } from 'viem';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import EthereumProvider from '@walletconnect/ethereum-provider';

const IS_TESTNET = import.meta.env.VITE_HL_NETWORK === 'testnet';
const WS_URL = IS_TESTNET
  ? 'wss://api.hyperliquid-testnet.xyz/ws'
  : 'wss://api.hyperliquid.xyz/ws';
const HL_REST = IS_TESTNET
  ? 'https://api.hyperliquid-testnet.xyz/info'
  : 'https://api.hyperliquid.xyz/info';
const TRACKED_ASSETS = ['BTC', 'ETH'];
const MAX_BACKOFF_MS = 30_000;

export function useHyperliquidPrices() {
  const [prices, setPrices] = useState({});
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const wsRef = useRef(null);
  const retriesRef = useRef(0);
  const timeoutRef = useRef(null);
  const connectTimerRef = useRef(null);

  useEffect(() => {
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (destroyed) { ws.close(); return; }
        retriesRef.current = 0;
        setConnected(true);
        ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'allMids' },
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.channel === 'allMids' && msg.data?.mids) {
            const mids = msg.data.mids;
            setPrices((prev) => {
              const updates = {};
              for (const asset of TRACKED_ASSETS) {
                const mid = mids[asset];
                if (mid === undefined) continue;
                const val = parseFloat(mid);
                if (Number.isFinite(val) && val !== prev[asset]) {
                  updates[asset] = val;
                }
              }
              if (Object.keys(updates).length === 0) return prev;
              return { ...prev, ...updates };
            });
            setLastUpdate(new Date());
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        setConnected(false);
        if (destroyed) return;
        const delay = Math.min(Math.pow(2, Math.min(retriesRef.current, 5)) * 1000, MAX_BACKOFF_MS);
        retriesRef.current += 1;
        timeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connectTimerRef.current = setTimeout(connect, 0);

    return () => {
      destroyed = true;
      clearTimeout(connectTimerRef.current);
      clearTimeout(timeoutRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { prices, connected, lastUpdate };
}

export function useHyperliquidAllMids() {
  const [allPrices, setAllPrices] = useState({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const retriesRef = useRef(0);
  const timeoutRef = useRef(null);

  useEffect(() => {
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (destroyed) { ws.close(); return; }
        retriesRef.current = 0;
        setConnected(true);
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.channel === 'allMids' && msg.data?.mids) {
            setAllPrices((prev) => {
              const next = { ...prev };
              let changed = false;
              for (const [asset, mid] of Object.entries(msg.data.mids)) {
                const val = parseFloat(mid);
                if (Number.isFinite(val) && val !== prev[asset]) {
                  next[asset] = val;
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        setConnected(false);
        if (destroyed) return;
        const delay = Math.min(Math.pow(2, Math.min(retriesRef.current, 5)) * 1000, MAX_BACKOFF_MS);
        retriesRef.current += 1;
        timeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      destroyed = true;
      clearTimeout(timeoutRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { allPrices, connected };
}

// ─── On-chain wallet balances (Arbitrum, Base, Optimism) ───────────────────

const CHAIN_CONFIG = {
  Ethereum: {
    rpc: 'https://ethereum.publicnode.com',
    tokens: {
      WBTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
      WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      DAI:  { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    },
  },
  Arbitrum: {
    rpc: 'https://arb1.arbitrum.io/rpc',
    tokens: {
      WBTC: { address: '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', decimals: 8 },
      WETH: { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 },
      USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      DAI:  { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    },
  },
  Base: {
    rpc: 'https://mainnet.base.org',
    tokens: {
      cbBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
      WETH:  { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      USDC:  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      DAI:   { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    },
  },
  Optimism: {
    rpc: 'https://mainnet.optimism.io',
    tokens: {
      WBTC: { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8 },
      WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
      USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
      DAI:  { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    },
  },
};

// Timeout por request RPC: evita que una lectura colgada bloquee el refresco (Codex #4).
const RPC_TIMEOUT_MS = 10_000;

// rpcFetch valida transporte (res.ok) y la capa JSON-RPC (json.error). LANZA en error en vez de
// devolver null → el llamador (Promise.allSettled) lo cuenta como fallo (estado partial/unavailable),
// nunca como saldo 0 (Codex #2/#4). `signal` permite abortar (timeout + cancelación del efecto).
async function rpcFetch(rpc, method, params, signal) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} en ${method}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error en ${method}: ${json.error?.message ?? 'desconocido'}`);
  // (Codex #2) Un result ausente es respuesta MALFORMADA → lanzar, no devolver null (que hexToFloat
  // convertiría en 0 = saldo falso). Un saldo cero legítimo llega como "0x0", no como ausencia.
  if (json.result === undefined || json.result === null) throw new Error(`RPC sin result en ${method}`);
  return json.result;
}

// Convierte hex EVM (256-bit) a Number para visualización.
// Usa BigInt para evitar pérdida de precisión antes de escalar.
// Mantiene 6 decimales significativos — suficiente para display de balances.
function hexToFloat(hex, decimals) {
  if (!hex || hex === '0x' || hex === '0x0') return 0;
  const raw = BigInt(hex);
  if (raw === 0n) return 0;
  const shift = decimals > 6 ? decimals - 6 : 0;
  const scaled = raw / BigInt(10 ** shift);          // BigInt seguro
  return Number(scaled) / 10 ** (decimals - shift);  // Number solo al final
}

async function getNative(rpc, address, signal) {
  const hex = await rpcFetch(rpc, 'eth_getBalance', [address, 'latest'], signal);
  return hexToFloat(hex, 18);
}

async function getErc20(rpc, token, address, decimals, signal) {
  const data = '0x70a08231' + address.slice(2).padStart(64, '0');
  const hex = await rpcFetch(rpc, 'eth_call', [{ to: token, data }, 'latest'], signal);
  return hexToFloat(hex, decimals);
}

// LANZA en error (HTTP no-ok) en vez de devolver 0: así un fallo cuenta como "no disponible", no como
// saldo cero (Codex #2). `signal` para timeout/cancelación.
async function getBitcoinBalance(address, signal) {
  const res = await fetch(`https://blockstream.info/api/address/${address}`, { signal });
  if (!res.ok) throw new Error(`Blockstream HTTP ${res.status}`);
  const data = await res.json();
  // (Codex #2) Validar la estructura: una respuesta sin chain_stats numérico es malformada → lanzar,
  // no asumir 0.
  const cs = data?.chain_stats;
  if (!cs || typeof cs.funded_txo_sum !== 'number' || typeof cs.spent_txo_sum !== 'number') {
    throw new Error('Blockstream: chain_stats inválido');
  }
  return (cs.funded_txo_sum - cs.spent_txo_sum) / 1e8;
}

// wallets: [{ _id, address, network, label }]
// Retorna:
//   balances: { ETH: { total, perWallet }, BTC: { total, perWallet } } — para cards de spot
//   walletTokens: { walletId: { label, network, tokens: { SYMBOL: amount } } } — para panel detalle
export function useWalletBalances(wallets) {
  const [balances, setBalances] = useState({});
  const [walletTokens, setWalletTokens] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const key = JSON.stringify((wallets ?? []).map(w => `${w._id}|${w.address}|${w.network}|${w.label}`));

  useEffect(() => {
    setBalances({});
    setWalletTokens({});
    setError(null);
    // (Codex #4) Apagar loading al quedar sin wallets: si el efecto previo estaba cargando, la UI
    // se quedaría en "cargando" indefinidamente al eliminar la última wallet.
    if (!wallets || wallets.length === 0) { setLoading(false); return; }
    // (Codex #4) AbortController del efecto: aborta lecturas en vuelo al desmontar o re-ejecutar.
    const controller = new AbortController();
    let cancelled = false;
    // (Codex #4) Guard de solapamiento: solo el run MÁS RECIENTE escribe estado. Un refresco lento de
    // 60s no puede pisar el resultado de uno posterior con datos viejos.
    let latestRun = 0;

    // Señal por request = aborto del efecto + timeout individual.
    const reqSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]);

    async function fetchAll() {
      const myRun = ++latestRun;
      setLoading(true);
      try {
        const ethAcc = {};   // (Codex #3) clave por _id, no por label(network): sin colisiones.
        const btcAcc = {};
        const wTokens = {};

        // Promise.all (no allSettled aquí): cada wallet maneja sus propios fallos y nunca rechaza;
        // así un fallo aislado no afecta al resto.
        await Promise.all(wallets.map(async (w) => {
          const walletKey = w._id;
          const tokenMap = {};
          let attempted = 0;
          let failed = 0;

          if (w.network === 'Bitcoin') {
            attempted += 1;
            try {
              const bal = await getBitcoinBalance(w.address, reqSignal());
              if (bal > 0) { tokenMap['BTC'] = bal; btcAcc[walletKey] = (btcAcc[walletKey] ?? 0) + bal; }
            } catch { failed += 1; }
          } else {
            const cfg = CHAIN_CONFIG[w.network];
            if (!cfg) {
              // (Codex #2) Red no soportada → "no disponible" explícito, NO saldo 0.
              wTokens[walletKey] = { label: w.label, network: w.network, address: w.address, tokens: {}, status: 'unavailable' };
              return;
            }

            // ETH nativo
            attempted += 1;
            try {
              const nativeEth = await getNative(cfg.rpc, w.address, reqSignal());
              if (nativeEth > 0) tokenMap['ETH'] = (tokenMap['ETH'] ?? 0) + nativeEth;
            } catch { failed += 1; }

            // Tokens ERC-20 configurados: inspeccionar CADA resultado (Codex #2).
            const results = await Promise.allSettled(
              Object.entries(cfg.tokens).map(async ([symbol, { address, decimals }]) => {
                const bal = await getErc20(cfg.rpc, address, w.address, decimals, reqSignal());
                return { symbol, bal };
              })
            );
            for (const r of results) {
              attempted += 1;
              if (r.status === 'fulfilled') {
                if (r.value.bal > 0) tokenMap[r.value.symbol] = (tokenMap[r.value.symbol] ?? 0) + r.value.bal;
              } else {
                failed += 1;
              }
            }

            // Acumular ETH y BTC por _id para las cards de spot.
            const totalEthHere = (tokenMap['ETH'] ?? 0) + (tokenMap['WETH'] ?? 0);
            const totalBtcHere = (tokenMap['WBTC'] ?? 0) + (tokenMap['cbBTC'] ?? 0);
            if (totalEthHere > 0) ethAcc[walletKey] = totalEthHere;
            if (totalBtcHere > 0) btcAcc[walletKey] = (btcAcc[walletKey] ?? 0) + totalBtcHere;
          }

          // (Codex #2) Estado del saldo: ok (nada falló) | partial (algunas lecturas fallaron) |
          // unavailable (todas fallaron). Nunca se presenta un error como cero/parcial silencioso.
          const status = failed === 0 ? 'ok' : (failed >= attempted ? 'unavailable' : 'partial');
          wTokens[walletKey] = { label: w.label, network: w.network, address: w.address, tokens: tokenMap, status };
        }));

        if (cancelled || myRun !== latestRun) return;

        const totalEth = Object.values(ethAcc).reduce((s, v) => s + v, 0);
        const totalBtc = Object.values(btcAcc).reduce((s, v) => s + v, 0);

        setBalances({
          ...(totalEth > 0 ? { ETH: { total: totalEth, perWallet: ethAcc } } : {}),
          ...(totalBtc > 0 ? { BTC: { total: totalBtc, perWallet: btcAcc } } : {}),
        });
        setWalletTokens(wTokens);
        setError(null);
      } catch (err) {
        if (!cancelled && myRun === latestRun) setError('Error leyendo balances');
      } finally {
        if (!cancelled && myRun === latestRun) setLoading(false);
      }
    }

    fetchAll();
    const interval = setInterval(fetchAll, 60_000);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); };
  }, [key]);

  return { balances, walletTokens, loading, error };
}

// Parsea el snapshot de cuenta HL (clearinghouseState + spotClearinghouseState) a la forma de la UI.
// Modo unified: withdrawable (perp, firme) y spotUsdcFree se exponen POR SEPARADO; la disponibilidad real
// de margen la valida el backend al operar (no se suman en cliente). Función PURA (sin fetch/estado).
function parseHLAccount(data, spotData) {
  const spotUsdcFree = (spotData?.balances ?? [])
    .filter((b) => b.coin === 'USDC')
    .reduce((s, b) => s + (parseFloat(b.total ?? 0) - parseFloat(b.hold ?? 0)), 0);
  return {
    accountValue: parseFloat(data?.marginSummary?.accountValue ?? 0),
    withdrawable: parseFloat(data?.withdrawable ?? 0),
    spotUsdcFree,
    totalNtlPos: parseFloat(data?.marginSummary?.totalNtlPos ?? 0),
    totalMarginUsed: parseFloat(data?.marginSummary?.totalMarginUsed ?? 0),
    openPositions: (data?.assetPositions ?? [])
      .filter(({ position: p }) => parseFloat(p?.szi ?? 0) !== 0)
      .map(({ position: p }) => ({
        coin: p.coin,
        size: parseFloat(p.szi),
        entryPx: parseFloat(p.entryPx ?? 0),
        unrealizedPnl: parseFloat(p.unrealizedPnl ?? 0),
        positionValue: parseFloat(p.positionValue ?? 0),
        roe: parseFloat(p.returnOnEquity ?? 0),
        leverage: p.leverage?.value ?? null,
        liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
      })),
  };
}

export function useHLAccountBalance(address, { includeOrders = false } = {}) {
  const [account, setAccount] = useState(null);
  const [openOrders, setOpenOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setAccount(null);
    setOpenOrders([]);
    setError(null);
    setLoading(false);
    if (!address) return;
    let cancelled = false;

    async function fetchAccount() {
      setLoading(true);
      try {
        const hlReq = (type) => fetch(HL_REST, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, user: address }),
        });
        const [stateRes, spotRes, ordersRes] = await Promise.all([
          hlReq('clearinghouseState'),
          hlReq('spotClearinghouseState'),   // colateral spot (modo unified)
          includeOrders ? hlReq('openOrders') : Promise.resolve(null),
        ]);
        if (!stateRes.ok) { if (!cancelled) setError('Error al consultar HL'); return; }
        if (cancelled) return;
        const [data, spotData, orders] = await Promise.all([
          stateRes.json(),
          spotRes?.ok ? spotRes.json() : Promise.resolve({}),
          ordersRes?.ok ? ordersRes.json() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setAccount(parseHLAccount(data, spotData));
        setOpenOrders(Array.isArray(orders) ? orders : []);
        setError(null);
      } catch (_) {
        if (!cancelled) setError('Sin conexión con Hyperliquid');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAccount();
    const interval = setInterval(fetchAccount, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [address]);

  return { account, openOrders, loading, error };
}

// (JAV-58 Fase C) Agregador: lee el snapshot de cuenta de VARIAS direcciones HL en UN ciclo (30s),
// deduplicando direcciones. Evita N llamadas duplicadas si varios bots comparten cuenta (Codex #3).
// Devuelve { byAddress: { [addr]: account }, loading }. Una dirección que falla queda ausente del map.
export function useHLAccountsBalances(addresses) {
  const [byAddress, setByAddress] = useState({});
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([...new Set((addresses ?? []).filter(Boolean))]);

  useEffect(() => {
    const list = JSON.parse(key);
    setByAddress({});
    if (list.length === 0) { setLoading(false); return; }
    const controller = new AbortController();
    let cancelled = false;
    let latestRun = 0;

    async function fetchAll() {
      const myRun = ++latestRun;
      setLoading(true);
      try {
        const entries = await Promise.all(list.map(async (addr) => {
          try {
            const hlReq = (type) => fetch(HL_REST, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, user: addr }),
              signal: controller.signal,
            });
            const [stateRes, spotRes] = await Promise.all([hlReq('clearinghouseState'), hlReq('spotClearinghouseState')]);
            if (!stateRes.ok) return [addr, null];
            const [data, spotData] = await Promise.all([
              stateRes.json(),
              spotRes?.ok ? spotRes.json() : Promise.resolve({}),
            ]);
            return [addr, parseHLAccount(data, spotData)];
          } catch { return [addr, null]; }
        }));
        if (cancelled || myRun !== latestRun) return;
        const map = {};
        for (const [addr, acc] of entries) if (acc) map[addr] = acc;
        setByAddress(map);
      } finally {
        if (!cancelled && myRun === latestRun) setLoading(false);
      }
    }

    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); };
  }, [key]);

  return { byAddress, loading };
}

export function useHyperliquidSpotState(address) {
  // perpPositions: posiciones abiertas en perps (BTC, ETH, etc.)
  // hlTokens: tokens nativos de HL spot (HYPE, PURR, etc.)
  const [perpPositions, setPerpPositions] = useState({});
  const [hlTokens, setHlTokens] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setPerpPositions({});
    setHlTokens({});
    setError(null);
    if (!address) return;
    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      try {
        const [perpRes, spotRes] = await Promise.all([
          fetch(HL_REST, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: address }),
          }),
          fetch(HL_REST, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'spotClearinghouseState', user: address }),
          }),
        ]);
        if (cancelled) return;

        if (!perpRes.ok || !spotRes.ok) {
          setError('Error al consultar Hyperliquid');
          return;
        }

        const [perpData, spotData] = await Promise.all([perpRes.json(), spotRes.json()]);
        if (cancelled) return;

        // Perp positions: assetPositions[].position
        const perps = {};
        for (const ap of perpData.assetPositions ?? []) {
          const p = ap.position;
          const size = parseFloat(p.szi);
          if (size !== 0) {
            perps[p.coin] = {
              size,
              entryPx: parseFloat(p.entryPx),
              unrealizedPnl: parseFloat(p.unrealizedPnl),
              positionValue: parseFloat(p.positionValue),
              roe: parseFloat(p.returnOnEquity ?? 0),
              leverage: p.leverage?.value ?? null,
              liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
            };
          }
        }
        setPerpPositions(perps);

        // HL spot tokens (no incluye BTC/ETH — son tokens nativos de HL)
        const tokens = {};
        for (const b of spotData.balances ?? []) {
          const total = parseFloat(b.total);
          const entryNtl = parseFloat(b.entryNtl);
          if (total > 0 && b.coin !== 'USDC') {
            tokens[b.coin] = { total, entryNtl, hold: parseFloat(b.hold ?? 0) };
          }
        }
        setHlTokens(tokens);

        setError(null);
      } catch (err) {
        if (!cancelled) setError('Sin conexión con Hyperliquid');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [address]);

  return { perpPositions, hlTokens, loading, error };
}

export function useHyperliquidFunding() {
  const [funding, setFunding] = useState({});

  useEffect(() => {
    let cancelled = false;

    async function fetchFunding() {
      try {
        const res = await fetch(HL_REST, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        });
        if (!res.ok || cancelled) return;
        const [meta, ctxs] = await res.json();
        if (cancelled) return;
        const result = {};
        meta.universe.forEach((asset, i) => {
          const val = parseFloat(ctxs[i]?.funding);
          if (Number.isFinite(val)) result[asset.name] = val;
        });
        setFunding(result);
      } catch (_) {}
    }

    fetchFunding();
    const interval = setInterval(fetchFunding, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return { funding };
}

// ─── Wallet signer (MetaMask + WalletConnect) ───────────────────────────────

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '';
const WC_CHAINS = [IS_TESTNET ? 421614 : 42161]; // Arbitrum Sepolia testnet / Arbitrum mainnet

export function useMetaMaskSigner() {
  const [account, setAccount] = useState(null);
  const [walletClient, setWalletClient] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectorType, setConnectorType] = useState(null); // 'metamask' | 'walletconnect'
  const [error, setError] = useState(null);
  const wcProviderRef = useRef(null);

  async function connectMetaMask() {
    if (!window.ethereum) { setError('MetaMask no está instalado'); return; }
    setIsConnecting(true);
    setError(null);
    try {
      const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const client = createWalletClient({ account: address, transport: custom(window.ethereum) });
      setAccount(address.toLowerCase());
      setWalletClient(client);
      setConnectorType('metamask');
    } catch (e) {
      setError(e?.message ?? 'Error conectando MetaMask');
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectWalletConnect() {
    if (!WC_PROJECT_ID) { setError('Falta VITE_WALLETCONNECT_PROJECT_ID en .env'); return; }
    setIsConnecting(true);
    setError(null);
    try {
      const provider = await EthereumProvider.init({
        projectId: WC_PROJECT_ID,
        chains: WC_CHAINS,
        showQrModal: true,
      });
      await provider.connect();
      wcProviderRef.current = provider;
      const [address] = await provider.request({ method: 'eth_requestAccounts' });
      const client = createWalletClient({ account: address, transport: custom(provider) });
      setAccount(address.toLowerCase());
      setWalletClient(client);
      setConnectorType('walletconnect');
    } catch (e) {
      setError(e?.message ?? 'Error conectando WalletConnect');
    } finally {
      setIsConnecting(false);
    }
  }

  async function disconnect() {
    if (connectorType === 'walletconnect' && wcProviderRef.current) {
      await wcProviderRef.current.disconnect().catch(() => {});
      wcProviderRef.current = null;
    }
    setAccount(null);
    setWalletClient(null);
    setConnectorType(null);
    setError(null);
  }

  return { account, walletClient, connectorType, connectMetaMask, connectWalletConnect, disconnect, isConnecting, error };
}

// ─── Testnet trade execution ─────────────────────────────────────────────────

const ASSET_IDS = { BTC: 0, ETH: 1 };
const IOC_SLIPPAGE = 0.01;

export async function executeHLTestnetOrder({ walletClient, asset, isBuy, size, price, leverage, reduceOnly = false }) {
  if (!IS_TESTNET) throw new Error('executeHLTestnetOrder solo disponible en modo testnet');
  const assetId = ASSET_IDS[asset.toUpperCase()];
  if (assetId == null) throw new Error(`Asset no soportado: ${asset}`);
  if (!walletClient) throw new Error('MetaMask no conectado');

  const transport = new HttpTransport({ isTestnet: IS_TESTNET });
  const exchange = new ExchangeClient({ transport, wallet: walletClient });

  if (leverage != null && !reduceOnly) {
    await exchange.updateLeverage({ asset: assetId, isCross: false, leverage: Math.round(leverage) });
  }

  const limitPrice = isBuy ? price * (1 + IOC_SLIPPAGE) : price * (1 - IOC_SLIPPAGE);
  const assetUpper = asset.toUpperCase();

  return exchange.order({
    orders: [{
      a: assetId,
      b: isBuy,
      p: limitPrice.toFixed(assetUpper === 'BTC' ? 0 : 2),
      s: size.toFixed(assetUpper === 'BTC' ? 5 : 4),
      r: reduceOnly,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  });
}
