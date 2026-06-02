import { useState, useEffect, useRef } from 'react';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HL_REST = 'https://api.hyperliquid.xyz/info';
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

export function useHyperliquidSpotState(address) {
  const [spotBalances, setSpotBalances] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSpotBalances({});
    if (!address) return;
    let cancelled = false;

    async function fetchSpot() {
      setLoading(true);
      try {
        const res = await fetch(HL_REST, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'spotClearinghouseState', user: address }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        const map = {};
        for (const b of data.balances ?? []) {
          const total = parseFloat(b.total);
          const entryNtl = parseFloat(b.entryNtl);
          if (total > 0) map[b.coin] = { total, entryNtl, hold: parseFloat(b.hold ?? 0) };
        }
        setSpotBalances(map);
      } catch (_) {} finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSpot();
    const interval = setInterval(fetchSpot, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [address]);

  return { spotBalances, loading };
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
