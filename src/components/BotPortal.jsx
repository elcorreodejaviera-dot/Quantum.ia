import React from 'react'
import { useUser, useClerk } from '@clerk/clerk-react'
import { useConvexAuth, useQuery, useMutation, useAction, usePaginatedQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useHyperliquidPrices, useHyperliquidFunding, useHyperliquidAllMids, useHyperliquidSpotState, useWalletBalances, useHLAccountBalance, useMetaMaskSigner, executeHLTestnetOrder } from '../hooks/useHyperliquid'

const IS_TESTNET = import.meta.env.VITE_HL_NETWORK === 'testnet';

const NETWORKS = ['Todas', 'Ethereum', 'Arbitrum', 'Base', 'Optimism'];
const PAIRS = ['Todos', 'BTC/USDC', 'ETH/USDC'];

const POOLS = [
  { id: 1, pair: 'BTC/USDC', network: 'Arbitrum', min: 63200, max: 72400, liquidity: 86240, fees24h: 118, apr: 42.6, exposure: 0.74, status: 'En rango' },
  { id: 2, pair: 'ETH/USDC', network: 'Arbitrum', min: 3420, max: 4020, liquidity: 54110, fees24h: 71, apr: 37.2, exposure: 0.62, status: 'En rango' },
  { id: 3, pair: 'BTC/USDC', network: 'Base', min: 64600, max: 70100, liquidity: 39220, fees24h: 64, apr: 51.8, exposure: 0.81, status: 'Cerca del borde' },
  { id: 4, pair: 'ETH/USDC', network: 'Base', min: 3600, max: 3880, liquidity: 33680, fees24h: 58, apr: 58.4, exposure: 0.77, status: 'En rango' },
  { id: 5, pair: 'BTC/USDC', network: 'Optimism', min: 61500, max: 74200, liquidity: 28400, fees24h: 39, apr: 31.7, exposure: 0.49, status: 'En rango' },
  { id: 6, pair: 'ETH/USDC', network: 'Optimism', min: 3860, max: 4240, liquidity: 24560, fees24h: 22, apr: 24.9, exposure: 0.88, status: 'Fuera de rango' },
];

const INITIAL_BOTS = [
  { id: 'bot1', name: 'bot1', action: 'Cobertura short', active: true, mode: 'Short', trigger: 'Precio sale del rango o delta > 0.65', hedge: '$42,300', health: 'Normal', poolTokenId: '#893421', walletId: 'WLT-001', capitalPerTrade: 2500, poolCapitalPercent: 75, leverage: 3, autoLeverage: true, stop: 2.5, takeProfit: 'Escalonado', tpSteps: [25, 50, 25], orderType: 'Trigger por precio', marginMode: 'Isolated', collateral: 'USDC', entryTrigger: 'Fuera de rango', triggerPrice: 68150 },
  { id: 'bot2', name: 'bot2', action: 'Cobertura long', active: true, mode: 'Long', trigger: 'Entrada defensiva cuando el precio recupera rango', hedge: '$31,700', health: 'Alta actividad', poolTokenId: '#893577', walletId: 'WLT-002', capitalPerTrade: 1800, poolCapitalPercent: 50, leverage: 2, autoLeverage: false, stop: 1.8, takeProfit: 'Fijo', tpSteps: [25, 50, 25], orderType: 'Trigger por rango', marginMode: 'Isolated', collateral: 'USDC', entryTrigger: 'Retorno al rango', triggerPrice: 3740 },
  { id: 'bot3', name: 'bot3', action: 'Rebalanceo APR', active: false, mode: 'Long + Short', trigger: 'Rebalanceo cuando APR cae bajo 18%', hedge: '$18,900', health: 'Pausado', poolTokenId: '#894002', walletId: 'WLT-003', capitalPerTrade: 1200, poolCapitalPercent: 100, leverage: 1, autoLeverage: true, stop: 3.2, takeProfit: 'Trailing', tpSteps: [25, 50, 25], orderType: 'Trigger por APR', marginMode: 'Isolated', collateral: 'USDC', entryTrigger: 'APR bajo', triggerPrice: 18 },
];

const WALLETS = [
  { id: 'WLT-001', label: 'Wallet bot1', type: 'Bot', owner: 'bot1', address: '0x8a21...91F4', balance: 42850, network: 'Arbitrum' },
  { id: 'WLT-002', label: 'Wallet bot2', type: 'Bot', owner: 'bot2', address: '0x43d9...A2c8', balance: 31640, network: 'Base' },
  { id: 'WLT-003', label: 'Wallet bot3', type: 'Bot', owner: 'bot3', address: '0x71b4...0E19', balance: 28620, network: 'Optimism' },
  { id: 'WLT-004', label: 'Wallet pool BTC', type: 'Pool', owner: 'BTC/USDC', address: '0x5c02...B7D1', balance: 19840, network: 'Arbitrum' },
  { id: 'WLT-005', label: 'Wallet pool ETH', type: 'Pool', owner: 'ETH/USDC', address: '0x96ef...3C44', balance: 15290, network: 'Base' },
];

const SUBSCRIPTIONS = [
  { type: 'Starter', coverage: 10000 },
  { type: 'Growth', coverage: 20000 },
  { type: 'Pro', coverage: 50000 },
  { type: 'Prime', coverage: 100000 },
  { type: 'Vault', coverage: 500000 },
  { type: 'Institutional', coverage: 1000000 },
];

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const ALERT_TYPE_LABELS = {
  out_of_range: 'Fuera de rango',
  apy_below: 'APY bajo umbral',
  price_cross: 'Precio cruza nivel',
};

const INITIAL_SPOT_POSITIONS = [
  { asset: 'BTC', amount: 0.42, dca: 63200, currentPrice: null },
  { asset: 'ETH', amount: 8.6, dca: 3420, currentPrice: null },
];

// Campos UI de bots que no están en el schema de Convex (trading config extendida)
const DEFAULT_BOT_UI = {
  hedge: '—', health: '—', poolTokenId: '—',
  tpSteps: [25, 50, 25], autoLeverage: false, takeProfit: 'Fijo',
  orderType: 'Trigger por precio', marginMode: 'Isolated', collateral: 'USDC',
  entryTrigger: 'Fuera de rango', triggerPrice: 0, poolCapitalPercent: 100,
};

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatUsdCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}


function formatPrice(pair, value) {
  const max = pair.startsWith('BTC') ? 0 : 2;
  return value.toLocaleString('en-US', { maximumFractionDigits: max });
}

function aprParts(annual) {
  return {
    daily: annual / 365,
    weekly: annual / 52,
    monthly: annual / 12,
    annual,
  };
}


function Summary({ pools, bots }) {
  const accounts = useQuery(api.hlCredentials.list) ?? [];
  const totalLiquidity = pools.reduce((sum, pool) => sum + pool.liquidity, 0);
  // Fees del USUARIO: su parte proporcional en cada pool (misma fórmula que el PoolCard),
  // no el fee total del pool de DeFiLlama — así coincide con lo que se ve en cada tarjeta.
  const fees = pools.reduce((sum, pool) => {
    const fee1d = pool.fees1d ?? pool.fees24h ?? 0;
    const tvl = pool.tvl ?? 0;
    const share = tvl > 0 && pool.liquidity > 0 ? pool.liquidity / tvl : 0;
    return sum + fee1d * share;
  }, 0);
  const avgApy = pools.length > 0
    ? pools.reduce((sum, pool) => sum + (pool.apy ?? 0), 0) / pools.length
    : 0;

  return (
    <div className="summary-grid">
      <SummaryItem label="Liquidez monitoreada" value={formatUsd(totalLiquidity)} sub={`${pools.length} pools activos`} />
      <SummaryItem label="Fees 24h (tu parte)" value={formatUsd(fees)} sub="Estimado por posición" />
      <SummaryItem
        label="APY promedio"
        value={pools.length > 0 ? `${avgApy.toFixed(1)}%` : '—'}
        sub={pools.length > 0 ? `${(avgApy / 52).toFixed(2)}% semanal` : 'Sin datos'}
      />
      <SummaryItem label="Cuentas Hyperliquid" value={`${accounts.length}`} sub={accounts.length === 1 ? '1 conectada' : `${accounts.length} conectadas`} />
    </div>
  );
}

function SummaryItem({ label, value, sub }) {
  return (
    <div className="summary-item">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="subvalue">{sub}</div>
    </div>
  );
}

