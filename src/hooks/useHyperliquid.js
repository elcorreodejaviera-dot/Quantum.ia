import { useState, useEffect, useRef } from 'react';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const TRACKED_ASSETS = ['BTC', 'ETH'];
const MAX_RETRIES = 5;

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
        if (destroyed) {
          ws.close();
          return;
        }
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
        if (!destroyed && retriesRef.current < MAX_RETRIES) {
          const delay = Math.pow(2, retriesRef.current) * 1000;
          retriesRef.current += 1;
          timeoutRef.current = setTimeout(connect, delay);
        }
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
