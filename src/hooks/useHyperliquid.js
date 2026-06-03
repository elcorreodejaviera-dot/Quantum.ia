import { useState, useEffect, useRef } from 'react';

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

async function rpcFetch(rpc, method, params) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result ?? null;
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

async function getNative(rpc, address) {
  const hex = await rpcFetch(rpc, 'eth_getBalance', [address, 'latest']);
  return hexToFloat(hex, 18);
}

async function getErc20(rpc, token, address, decimals) {
  const data = '0x70a08231' + address.slice(2).padStart(64, '0');
  const hex = await rpcFetch(rpc, 'eth_call', [{ to: token, data }, 'latest']);
  return hexToFloat(hex, decimals);
}

async function getBitcoinBalance(address) {
  const res = await fetch(`https://blockstream.info/api/address/${address}`);
  if (!res.ok) return 0;
  const data = await res.json();
  const funded = data.chain_stats?.funded_txo_sum ?? 0;
  const spent = data.chain_stats?.spent_txo_sum ?? 0;
  return (funded - spent) / 1e8;
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
    if (!wallets || wallets.length === 0) return;
    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      try {
        const ethAcc = {};
        const btcAcc = {};
        const wTokens = {};

        await Promise.allSettled(wallets.map(async (w) => {
          const walletKey = w._id;
          const tokenMap = {};

          if (w.network === 'Bitcoin') {
            const bal = await getBitcoinBalance(w.address);
            if (bal > 0) {
              tokenMap['BTC'] = bal;
              btcAcc[`${w.label}(BTC)`] = bal;
            }
          } else {
            const cfg = CHAIN_CONFIG[w.network];
            if (!cfg) return;

            // ETH nativo
            const nativeEth = await getNative(cfg.rpc, w.address);
            if (nativeEth > 0) tokenMap['ETH'] = (tokenMap['ETH'] ?? 0) + nativeEth;

            // Todos los tokens ERC-20 configurados
            await Promise.allSettled(
              Object.entries(cfg.tokens).map(async ([symbol, { address, decimals }]) => {
                const bal = await getErc20(cfg.rpc, address, w.address, decimals);
                if (bal > 0) tokenMap[symbol] = (tokenMap[symbol] ?? 0) + bal;
              })
            );

            // Acumular ETH y BTC para las cards de spot
            const totalEthHere = (tokenMap['ETH'] ?? 0) + (tokenMap['WETH'] ?? 0);
            const totalBtcHere = (tokenMap['WBTC'] ?? 0) + (tokenMap['cbBTC'] ?? 0);
            const wKey = `${w.label}(${w.network})`;
            if (totalEthHere > 0) ethAcc[wKey] = totalEthHere;
            if (totalBtcHere > 0) btcAcc[wKey] = totalBtcHere;
          }

          if (Object.keys(tokenMap).length > 0) {
            wTokens[walletKey] = { label: w.label, network: w.network, address: w.address, tokens: tokenMap };
          }
        }));

        if (cancelled) return;

        const totalEth = Object.values(ethAcc).reduce((s, v) => s + v, 0);
        const totalBtc = Object.values(btcAcc).reduce((s, v) => s + v, 0);

        setBalances({
          ...(totalEth > 0 ? { ETH: { total: totalEth, perWallet: ethAcc } } : {}),
          ...(totalBtc > 0 ? { BTC: { total: totalBtc, perWallet: btcAcc } } : {}),
        });
        setWalletTokens(wTokens);
        setError(null);
      } catch (err) {
        if (!cancelled) setError('Error leyendo balances');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    const interval = setInterval(fetchAll, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [key]);

  return { balances, walletTokens, loading, error };
}

export function useHLAccountBalance(address) {
  const [account, setAccount] = useState(null);
  const [openOrders, setOpenOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setAccount(null);
    setOpenOrders([]);
    setError(null);
    if (!address) return;
    let cancelled = false;

    async function fetchAccount() {
      setLoading(true);
      try {
        const [stateRes, ordersRes] = await Promise.all([
          fetch(HL_REST, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: address }),
          }),
          fetch(HL_REST, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'openOrders', user: address }),
          }),
        ]);
        if (!stateRes.ok) { if (!cancelled) setError('Error al consultar HL'); return; }
        if (cancelled) return;
        const [data, orders] = await Promise.all([
          stateRes.json(),
          ordersRes.ok ? ordersRes.json() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setAccount({
          accountValue: parseFloat(data.marginSummary?.accountValue ?? 0),
          withdrawable: parseFloat(data.withdrawable ?? 0),
          totalNtlPos: parseFloat(data.marginSummary?.totalNtlPos ?? 0),
          totalMarginUsed: parseFloat(data.marginSummary?.totalMarginUsed ?? 0),
          openPositions: (data.assetPositions ?? [])
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
        });
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