function NetworkLiquidity({ pools }) {
  const byNetwork = ['Ethereum', 'Arbitrum', 'Base', 'Optimism'].map((network) => {
    const networkPools = pools.filter((pool) => pool.network === network);
    const liquidity = networkPools.reduce((sum, pool) => sum + pool.liquidity, 0);
    const fees24h = networkPools.reduce((sum, pool) => sum + pool.fees24h, 0);
    const avgApy = networkPools.length
      ? networkPools.reduce((sum, pool) => sum + (pool.apy ?? 0), 0) / networkPools.length
      : 0;
    return { network, liquidity, fees24h, avgApy };
  });

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Liquidez diaria por red</h2>
        <span className="pill">24h</span>
      </div>
      <div className="network-liquidity">
        {byNetwork.map((item) => (
          <div className="network-card" key={item.network}>
            <div>
              <div className="network-name">{item.network}</div>
              <div className="label">Liquidez monitoreada</div>
            </div>
            <div className="network-value">{formatUsd(item.liquidity)}</div>
            <div className="network-meta">
              <span>Fees diarios <strong>{formatUsd(item.fees24h)}</strong></span>
              <span>APY prom. <strong>{item.avgApy.toFixed(1)}%</strong></span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const EXPLORER_URLS = {
  Ethereum: 'https://etherscan.io/address/',
  Arbitrum: 'https://arbiscan.io/address/',
  Base: 'https://basescan.org/address/',
  Optimism: 'https://optimistic.etherscan.io/address/',
};


function dexName(defillamaId) {
  if (!defillamaId) return 'Uniswap v3';
  if (defillamaId.includes('uniswap-v3')) return 'Uniswap v3';
  if (defillamaId.includes('uniswap-v2')) return 'Uniswap v2';
  if (defillamaId.includes('curve')) return 'Curve';
  return defillamaId.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

function shortenAddress(addr) {
  if (!addr) return null;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function PoolCard({ pool, canManage, canTradeLive }) {
  const deletePoolMutation = useMutation(api.pools.deletePool);
  const allBots = useQuery(api.bots.listBots);
  const savePoolBot = useMutation(api.bots.getOrCreatePoolBot);
  const deletePoolBotMutation = useMutation(api.bots.deletePoolBot);
  const closeBotPositionAction = useAction(api.hyperliquid.closeBotPosition);
  const ilBot = (allBots ?? []).find((b) => b.poolId === pool.id && b.kind === 'il') ?? null;
  const tradingBot = (allBots ?? []).find((b) => b.poolId === pool.id && b.kind === 'trading') ?? null;
  const [botModal, setBotModal] = React.useState(null);   // 'il' | 'trading' | null
  const [botBusy, setBotBusy] = React.useState(false);

  async function togglePoolBot(bot) {
    if (!bot || botBusy) return;
    setBotBusy(true);
    try {
      await savePoolBot(serializePoolBotConfig(bot, { active: !bot.active }));
    } catch (e) {
      window.alert(e?.message ?? 'No se pudo cambiar el estado del bot.');
    } finally {
      setBotBusy(false);
    }
  }

  // Elimina el bot deteniéndolo de forma segura. Si está bloqueado por una posición/ejecución viva
  // en HL, ofrece CERRARLA desde el portal (G4: cancela SL + cierra a mercado reduceOnly) y reintenta
  // el borrado — el usuario nunca queda atascado sin poder quitar el bot.
  async function deletePoolBotHandler(bot, label) {
    if (!bot || botBusy) return;
    if (!window.confirm(`¿Eliminar el bot "${label}" de este pool?\nSe detendrá de forma segura antes de borrarlo.`)) return;
    setBotBusy(true);
    try {
      let r = await deletePoolBotMutation({ botId: bot._id });
      if (r?.blockedByExecution) {
        const doClose = window.confirm('Este bot tiene una POSICIÓN ABIERTA en Hyperliquid (con su Stop Loss).\n\n¿Cerrarla ahora desde el portal (cierre a mercado reduceOnly + cancelar SL) y eliminar el bot?\n\nEs capital real: se cerrará la posición.');
        if (!doClose) return;
        const res = await closeBotPositionAction({ botId: bot._id });
        if (res?.sziAfter !== 0 || res?.ordersRemaining !== 0) {
          window.alert('No se pudo dejar la posición y sus órdenes (SL) totalmente cerradas en Hyperliquid. El bot se mantiene intacto y protegido. Revisa en Hyperliquid y reintenta en unos segundos.');
          return;
        }
        r = await deletePoolBotMutation({ botId: bot._id });
      }
      if (r?.stopping && !r?.deleted) {
        window.alert('El bot se está deteniendo (cancelando su cobertura automática). Vuelve a pulsar "Eliminar" en unos segundos.');
      }
    } catch (e) {
      window.alert(e?.message ?? 'No se pudo eliminar el bot.');
    } finally {
      setBotBusy(false);
    }
  }
  // (Codex #7) Rango con anchura > 0: protege el denominador frente a min===max (NaN%).
  const rangeSpan = pool.max - pool.min;
  const validRange = Number.isFinite(rangeSpan) && rangeSpan > 0;
  const hasPrice = pool.price != null && validRange;
  const pos = hasPrice
    ? Math.max(4, Math.min(96, ((pool.price - pool.min) / rangeSpan) * 100))
    : 50;
  // C: precio de entrada del LP (automático desde la posición). Se oculta si no se ha
  // capturado todavía, el rango es degenerado, o cae fuera del rango [min, max].
  const hasEntry = validRange && pool.entryPrice != null && pool.entryPrice >= pool.min && pool.entryPrice <= pool.max;
  const entryPos = hasEntry
    ? Math.max(4, Math.min(96, ((pool.entryPrice - pool.min) / rangeSpan) * 100))
    : 0;
  // APR calculado igual que Uniswap: Vol24h × feeTier/1M × 365 / TVL × 100
  const calcTvl = pool.tvl ?? 0;
  const calcVol = pool.volume1d ?? null;
  const calcFee = pool.feeTier ?? null;
  const rawApr = (Number.isFinite(calcVol) && Number.isFinite(calcFee) && Number.isFinite(calcTvl) && calcTvl > 0)
    ? (calcVol * (calcFee / 1_000_000) * 365 / calcTvl) * 100
    : null;
  const uniswapApr = Number.isFinite(rawApr) ? rawApr : null;

  // Usar APR calculado si está disponible, sino caer en DeFiLlama apy
  const displayApy = Number.isFinite(uniswapApr) ? uniswapApr
    : Number.isFinite(pool.apy) ? pool.apy
    : 0;
  const parts = aprParts(displayApy);
  const apyLabel = uniswapApr != null
    ? 'APR (Uniswap)'
    : pool.apyUpdatedAt ? 'APY DeFiLlama' : 'APY estimado';
  const tone = pool.status === 'Fuera de rango' ? 'red' : pool.status === 'Cerca del borde' ? 'amber' : 'green';
  const hasBorrowData = pool.borrowHealth > 0;
  const borrowTone = !hasBorrowData ? 'faint' : pool.borrowHealth < 50 ? 'red' : pool.borrowHealth < 70 ? 'amber' : 'green';
  const borrowLabel = !hasBorrowData ? 'Sin datos' : pool.borrowHealth < 50 ? 'Riesgo alto' : pool.borrowHealth < 70 ? 'Vigilar' : 'Saludable';

  const feeTierLabel = pool.feeTier != null ? `${(pool.feeTier / 10000).toFixed(2)}%` : null;
  const explorerBase = EXPLORER_URLS[pool.network] ?? null;
  const poolShort = shortenAddress(pool.poolAddress);

  // Desglose PNL — datos protegidos contra NaN/Infinity
  const fees1d = pool.fees1d ?? pool.fees24h ?? 0;
  const tvl = pool.tvl ?? 0;
  const feeApr = tvl > 0 ? (fees1d / tvl) * 365 * 100 : null;
  const totalApy = displayApy;
  const capitalApr = feeApr != null ? totalApy - feeApr : null;
  // Fees estimadas del usuario — proporcional a su posición dentro del pool total
  const userLiquidity = pool.liquidity;
  const userShare = tvl > 0 && userLiquidity > 0 ? userLiquidity / tvl : null;
  const userFees1d = userShare != null ? fees1d * userShare : null;


  return (
    <>
    <article className="pool-card">
      <div className="pool-title">
        <div>
          <div className="pair">{pool.pair}</div>
          <div className="network">{pool.network}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {feeTierLabel && <span className="pill" title="Fee tier">{feeTierLabel} fee</span>}
          {pool.closed
            ? <span className="pill red" title="La posición LP ya no existe on-chain">Posición cerrada</span>
            : <span className={`pill ${tone}`}>{pool.status}</span>}
          <button
            className="mini-btn"
            style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red)', borderColor: 'var(--red)' }}
            onClick={() => { if (window.confirm(`¿Eliminar pool ${pool.pair} (${pool.network})?`)) deletePoolMutation({ id: pool.id }); }}
          >
            ✕
          </button>
        </div>
      </div>

      {pool.closed && (
        <div className="pool-closed-banner">
          Esta posición ya no existe en Uniswap/Revert. Cierra la protección (pausa su bot)
          para poder proteger otro pool, o elimina este pool del portal.
        </div>
      )}

      <div className={`borrow-health borrow-health-featured ${hasBorrowData ? borrowTone : 'inactive'}`}>
        <div className="borrow-head">
          <span>Revert Lend {hasBorrowData ? '· Activo' : '· Sin apalancamiento'}</span>
          {hasBorrowData && <strong>{borrowLabel}</strong>}
        </div>
        {hasBorrowData ? (
          <>
            <div className="borrow-main">
              <span>{pool.healthFactor.toFixed(2)}</span>
              <strong>{pool.leverageRevert.toFixed(1)}% LTV</strong>
            </div>
            <div
              className="borrow-track"
              style={{ '--hp': `${pool.borrowHealth}%` }}
              aria-label={`Loan health ${pool.borrowHealth}%`}
            />
            <div className="borrow-foot">
              <span>Loan health</span>
              <span>Loan-to-value</span>
            </div>
            <div className="borrow-details">
              <div className="borrow-detail-item">
                <span className="borrow-detail-label">Deuda activa</span>
                <span className="borrow-detail-value">${pool.amountToRepay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</span>
              </div>
              <div className="borrow-detail-item">
                <span className="borrow-detail-label">Valor liquidación</span>
                <span className="borrow-detail-value negative">${pool.liquidationThreshold.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</span>
              </div>
              <div className="borrow-detail-item">
                <span className="borrow-detail-label">Disponible borrow</span>
                <span className="borrow-detail-value positive">${pool.availableToBorrow.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</span>
              </div>
            </div>
          </>
        ) : (
          <div className="borrow-inactive-msg">
            Este pool no usa Revert Lend — no hay posición apalancada
          </div>
        )}
      </div>

      <div className="range-chart" aria-label="Rango de precio">
        <div className="range-chart-inner">
          <div className="range-chart-labels">
            <span className="range-chart-max">${formatPrice(pool.pair, pool.max)}</span>
            <span className="range-chart-min">${formatPrice(pool.pair, pool.min)}</span>
          </div>
          <div className="range-chart-bar-wrap">
            <div className="range-chart-bar">
              <div
                className={`range-chart-fill${!hasPrice || pool.status === 'Fuera de rango' ? ' out' : ''}`}
                style={{ height: `${pos}%` }}
              />
            </div>
            {hasEntry && (() => {
              const entryTip = 'Precio observado al detectar la posición por primera vez (aproximado, no verificable on-chain). Uniswap V3 no guarda el precio de entrada real.';
              return (
                <div
                  className="range-chart-entry-line"
                  style={{ bottom: `${entryPos}%` }}
                  aria-label={`Entrada aproximada ${formatPrice(pool.pair, pool.entryPrice)}. ${entryTip}`}
                >
                  <span title={entryTip}>Entrada aprox.</span>
                  <strong title={entryTip}>${formatPrice(pool.pair, pool.entryPrice)}</strong>
                </div>
              );
            })()}
            {hasPrice && (
              <div className="range-chart-price-line" style={{ bottom: `${pos}%` }}>
                <span>Precio</span>
                <strong>${formatPrice(pool.pair, pool.price)}</strong>
              </div>
            )}
          </div>
        </div>
        <div className="range-chart-footer">
          {pool.liquidity > 0
            ? <><span>Posición LP</span><strong className="positive">{formatUsdCompact(pool.liquidity)}</strong></>
            : <span className="range-chart-no-pos">Posición LP no disponible</span>
          }
          {pool.feesUncollectedUsd != null && (
            <><span title="Comisiones de TU posición pendientes de cobrar (en vivo desde Uniswap). Distinto de 'Fees 24h' (del pool entero)." style={{ cursor: 'help' }}>Fees</span><strong className="positive">{formatUsdCompact(pool.feesUncollectedUsd)}</strong></>
          )}
          {hasPrice && (
            <span className="range-chart-pct">
              {Math.round(pos)}% del rango
            </span>
          )}
        </div>
      </div>

      <div className="pool-meta">
        <Metric label="TVL" value={pool.tvl != null ? formatUsdCompact(pool.tvl) : formatUsdCompact(pool.liquidity)} />
        <Metric label="Vol. 24h" value={pool.volume1d != null ? formatUsdCompact(pool.volume1d) : '—'} />
        <Metric label="Vol. 7d" value={pool.volume7d != null ? formatUsdCompact(pool.volume7d) : '—'} />
        <Metric label="Fees 24h" value={formatUsdCompact(pool.fees24h)} />
        <Metric label={apyLabel} value={`${parts.annual.toFixed(1)}%`} />
        <Metric label="Funding" value={pool.funding != null ? `${(pool.funding * 100).toFixed(4)}%` : '—'} />
      </div>
      <div className="pool-info">
        <span><span className="pool-info-label">Chain:</span> {pool.network}</span>
        <span><span className="pool-info-label">DEX:</span> {dexName(pool.defillamaId)}</span>
        {poolShort && (
          explorerBase
            ? <a className="pool-info-link" href={`${explorerBase}${pool.poolAddress}`} target="_blank" rel="noopener noreferrer">
                <span className="pool-info-label">Pool:</span> {poolShort}
              </a>
            : <span><span className="pool-info-label">Pool:</span> {poolShort}</span>
        )}
        {pool.apyUpdatedAt && (
          <span className="pool-info-ts">
            DeFiLlama {new Date(pool.apyUpdatedAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      <details className="pool-pnl" open>
        <summary className="pool-pnl-toggle">Proyección fees</summary>
        <div className="pool-pnl-body">

          {/* PROYECCIÓN FEES — fracción del usuario en los fees de la red */}
          <div className="pool-pnl-section">
            <div className="pool-pnl-section-title">
              Fees estimadas (tu posición
              {userShare != null ? ` · ${(userShare * 100).toFixed(3)}% del pool` : ''})
            </div>
            <div className="pool-pnl-grid pool-pnl-grid-4">
              <Metric label="Diario"
                value={userFees1d != null ? <span className="positive">{formatUsdCompact(userFees1d)} ({feeApr != null ? (feeApr / 365).toFixed(3) : '0.000'}%)</span> : '—'} />
              <Metric label="Semanal"
                value={userFees1d != null ? <span className="positive">{formatUsdCompact(userFees1d * 7)} ({feeApr != null ? (feeApr / 52).toFixed(2) : '0.00'}%)</span> : '—'} />
              <Metric label="Mensual"
                value={userFees1d != null ? <span className="positive">{formatUsdCompact(userFees1d * 30)} ({feeApr != null ? (feeApr / 12).toFixed(2) : '0.00'}%)</span> : '—'} />
              <Metric label="Anual"
                value={userFees1d != null ? <span className="positive">{formatUsdCompact(userFees1d * 365)} ({feeApr != null ? feeApr.toFixed(1) : '0.0'}%)</span> : '—'} />
            </div>
          </div>

          {(pool.tokenId != null) && (
            <div className="pool-info" style={{ marginTop: 8 }}>
              <span><span className="pool-info-label">NFT:</span> #{pool.tokenId}</span>
              <a className="pool-info-link" href={`https://app.uniswap.org/positions/v3/${pool.network.toLowerCase()}/${pool.tokenId}`} target="_blank" rel="noopener noreferrer">
                Ver en Uniswap
              </a>
            </div>
          )}

        </div>
      </details>

      {canManage && (
        <div className="pool-bot-actions" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <BotActionButton label="Proteger" bot={ilBot} busy={botBusy}
            onConfig={() => setBotModal('il')} onToggle={() => togglePoolBot(ilBot)}
            onDelete={() => deletePoolBotHandler(ilBot, 'Proteger')} />
          <BotActionButton label="Trading" bot={tradingBot} busy={botBusy}
            onConfig={() => setBotModal('trading')} onToggle={() => togglePoolBot(tradingBot)}
            onDelete={() => deletePoolBotHandler(tradingBot, 'Trading')} />
        </div>
      )}

    </article>
    {botModal === 'il' && <ProtectionBotModal pool={pool} bot={ilBot} canTradeLive={canTradeLive} onClose={() => setBotModal(null)} />}
    {botModal === 'trading' && <TradingBotModal pool={pool} bot={tradingBot} canTradeLive={canTradeLive} onClose={() => setBotModal(null)} />}
    </>
  );
}

function Metric({ label, value, title }) {
  return (
    <div className="metric" title={title} style={title ? { cursor: 'help' } : undefined}>
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SubscriptionBar({ pools = [] }) {
  const current = SUBSCRIPTIONS[2]; // Pro $50,000
  const [mobileOpen, setMobileOpen] = React.useState(false);
  // Cobertura usada = liquidez real monitoreada en los pools del usuario.
  const used = pools.reduce((sum, p) => sum + (p.liquidity ?? 0), 0);
  const pct = current.coverage > 0 ? Math.min(100, (used / current.coverage) * 100) : 0;
  const pctStr = `${pct.toFixed(pct < 10 ? 1 : 0)}%`;

  return (
    <div className={`sub-bar-inline${mobileOpen ? ' sub-mobile-open' : ''}`}>
      <button className="sub-plan-badge" onClick={() => setMobileOpen(v => !v)}>
        {current.type} Online <span className="sub-badge-chevron">{mobileOpen ? '▲' : '▼'}</span>
      </button>
      <div className="sub-stat">
        <span className="sub-stat-label">Cobertura: {formatUsdCompact(used)} / {formatUsdCompact(current.coverage)}</span>
        <div className="sub-progress-track">
          <div className="sub-progress-fill active" style={{ width: pctStr }} />
        </div>
      </div>
      <div className="sub-stat">
        <span className="sub-stat-label">Cobertura de pools: {formatUsdCompact(used)} / {formatUsdCompact(current.coverage)}</span>
        <div className="sub-progress-track">
          <div className="sub-progress-fill" style={{ width: pctStr }} />
        </div>
      </div>
      <button className="sub-upgrade-btn">Upgrade</button>
    </div>
  );
}

function WalletPanel() {
  const walletsFromDb = useQuery(api.wallets.listWallets);
  const wallets = (walletsFromDb ?? []).map((w) => ({ ...w, id: w._id, owner: w.ownerId ?? '—', balance: 0 }));
  const botWallets = wallets.filter((wallet) => wallet.type === 'Bot');
  const poolWallets = wallets.filter((wallet) => wallet.type === 'Pool');
  const [open, setOpen] = React.useState(false);

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Wallets</h2>
        <button className="mini-btn" onClick={() => setOpen((value) => !value)}>
          Wallet
        </button>
      </div>
      <div className="wallet-summary">
        <span className="pill">{wallets.length} conectadas</span>
        <span className="label">Wallets de bots y pools conectadas al portal.</span>
      </div>
      {open && (
        <>
          <div className="wallet-group-title">Bots</div>
          <div className="wallet-list">
            {botWallets.map((wallet) => <WalletRow key={wallet.id} wallet={wallet} />)}
          </div>
          <div className="wallet-group-title">Pools</div>
          <div className="wallet-list">
            {poolWallets.map((wallet) => <WalletRow key={wallet.id} wallet={wallet} />)}
          </div>
        </>
      )}
    </section>
  );
}

function WalletRow({ wallet }) {
  return (
    <div className="wallet-row">
      <div>
        <div className="wallet-name">{wallet.label}</div>
        <div className="network">{wallet.address}</div>
      </div>
      <div className="wallet-right">
        <span className="mono">{formatUsd(wallet.balance)}</span>
        <span className="pill">{wallet.owner}</span>
      </div>
    </div>
  );
}

function ConfigAction({ title, value, children }) {
  return (
    <details className="config-action">
      <summary className="config-action-summary">
        <span>{title}</span>
        <strong>{value}</strong>
      </summary>
      <div className="config-action-body">{children}</div>
    </details>
  );
}

function ToastContainer({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">{t.message}</div>
      ))}
    </div>
  );
}

// Devuelve el pool que protege el bot, o null si no está vinculado/cerrado.
// Un bot SIEMPRE actúa exclusivamente sobre su pool vinculado (bot.poolId);
// nunca sobre otros pools, aunque cumplan la condición (JAV-36 #1).
function linkedPool(bot, pools) {
  if (!bot.poolId) return null;
  const pool = pools.find(p => p.id === bot.poolId);
  if (!pool || pool.closed) return null; // pool inexistente o posición cerrada → no actúa
  return pool;
}

function evaluateTrigger(bot, pools, prices) {
  if (!bot.active || !bot.simulationMode) return false;
  if (bot.orderType === 'Trigger manual') return false; // solo disparo manual

  const pool = linkedPool(bot, pools);
  if (!pool) return false; // sin pool vinculado activo, el bot no dispara

  // DCA Auto: evaluar por entryTrigger si existe, sino por trigger text
  const t = (bot.entryTrigger ?? bot.trigger ?? '').toLowerCase();
  const asset = pool.pair?.split('/')[0];
  const price = prices[asset];

  if (t.includes('sale del rango') || t.includes('fuera de rango')) {
    return price != null && (price < pool.min || price > pool.max);
  }
  if (t.includes('recupera rango') || t.includes('retorno')) {
    return price != null && price >= pool.min && price <= pool.max;
  }
  if (t.includes('apr') || t.includes('rebalanceo')) {
    const match = t.match(/(\d+(?:\.\d+)?)/);
    const threshold = match ? parseFloat(match[1]) : 18;
    return pool.apy != null && pool.apy < threshold;
  }
  return false;
}

function getSignalMeta(bot, pools, prices) {
  const pool = linkedPool(bot, pools);
  const asset = pool?.pair?.split('/')[0] ?? 'POOL';
  return { asset, price: prices[asset] ?? 0, network: pool?.network ?? 'Arbitrum' };
}

function BotCard({ bot, pools = [], poolClosed, canManage, onSetActive, onMode, onConfig, onManualTrigger, userLoaded }) {
  const tone = bot.active ? 'green' : 'faint';
  const [configOpen, setConfigOpen] = React.useState(false);
  const wallet = WALLETS.find((item) => item.id === bot.walletId);
  const tpTotal = bot.tpSteps.reduce((sum, value) => sum + value, 0);

  function updateTpStep(index, value) {
    const next = [...bot.tpSteps];
    next[index] = Number(value);
    onConfig(bot.id, { tpSteps: next });
  }

  return (
    <article className="bot-card">
      <div className="bot-head">
        <div>
          <div className="bot-name">{bot.name}</div>
          <div className="network">{bot.action}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {userLoaded && !canManage && <span className="pill faint" title="Solo lectura">Lectura</span>}
          {poolClosed && <span className="pill red" title="El pool protegido se cerró on-chain">Pool cerrado</span>}
          <span className={`pill ${tone}`}>{bot.active ? 'Activo' : 'Pausado'}</span>
        </div>
      </div>
      {poolClosed && (
        <div className="bot-pool-closed">
          El pool que protege este bot se cerró on-chain. El bot fue pausado automáticamente.
          Vincúlalo a otro pool o elimínalo.
        </div>
      )}
      <div className="bot-row">
        <span>
          {bot.orderType === 'Trigger manual'
            ? 'Modo manual'
            : `DCA Auto · ${bot.entryTrigger ?? bot.trigger}`}
        </span>
        <span className="mono">{bot.hedge}</span>
      </div>
      <div className="bot-row">
        <span>Modo: <strong className={bot.mode === 'Long' ? 'blue' : 'cyan'}>{bot.mode}</strong></span>
        <div className="bot-actions">
          <button className={`mini-btn ${bot.mode === 'Long' ? 'active' : ''}`} onClick={() => onMode(bot.id, 'Long')} disabled={!canManage}>Long</button>
          <button className={`mini-btn ${bot.mode === 'Short' ? 'active' : ''}`} onClick={() => onMode(bot.id, 'Short')} disabled={!canManage}>Short</button>
          <button className={`mini-btn ${bot.mode === 'Long + Short' ? 'active' : ''}`} onClick={() => onMode(bot.id, 'Long + Short')} disabled={!canManage}>Long + Short</button>
        </div>
      </div>
      <div className="futures-summary">
        <div className="futures-title">Operación de futuros</div>
        <div className="futures-grid">
          <Metric label="Dirección" value={bot.mode} />
          <Metric label="Orden" value={bot.orderType} />
          <Metric label="Margen" value={bot.marginMode} />
          <Metric label="Wallet HL" value={bot.walletId?.startsWith('0x') ? `${bot.walletId.slice(0,8)}…` : '—'} />
          <Metric label="Pool monitor" value={`${bot.poolCapitalPercent}%`} />
          <Metric label="Leverage" value={bot.autoLeverage ? 'Auto' : `${bot.leverage ?? 0}x`} />
          <Metric label="Stop" value={`${bot.stop.toFixed(1)}%`} />
          <Metric label="TP" value={bot.takeProfit} />
        </div>
      </div>
      <div className="bot-state-actions">
        <button className={`mini-btn ${!bot.active ? 'active' : ''}`} onClick={() => onSetActive(bot.id, false)} disabled={!canManage}>Pausar</button>
        <button className={`mini-btn ${bot.active ? 'active' : ''}`} onClick={() => onSetActive(bot.id, true)} disabled={!canManage || !bot.poolId || poolClosed} title={!bot.poolId ? 'Vincula un pool primero' : poolClosed ? 'El pool protegido está cerrado' : ''}>Activar</button>
      </div>
      <div className="wallet-actions">
        <button className="mini-btn" onClick={() => setConfigOpen((value) => !value)} disabled={!canManage}>Configurar</button>
        <button className="mini-btn">Escanear wallet</button>
        <button className="mini-btn">Token ID de pool {bot.poolTokenId}</button>
        {bot.simulationMode && canManage && (
          <button className="mini-btn amber" onClick={() => onManualTrigger?.(bot)} disabled={!bot.poolId || poolClosed}>
            Disparar señal
          </button>
        )}
      </div>
      {configOpen && (
        <div className="bot-config">
          <div className="config-header">
            <div>
              <div className="config-title">{bot.name}</div>
              <div className="network">{wallet?.label} · {wallet?.address}</div>
            </div>
            <span className="pill">{bot.poolTokenId}</span>
          </div>

          <ConfigAction
            title="Pool protegido"
            value={(() => {
              const lp = pools.find((p) => p.id === bot.poolId);
              return lp ? `${lp.pair} · ${lp.network}` : 'Sin vincular';
            })()}
          >
            <label className="config-field">
              <span>Pool que protege este bot</span>
              <select
                value={bot.poolId ?? ''}
                onChange={(event) => onConfig(bot.id, { poolId: event.target.value || null })}
              >
                <option value="">Sin vincular</option>
                {pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.pair} · {p.network}{p.closed ? ' (cerrado)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <p className="network" style={{ marginTop: 6 }}>
              El bot solo actúa sobre su pool vinculado. Sin pool (o con el pool cerrado) no dispara.
            </p>
          </ConfigAction>

          <ConfigAction title="Dirección" value={bot.mode}>
            <label className="config-field">
              <span>Dirección de cobertura</span>
              <select value={bot.mode} onChange={(event) => onMode(bot.id, event.target.value)}>
                <option>Long</option>
                <option>Short</option>
                <option>Long + Short</option>
              </select>
            </label>
          </ConfigAction>

          <ConfigAction
            title="Modo trigger"
            value={bot.orderType === 'Trigger manual' ? 'Manual' : 'DCA Auto'}
          >
            <div className="trigger-mode-switch">
              <button
                className={`trigger-option${bot.orderType === 'Trigger manual' ? ' active' : ''}`}
                onClick={() => onConfig(bot.id, { orderType: 'Trigger manual' })}
              >
                Manual
              </button>
              <button
                className={`trigger-option${bot.orderType !== 'Trigger manual' ? ' active' : ''}`}
                onClick={() => onConfig(bot.id, { orderType: 'Trigger por rango' })}
              >
                DCA Auto
              </button>
            </div>
            {bot.orderType === 'Trigger manual' ? (
              <p className="network" style={{ marginTop: 6 }}>
                El bot solo dispara cuando pulsas "Disparar señal" manualmente.
              </p>
            ) : (
              <>
                <label className="config-field" style={{ marginTop: 6 }}>
                  <span>Precio DCA / nivel de entrada</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={bot.triggerPrice}
                    onChange={(event) => onConfig(bot.id, { triggerPrice: Number(event.target.value) })}
                  />
                </label>
                <label className="config-field">
                  <span>Condición</span>
                  <select value={bot.entryTrigger} onChange={(event) => onConfig(bot.id, { entryTrigger: event.target.value })}>
                    <option>Fuera de rango</option>
                    <option>Retorno al rango</option>
                    <option>APR bajo</option>
                    <option>Volatilidad alta</option>
                  </select>
                </label>
                <p className="network" style={{ marginTop: 4 }}>
                  El bot evalúa la condición automáticamente con precios en tiempo real.
                </p>
              </>
            )}
          </ConfigAction>

          <ConfigAction
            title="Wallet HL"
            value={bot.walletId?.startsWith('0x') ? `${bot.walletId.slice(0, 8)}…${bot.walletId.slice(-6)}` : (bot.walletId ?? 'Sin configurar')}
          >
            <label className="config-field">
              <span>Dirección wallet HL (0x)</span>
              <input
                type="text"
                placeholder="0x... wallet para ejecutar cobertura"
                value={bot.walletId ?? ''}
                onChange={(event) => onConfig(bot.id, { walletId: event.target.value.trim() })}
              />
            </label>
            <div className="config-field">
              <span>Leverage (1-25x)</span>
              <div className="range-control">
                <input
                  type="range"
                  min="1"
                  max="25"
                  step="1"
                  value={bot.leverage}
                  onChange={(event) => onConfig(bot.id, { leverage: Number(event.target.value) })}
                  disabled={bot.autoLeverage}
                />
                <strong>{bot.autoLeverage ? 'Auto' : `${bot.leverage}x`}</strong>
              </div>
            </div>
            <label className="config-check">
              <input
                type="checkbox"
                checked={bot.autoLeverage}
                onChange={(event) => onConfig(bot.id, { autoLeverage: event.target.checked })}
              />
              <span>Autoleverage</span>
            </label>
            <label className="config-field">
              <span>Colateral</span>
              <select value={bot.collateral} onChange={(event) => onConfig(bot.id, { collateral: event.target.value })}>
                <option>USDC</option>
                <option>USDT</option>
                <option>USD</option>
              </select>
            </label>
          </ConfigAction>

          <ConfigAction title="Stop" value={`${bot.stop.toFixed(1)}%`}>
            <div className="config-field">
              <span>Stop</span>
              <div className="range-control">
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={bot.stop}
                  onChange={(event) => onConfig(bot.id, { stop: Number(event.target.value) })}
                />
                <strong>{bot.stop.toFixed(1)}%</strong>
              </div>
            </div>
          </ConfigAction>

          <ConfigAction title="Take profit" value={bot.takeProfit}>
            <label className="config-field">
              <span>Tipo de TP</span>
              <select value={bot.takeProfit} onChange={(event) => onConfig(bot.id, { takeProfit: event.target.value })}>
                <option>Fijo</option>
                <option>Escalonado</option>
                <option>Trailing</option>
                <option>Por APR</option>
                <option>Por cierre de rango</option>
              </select>
            </label>
            {bot.takeProfit === 'Escalonado' && (
              <div className="tp-steps">
                <div className="tp-head">
                  <span>Escalones de TP</span>
                  <strong className={tpTotal === 100 ? 'green' : 'amber'}>{tpTotal}% total</strong>
                </div>
                {[0, 1, 2].map((index) => (
                  <label className="config-field" key={index}>
                    <span>TP {index + 1}</span>
                    <div className="range-control">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={bot.tpSteps[index]}
                        onChange={(event) => updateTpStep(index, event.target.value)}
                      />
                      <strong>{bot.tpSteps[index]}%</strong>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </ConfigAction>
        </div>
      )}
    </article>
  );
}

function RiskPanel({ pools }) {
  return (
    <section className="panel">
      <div className="section-head">
        <h2>Riesgo por pool</h2>
        <span className="pill">Delta estimado</span>
      </div>
      <div className="risk-table">
        {pools.map((pool) => {
          const risk = pool.exposure > 0.82 ? 'Alto' : pool.exposure > 0.68 ? 'Medio' : 'Bajo';
          const tone = risk === 'Alto' ? 'red' : risk === 'Medio' ? 'amber' : 'green';
          return (
            <div className="risk-row" key={pool.id}>
              <span>{pool.pair} <span className="network">en {pool.network}</span></span>
              <span className="mono">{pool.exposure.toFixed(2)}</span>
              <span className={tone}>{risk}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const DEFAULT_PROTECTOR = { active: true, side: 'Short', leverage: 4, buySize: 15, maxBuys: 3, capitalReserve: 5000, orderType: 'Cobertura DCA', takeProfit: 'Rebajar DCA', hlWallet: '', stopLoss: 1, tradeAmount: 0, moveSlToBE: false, moveSlToBEAt: 1 };

function HLMarketPanel() {
  const [hlSearch, setHlSearch] = React.useState('');
  const { allPrices, connected: hlConnected } = useHyperliquidAllMids();

  return (
    <div className="hl-market">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <input
          className="hl-search"
          placeholder="Buscar asset..."
          value={hlSearch}
          onChange={e => setHlSearch(e.target.value.toUpperCase())}
          style={{ margin: 0, flex: 1 }}
        />
        <span className={`pill${hlConnected ? ' green' : ''}`}>
          {hlConnected ? 'En vivo' : 'Conectando...'}
        </span>
      </div>
      <div className="hl-price-grid">
        {Object.entries(allPrices)
          .filter(([asset]) => !hlSearch || asset.includes(hlSearch))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([asset, price]) => (
            <div key={asset} className="hl-price-row">
              <span className="hl-asset">{asset}</span>
              <span className="hl-price mono">${formatPrice(`${asset}/USDC`, price)}</span>
            </div>
          ))
        }
      </div>
    </div>
  );
}

function protectorKey(userId, asset) {
  return `protector_${userId ?? 'anon'}_${asset}`;
}

function loadProtector(userId, asset) {
  try {
    const saved = localStorage.getItem(protectorKey(userId, asset));
    return saved ? { ...DEFAULT_PROTECTOR, ...JSON.parse(saved) } : DEFAULT_PROTECTOR;
  } catch (_) { return DEFAULT_PROTECTOR; }
}

function saveProtector(userId, asset, protector) {
  try { localStorage.setItem(protectorKey(userId, asset), JSON.stringify(protector)); } catch (_) {}
}

function PurchaseHistorySection({ asset }) {
  const history = useQuery(api.spot_positions.listPurchaseHistory, { asset });
  if (!history) return <p className="network" style={{ padding: '8px 0' }}>Cargando...</p>;
  if (!history.length) return <p className="network" style={{ padding: '8px 0' }}>Sin compras registradas.</p>;
  return (
    <div className="purchase-history-list">
      {history.map((h) => {
        const date = new Date(h.timestamp);
        const dateStr = date.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const timeStr = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        const isFirst = h.dcaBefore === 0;
        return (
          <div key={h._id} className="purchase-history-row">
            <div className="purchase-history-left">
              <span className={`pill ${isFirst ? 'blue' : 'green'}`}>{isFirst ? 'Inicial' : '+ Compra'}</span>
              <span className="mono">+{h.qty} {h.asset} @ ${h.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="purchase-history-right">
              {!isFirst && (
                <span className="network">
                  DCA {h.dcaBefore.toLocaleString('en-US', { maximumFractionDigits: 0 })} → <strong>${h.dcaAfter.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong>
                </span>
              )}
              <span className="network">{dateStr} {timeStr}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SpotPositions({ prices, connected, userId, simulationMode, tradingEnabled, isAdmin, userLoaded }) {
  const positionsFromDb = useQuery(api.spot_positions.listMyPositions);
  const addPositionMutation = useMutation(api.spot_positions.addPosition);
  const updatePositionMutation = useMutation(api.spot_positions.updatePosition);
  const recordPurchaseMutation = useMutation(api.spot_positions.recordPurchase);
  const recordSignalMutation = useMutation(api.tradesHistory.recordSignal);
  const [positions, setPositions] = React.useState(() =>
    INITIAL_SPOT_POSITIONS.map(p => ({ ...p, protector: loadProtector(userId, p.asset) }))
  );
  const [openAssets, setOpenAssets] = React.useState({});
  const [addForm, setAddForm] = React.useState({});
  const [openPurchase, setOpenPurchase] = React.useState({});
  const [purchaseForm, setPurchaseForm] = React.useState({});
  const [openHistory, setOpenHistory] = React.useState({});
  const [editingAssets, setEditingAssets] = React.useState({});
  const [drafts, setDrafts] = React.useState(() => {
    const d = {};
    for (const p of INITIAL_SPOT_POSITIONS) {
      d[p.asset] = { dca: String(p.dca), amount: String(p.amount) };
    }
    return d;
  });
  const cooldownRef = React.useRef({});
  const COOLDOWN_MS = 60 * 60 * 1000;

  React.useEffect(() => {
    if (!positionsFromDb?.length) return;
    setPositions(positionsFromDb.map((p) => ({
      ...p, id: p._id, currentPrice: null, protector: loadProtector(userId, p.asset),
    })));
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of positionsFromDb) {
        next[p.asset] = { dca: String(p.dca), amount: String(p.amount) };
      }
      return next;
    });
  }, [positionsFromDb]);

  React.useEffect(() => {
    setPositions((items) => items.map((pos) => ({
      ...pos, currentPrice: prices[pos.asset] ?? pos.currentPrice,
    })));
  }, [prices]);

  const recordSpotSignal = React.useCallback(async (asset, triggerType, price, amount, protector) => {
    try {
      const lev = protector?.leverage ?? 0;
      const sl = protector?.stopLoss ?? 1;
      const be = protector?.moveSlToBE ? ` BE@${protector.moveSlToBEAt ?? 1}%` : '';
      const side = protector?.side ?? 'Short';
      const action = `Cobertura ${side} ${asset} ${lev}x SL${sl}%${be}`;

      // El protector spot solo registra señal (simulación). La ejecución real es de los
      // pool-bots por botId (Parte C / Fase 3, bloqueada por JAV-37).
      await recordSignalMutation({ action, asset, amount, price, network: 'Spot', botName: `Bot protector ${asset}`, triggerType });
    } catch (error) {
      console.error('Failed to record spot protector signal', error);
    }
  }, [recordSignalMutation]);

  const EVM_RE_AUTO = /^0x[a-fA-F0-9]{40}$/;

  // Evaluación automática — corre en cada tick de precio
  React.useEffect(() => {
    for (const pos of positions) {
      const p = pos.protector;
      if (!p?.active || !pos.currentPrice || p.orderType === 'Trigger manual') continue;
      if (!p.tradeAmount || p.tradeAmount <= 0) continue;             // guard: monto configurado
      if (!p.hlWallet || !EVM_RE_AUTO.test(p.hlWallet)) continue;     // guard: wallet HL válida
      if (!simulationMode && !tradingEnabled) continue;               // guard: no live without backend flag
      const now = Date.now();
      if (now - (cooldownRef.current[pos.asset] ?? 0) < COOLDOWN_MS) continue;
      if (pos.currentPrice <= pos.dca) {
        cooldownRef.current[pos.asset] = now;
        recordSpotSignal(pos.asset, 'auto', pos.currentPrice, p.tradeAmount, p);
      }
    }
  }, [positions, recordSpotSignal, simulationMode, tradingEnabled]);

  function handleDraftChange(asset, field, value) {
    setDrafts((prev) => ({ ...prev, [asset]: { ...prev[asset], [field]: value } }));
  }

  function commitDraft(asset, field) {
    const raw = drafts[asset]?.[field] ?? '';
    const num = parseFloat(raw);
    const pos = positions.find((p) => p.asset === asset);
    if (!raw || isNaN(num) || num <= 0) {
      // Revert to last valid value
      if (pos) setDrafts((prev) => ({ ...prev, [asset]: { ...prev[asset], [field]: String(pos[field]) } }));
      return;
    }
    setPositions((items) => items.map((item) => (item.asset !== asset ? item : { ...item, [field]: num })));
    if (pos?.id) {
      updatePositionMutation({ id: pos.id, [field]: num }).catch((err) => console.error('updatePosition failed', err));
    }
  }

  function updateProtector(asset, patch) {
    setPositions((items) => items.map((item) => {
      if (item.asset !== asset) return item;
      const updated = { ...item.protector, ...patch };
      saveProtector(userId, asset, updated);
      return { ...item, protector: updated };
    }));
  }

  const SPOT_ASSETS = ['BTC', 'ETH'];
  const missingAssets = positionsFromDb !== undefined
    ? SPOT_ASSETS.filter((a) => !positionsFromDb.some((p) => p.asset === a))
    : [];

  async function handleAddPosition(asset) {
    const form = addForm[asset] ?? {};
    const amount = parseFloat(form.amount);
    const dca = parseFloat(form.dca);
    if (!amount || amount <= 0 || !dca || dca <= 0) return;
    try {
      await addPositionMutation({ asset, amount, dca });
      setAddForm((prev) => ({ ...prev, [asset]: { amount: '', dca: '' } }));
    } catch (err) {
      console.error('addPosition failed', err);
    }
  }

  function toggleAsset(asset) {
    setOpenAssets(prev => ({ ...prev, [asset]: !prev[asset] }));
  }

  function togglePurchase(asset) {
    setOpenPurchase((prev) => ({ ...prev, [asset]: !prev[asset] }));
    setPurchaseForm((prev) => ({ ...prev, [asset]: { qty: '', price: '' } }));
  }

  function startEdit(asset) {
    setEditingAssets(prev => ({ ...prev, [asset]: true }));
  }

  function cancelEdit(asset) {
    const pos = positions.find(p => p.asset === asset);
    if (pos) setDrafts(prev => ({ ...prev, [asset]: { dca: String(pos.dca), amount: String(pos.amount) } }));
    setEditingAssets(prev => ({ ...prev, [asset]: false }));
  }

  function saveEdit(asset) {
    const dcaRaw = drafts[asset]?.dca ?? '';
    const amountRaw = drafts[asset]?.amount ?? '';
    const dca = parseFloat(dcaRaw);
    const amount = parseFloat(amountRaw);
    if (!dcaRaw || isNaN(dca) || dca <= 0 || !amountRaw || isNaN(amount) || amount <= 0) return;
    const pos = positions.find(p => p.asset === asset);
    setPositions(items => items.map(item => item.asset !== asset ? item : { ...item, dca, amount }));
    if (pos?.id) {
      updatePositionMutation({ id: pos.id, dca, amount }).catch(err => console.error('updatePosition failed', err));
    }
    setEditingAssets(prev => ({ ...prev, [asset]: false }));
  }

  function calcNewDCA(currentAmount, currentDCA, addQty, addPrice) {
    const newAmount = currentAmount + addQty;
    const newDCA = (currentAmount * currentDCA + addQty * addPrice) / newAmount;
    return { newDCA, newAmount };
  }

  async function handleRegisterPurchase(asset) {
    const form = purchaseForm[asset] ?? {};
    const qty = parseFloat(form.qty);
    const price = parseFloat(form.price);
    if (!qty || qty <= 0 || !price || price <= 0) return;
    const pos = positions.find((p) => p.asset === asset);
    if (!pos) return;
    const { newDCA, newAmount } = calcNewDCA(pos.amount, pos.dca, qty, price);
    setPositions((items) => items.map((item) =>
      item.asset !== asset ? item : { ...item, dca: newDCA, amount: newAmount }
    ));
    setDrafts((prev) => ({
      ...prev,
      [asset]: { dca: String(Math.round(newDCA)), amount: String(+newAmount.toFixed(8)) },
    }));
    if (pos.id) {
      updatePositionMutation({ id: pos.id, dca: newDCA, amount: newAmount }).catch((err) =>
        console.error('updatePosition failed', err)
      );
    }
    recordPurchaseMutation({
      asset,
      qty,
      price,
      dcaBefore: pos.dca,
      dcaAfter: newDCA,
      amountBefore: pos.amount,
      amountAfter: newAmount,
    }).catch((err) => console.error('recordPurchase failed', err));
    setOpenPurchase((prev) => ({ ...prev, [asset]: false }));
    setPurchaseForm((prev) => ({ ...prev, [asset]: { qty: '', price: '' } }));
  }

  const portfolioInvested = positions.reduce((s, p) => {
    const dca = editingAssets[p.asset] ? (parseFloat(drafts[p.asset]?.dca) || p.dca) : p.dca;
    const amount = editingAssets[p.asset] ? (parseFloat(drafts[p.asset]?.amount) || p.amount) : p.amount;
    return s + dca * amount;
  }, 0);
  const portfolioCurrent = positions.reduce((s, p) => {
    const amount = editingAssets[p.asset] ? (parseFloat(drafts[p.asset]?.amount) || p.amount) : p.amount;
    return s + (p.currentPrice != null ? p.currentPrice * amount : 0);
  }, 0);
  const portfolioHasPrices = positions.some((p) => p.currentPrice != null);
  const portfolioPnl = portfolioHasPrices ? portfolioCurrent - portfolioInvested : null;
  const portfolioPnlPct = portfolioPnl != null && portfolioInvested > 0 ? (portfolioPnl / portfolioInvested) * 100 : null;
  const portfolioPositive = portfolioPnl != null && portfolioPnl >= 0;

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Posiciones spot</h2>
        {portfolioHasPrices && (
          <span className={`spot-calc-value${portfolioPositive ? ' positive' : ' negative'}`} style={{ fontSize: 14 }}>
            {formatUsd(portfolioCurrent)}
            {portfolioPnlPct != null && (
              <span style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}>
                {portfolioPositive ? '+' : ''}{portfolioPnlPct.toFixed(2)}%
              </span>
            )}
          </span>
        )}
        <span className={`pill${connected ? ' green' : ''}`}>{connected ? 'HL en vivo' : 'Conectando...'}</span>
        <span className={`pill${!simulationMode && tradingEnabled ? ' green' : ' amber'}`}>
          {!simulationMode && tradingEnabled ? 'Ejecución HL' : 'Simulación'}
        </span>
      </div>
      <div className="spot-list">
        {missingAssets.map((asset) => (
          <article className="spot-card" key={`add-${asset}`}>
            <div className="spot-collapse-btn">
              <span className="pair" style={{ flexShrink: 0 }}>{asset}</span>
              <div className="spot-collapse-inputs">
                <label className="spot-inline-field">
                  <span>Precio DCA</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="ej. 63200"
                    value={addForm[asset]?.dca ?? ''}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, [asset]: { ...prev[asset], dca: e.target.value } }))}
                  />
                </label>
                <label className="spot-inline-field">
                  <span>Monto ({asset})</span>
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    placeholder="ej. 0.42"
                    value={addForm[asset]?.amount ?? ''}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, [asset]: { ...prev[asset], amount: e.target.value } }))}
                  />
                </label>
              </div>
              <div className="spot-collapse-right">
                <button className="mini-btn active" onClick={() => handleAddPosition(asset)}>+ Añadir</button>
              </div>
            </div>
          </article>
        ))}

        {positions.map((position) => {
          const hasPrice = position.currentPrice != null;
          const isOpen = !!openAssets[position.asset];
          const isEditing = !!editingAssets[position.asset];
          const displayDca = isEditing ? (parseFloat(drafts[position.asset]?.dca) || position.dca) : position.dca;
          const displayAmount = isEditing ? (parseFloat(drafts[position.asset]?.amount) || position.amount) : position.amount;
          const invested = displayDca * displayAmount;
          const currentVal = hasPrice ? position.currentPrice * displayAmount : null;
          const pnl = currentVal != null ? currentVal - invested : null;
          const pnlPositive = pnl != null && pnl >= 0;
          const pnlPct = pnl != null && invested > 0 ? (pnl / invested) * 100 : null;
          const pForm = purchaseForm[position.asset] ?? {};
          const addQty = parseFloat(pForm.qty);
          const addPrice = parseFloat(pForm.price);
          const purchasePreview = addQty > 0 && addPrice > 0
            ? calcNewDCA(position.amount, position.dca, addQty, addPrice)
            : null;

          return (
            <article className="spot-card" key={position.asset}>
              {/* Cabecera */}
              <div className="spot-card-header">
                <div className="spot-card-identity">
                  <span className="pair">{position.asset}</span>
                  {hasPrice && (
                    <span className="spot-live-price">
                      ${formatPrice(`${position.asset}/USDC`, position.currentPrice)}
                    </span>
                  )}
                </div>
                <div className="spot-card-actions">
                  {isEditing ? (
                    <>
                      <button className="mini-btn active" onClick={() => saveEdit(position.asset)}>Guardar</button>
                      <button className="mini-btn" onClick={() => cancelEdit(position.asset)}>Cancelar</button>
                    </>
                  ) : (
                    <button className="mini-btn" onClick={() => startEdit(position.asset)}>Modificar</button>
                  )}
                  <button
                    className={`mini-btn${openPurchase[position.asset] ? ' amber' : ''}`}
                    onClick={() => togglePurchase(position.asset)}
                  >
                    {openPurchase[position.asset] ? '✕ Cancelar' : '+ Compra'}
                  </button>
                  <button
                    className={`mini-btn${openHistory[position.asset] ? ' active' : ''}`}
                    onClick={() => setOpenHistory((prev) => ({ ...prev, [position.asset]: !prev[position.asset] }))}
                  >
                    Historial
                  </button>
                  <button className="mini-btn" onClick={() => toggleAsset(position.asset)}>
                    Bot {isOpen ? '▲' : '▼'}
                  </button>
                  <span className="pill">{position.protector?.active ? 'Bot activo' : 'Bot pausado'}</span>
                </div>
              </div>

              {/* Métricas bloqueadas */}
              {!isEditing && (
                <div className="spot-metrics-display">
                  <div className="spot-metric-cell">
                    <span>Precio DCA</span>
                    <strong>${formatPrice(`${position.asset}/USDC`, position.dca)}</strong>
                  </div>
                  <div className="spot-metric-cell">
                    <span>Monto ({position.asset})</span>
                    <strong>{position.amount}</strong>
                  </div>
                  <div className="spot-metric-cell">
                    <span>Invertido</span>
                    <strong>{invested > 0 ? formatUsd(invested) : '—'}</strong>
                  </div>
                  <div className="spot-metric-cell">
                    <span>Valor actual</span>
                    <strong className={currentVal != null ? (pnlPositive ? 'positive' : 'negative') : ''}>
                      {currentVal != null ? formatUsd(currentVal) : '—'}
                    </strong>
                  </div>
                  <div className="spot-metric-cell">
                    <span>ROI</span>
                    {pnlPct != null ? (
                      <>
                        <strong className={pnlPositive ? 'positive' : 'negative'}>
                          {pnlPositive ? '+' : ''}{pnlPct.toFixed(2)}%
                        </strong>
                        <em className={`spot-metric-sub ${pnlPositive ? 'positive' : 'negative'}`}>
                          {pnlPositive ? '+' : ''}{formatUsd(pnl)}
                        </em>
                      </>
                    ) : <strong>—</strong>}
                  </div>
                </div>
              )}

              {/* Formulario de edición */}
              {isEditing && (
                <div className="spot-edit-form">
                  <div className="spot-edit-field">
                    <span>Precio DCA</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={drafts[position.asset]?.dca ?? ''}
                      onChange={(e) => handleDraftChange(position.asset, 'dca', e.target.value)}
                    />
                  </div>
                  <div className="spot-edit-field">
                    <span>Monto ({position.asset})</span>
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      value={drafts[position.asset]?.amount ?? ''}
                      onChange={(e) => handleDraftChange(position.asset, 'amount', e.target.value)}
                    />
                  </div>
                  <div className="spot-edit-field">
                    <span>Invertido</span>
                    <strong>{invested > 0 ? formatUsd(invested) : '—'}</strong>
                  </div>
                  <div className="spot-edit-field">
                    <span>Valor actual</span>
                    <strong className={currentVal != null ? (pnlPositive ? 'positive' : 'negative') : ''}>
                      {currentVal != null ? formatUsd(currentVal) : '—'}
                    </strong>
                  </div>
                  <div className="spot-edit-field">
                    <span>ROI</span>
                    {pnlPct != null ? (
                      <>
                        <strong className={pnlPositive ? 'positive' : 'negative'}>
                          {pnlPositive ? '+' : ''}{pnlPct.toFixed(2)}%
                        </strong>
                        <em className={`spot-metric-sub ${pnlPositive ? 'positive' : 'negative'}`}>
                          {pnlPositive ? '+' : ''}{formatUsd(pnl)}
                        </em>
                      </>
                    ) : <strong>—</strong>}
                  </div>
                </div>
              )}

              {openPurchase[position.asset] && (
                <div className="spot-purchase-form">
                  <label className="spot-inline-field">
                    <span>Cantidad comprada ({position.asset})</span>
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      placeholder="ej. 0.10"
                      value={pForm.qty ?? ''}
                      onChange={(e) => setPurchaseForm((prev) => ({ ...prev, [position.asset]: { ...prev[position.asset], qty: e.target.value } }))}
                    />
                  </label>
                  <label className="spot-inline-field">
                    <span>Precio pagado (USD)</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="ej. 58000"
                      value={pForm.price ?? ''}
                      onChange={(e) => setPurchaseForm((prev) => ({ ...prev, [position.asset]: { ...prev[position.asset], price: e.target.value } }))}
                    />
                  </label>
                  {purchasePreview && (
                    <div className="spot-purchase-preview">
                      <span>Nuevo DCA <strong>${formatPrice(`${position.asset}/USDC`, purchasePreview.newDCA)}</strong></span>
                      <span>Nueva cantidad <strong>{+purchasePreview.newAmount.toFixed(8)} {position.asset}</strong></span>
                      <span>Nuevo invertido <strong>{formatUsd(purchasePreview.newDCA * purchasePreview.newAmount)}</strong></span>
                    </div>
                  )}
                  <button
                    className="mini-btn active"
                    onClick={() => handleRegisterPurchase(position.asset)}
                    disabled={!purchasePreview}
                  >
                    Confirmar compra
                  </button>
                </div>
              )}

              {openHistory[position.asset] && (
                <div className="spot-history-panel">
                  <div className="section-sub" style={{ marginTop: 0 }}>Historial de compras — {position.asset}</div>
                  <PurchaseHistorySection asset={position.asset} />
                </div>
              )}

              {isOpen && (
                <SpotProtectorBot
                  asset={position.asset}
                  protector={position.protector}
                  currentPrice={position.currentPrice}
                  simulationMode={simulationMode}
                  tradingEnabled={tradingEnabled}
                  onChange={(patch) => updateProtector(position.asset, patch)}
                  onFireSignal={(triggerType, price, amount) => recordSpotSignal(position.asset, triggerType, price, amount, position.protector)}
                  isAdmin={isAdmin}
                  userLoaded={userLoaded}
                />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

const FORMULA_INJECTION_RE = /^[=+\-@]/;
function sanitizeCsvCell(value) {
  const s = String(value);
  return FORMULA_INJECTION_RE.test(s) ? `'${s}` : s;
}

function exportCsv(rows) {
  const headers = ['Fecha', 'Bot', 'Acción', 'Asset', 'Monto (USD)', 'Precio', 'Red', 'Tipo', 'Simulado', 'Estado exchange', 'Order ID'];
  const lines = rows.map(r => {
    const d = new Date(r.timestamp).toLocaleString('es');
    return [
      d,
      sanitizeCsvCell(r.botName ?? '—'),
      sanitizeCsvCell(r.action),
      sanitizeCsvCell(r.asset),
      r.amount.toFixed(2),
      r.price > 0 ? r.price.toFixed(2) : '—',
      sanitizeCsvCell(r.network),
      sanitizeCsvCell(r.triggerType ?? '—'),
      r.simulated ? 'Sí' : 'No',
      sanitizeCsvCell(r.exchangeStatus ?? '—'),
      sanitizeCsvCell(r.orderId ?? '—'),
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  const csv = [headers.join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit_log_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function AuditLogPanel({ isAdmin, mySignals }) {
  const [asset, setAsset] = React.useState('');
  const [network, setNetwork] = React.useState('');
  const [simulated, setSimulated] = React.useState('');
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate] = React.useState('');

  const adminLogs = useQuery(
    api.tradesHistory.listAllSignals,
    isAdmin ? {
      asset: asset || undefined,
      network: network || undefined,
      simulated: simulated === '' ? undefined : simulated === 'true',
      fromDate: fromDate ? new Date(fromDate).getTime() : undefined,
      toDate: toDate ? new Date(toDate + 'T23:59:59').getTime() : undefined,
      limit: 500,
    } : 'skip'
  );

  const rows = isAdmin ? (adminLogs ?? []) : (mySignals ?? []);
  const title = isAdmin ? 'Logs de auditoría' : 'Historial simulado';

  return (
    <section className="panel">
      <div className="section-head">
        <h2>{title}</h2>
        {isAdmin && <span className="pill red">ADMIN</span>}
        {!isAdmin && <span className="pill amber">Simulación</span>}
        <span className="pill">{rows.length} registros</span>
        {isAdmin && rows.length > 0 && (
          <button className="mini-btn" onClick={() => exportCsv(rows)}>Exportar CSV</button>
        )}
      </div>

      {isAdmin && (
        <div className="audit-filters">
          <select value={asset} onChange={e => setAsset(e.target.value)}>
            <option value="">Todos los assets</option>
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
          </select>
          <select value={network} onChange={e => setNetwork(e.target.value)}>
            <option value="">Todas las redes</option>
            <option value="Ethereum">Ethereum</option>
            <option value="Arbitrum">Arbitrum</option>
            <option value="Base">Base</option>
            <option value="Optimism">Optimism</option>
            <option value="testnet">Testnet</option>
            <option value="Spot">Spot</option>
          </select>
          <select value={simulated} onChange={e => setSimulated(e.target.value)}>
            <option value="">Real + Simulado</option>
            <option value="true">Solo simulado</option>
            <option value="false">Solo real</option>
          </select>
          <label className="audit-date-field">
            <span>Desde</span>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </label>
          <label className="audit-date-field">
            <span>Hasta</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </label>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="network" style={{ paddingTop: 8 }}>
          {isAdmin ? 'Sin registros con los filtros actuales.' : 'Sin señales todavía. Los bots activos en simulación dispararán señales automáticamente.'}
        </p>
      ) : (
        <div className="audit-table">
          <div className="audit-header">
            <span>Fecha</span>
            <span>Bot / Acción</span>
            <span>Asset</span>
            <span>Monto</span>
            <span>Precio</span>
            <span>Red</span>
            <span>Tipo</span>
            {isAdmin && <span>Estado</span>}
          </div>
          {rows.map((r) => {
            const d = new Date(r.timestamp);
            const dateStr = d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' });
            const timeStr = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
            const isReal = !r.simulated;
            return (
              <div key={r._id} className={`audit-row${isReal ? ' audit-row-real' : ''}`}>
                <span className="network">{dateStr} {timeStr}</span>
                <div>
                  <div className="audit-bot">{r.botName ?? '—'}</div>
                  <div className="network" style={{ fontSize: 11 }}>{r.action}</div>
                </div>
                <span className="mono">{r.asset}</span>
                <span className="mono">{r.amount > 0 ? formatUsd(r.amount) : '—'}</span>
                <span className="mono">{r.price > 0 ? `$${formatPrice(`${r.asset}/USDC`, r.price)}` : '—'}</span>
                <span className="network">{r.network}</span>
                <span className={`pill ${r.simulated ? 'amber' : 'green'}`} style={{ fontSize: 10 }}>
                  {r.simulated ? 'SIM' : 'REAL'}
                </span>
                {isAdmin && (
                  <span className="network" style={{ fontSize: 11 }}>
                    {r.exchangeStatus ?? '—'}
                    {r.orderId && <span className="mono" style={{ display: 'block', fontSize: 10 }}>#{r.orderId}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AlertsPanel({ alerts, history, onCreate, onDelete }) {
  const [alertType, setAlertType] = React.useState('out_of_range');
  const [alertPair, setAlertPair] = React.useState('BTC/USDC');
  const [alertNetwork, setAlertNetwork] = React.useState('');
  const [alertThreshold, setAlertThreshold] = React.useState('');

  function handleCreate(e) {
    e.preventDefault();
    const threshold = alertThreshold !== '' ? parseFloat(alertThreshold) : undefined;
    onCreate({ alertType, pair: alertPair, network: alertNetwork || undefined, threshold });
    setAlertThreshold('');
  }

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Alertas</h2>
        <span className="pill">{alerts?.filter((a) => a.active).length ?? 0} activas</span>
      </div>

      <form className="alert-form" onSubmit={handleCreate}>
        <select value={alertType} onChange={(e) => setAlertType(e.target.value)}>
          <option value="out_of_range">Fuera de rango</option>
          <option value="apy_below">APY bajo umbral</option>
          <option value="price_cross">Precio cruza nivel</option>
        </select>
        <select value={alertPair} onChange={(e) => setAlertPair(e.target.value)}>
          <option>BTC/USDC</option>
          <option>ETH/USDC</option>
        </select>
        {alertType === 'out_of_range' && (
          <select value={alertNetwork} onChange={(e) => setAlertNetwork(e.target.value)}>
            <option value="">Todas las redes</option>
            <option value="Ethereum">Ethereum</option>
            <option value="Arbitrum">Arbitrum</option>
            <option value="Base">Base</option>
            <option value="Optimism">Optimism</option>
          </select>
        )}
        {(alertType === 'apy_below' || alertType === 'price_cross') && (
          <input
            type="number"
            placeholder={alertType === 'apy_below' ? 'APY % umbral' : 'Precio nivel'}
            value={alertThreshold}
            onChange={(e) => setAlertThreshold(e.target.value)}
            min="0"
            step="any"
            required
          />
        )}
        <button type="submit" className="mini-btn active">+ Añadir</button>
      </form>

      {alerts && alerts.length > 0 && (
        <div className="alert-list">
          {alerts.map((a) => (
            <div key={a._id} className="alert-row">
              <div className="alert-info">
                <span className="pill amber">{ALERT_TYPE_LABELS[a.alertType]}</span>
                <span>{a.pair}{a.network ? ` · ${a.network}` : ''}</span>
                {a.threshold != null && (
                  <span>→ {a.threshold}{a.alertType === 'apy_below' ? '%' : ''}</span>
                )}
              </div>
              <button className="mini-btn" onClick={() => onDelete(a._id)}>×</button>
            </div>
          ))}
        </div>
      )}

      {history && history.length > 0 && (
        <>
          <div className="section-sub">Historial de disparos</div>
          <div className="signal-list">
            {history.map((h) => (
              <div key={h._id} className="signal-row">
                <div className="signal-main">
                  <span className="pill red">{ALERT_TYPE_LABELS[h.alertType] ?? h.alertType}</span>
                  <span className="network">{h.pair}</span>
                </div>
                <div className="signal-meta">
                  <span className="network">{h.message}</span>
                  <span className="network">{new Date(h.timestamp).toLocaleString('es')}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const EVM_RE_PROTECTOR = /^0x[a-fA-F0-9]{40}$/;

function ScanTokenIdModal({ onClose, onAdded }) {
  const [tokenIdInput, setTokenIdInput] = React.useState('');
  const [network, setNetwork] = React.useState('Base');
  const [result, setResult] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [adding, setAdding] = React.useState(false);

  const scanAction = useAction(api.actions.poolScanner.scanPoolByTokenId);
  const createPoolMutation = useMutation(api.pools.createPool);
  const fetchPositionAction = useAction(api.actions.poolScanner.fetchPositionLiquidity);

  async function handleScan() {
    const raw = tokenIdInput.trim();
    if (!raw || !/^\d+$/.test(raw)) {
      setError('Introduce un Token ID numérico válido (solo dígitos, sin decimales).');
      return;
    }
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) {
      setError('Token ID fuera de rango.');
      return;
    }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await scanAction({ tokenId: id, network });
      setResult(data);
    } catch (e) {
      setError(e?.message ?? 'Error escaneando la posición.');
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    if (!result) return;
    setAdding(true);
    setError('');
    try {
      let initialLiquidityUsd;
      let initialLiquidityAt;
      if (result.currentPrice != null && result.currentPrice > 0) {
        try {
          const pd = await fetchPositionAction({ tokenId: result.tokenId, network: result.network, priceUsd: result.currentPrice });
          if (pd.liquidityUsd > 0) {
            initialLiquidityUsd = pd.liquidityUsd;
            initialLiquidityAt = Date.now();
          }
        } catch (e) {
          // no fatal — el pool se añade sin capital inicial si falla la RPC
          if (import.meta.env.DEV) console.warn('fetchPositionAction falló al obtener capital inicial:', e);
        }
      }
      await createPoolMutation({
        pair: result.pair,
        network: result.network,
        minRange: result.minRange,
        maxRange: result.maxRange,
        status: result.status,
        feeTier: result.feeTier,
        poolAddress: result.poolAddress,
        tokenId: result.tokenId,
        initialLiquidityUsd,
        initialLiquidityAt,
        // C: precio de entrada = precio slot0 al registrar la posición.
        entryPrice: (result.currentPrice != null && result.currentPrice > 0) ? result.currentPrice : undefined,
      });
      onAdded?.();
      onClose();
    } catch (e) {
      setError(e?.message ?? 'Error añadiendo el pool.');
    } finally {
      setAdding(false);
    }
  }

  const tone = result?.status === 'En rango' ? 'green' : result?.status?.startsWith('Fuera') ? 'red' : 'faint';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel scan-modal" onClick={e => e.stopPropagation()}>
        <div className="section-head">
          <h2>Buscar por Token ID</h2>
          <button className="ghost-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={onClose}>✕</button>
        </div>
        <p className="network" style={{ marginBottom: 14, fontSize: 12 }}>
          Introduce el Token ID de tu posición LP para añadirla al portal.<br />
          Lo encuentras en Revert Finance o en el explorador de tu red — es el ID del NFT de Uniswap V3.
        </p>

        <label className="config-field">
          <span>Token ID (número)</span>
          <input
            type="number"
            min="1"
            placeholder="Ej: 5257781"
            value={tokenIdInput}
            onChange={e => { setTokenIdInput(e.target.value); setResult(null); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleScan()}
          />
        </label>

        <label className="config-field" style={{ marginTop: 10 }}>
          <span>Cadena</span>
          <select value={network} onChange={e => { setNetwork(e.target.value); setResult(null); setError(''); }}>
            <option value="Ethereum">Ethereum</option>
            <option value="Base">Base</option>
            <option value="Arbitrum">Arbitrum</option>
            <option value="Optimism">Optimism</option>
          </select>
        </label>

        <button
          className="primary-btn"
          style={{ width: '100%', marginTop: 14, padding: '10px' }}
          onClick={handleScan}
          disabled={loading || !tokenIdInput.trim()}
        >
          {loading ? 'Buscando...' : 'Buscar Posición'}
        </button>

        {error && <p style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</p>}

        {result && (
          <div className="scan-result">
            <div className="scan-result-header">
              <div>
                <span className="pair">{result.pair}</span>
                {result.feeTier && (
                  <span className="pill" style={{ marginLeft: 8, fontSize: 11 }}>
                    {(result.feeTier / 10000).toFixed(2)}%
                  </span>
                )}
                <span className={`pill ${tone}`} style={{ marginLeft: 6, fontSize: 11 }}>{result.status}</span>
              </div>
            </div>
            <div className="scan-result-meta">
              <span>Rango: ${result.minRange.toLocaleString('en-US', { maximumFractionDigits: 2 })} — ${result.maxRange.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              {result.currentPrice != null && (
                <span>Precio: ${result.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              )}
              <span>ID: {result.tokenId} | {result.network}</span>
            </div>
            <button
              className="primary-btn"
              style={{ width: '100%', marginTop: 12, padding: '10px', background: 'var(--amber)', color: '#000', fontWeight: 700 }}
              onClick={handleAdd}
              disabled={adding}
            >
              {adding ? 'Añadiendo...' : 'Añadir Pool'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TradeConfirmModal({ trade, onConfirm, onCancel, executing }) {
  if (!trade) return null;
  return (
    <div className="modal-overlay" onClick={executing ? undefined : onCancel}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <h2>Confirmar orden</h2>
          <span className="pill red">Testnet</span>
        </div>
        <div className="futures-grid compact" style={{ marginTop: 12 }}>
          <Metric label="Activo" value={trade.asset} />
          <Metric label="Dirección" value={<span className={`pill ${trade.isBuy ? 'green' : 'red'}`}>{trade.isBuy ? 'Long' : 'Short'}</span>} />
          <Metric label="Tamaño" value={trade.size.toFixed(trade.asset === 'BTC' ? 5 : 4)} />
          <Metric label="Precio ref." value={`$${trade.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`} />
          {trade.leverage != null && <Metric label="Leverage" value={`${trade.leverage}x`} />}
          {trade.reduceOnly && <Metric label="Tipo" value="Cerrar posición" />}
        </div>
        <p className="network" style={{ marginTop: 10, fontSize: 12 }}>
          MetaMask pedirá tu firma. La orden se ejecutará en Hyperliquid testnet.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="ghost-btn" onClick={onCancel} disabled={executing} style={{ flex: 1 }}>Cancelar</button>
          <button className="primary-btn" onClick={onConfirm} disabled={executing} style={{ flex: 1 }}>
            {executing ? 'Firmando…' : 'Confirmar y firmar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Bots por pool (Fase 1, Parte C) ---

const BUFFER_OPTIONS = [0, 20, 40, 60, 80, 100];
const CAPITAL_OPTIONS = [50, 75, 100, 125, 150, 175, 200];
const BREAKOUT_DIRS = [
  { v: 'long_short', l: 'LONG + SHORT' },
  { v: 'long', l: 'Solo LONG' },
  { v: 'short', l: 'Solo SHORT' },
];

function poolBaseAsset(pair) {
  const sym = (pair?.split('/')[0] ?? '').toUpperCase();
  return sym === 'WETH' ? 'ETH' : sym === 'WBTC' ? 'BTC' : sym;
}

// Convex rechaza propiedades con valor `undefined` ("undefined is not a valid Convex value").
// Hay que OMITIR la clave, no asignar undefined. Se aplica a todo arg de mutation/action.
function pruneUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, val]) => val !== undefined));
}

// Serializador ÚNICO de la config canónica de un pool-bot para reenviar a getOrCreatePoolBot.
// Reenvía SIEMPRE el estado completo (incl. hlAccountId y simulationMode) para que pausar/
// reactivar no desvincule la cuenta ni cambie el modo. overrides ajusta p. ej. { active }.
function serializePoolBotConfig(bot, overrides = {}) {
  return pruneUndefined({
    poolId: bot.poolId,
    kind: bot.kind,
    hlAccountId: bot.hlAccountId ?? undefined,
    direction: bot.direction,
    leverage: bot.leverage,
    autoLeverage: bot.autoLeverage,
    capitalPct: bot.capitalPct,
    bufferPct: bot.bufferPct,
    stopLossPct: bot.stopLossPct,
    breakevenPct: bot.breakevenPct,
    trailingStop: bot.trailingStop,
    trailingPct: bot.trailingPct,
    preTriggerPct: bot.preTriggerPct,
    allowReentryFromAbove: bot.allowReentryFromAbove,
    autoRearm: bot.autoRearm,
    tps: bot.tps,
    active: bot.active,
    simulationMode: bot.simulationMode,
    ...overrides,
  });
}

// Estimación del tiempo de pausa: el cron "reconcile pool arms" corre cada 1 min (convex/crons.ts),
// así que la cancelación en HL cae como muy tarde en ~60s desde la solicitud. Es una ESTIMACIÓN.
const DISARM_ETA_SECONDS = 60;

// Botón de acción de un pool-bot en la PoolCard: estado + configurar/reconfigurar + pausar/activar.
function BotActionButton({ label, bot, busy, onConfig, onToggle, onDelete }) {
  const disarming = bot?.disarmPending === true;
  // useEffect INCONDICIONAL (regla de hooks); el guard va dentro. Refresca `now` cada segundo solo
  // mientras se está deteniendo, con cleanup del intervalo.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!disarming) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [disarming]);

  // Texto del estado de pausa. Con ancla (disarmRequestedAt) → contador estimado; al llegar a 0 →
  // "finalizando…" (el cron puede tardar hasta ~60s y a veces necesita otro ciclo). Sin ancla
  // (filas legacy o pausa recién solicitada) → solo "Deteniendo…".
  let disarmText = 'Deteniendo…';
  if (disarming && typeof bot.disarmRequestedAt === 'number') {
    const elapsed = Math.max(0, Math.floor((now - bot.disarmRequestedAt) / 1000));
    // Normaliza desfases del reloj cliente (ancla "futura") acotando el restante a [0, 60].
    const remaining = Math.min(DISARM_ETA_SECONDS, Math.max(0, DISARM_ETA_SECONDS - elapsed));
    disarmText = remaining > 0
      ? `Deteniendo… ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
      : 'Deteniendo… finalizando…';
  }

  return (
    <div className="pool-bot-action" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 13 }}>{label}</strong>
        {bot && (
          <span className={`pill ${disarming ? 'faint' : (bot.active ? 'green' : 'faint')}`} style={{ fontSize: 10 }}>
            {disarming ? 'Deteniéndose' : (bot.active ? 'Activo' : 'Pausado')}{bot.simulationMode ? ' · sim' : ''}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="mini-btn" onClick={onConfig} style={{ flex: 1 }}>
          {bot ? 'Reconfigurar' : 'Configurar'}
        </button>
        {bot && (
          // Mientras se detiene: deshabilitado + contador estimado en el propio botón de pausa.
          <button
            className="mini-btn"
            onClick={onToggle}
            disabled={busy || disarming}
            title={disarming ? 'Cancelando el trigger en HL; la pausa se completa al terminar.' : undefined}
          >
            {disarming ? disarmText : (bot.active ? 'Pausar' : 'Activar')}
          </button>
        )}
        {/* D: eliminar el bot del pool (parada segura + borrado). Deshabilitado mientras se desarma. */}
        {bot && (
          <button
            className="mini-btn"
            onClick={onDelete}
            disabled={busy || disarming}
            title={disarming ? 'Deteniendo el bot (cancelando órdenes en HL)…' : 'Eliminar este bot del pool'}
            style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
          >
            {disarming ? 'Deteniendo…' : 'Eliminar'}
          </button>
        )}
      </div>
      {/* JAV-44 (Codex #5/#6): estado del auto-rearm — estado, error, TIPO de error, intentos y próximo
          intento, tanto en pending como en blocked. Se limpia el prefijo [kind] del mensaje crudo. */}
      {bot && bot.rearmStatus && (() => {
        const errMsg = bot.lastRearmError ? String(bot.lastRearmError).replace(/^\[[a-z_]+\]\s*/, '') : '';
        const kind = bot.lastRearmErrorKind ? ` (${bot.lastRearmErrorKind})` : '';
        const blocked = bot.rearmStatus === 'blocked';
        return (
          <div style={{ fontSize: 10, lineHeight: 1.35, color: blocked ? 'var(--red,#f44)' : 'var(--muted,#999)' }}>
            {blocked ? '⚠️ Re-armado bloqueado' : '↻ Re-armando cobertura'}
            {bot.rearmAttempts ? ` · intento ${bot.rearmAttempts}` : ''}
            {bot.nextRearmAt ? ` · próx. ${new Date(bot.nextRearmAt).toLocaleTimeString()}` : ''}
            {errMsg ? ` · ${blocked ? '' : 'último error'}${kind}: ${errMsg}` : ''}
          </div>
        );
      })()}
    </div>
  );
}

// Selector de cuenta HL (compartido por ambos modales). Muestra el balance de la cuenta elegida.
function HLAccountSelect({ accounts, value, onChange }) {
  const selected = accounts.find((a) => a.id === value) ?? null;
  const { account: bal } = useHLAccountBalance(selected?.tradingAccountAddress ?? null);
  return (
    <div className="config-field">
      <span>Wallet</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Selecciona una cuenta…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {(a.label ?? 'Cuenta')} ({a.tradingAccountAddress.slice(0, 6)}…{a.tradingAccountAddress.slice(-4)})
          </option>
        ))}
      </select>
      {selected && (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}
          title="Withdrawable API (perp) y USDC spot libre. La disponibilidad real se valida al operar.">
          {bal ? `Withdrawable ${formatUsd(bal.withdrawable)} · Spot ${formatUsd(bal.spotUsdcFree)}` : '…'}
        </span>
      )}
    </div>
  );
}

// Toggle de modo real (solo visible con canTradeLive). Banner de beta cuando está activo.
function RealModeToggle({ realMode, setRealMode, canTradeLive }) {
  if (!canTradeLive) return null;
  return (
    <div className="be-block" style={{ marginTop: 8 }}>
      <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={realMode} onChange={(e) => setRealMode(e.target.checked)} />
        <strong>Modo real (ejecución HL con tu capital)</strong>
      </label>
      {realMode && (
        <p style={{ fontSize: 11, color: 'var(--red)', margin: '4px 0 0' }}>
          BETA — órdenes reales con tu capital. El stop-loss es un stop-market (banda 1%): puede no llenarse si el mercado atraviesa la banda en un gap brusco.
        </p>
      )}
    </div>
  );
}

// Filas de take-profits (gainPct / closePct). Cantidad fija según el tipo de bot.
function TakeProfitRows({ tps, setTps }) {
  const update = (i, field, val) =>
    setTps(tps.map((t, idx) => (idx === i ? { ...t, [field]: Number(val) } : t)));
  return (
    <>
      {tps.map((tp, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
          <label className="config-field" style={{ margin: 0 }}>
            <span>TP{i + 1} — % ganancia</span>
            <input type="number" step="0.1" min="0" value={tp.gainPct}
              onChange={(e) => update(i, 'gainPct', e.target.value)} />
          </label>
          <label className="config-field" style={{ margin: 0 }}>
            <span>TP{i + 1} — % cierre</span>
            <input type="number" step="1" min="0" value={tp.closePct}
              onChange={(e) => update(i, 'closePct', e.target.value)} />
          </label>
        </div>
      ))}
    </>
  );
}

// Modal "Configurar Protección" (bot IL — cobertura short).
function ProtectionBotModal({ pool, bot, canTradeLive, onClose, onSaved }) {
  const save = useMutation(api.bots.getOrCreatePoolBot);
  const accounts = useQuery(api.hlCredentials.list) ?? [];
  // Modo real (ejecución HL con capital real): requiere canTradeLive. Por defecto simulación.
  const [realMode, setRealMode] = React.useState(bot ? !bot.simulationMode : false);
  // Precarga desde el bot existente (reconfigurar) o defaults (crear).
  const [hlAccountId, setHlAccountId] = React.useState(bot?.hlAccountId ?? null);
  const [leverage, setLeverage] = React.useState(bot?.leverage ?? 20);
  const [autoLeverage, setAutoLeverage] = React.useState(bot?.autoLeverage ?? false);
  const [bufferPct, setBufferPct] = React.useState(bot?.bufferPct ?? 100);
  const [stopLossPct, setStopLossPct] = React.useState(bot?.stopLossPct ?? 1);
  const [breakevenPct, setBreakevenPct] = React.useState(bot?.breakevenPct ?? 0.5);
  // Distinguir tps undefined (crear → defaults) de tps: [] intencional (reconfigurar → vacío).
  const [tps, setTps] = React.useState(bot ? (bot.tps ?? []) : [{ gainPct: 0.5, closePct: 40 }, { gainPct: 1.5, closePct: 60 }]);
  const [noReentryFromAbove, setNoReentryFromAbove] = React.useState(bot?.allowReentryFromAbove === false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const asset = poolBaseAsset(pool.pair);
  const selected = accounts.find((a) => a.id === hlAccountId) ?? null;
  const { account: bal } = useHLAccountBalance(selected?.tradingAccountAddress ?? null);

  const poolCapital = pool.liquidity > 0 ? pool.liquidity : 0;
  const capitalIsReal = !!pool.liquidityReal;       // false = estimado (mock), no lectura on-chain
  const effectiveCapital = poolCapital * (1 + bufferPct / 100);
  const thisBotMargin = leverage > 0 ? effectiveCapital / leverage : 0;
  const marginUsed = bal?.totalMarginUsed ?? 0;     // margen usado en la cuenta (no "otros bots")
  // Conservador: el margen disponible firme es el del perp (withdrawable). El USDC spot es
  // colateral estimado en modo unified (haircuts no calculables en cliente) — se muestra aparte.
  const withdrawable = bal?.withdrawable ?? 0;
  const spotUsdcFree = bal?.spotUsdcFree ?? 0;
  const availableAfter = withdrawable - thisBotMargin;

  async function handleSave() {
    setError(''); setSaving(true);
    try {
      await save(pruneUndefined({
        poolId: pool.id, kind: 'il', direction: 'short',
        hlAccountId: hlAccountId ?? undefined,
        leverage, autoLeverage, bufferPct, stopLossPct, breakevenPct,
        tps: tps.filter((t) => t.gainPct > 0 && t.closePct > 0),
        allowReentryFromAbove: !noReentryFromAbove,
        active: bot ? bot.active : true,   // editar conserva el estado; crear activa
        simulationMode: !(realMode && canTradeLive),   // real solo con permiso
      }));
      onSaved?.(); onClose();
    } catch (e) {
      setError(e?.message ?? 'No se pudo activar la protección.');
    } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <h2>🛡 Configurar Protección</h2>
          <button className="ghost-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={onClose}>✕</button>
        </div>
        <p className="network" style={{ fontSize: 12, marginBottom: 10 }}>
          {pool.pair} · Rango {formatPrice(pool.pair, pool.min)} – {formatPrice(pool.pair, pool.max)}
        </p>

        <HLAccountSelect accounts={accounts} value={hlAccountId} onChange={setHlAccountId} />

        <label className="config-field" style={{ marginTop: 8 }}>
          <span>Perp (SHORT)</span>
          <input value={`${asset}-PERP`} readOnly />
        </label>

        <div className="config-field" style={{ padding: '8px 0' }}>
          <span>Leverage (Isolated)</span>
          <div className="range-control">
            <input type="range" min="1" max="20" step="1" value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))} />
            <strong>{leverage}x</strong>
          </div>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <input type="checkbox" checked={autoLeverage} onChange={(e) => setAutoLeverage(e.target.checked)} />
            Permitir auto-ajuste de leverage si el balance es insuficiente
          </label>
        </div>

        {selected && (
          <>
            <div className="futures-grid compact" style={{ marginBottom: 4 }}>
              <Metric label="Margen usado actual" value={formatUsd(marginUsed)} />
              <Metric label="Margen este bot" value={formatUsd(thisBotMargin)} />
              <Metric label="Withdrawable API" value={formatUsd(withdrawable)} />
              <Metric label="Disponible después" value={<span className={availableAfter >= 0 ? 'positive' : 'negative'}>{formatUsd(availableAfter)}</span>} />
            </div>
            {spotUsdcFree > 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, display: 'block' }}>
                + {formatUsd(spotUsdcFree)} USDC spot libre (colateral en modo unified; margen real validado por el backend al operar).
              </span>
            )}
          </>
        )}

        <div className="config-field" style={{ padding: '4px 0' }}>
          <span>Buffer de Capital</span>
          <div className="segmented" style={{ flexWrap: 'wrap' }}>
            {BUFFER_OPTIONS.map((b) => (
              <button key={b} aria-pressed={bufferPct === b} onClick={() => setBufferPct(b)}>
                {b === 0 ? 'Sin' : `+${b}%`}
              </button>
            ))}
          </div>
          {poolCapital > 0 && (
            <span style={{ fontSize: 12, color: 'var(--amber)' }}>
              Posición efectiva: {formatUsd(effectiveCapital)} (pool {formatUsd(poolCapital)}{capitalIsReal ? '' : ' estimado'} + {bufferPct}%)
            </span>
          )}
        </div>

        <label className="config-field" style={{ padding: '4px 0' }}>
          <span>Stop Loss Fijo (%)</span>
          <input type="number" step="0.1" min="0" value={stopLossPct}
            onChange={(e) => setStopLossPct(Number(e.target.value))} />
        </label>

        <div className="config-field" style={{ padding: '4px 0' }}>
          <span>Breakeven (% ganancia para mover SL)</span>
          <div className="range-control">
            <input type="range" min="0.5" max="3" step="0.1" value={breakevenPct}
              onChange={(e) => setBreakevenPct(Number(e.target.value))} />
            <strong>{breakevenPct}%</strong>
          </div>
        </div>

        <div className="config-field" style={{ padding: '4px 0' }}>
          <span>Take Profits (opcional)</span>
          <TakeProfitRows tps={tps} setTps={setTps} />
        </div>

        <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0' }}>
          <input type="checkbox" checked={noReentryFromAbove} onChange={(e) => setNoReentryFromAbove(e.target.checked)} />
          No proteger cuando reentra al rango desde arriba
        </label>

        <RealModeToggle realMode={realMode} setRealMode={setRealMode} canTradeLive={canTradeLive} />

        {error && <p style={{ color: 'var(--red)', fontSize: 12 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="ghost-btn" onClick={onClose} disabled={saving} style={{ flex: 1 }}>Cancelar</button>
          <button className="primary-btn" onClick={handleSave} disabled={saving || !hlAccountId} style={{ flex: 1 }}>
            {saving ? 'Guardando…' : (bot ? 'Guardar cambios' : 'Activar Protección')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Modal "Configurar Trading" (bot breakout long/short).
function TradingBotModal({ pool, bot, canTradeLive, onClose, onSaved }) {
  const save = useMutation(api.bots.getOrCreatePoolBot);
  const accounts = useQuery(api.hlCredentials.list) ?? [];
  const [realMode, setRealMode] = React.useState(bot ? !bot.simulationMode : false);
  // Precarga desde el bot existente (reconfigurar) o defaults (crear).
  const [hlAccountId, setHlAccountId] = React.useState(bot?.hlAccountId ?? null);
  const [direction, setDirection] = React.useState(bot?.direction ?? 'long_short');
  const [capitalPct, setCapitalPct] = React.useState(bot?.capitalPct ?? 100);
  const [preTriggerPct, setPreTriggerPct] = React.useState(bot?.preTriggerPct ?? 0);
  const [leverage, setLeverage] = React.useState(bot?.leverage ?? 20);
  const [autoLeverage, setAutoLeverage] = React.useState(bot?.autoLeverage ?? false);
  const [stopLossPct, setStopLossPct] = React.useState(bot?.stopLossPct ?? 1);
  const [breakevenPct, setBreakevenPct] = React.useState(bot?.breakevenPct ?? 0.5);
  const [trailingStop, setTrailingStop] = React.useState(bot?.trailingStop ?? true);
  const [trailingPct, setTrailingPct] = React.useState(bot?.trailingPct ?? 1);
  // Distinguir tps undefined (crear → defaults) de tps: [] intencional (reconfigurar → vacío).
  const [tps, setTps] = React.useState(bot ? (bot.tps ?? []) : [
    { gainPct: 0.5, closePct: 30 }, { gainPct: 2, closePct: 50 }, { gainPct: 5, closePct: 20 },
  ]);
  const [autoRearm, setAutoRearm] = React.useState(bot?.autoRearm ?? true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const selected = accounts.find((a) => a.id === hlAccountId) ?? null;
  const poolCapital = pool.liquidity > 0 ? pool.liquidity : 0;
  const capitalIsReal = !!pool.liquidityReal;       // false = estimado (mock)
  const opCapital = poolCapital * (capitalPct / 100);

  async function handleSave() {
    setError(''); setSaving(true);
    try {
      await save(pruneUndefined({
        poolId: pool.id, kind: 'trading', direction,
        hlAccountId: hlAccountId ?? undefined,
        capitalPct, preTriggerPct, leverage, autoLeverage, stopLossPct, breakevenPct,
        trailingStop, trailingPct,   // estado completo: se persiste siempre (latente si trailing off)
        tps: tps.filter((t) => t.gainPct > 0 && t.closePct > 0),
        autoRearm, active: bot ? bot.active : true,   // editar conserva el estado; crear activa
        simulationMode: !(realMode && canTradeLive),   // real solo con permiso
      }));
      onSaved?.(); onClose();
    } catch (e) {
      setError(e?.message ?? 'No se pudo activar el trading.');
    } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <h2>Configurar Trading</h2>
          <button className="ghost-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={onClose}>✕</button>
        </div>
        <p className="network" style={{ fontSize: 12, marginBottom: 10 }}>
          {pool.pair} · Rango {formatPrice(pool.pair, pool.min)} – {formatPrice(pool.pair, pool.max)}
        </p>

        <HLAccountSelect accounts={accounts} value={hlAccountId} onChange={setHlAccountId} />

        <div className="config-field" style={{ padding: '8px 0' }}>
          <span>Dirección del Breakout</span>
          <div className="segmented" style={{ flexWrap: 'wrap' }}>
            {BREAKOUT_DIRS.map((d) => (
              <button key={d.v} aria-pressed={direction === d.v} onClick={() => setDirection(d.v)}>{d.l}</button>
            ))}
          </div>
          <span style={{ fontSize: 12 }} className="network">Abre LONG arriba y SHORT abajo del rango</span>
        </div>

        <div className="config-field" style={{ padding: '4px 0' }}>
          <span>Capital relativo al pool</span>
          <div className="segmented" style={{ flexWrap: 'wrap' }}>
            {CAPITAL_OPTIONS.map((c) => (
              <button key={c} aria-pressed={capitalPct === c} onClick={() => setCapitalPct(c)}>{c}%</button>
            ))}
          </div>
          {poolCapital > 0 && (
            <span style={{ fontSize: 12, color: 'var(--amber)' }}>
              Capital: {formatUsd(opCapital)} (de pool {formatUsd(poolCapital)}{capitalIsReal ? '' : ' estimado'})
            </span>
          )}
        </div>

        <div className="config-field" style={{ padding: '4px 0' }}>
          <span>Pre-trigger</span>
          <div className="range-control">
            <input type="range" min="0" max="5" step="0.1" value={preTriggerPct}
              onChange={(e) => setPreTriggerPct(Number(e.target.value))} />
            <strong>{preTriggerPct}%</strong>
          </div>
        </div>

        <div className="config-field" style={{ padding: '4px 0' }}>
          <span>Leverage (Isolated)</span>
          <div className="range-control">
            <input type="range" min="1" max="20" step="1" value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))} />
            <strong>{leverage}x</strong>
          </div>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <input type="checkbox" checked={autoLeverage} onChange={(e) => setAutoLeverage(e.target.checked)} />
            Permitir auto-ajuste de leverage si el balance es insuficiente
          </label>
        </div>

        <label className="config-field" style={{ padding: '4px 0' }}>
          <span>Stop Loss Fijo (%)</span>
          <input type="number" step="0.1" min="0" value={stopLossPct}
            onChange={(e) => setStopLossPct(Number(e.target.value))} />
        </label>

        <div className="config-field" style={{ padding: '4px 0' }}>
          <span>Breakeven (% ganancia para mover SL a entrada)</span>
          <div className="range-control">
            <input type="range" min="0.5" max="3" step="0.1" value={breakevenPct}
              onChange={(e) => setBreakevenPct(Number(e.target.value))} />
            <strong>{breakevenPct}%</strong>
          </div>
        </div>

        <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0 4px' }}>
          <input type="checkbox" checked={trailingStop} onChange={(e) => setTrailingStop(e.target.checked)} />
          Trailing Stop
        </label>
        {trailingStop && (
          <input type="number" step="0.1" min="0" value={trailingPct}
            onChange={(e) => setTrailingPct(Number(e.target.value))}
            style={{ width: '100%' }} />
        )}

        <div className="config-field" style={{ padding: '8px 0 4px' }}>
          <span>Take Profits (3 niveles)</span>
          <TakeProfitRows tps={tps} setTps={setTps} />
        </div>

        <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0' }}>
          <input type="checkbox" checked={autoRearm} onChange={(e) => setAutoRearm(e.target.checked)} />
          Auto-rearm — tras SL, el bot vuelve a buscar breakouts automáticamente
        </label>

        <RealModeToggle realMode={realMode} setRealMode={setRealMode} canTradeLive={canTradeLive} />

        {error && <p style={{ color: 'var(--red)', fontSize: 12 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="ghost-btn" onClick={onClose} disabled={saving} style={{ flex: 1 }}>Cancelar</button>
          <button className="primary-btn" onClick={handleSave} disabled={saving || !hlAccountId} style={{ flex: 1 }}>
            {saving ? 'Guardando…' : (bot ? 'Guardar cambios' : 'Activar Trading')}
          </button>
        </div>
      </div>
    </div>
  );
}


// Fila de una cuenta HL conectada (balance + revocar).
function HLAccountRow({ account, onRevoke }) {
  const { account: bal } = useHLAccountBalance(account.tradingAccountAddress);
  return (
    <div className="wallet-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0' }}>
      <div>
        <strong style={{ fontSize: 13 }}>{account.label ?? 'Cuenta'}</strong>
        <div className="network" style={{ fontSize: 11 }}>
          {account.tradingAccountAddress.slice(0, 8)}…{account.tradingAccountAddress.slice(-6)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12 }} title="Withdrawable API (perp) · USDC spot libre">{bal ? `W ${formatUsd(bal.withdrawable)} · S ${formatUsd(bal.spotUsdcFree)}` : '…'}</span>
        <button className="mini-btn" onClick={onRevoke}>Revocar</button>
      </div>
    </div>
  );
}

// Panel dedicado de gestión de cuentas Hyperliquid (multi-cuenta). Reemplaza la UI legacy.
function HLAccountsPanel() {
  const accounts = useQuery(api.hlCredentials.list);
  const connect = useAction(api.hlCredentialActions.connectAccount);
  const revoke = useMutation(api.hlCredentials.revokeById);
  const [label, setLabel] = React.useState('');
  const [privateKey, setPrivateKey] = React.useState('');
  const [tradingAccountAddress, setTradingAccountAddress] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  async function handleConnect() {
    setError(''); setBusy(true);
    try {
      await connect(pruneUndefined({
        privateKey: privateKey.trim(),
        tradingAccountAddress: tradingAccountAddress.trim(),
        label: label.trim() || undefined,
      }));
      setLabel(''); setPrivateKey(''); setTradingAccountAddress('');
    } catch (e) {
      setError(e?.message ?? 'No se pudo conectar la cuenta.');
    } finally { setBusy(false); }
  }

  async function handleRevoke(id) {
    if (!window.confirm('¿Revocar esta cuenta? Se pausarán y desvincularán sus bots.')) return;
    setError('');
    try { await revoke({ id }); } catch (e) { setError(e?.message ?? 'No se pudo revocar.'); }
  }

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Cuentas Hyperliquid</h2>
        <span className="pill">{accounts?.length ?? 0}</span>
      </div>
      {(accounts ?? []).map((a) => (
        <HLAccountRow key={a.id} account={a} onRevoke={() => handleRevoke(a.id)} />
      ))}
      <div className="be-block" style={{ marginTop: 10 }}>
        <div className="be-head"><span>Conectar nueva cuenta</span></div>
        <label className="config-field"><span>Etiqueta (opcional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej: Avaro" /></label>
        <label className="config-field" style={{ marginTop: 6 }}><span>Cuenta principal HL (0x...)</span>
          <input value={tradingAccountAddress} onChange={(e) => setTradingAccountAddress(e.target.value)}
            placeholder="0x... wallet MetaMask/Rabby" /></label>
        <label className="config-field" style={{ marginTop: 6 }}><span>Private key API wallet</span>
          <input type="password" autoComplete="off" value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)} placeholder="0x... solo se cifra en backend" /></label>
        {error && <span style={{ fontSize: 11, color: 'var(--red)' }}>{error}</span>}
        <button className="primary-btn" style={{ marginTop: 8, width: '100%' }} onClick={handleConnect}
          disabled={busy || !privateKey.trim() || !tradingAccountAddress.trim()}>
          {busy ? 'Conectando…' : 'Conectar cuenta'}
        </button>
      </div>
    </section>
  );
}

function HLAccountPanel({ walletAddress, userLoaded, prices, isAdmin }) {
  const setWalletAddressMutation = useMutation(api.users.setWalletAddress);
  const clearWalletAddressMutation = useMutation(api.users.clearWalletAddress);
  const recordTestnetExecution = useMutation(api.tradesHistory.recordTestnetExecution);
  const [draft, setDraft] = React.useState(walletAddress ?? '');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');

  // MetaMask
  const { account: mmAccount, walletClient, connectorType, connectMetaMask, connectWalletConnect, disconnect: disconnectMM, isConnecting, error: mmError } = useMetaMaskSigner();

  // Trade state
  const [pendingTrade, setPendingTrade] = React.useState(null);
  const [executing, setExecuting] = React.useState(false);
  const [tradeError, setTradeError] = React.useState('');
  const [tradeSuccess, setTradeSuccess] = React.useState('');

  // New order form
  const [orderAsset, setOrderAsset] = React.useState('BTC');
  const [orderSide, setOrderSide] = React.useState('Long');
  const [orderAmount, setOrderAmount] = React.useState('');
  const [orderLeverage, setOrderLeverage] = React.useState('1');

  React.useEffect(() => {
    if (walletAddress != null) setDraft(walletAddress);
  }, [walletAddress]);

  const validWallet = EVM_RE_PROTECTOR.test(draft);
  const isDirty = draft !== (walletAddress ?? '');
  const { account, openOrders, loading, error } = useHLAccountBalance(validWallet ? draft : null, { includeOrders: true });

  async function saveWallet() {
    if (!validWallet) return;
    setSaving(true);
    setSaveError('');
    try {
      await setWalletAddressMutation({ walletAddress: draft });
    } catch (e) {
      setSaveError(e?.message ?? 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function clearWallet() {
    setSaveError('');
    try {
      await clearWalletAddressMutation({});
      setDraft('');
    } catch (e) {
      setSaveError(e?.message ?? 'Error al borrar');
    }
  }

  function openNewOrder() {
    const amount = parseFloat(orderAmount);
    if (!amount || amount <= 0) return;
    const livePrice = prices?.[orderAsset];
    if (!livePrice) { setTradeError(`Sin precio live para ${orderAsset}`); return; }
    setPendingTrade({
      asset: orderAsset,
      isBuy: orderSide === 'Long',
      size: amount / livePrice,
      price: livePrice,
      leverage: parseInt(orderLeverage, 10) || 1,
      reduceOnly: false,
      usdAmount: amount,
    });
    setTradeError('');
    setTradeSuccess('');
  }

  function openClosePosition(pos) {
    const livePrice = prices?.[pos.coin] ?? pos.entryPx;
    setPendingTrade({
      asset: pos.coin,
      isBuy: pos.size < 0,
      size: Math.abs(pos.size),
      price: livePrice,
      leverage: null,
      reduceOnly: true,
    });
    setTradeError('');
    setTradeSuccess('');
  }

  async function confirmTrade() {
    if (!pendingTrade || !walletClient) return;
    if (mmAccount && draft && mmAccount.toLowerCase() !== draft.toLowerCase()) {
      setTradeError(`La wallet conectada (${mmAccount.slice(0,8)}…) no coincide con la wallet escaneada. Reconecta la wallet correcta.`);
      return;
    }
    setExecuting(true);
    setTradeError('');
    try {
      const response = await executeHLTestnetOrder({
        walletClient,
        asset: pendingTrade.asset,
        isBuy: pendingTrade.isBuy,
        size: pendingTrade.size,
        price: pendingTrade.price,
        leverage: pendingTrade.leverage,
        reduceOnly: pendingTrade.reduceOnly,
      });
      const statuses = response?.response?.data?.statuses;
      const first = Array.isArray(statuses) ? statuses[0] : undefined;
      if (first?.error) throw new Error(`Hyperliquid rechazó la orden: ${first.error}`);
      const orderId = first?.resting?.oid ?? first?.filled?.oid;
      const status = response?.status ?? 'unknown';

      await recordTestnetExecution({
        action: `${pendingTrade.reduceOnly ? 'Cerrar' : pendingTrade.isBuy ? 'Long' : 'Short'} ${pendingTrade.asset}`,
        asset: pendingTrade.asset,
        amount: pendingTrade.usdAmount ?? pendingTrade.size * pendingTrade.price,
        price: pendingTrade.price,
        triggerType: 'manual',
        exchangeStatus: status,
        orderId: orderId != null ? String(orderId) : undefined,
      });

      setTradeSuccess(`Orden enviada — ID: ${orderId ?? 'n/a'}`);
      setPendingTrade(null);
    } catch (e) {
      setTradeError(e?.message ?? 'Error ejecutando orden');
    } finally {
      setExecuting(false);
    }
  }

  return (
    <section className="panel">
      <TradeConfirmModal trade={pendingTrade} onConfirm={confirmTrade} onCancel={() => setPendingTrade(null)} executing={executing} />

      <div className="section-head">
        <h2>Cuenta Hyperliquid{IS_TESTNET && <span className="pill red" style={{ marginLeft: 8, fontSize: 11 }}>Testnet</span>}</h2>
        <span className={`pill ${loading ? '' : account ? 'green' : 'faint'}`}>
          {loading ? 'Cargando…' : account ? 'Conectada' : 'Sin wallet'}
        </span>
      </div>

      {/* MetaMask */}
      {IS_TESTNET && isAdmin && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 0 4px' }}>
          {mmAccount ? (
            <>
              <span className="pill green" style={{ fontSize: 11 }}>
                {connectorType === 'walletconnect' ? 'WalletConnect' : 'MetaMask'} {mmAccount.slice(0, 6)}…{mmAccount.slice(-4)}
              </span>
              <button className="ghost-btn" style={{ padding: '3px 10px', fontSize: 11 }} onClick={disconnectMM}>Desconectar</button>
            </>
          ) : (
            <>
              <button className="primary-btn" style={{ padding: '5px 12px', fontSize: 12 }} onClick={connectMetaMask} disabled={isConnecting}>
                {isConnecting ? 'Conectando…' : 'MetaMask'}
              </button>
              <button className="ghost-btn" style={{ padding: '5px 12px', fontSize: 12 }} onClick={connectWalletConnect} disabled={isConnecting}>
                WalletConnect
              </button>
            </>
          )}
          {mmError && <span style={{ fontSize: 11, color: 'var(--red,#f44)' }}>{mmError}</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '10px 0 4px', flexWrap: 'wrap' }}>
        <input
          className="hl-search"
          style={{ flex: 1, minWidth: 0, margin: 0 }}
          placeholder="0x... wallet Hyperliquid"
          value={draft}
          onChange={(e) => { setDraft(e.target.value.trim()); setSaveError(''); }}
          disabled={!userLoaded}
        />
        {isDirty && (
          <button
            className="primary-btn"
            style={{ padding: '5px 12px', fontSize: 12 }}
            onClick={saveWallet}
            disabled={!validWallet || saving}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        )}
        {!isDirty && walletAddress && (
          <button
            className="ghost-btn"
            style={{ padding: '5px 12px', fontSize: 12 }}
            onClick={clearWallet}
            disabled={!userLoaded}
          >
            Borrar
          </button>
        )}
      </div>
      {draft && !validWallet && (
        <span style={{ fontSize: 11, color: 'var(--red,#f44)' }}>Dirección EVM inválida</span>
      )}
      {saveError && <span style={{ fontSize: 11, color: 'var(--red,#f44)' }}>{saveError}</span>}
      {error && <p className="network" style={{ color: 'var(--red,#f44)', marginTop: 8 }}>{error}</p>}

      {account && (
        <>
          <div className="futures-grid compact" style={{ marginTop: 10 }}>
            <Metric label="Valor cuenta" value={formatUsd(account.accountValue)} />
            <Metric label="Retirable" value={formatUsd(account.withdrawable)} />
            <Metric label="Nocional" value={formatUsd(account.totalNtlPos)} />
            <Metric label="Margen usado" value={formatUsd(account.totalMarginUsed)} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Posiciones abiertas</span>
            <span className="pill">{account.openPositions.length}</span>
          </div>
          {account.openPositions.length === 0 ? (
            <p className="network" style={{ fontSize: 12 }}>Sin posiciones abiertas</p>
          ) : (
            <div className="hl-position-list">
              {account.openPositions.map((pos) => (
                <div key={pos.coin} style={{ padding: '8px 0', borderBottom: '1px solid var(--border,#222)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{pos.coin}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className={`pill ${pos.size > 0 ? 'green' : 'red'}`} style={{ fontSize: 11 }}>
                        {pos.size > 0 ? 'Long' : 'Short'} {Math.abs(pos.size).toLocaleString('en-US', { maximumFractionDigits: 4 })}
                      </span>
                      {IS_TESTNET && isAdmin && mmAccount && (
                        <button className="ghost-btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => openClosePosition(pos)}>
                          Cerrar
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="futures-grid compact" style={{ gap: 4 }}>
                    <Metric label="Entrada" value={`$${pos.entryPx.toLocaleString('en-US', { maximumFractionDigits: 2 })}`} />
                    <Metric label="PnL no real." value={<span style={{ color: pos.unrealizedPnl >= 0 ? 'var(--green,#4c7)' : 'var(--red,#f44)' }}>{formatUsd(pos.unrealizedPnl)}</span>} />
                    <Metric label="ROE" value={<span style={{ color: pos.roe >= 0 ? 'var(--green,#4c7)' : 'var(--red,#f44)' }}>{(pos.roe * 100).toFixed(2)}%</span>} />
                    {pos.leverage != null && <Metric label="Leverage" value={`${pos.leverage}x`} />}
                    {pos.liquidationPx != null && <Metric label="Liquidación" value={`$${pos.liquidationPx.toLocaleString('en-US', { maximumFractionDigits: 2 })}`} />}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Nueva orden — solo en testnet, solo admin, con wallet conectada */}
          {IS_TESTNET && isAdmin && mmAccount && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Nueva orden</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={orderAsset} onChange={(e) => setOrderAsset(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }}>
                  <option value="BTC">BTC</option>
                  <option value="ETH">ETH</option>
                </select>
                <select value={orderSide} onChange={(e) => setOrderSide(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }}>
                  <option value="Long">Long</option>
                  <option value="Short">Short</option>
                </select>
                <input
                  type="number"
                  placeholder="USDC"
                  value={orderAmount}
                  onChange={(e) => setOrderAmount(e.target.value)}
                  style={{ width: 80, fontSize: 12, padding: '4px 8px' }}
                  min="0"
                />
                <input
                  type="number"
                  placeholder="Lev"
                  value={orderLeverage}
                  onChange={(e) => setOrderLeverage(e.target.value)}
                  style={{ width: 55, fontSize: 12, padding: '4px 8px' }}
                  min="1" max="25"
                />
                <button
                  className="primary-btn"
                  style={{ padding: '4px 12px', fontSize: 12 }}
                  onClick={openNewOrder}
                  disabled={!orderAmount || parseFloat(orderAmount) <= 0}
                >
                  Abrir
                </button>
              </div>
            </>
          )}

          {tradeError && <p style={{ fontSize: 11, color: 'var(--red,#f44)', marginTop: 8 }}>{tradeError}</p>}
          {tradeSuccess && <p style={{ fontSize: 11, color: 'var(--green,#4c7)', marginTop: 8 }}>{tradeSuccess}</p>}

          {openOrders.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Órdenes pendientes</span>
                <span className="pill">{openOrders.length}</span>
              </div>
              <div className="hl-position-list">
                {openOrders.map((order) => (
                  <div className="hl-position-row" key={order.oid} style={{ padding: '6px 0' }}>
                    <span style={{ fontWeight: 600 }}>{order.coin}</span>
                    <span className={`pill ${order.side === 'B' ? 'green' : 'red'}`} style={{ fontSize: 11 }}>
                      {order.side === 'B' ? 'Compra' : 'Venta'} {parseFloat(order.sz).toLocaleString('en-US', { maximumFractionDigits: 4 })}
                    </span>
                    <span className="mono" style={{ fontSize: 12 }}>${parseFloat(order.limitPx).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function SpotProtectorBot({ asset, protector, onChange, currentPrice, simulationMode, tradingEnabled, onFireSignal, isAdmin, userLoaded }) {
  const hlWallet = protector.hlWallet ?? '';
  const validWallet = EVM_RE_PROTECTOR.test(hlWallet);
  const { account: hlAccount, loading: hlBalLoading, error: hlBalError } = useHLAccountBalance(validWallet ? hlWallet : null);
  // La gestión de API wallets HL vive ahora en HLAccountsPanel (multi-cuenta, connectAccount).

  function handleManual() {
    if (!protector.active) return;
    if (!protector.tradeAmount || protector.tradeAmount <= 0) return;
    onFireSignal?.('manual', currentPrice ?? 0, protector.tradeAmount ?? 0);
  }

  return (
    <div className="spot-protector">
      <div className="spot-protector-head">
        <span>Bot cobertura {asset}</span>
        <span className={`pill ${protector.active ? 'green' : 'faint'}`}>{protector.active ? 'Activo' : 'Pausado'}</span>
      </div>

      {/* Wallet HL */}
      <div className="config-field" style={{ padding: '10px 0 4px' }}>
        <span>Wallet Hyperliquid</span>
        <input
          className="hl-search"
          style={{ margin: 0 }}
          placeholder="0x... wallet HL para cobertura"
          value={hlWallet}
          onChange={(e) => onChange({ hlWallet: e.target.value.trim() })}
        />
      </div>
      {hlWallet && !validWallet && (
        <span style={{ fontSize: 11, color: 'var(--red,#f44)' }}>Dirección EVM inválida</span>
      )}
      {validWallet && (
        <div className="hl-account-scan">
          <div className="network" style={{ fontSize: 12 }}>
            Scanner HL:{' '}
            {hlBalLoading ? 'Cargando...' :
             hlBalError ? <span style={{ color: 'var(--red,#f44)' }}>{hlBalError}</span> :
             hlAccount ? 'Cuenta conectada' : '—'}
          </div>
          {hlAccount && (
            <>
              <div className="futures-grid compact">
                <Metric label="Account value" value={formatUsd(hlAccount.accountValue)} />
                <Metric label="Withdrawable" value={formatUsd(hlAccount.withdrawable)} />
                <Metric label="Notional" value={formatUsd(hlAccount.totalNtlPos)} />
                <Metric label="Margin used" value={formatUsd(hlAccount.totalMarginUsed)} />
              </div>
              <div className="network" style={{ fontSize: 12, marginTop: 6 }}>
                Posiciones abiertas: {hlAccount.openPositions.length}
              </div>
              {hlAccount.openPositions.length > 0 && (
                <div className="hl-position-list">
                  {hlAccount.openPositions.slice(0, 4).map((pos) => (
                    <div className="hl-position-row" key={pos.coin}>
                      <span>{pos.coin}</span>
                      <span className="mono">{pos.size > 0 ? 'Long' : 'Short'} {Math.abs(pos.size).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
                      <span className="mono">@ ${pos.entryPx > 0 ? formatPrice(`${pos.coin}/USDC`, pos.entryPx) : '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Leverage */}
      <label className="config-field" style={{ padding: '4px 0' }}>
        <span>Dirección cobertura</span>
        <select value={protector.side ?? 'Short'} onChange={(e) => onChange({ side: e.target.value })}>
          <option>Short</option>
          <option>Long</option>
        </select>
      </label>

      <div className="config-field" style={{ padding: '4px 0' }}>
        <span>Leverage de cobertura</span>
        <div className="range-control">
          <input
            type="range" min="0" max="25" step="1"
            value={protector.leverage ?? 0}
            onChange={(e) => onChange({ leverage: Number(e.target.value) })}
          />
          <strong>{protector.leverage ?? 0}x</strong>
        </div>
      </div>

      {/* Monto de la operación */}
      <div className="config-field" style={{ padding: '4px 0' }}>
        <span>Monto a operar (USDC)</span>
        <input
          type="number"
          className="hl-search"
          style={{ margin: 0 }}
          min="0"
          step="100"
          placeholder="0"
          value={protector.tradeAmount ?? 0}
          onChange={(e) => onChange({ tradeAmount: Number(e.target.value) })}
        />
      </div>

      {/* Stop Loss */}
      <div className="config-field" style={{ padding: '4px 0' }}>
        <span>Stop Loss</span>
        <div className="range-control">
          <input
            type="range" min="0.1" max="5" step="0.1"
            value={protector.stopLoss ?? 1}
            onChange={(e) => onChange({ stopLoss: Number(e.target.value) })}
          />
          <strong>{(protector.stopLoss ?? 1).toFixed(1)}%</strong>
        </div>
      </div>

      {/* Mover SL a Break Even */}
      <div className="be-block">
        <div className="be-head">
          <span>Mover SL a Break Even</span>
          <button
            className={`mini-btn ${protector.moveSlToBE ? 'active' : ''}`}
            onClick={() => onChange({ moveSlToBE: !protector.moveSlToBE })}
          >
            {protector.moveSlToBE ? 'ON' : 'OFF'}
          </button>
        </div>
        {protector.moveSlToBE && (
          <div className="config-field" style={{ marginTop: 6 }}>
            <span>Mover BE cuando ganancia ≥</span>
            <div className="range-control">
              <input
                type="range" min="0.1" max="20" step="0.1"
                value={protector.moveSlToBEAt ?? 1}
                onChange={(e) => onChange({ moveSlToBEAt: Number(e.target.value) })}
              />
              <strong>{(protector.moveSlToBEAt ?? 1).toFixed(1)}%</strong>
            </div>
          </div>
        )}
      </div>

      <div className="bot-state-actions">
        <button className={`mini-btn ${!protector.active ? 'active' : ''}`} onClick={() => onChange({ active: false })} disabled={!isAdmin}>Pausar</button>
        <button className={`mini-btn ${protector.active ? 'active' : ''}`} onClick={() => onChange({ active: true })} disabled={!isAdmin}>Activar</button>
        <span className={`pill${!simulationMode && tradingEnabled ? ' green' : ' amber'}`}>
          {!simulationMode && tradingEnabled ? 'LIVE HL' : 'Simulación'}
        </span>
        {userLoaded && !isAdmin && <span className="pill faint" title="Solo lectura">Lectura</span>}
        {protector.active && isAdmin && (
          <button className="mini-btn amber" onClick={handleManual}>Disparar manual</button>
        )}
      </div>
    </div>
  );
}

// Límites de ejecución (valores efectivos) — admin.
function ExecutionLimitsPanel() {
  const limits = useQuery(api.systemConfig.getExecutionLimits, {});
  const setPerOrder = useMutation(api.systemConfig.setMaxNotionalPerOrder);
  const setDaily = useMutation(api.systemConfig.setMaxNotionalPerUserDaily);
  const [perOrder, setPerOrderV] = React.useState('');
  const [daily, setDailyV] = React.useState('');
  const [msg, setMsg] = React.useState('');
  React.useEffect(() => {
    if (limits) {
      setPerOrderV(String(limits.maxNotionalPerOrder));
      setDailyV(String(limits.maxNotionalPerUserDaily));
    }
  }, [limits]);
  async function apply(fn, val) {
    setMsg('');
    try { await fn({ value: Number(val) }); setMsg('Guardado.'); }
    catch (e) { setMsg(e?.message ?? 'Error'); }
  }
  const Row = ({ label, val, set, fn, step, allowZero }) => {
    const n = Number(val);
    const valid = Number.isFinite(n) && (allowZero ? n >= 0 : n > 0);
    return (
      <label className="config-field" style={{ marginTop: 6 }}><span>{label}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input type="number" step={step ?? '1'} value={val} onChange={(e) => set(e.target.value)} />
          <button className="mini-btn" onClick={() => apply(fn, val)} disabled={!valid}>Set</button>
        </div></label>
    );
  };
  return (
    <div className="be-block" style={{ marginTop: 12 }}>
      <div className="be-head"><span>Límites de ejecución (efectivos)</span></div>
      <Row label="Máx nocional por orden (USDC)" val={perOrder} set={setPerOrderV} fn={setPerOrder} />
      <Row label="Máx nocional diario / usuario (USDC)" val={daily} set={setDailyV} fn={setDaily} />
      <p style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
        El SL es una orden trigger <b>stop-market</b> con banda de slippage fija (1%); puede no
        ejecutarse si el mercado atraviesa la banda en un gap. No es configurable.
      </p>
      {msg && <span style={{ fontSize: 11 }}>{msg}</span>}
    </div>
  );
}

// Concesión/revocación de canTradeLive — admin (paginado).
function BetaPermissionsPanel() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.users.listUsersWithTradeLive, {}, { initialNumItems: 50 });
  const grant = useMutation(api.users.grantTradeLive);
  const revoke = useMutation(api.users.revokeTradeLive);
  const [msg, setMsg] = React.useState('');
  async function toggle(u) {
    setMsg('');
    try { u.canTradeLive ? await revoke({ userId: u.userId }) : await grant({ userId: u.userId }); }
    catch (e) { setMsg(e?.message ?? 'Error'); }
  }
  return (
    <div className="be-block" style={{ marginTop: 12 }}>
      <div className="be-head"><span>Trading real (canTradeLive)</span></div>
      {results.map((u) => (
        <div key={u.userId} className="wallet-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ fontSize: 12 }}>{u.email ?? u.name ?? u.userId.slice(0, 8)}{u.role === 'admin' ? ' (admin)' : ''}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`pill ${u.canTradeLive ? 'green' : 'faint'}`} style={{ fontSize: 10 }}>{u.canTradeLive ? 'SÍ' : 'NO'}</span>
            {u.role !== 'admin' && <button className="mini-btn" onClick={() => toggle(u)}>{u.canTradeLive ? 'Revocar' : 'Conceder'}</button>}
          </div>
        </div>
      ))}
      {status === 'CanLoadMore' && <button className="mini-btn" style={{ marginTop: 6 }} onClick={() => loadMore(50)}>Cargar más</button>}
      {msg && <span style={{ fontSize: 11, color: 'var(--red)' }}>{msg}</span>}
    </div>
  );
}

// Observabilidad de ejecuciones reales (status/error en vivo) — admin. El "dónde falla".
function ExecutionsObservabilityPanel() {
  const rows = useQuery(api.executions.listRecentExecutions, { limit: 50 });
  const color = (s) => (s === 'protected' || s === 'closed') ? 'green'
    : s === 'failed' ? 'faint' : (s === 'sl_failed' || s === 'unknown') ? 'red' : 'amber';
  return (
    <div className="be-block" style={{ marginTop: 12 }}>
      <div className="be-head"><span>Ejecuciones recientes (diagnóstico)</span></div>
      {(rows ?? []).length === 0 && <span className="network" style={{ fontSize: 11 }}>Sin ejecuciones.</span>}
      {(rows ?? []).map((r) => (
        <div key={r.requestId} style={{ fontSize: 11, padding: '4px 0', borderBottom: '1px solid var(--border,#222)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span><span className={`pill ${color(r.status)}`} style={{ fontSize: 10 }}>{r.status}</span> {r.asset} {r.side} ${typeof r.notional === 'number' ? r.notional.toFixed(2) : r.notional}</span>
            <span className="network">{r.email ?? String(r.userId).slice(0, 8)} · {r.network}</span>
          </div>
          {r.error && <div style={{ color: 'var(--red)' }}>{r.error}</div>}
          <div className="network">
            {r.botName ?? ''} · {r.account ?? (r.accountAddress ? `${r.accountAddress.slice(0, 6)}…${r.accountAddress.slice(-4)}` : String(r.hlAccountId).slice(0, 8))} · {new Date(r.updatedAt).toLocaleTimeString('es')}
          </div>
        </div>
      ))}
    </div>
  );
}

function AdminPanel({ simulationMode, tradingEnabled, onSetSimulation, onSetTrading, onKillSwitch }) {
  const [killConfirm, setKillConfirm] = React.useState(false);
  const [tradingConfirm, setTradingConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  // Fix 1: limpiar confirmación stale si simulación se activa antes de confirmar
  React.useEffect(() => {
    if (simulationMode) setTradingConfirm(false);
  }, [simulationMode]);

  async function handleKillSwitch() {
    if (!killConfirm) { setKillConfirm(true); return; }
    setBusy(true);
    setError('');
    try {
      await onKillSwitch();
      setKillConfirm(false);
    } catch (err) {
      setError(`Kill switch falló: ${err?.message ?? 'error desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleSimulation() {
    setBusy(true);
    setError('');
    try {
      await onSetSimulation(!simulationMode);
    } catch (err) {
      setError(`Error simulación: ${err?.message ?? 'error desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleTrading() {
    // Fix 1: guard doble — si simulationMode está activo, bloquear siempre
    if (simulationMode) { setTradingConfirm(false); return; }
    if (!tradingEnabled && !tradingConfirm) { setTradingConfirm(true); return; }
    setBusy(true);
    setError('');
    try {
      await onSetTrading(!tradingEnabled);
      setTradingConfirm(false);
    } catch (err) {
      setError(`Error trading: ${err?.message ?? 'error desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel admin-panel">
      <div className="section-head">
        <h2>Panel Admin</h2>
        <span className="pill red">ADMIN</span>
      </div>

      <div className="admin-status">
        <div className="admin-status-row">
          <span>Modo simulación</span>
          <span className={`pill ${simulationMode ? 'amber' : 'green'}`}>{simulationMode ? 'ON' : 'OFF'}</span>
        </div>
        <div className="admin-status-row">
          <span>Trading en vivo</span>
          <span className={`pill ${tradingEnabled ? 'green' : 'faint'}`}>{tradingEnabled ? 'ACTIVO' : 'DESACTIVADO'}</span>
        </div>
      </div>

      {error && <p style={{ color: 'var(--red)', fontSize: 12, margin: '4px 0' }}>{error}</p>}

      <div className="admin-actions">
        {/* Kill Switch */}
        <button
          className={`admin-kill-btn${killConfirm ? ' confirming' : ''}`}
          onClick={handleKillSwitch}
          disabled={busy || (!tradingEnabled && simulationMode)}
        >
          {killConfirm ? '⚠ Confirmar — DETENER TODO' : '🛑 DETENER TODO'}
        </button>
        {killConfirm && (
          <button className="mini-btn" onClick={() => setKillConfirm(false)}>Cancelar</button>
        )}

        {/* Simulación toggle */}
        <div className="admin-toggle-row">
          <span>Simulación</span>
          <button className={`mini-btn ${simulationMode ? 'amber' : ''}`} onClick={handleToggleSimulation} disabled={busy}>
            {simulationMode ? 'Desactivar SIM' : 'Activar SIM'}
          </button>
        </div>

        {/* Trading toggle — Fix 1: "Confirmar LIVE" bloqueado si simulationMode es true */}
        <div className="admin-toggle-row">
          <span>Trading live</span>
          {tradingConfirm && !tradingEnabled ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="mini-btn active"
                onClick={handleToggleTrading}
                disabled={busy || simulationMode}
              >
                Confirmar LIVE
              </button>
              <button className="mini-btn" onClick={() => setTradingConfirm(false)}>Cancelar</button>
            </div>
          ) : (
            <button
              className={`mini-btn ${tradingEnabled ? 'active' : ''}`}
              onClick={handleToggleTrading}
              disabled={busy || simulationMode}
              title={simulationMode ? 'Desactiva simulación primero' : ''}
            >
              {tradingEnabled ? 'Desactivar LIVE' : 'Activar LIVE'}
            </button>
          )}
        </div>
      </div>

      <BetaPermissionsPanel />
      <ExecutionLimitsPanel />
      <ExecutionsObservabilityPanel />
    </section>
  );
}

function Dashboard({ user, onLogout, userId }) {
  const [network, setNetwork] = React.useState('Todas');
  const [pair, setPair] = React.useState('Todos');
  const [theme, setTheme] = React.useState('dark');

  const botsFromDb = useQuery(api.bots.listBots);
  const toggleBotMutation = useMutation(api.bots.toggleBot);
  const updateBotMutation = useMutation(api.bots.updateBot);
  const poolsFromDb = useQuery(api.pools.listPools);
  const setPoolEntryPrice = useMutation(api.pools.setPoolEntryPriceIfMissing);
  const entryPriceTried = React.useRef(new Set());
  const { prices, connected } = useHyperliquidPrices();
  const { funding } = useHyperliquidFunding();
  const simModeConfig = useQuery(api.systemConfig.getConfig, { key: "simulationMode" });
  const simulationMode = simModeConfig?.value ?? true;
  const tradingEnabledConfig = useQuery(api.systemConfig.getConfig, { key: "tradingEnabled" });
  const tradingEnabled = tradingEnabledConfig?.value ?? false;
  const setSimulationModeMutation = useMutation(api.systemConfig.setSimulationMode);
  const setTradingEnabledMutation = useMutation(api.systemConfig.setTradingEnabled);
  const currentUser = useQuery(api.users.getUser, {});
  const userLoaded = currentUser !== undefined;
  const isAdmin = currentUser?.role === 'admin';
  const userPermissions = useQuery(api.users.getUserPermissions, {});
  // Gestionar bots: admins o usuarios con el permiso canManageBots vigente.
  const canManageBots = isAdmin || (userPermissions ?? []).some((p) => p.permission === 'canManageBots');
  // Trading real (separado): admins o usuarios con canTradeLive vigente.
  const canTradeLive = isAdmin || (userPermissions ?? []).some((p) => p.permission === 'canTradeLive');
  const recordSignalMutation = useMutation(api.tradesHistory.recordSignal);
  const signals = useQuery(api.tradesHistory.listSignals, {});
  const signalCooldownRef = React.useRef({});

  const userAlerts = useQuery(api.alerts.listAlerts, {});
  const alertHistory = useQuery(api.alerts.listAlertHistory, {});
  const createAlertMutation = useMutation(api.alerts.createAlert);
  const deleteAlertMutation = useMutation(api.alerts.deleteAlert);
  const recordAlertTriggerMutation = useMutation(api.alerts.recordAlertTrigger);
  const [toasts, setToasts] = React.useState([]);
  const [scanModalOpen, setScanModalOpen] = React.useState(false);
  const alertCooldownRef = React.useRef({});
  const alertDirectionRef = React.useRef({});

  const logAdminActionMutation = useMutation(api.systemConfig.logAdminAction);

  const fetchPositionAction = useAction(api.actions.poolScanner.fetchPositionLiquidity);
  const [positionData, setPositionData] = React.useState({});
  const positionFetchedRef = React.useRef({});
  const POSITION_TTL_MS = 30 * 1000;

  React.useEffect(() => {
    if (!poolsFromDb?.length || !Object.keys(prices).length) return;
    const now = Date.now();
    for (const p of poolsFromDb) {
      if (!p.tokenId) continue;
      const key = String(p._id);
      if (now - (positionFetchedRef.current[key] ?? 0) < POSITION_TTL_MS) continue;
      const asset = normalizeAsset(p.pair?.split('/')[0]);
      const priceUsd = prices[asset];
      if (!priceUsd) continue;
      positionFetchedRef.current[key] = now;
      fetchPositionAction({ tokenId: p.tokenId, network: p.network, priceUsd, poolAddress: p.poolAddress ?? undefined })
        .then(result => { setPositionData(prev => ({ ...prev, [p._id]: result })); })
        .catch(() => { delete positionFetchedRef.current[key]; });
    }
  }, [poolsFromDb, prices]);

  async function killSwitch() {
    await setTradingEnabledMutation({ enabled: false });
    await setSimulationModeMutation({ enabled: true });
    // log es best-effort — un fallo aquí no debe enmascarar que el kill switch sí se aplicó
    logAdminActionMutation({ action: 'kill_switch', meta: { triggeredBy: userId } }).catch(
      (err) => console.error('admin log failed (kill switch was applied)', err)
    );
  }

  // UI-only state que no persiste en Convex (trading config extendida)
  const [localBotState, setLocalBotState] = React.useState({});

  const bots = React.useMemo(() => {
    if (!botsFromDb || botsFromDb.length === 0) return [];
    return botsFromDb.map((b) => ({
      ...DEFAULT_BOT_UI,
      ...b,
      id: b._id,
      ...(localBotState[b._id] ?? {}),
    }));
  }, [botsFromDb, localBotState]);

  // Normaliza símbolos wrapped (WETH→ETH, WBTC→BTC) para lookup de precios y mock
  function normalizeAsset(sym) {
    if (sym === 'WETH') return 'ETH';
    if (sym === 'WBTC') return 'BTC';
    return sym;
  }
  function normalizePair(pair) {
    if (!pair) return pair;
    return pair.split('/').map(normalizeAsset).join('/');
  }

  // Fusionar config de Convex con campos mock (liquidez/APR) e inyectar precio, funding y APY en tiempo real
  const pools = React.useMemo(() => {
    if (!poolsFromDb || poolsFromDb.length === 0) return [];
    return poolsFromDb.map((p) => {
      const normalizedPair = normalizePair(p.pair);
      const asset = normalizeAsset(p.pair?.split('/')[0]);
      const mock = POOLS.find((m) => m.pair === normalizedPair && m.network === p.network) ?? {};
      const pd = positionData[p._id];
      return {
        liquidity: 0,
        apr: 0,
        exposure: 0,
        borrowHealth: 0,
        leverageRevert: 0,
        healthFactor: 0,
        amountToRepay: 0,
        liquidationThreshold: 0,
        availableToBorrow: 0,
        ...mock,
        ...p,
        id: p._id,
        min: p.minRange,
        max: p.maxRange,
        apy: p.apy ?? mock.apr ?? 0,
        fees24h: p.fees1d ?? mock.fees24h ?? 0,
        price: prices[asset] ?? null,
        funding: funding[asset] ?? null,
        // Posición LP real del usuario sobreescribe mock cuando está disponible
        ...(pd != null ? {
          liquidity: pd.liquidityUsd,
          liquidityReal: true,          // lectura on-chain real (vs mock estimado)
          exposure: pd.exposure,
          feesUncollectedUsd: pd.feesUncollectedUsd ?? null,   // F1: fees sin cobrar (null = sin dato)
          ...(pd.borrowHealth > 0 ? {
            borrowHealth: pd.borrowHealth,
            leverageRevert: pd.leverageRevert ?? 0,
            healthFactor: pd.healthFactor ?? 0,
            amountToRepay: pd.amountToRepay ?? 0,
            liquidationThreshold: pd.liquidationThreshold ?? 0,
            availableToBorrow: pd.availableToBorrow ?? 0,
          } : {}),
        } : {}),
        // Status calculado en tiempo real con precio live — sobreescribe el guardado en Convex
        status: (() => {
          const livePrice = prices[asset] ?? null;
          if (livePrice == null) return p.status ?? 'Sin datos';
          if (livePrice < p.minRange) return 'Fuera de rango';
          if (livePrice > p.maxRange) return 'Fuera de rango';
          const rangeWidth = p.maxRange - p.minRange;
          const nearEdge = rangeWidth * 0.05;
          if (livePrice < p.minRange + nearEdge || livePrice > p.maxRange - nearEdge) return 'Cerca del borde';
          return 'En rango';
        })(),
      };
    });
  }, [poolsFromDb, prices, funding, positionData]);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // C (JAV-UI): backfill del precio de entrada para pools registrados antes de esta función.
  // Una sola vez por pool y SESIÓN: si el pool no tiene entryPrice y hay precio en vivo, persistirlo.
  // La mutation es idempotente (no sobreescribe) y valida ownership. (Codex #4) El pool se marca en
  // el ref ANTES de llamar y NO se desbloquea aunque falle: cada tick de precio del WebSocket
  // dispararía el efecto y, sin este bloqueo, repetiría la mutation en bucle. Un fallo transitorio
  // se reintentará en la próxima recarga (el backfill es best-effort, no crítico).
  React.useEffect(() => {
    if (!Array.isArray(poolsFromDb)) return;
    for (const p of poolsFromDb) {
      if (p.entryPrice != null) continue;
      if (entryPriceTried.current.has(p._id)) continue;
      const asset = normalizeAsset(p.pair?.split('/')[0]);
      const livePrice = prices[asset];
      if (!(livePrice > 0)) continue;
      entryPriceTried.current.add(p._id);
      setPoolEntryPrice({ id: p._id, price: livePrice }).catch(() => {
        // no fatal y NO se reintenta en esta sesión (evita el bucle de escrituras por tick).
      });
    }
  }, [poolsFromDb, prices, setPoolEntryPrice]);

  function addToast(message) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }

  async function handleCreateAlert(args) {
    try { await createAlertMutation(args); } catch (err) { console.error('createAlert failed', err); }
  }

  async function handleDeleteAlert(id) {
    try { await deleteAlertMutation({ id }); } catch (err) { console.error('deleteAlert failed', err); }
  }

  const filteredPools = pools.filter((pool) => {
    const networkOk = network === 'Todas' || pool.network === network;
    const pairOk = pair === 'Todos' || pool.pair === pair;
    return networkOk && pairOk;
  });

  const hasOutOfRangePools = filteredPools.some(
    (p) => p.price != null && (p.price < p.min || p.price > p.max)
  );

  async function setBotActive(id, active) {
    if (!botsFromDb?.find((b) => b._id === id)) return;
    try {
      await toggleBotMutation({ id, active });
      setLocalBotState((prev) => ({ ...prev, [id]: { ...prev[id], active } }));
    } catch (error) {
      console.error('Failed to update bot active state', error);
      addToast(error?.message ?? 'No se pudo cambiar el estado del bot.');
    }
  }

  async function setBotMode(id, mode) {
    if (!botsFromDb?.find((b) => b._id === id)) return;
    try {
      await updateBotMutation({ id, mode });
      setLocalBotState((prev) => ({ ...prev, [id]: { ...prev[id], mode } }));
    } catch (error) {
      console.error('Failed to update bot mode', error);
    }
  }

  async function updateBotConfig(id, patch) {
    if (!botsFromDb?.find((b) => b._id === id)) return;
    const schemaFields = ['capitalPerTrade', 'leverage', 'stop', 'simulationMode', 'walletId', 'orderType', 'entryTrigger', 'triggerPrice', 'autoLeverage', 'collateral', 'poolId'];
    const persistable = Object.fromEntries(
      Object.entries(patch).filter(([k]) => schemaFields.includes(k))
    );

    try {
      if (Object.keys(persistable).length > 0) {
        await updateBotMutation({ id, ...persistable });
      }
      setLocalBotState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    } catch (error) {
      console.error('Failed to update bot config', error);
    }
  }

  async function fireSignal(bot, triggerType, poolsData, pricesData) {
    try {
      const { asset, price, network } = getSignalMeta(bot, poolsData, pricesData);
      await recordSignalMutation({
        action: bot.action,
        asset,
        amount: bot.capitalPerTrade,
        price,
        network,
        botId: bot.id,
        botName: bot.name,
        triggerType,
      });
    } catch (err) {
      console.error('recordSignal failed', err);
    }
  }

  React.useEffect(() => {
    if (!simulationMode || !bots.length || !pools.length || !Object.keys(prices).length) return;
    const COOLDOWN_MS = 5 * 60 * 1000;
    const now = Date.now();
    for (const bot of bots) {
      if (!bot.active || !bot.simulationMode) continue;
      const lastFired = signalCooldownRef.current[bot.id] ?? 0;
      if (now - lastFired < COOLDOWN_MS) continue;
      if (evaluateTrigger(bot, pools, prices)) {
        signalCooldownRef.current[bot.id] = now;
        fireSignal(bot, 'auto', pools, prices);
      }
    }
  }, [prices, bots, pools, simulationMode]);

  React.useEffect(() => {
    if (!userAlerts?.length || !pools.length) return;
    const now = Date.now();
    for (const alert of userAlerts) {
      if (!alert.active) continue;
      const lastFired = alertCooldownRef.current[alert._id] ?? 0;
      if (now - lastFired < ALERT_COOLDOWN_MS) continue;

      let triggered = false;
      let message = '';

      switch (alert.alertType) {
        case 'out_of_range': {
          const matched = pools.filter(
            (p) => p.pair === alert.pair && (!alert.network || p.network === alert.network)
          );
          const offRange = matched.find((p) => p.price != null && (p.price < p.min || p.price > p.max));
          if (offRange) {
            triggered = true;
            message = `Pool ${offRange.pair} (${offRange.network}) fuera de rango — precio $${formatPrice(offRange.pair, offRange.price)}`;
          }
          break;
        }
        case 'apy_below': {
          const matched = pools.filter((p) => p.pair === alert.pair);
          const low = matched.find((p) => p.apy != null && alert.threshold != null && p.apy < alert.threshold);
          if (low) {
            triggered = true;
            message = `APY de ${low.pair} (${low.network}) en ${low.apy.toFixed(1)}% — umbral ${alert.threshold}%`;
          }
          break;
        }
        case 'price_cross': {
          const asset = alert.pair.split('/')[0];
          const price = prices[asset];
          if (price != null && alert.threshold != null) {
            const currentSide = price >= alert.threshold ? 'above' : 'below';
            const prevSide = alertDirectionRef.current[alert._id];
            alertDirectionRef.current[alert._id] = currentSide;
            if (prevSide && prevSide !== currentSide) {
              triggered = true;
              message = `Precio de ${alert.pair} cruzó $${alert.threshold} — actual $${formatPrice(alert.pair, price)}`;
            }
          }
          break;
        }
      }

      if (triggered) {
        alertCooldownRef.current[alert._id] = now;
        addToast(message);
        recordAlertTriggerMutation({ alertId: alert._id, message }).catch((err) =>
          console.error('recordAlertTrigger failed', err)
        );
      }
    }
  }, [prices, pools, userAlerts]);

  async function handleManualTrigger(bot) {
    // Mismo guard que el disparo automático: sin pool vinculado y abierto, no se dispara.
    if (!linkedPool(bot, pools)) {
      addToast('Este bot no tiene un pool vinculado activo: no se puede disparar.');
      return;
    }
    await fireSignal(bot, 'manual', pools, prices);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="top-left">
          <span className="status-dot"></span>
          <div className="brand">Quantum<em>.ia</em></div>
          <span className="pill">Liquidity Hedge</span>
          <SubscriptionBar pools={pools} />
        </div>
        <div className="top-actions">
          <button className="ghost-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Modo blanco' : 'Modo oscuro'}
          </button>
          {userLoaded && !isAdmin && <span className="pill faint">Solo lectura</span>}
          <span className="pill">{user.name}</span>
          <button className="ghost-btn" onClick={onLogout}>Salir</button>
        </div>
      </header>

      {IS_TESTNET && (
        <div className="testnet-banner">
          TESTNET — Sin capital real
        </div>
      )}
      {simulationMode && (
        <div className="sim-banner">
          MODO SIMULACIÓN — Sin operaciones reales
        </div>
      )}

      <main className="main">
        <section className="hero">
          <div className="hero-main">
            <div className="hero-brand">
              <span className="status-dot"></span>
              <h1>Quantum.ia</h1>
            </div>
            <p className="hero-copy">
              Pools BTC/USDC y ETH/USDC en Arbitrum, Base y Optimism con APR por periodo,
              lectura de rango y tres bots preparados para cobertura long o short.
            </p>
          </div>
          <Summary pools={filteredPools} bots={bots} />
        </section>

        <section className="toolbar" aria-label="Filtros del portal">
          <div className="toolbar-group">
            <div className="segmented network-segmented">
              {NETWORKS.map((item) => (
                <button key={item} aria-pressed={network === item} onClick={() => setNetwork(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="toolbar-group">
            <select value={pair} onChange={(event) => setPair(event.target.value)} aria-label="Par">
              {PAIRS.map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>
        </section>

        {scanModalOpen && (
          <ScanTokenIdModal
            onClose={() => setScanModalOpen(false)}
            onAdded={() => addToast('Pool añadido correctamente.')}
          />
        )}

        <div className="content-grid">
          <div className="stack">
            <section className="panel">
              <div className="section-head">
                <h2>
                  Pools de liquidez
                  {hasOutOfRangePools && <span className="badge-alert" title="Hay pools fuera de rango"></span>}
                </h2>
                <span className="pill">{filteredPools.length} visibles</span>
                <button className="mini-btn" onClick={() => setScanModalOpen(true)} title="Añadir pool por Token ID">
                  # Token ID
                </button>
              </div>
              <div className="pool-grid">
                {filteredPools.map((pool) => <PoolCard key={pool.id} pool={pool} canManage={canManageBots} canTradeLive={canTradeLive} />)}
              </div>
            </section>
            {canTradeLive && <HLAccountsPanel />}
            <SpotPositions
              prices={prices}
              connected={connected}
              userId={userId}
              simulationMode={simulationMode}
              tradingEnabled={tradingEnabled}
              isAdmin={isAdmin}
              userLoaded={userLoaded}
            />
            <AuditLogPanel isAdmin={isAdmin} mySignals={signals} />
            <AlertsPanel
              alerts={userAlerts}
              history={alertHistory}
              onCreate={handleCreateAlert}
              onDelete={handleDeleteAlert}
            />
          </div>

          <aside className="stack">
            <section className="panel">
              <div className="section-head">
                <h2>Bots de cobertura</h2>
            <span className="pill">3 acciones</span>
              </div>
              <div className="bot-list">
                {/* Solo bots legacy: los bots por pool (kind il/trading) se gestionan en la
                    tarjeta del pool y NO tienen los campos legacy que usa BotCard (stop, tpSteps). */}
                {bots.filter((b) => !b.kind).map((bot) => {
                  const linked = bot.poolId ? pools.find((p) => p.id === bot.poolId) : null;
                  return (
                    <BotCard key={bot.id} bot={bot} pools={pools} poolClosed={!!linked?.closed} canManage={canManageBots} onSetActive={setBotActive} onMode={setBotMode} onConfig={updateBotConfig} onManualTrigger={handleManualTrigger} userLoaded={userLoaded} />
                  );
                })}
                {bots.filter((b) => !b.kind).length === 0 && (
                  <p className="network" style={{ padding: '8px 0' }}>Los bots se configuran en cada pool (IL y Trading).</p>
                )}
              </div>
            </section>
            {isAdmin && (
              <AdminPanel
                simulationMode={simulationMode}
                tradingEnabled={tradingEnabled}
                onSetSimulation={(v) => setSimulationModeMutation({ enabled: v })}
                onSetTrading={(v) => setTradingEnabledMutation({ enabled: v })}
                onKillSwitch={killSwitch}
              />
            )}
            <WalletPanel />
            <HLAccountPanel walletAddress={currentUser?.walletAddress ?? null} userLoaded={userLoaded} prices={prices} isAdmin={isAdmin} />
            <NetworkLiquidity pools={filteredPools} />
            <RiskPanel pools={filteredPools} />
          </aside>
        </div>
      </main>
      <ToastContainer toasts={toasts} />
    </div>
  );
}

function DashboardWithClerk() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const getOrCreateUser = useMutation(api.users.getOrCreateUser);
  const name = user?.firstName || user?.emailAddresses?.[0]?.emailAddress || 'Usuario';

  React.useEffect(() => {
    if (!isAuthenticated) return;
    getOrCreateUser().catch((error) => {
      console.error('Failed to sync user with Convex', error);
    });
  }, [getOrCreateUser, isAuthenticated]);

  if (isLoading) {
    return (
      <div className="app-shell">
        <main className="main">
          <section className="panel">
            <div className="section-head">
              <h2>Conectando Convex</h2>
              <span className="pill">Auth</span>
            </div>
            <p className="network">Validando sesión con el backend.</p>
          </section>
        </main>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="app-shell">
        <main className="main">
          <section className="panel">
            <div className="section-head">
              <h2>Convex no autenticado</h2>
              <span className="pill red">Revisar Clerk</span>
            </div>
            <p className="network">
              Clerk inició sesión, pero no pudo emitir el token JWT para Convex. Verifica que exista el JWT template
              "convex" en Clerk y que coincida con `convex/auth.config.ts`.
            </p>
            <button className="ghost-btn" onClick={() => signOut()}>Salir</button>
          </section>
        </main>
      </div>
    );
  }

  return <Dashboard user={{ name }} onLogout={() => signOut()} userId={user?.id ?? 'anon'} />;
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="app-shell">
          <main className="main">
            <section className="panel">
              <div className="section-head">
                <h2>Error al cargar el portal</h2>
                <span className="pill red">Error</span>
              </div>
              <p className="network" style={{ color: 'var(--red,#f44)', wordBreak: 'break-all' }}>
                {this.state.error?.message ?? String(this.state.error)}
              </p>
              <button className="ghost-btn" style={{ marginTop: 12 }} onClick={() => this.setState({ error: null })}>
                Reintentar
              </button>
            </section>
          </main>
        </div>
      );
    }
    return this.props.children;
  }
}

function WrappedDashboard(props) {
  return (
    <ErrorBoundary>
      <DashboardWithClerk {...props} />
    </ErrorBoundary>
  );
}

export default WrappedDashboard;
