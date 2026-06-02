import React from 'react'
import { useUser, useClerk } from '@clerk/clerk-react'
import { useConvexAuth, useQuery, useMutation, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useHyperliquidPrices, useHyperliquidFunding, useHyperliquidAllMids, useHyperliquidSpotState, useWalletBalances, useHLAccountBalance } from '../hooks/useHyperliquid'

const USERS = [
  { username: 'admin', password: import.meta.env.VITE_ADMIN_PASSWORD, name: 'Operador principal' },
];

const NETWORKS = ['Todas', 'Arbitrum', 'Base', 'Optimism'];
const PAIRS = ['Todos', 'BTC/USDC', 'ETH/USDC'];

const POOLS = [
  { id: 1, pair: 'BTC/USDC', network: 'Arbitrum', min: 63200, max: 72400, liquidity: 86240, fees24h: 118, apr: 42.6, exposure: 0.74, borrowHealth: 82, leverageRevert: 2.4, status: 'En rango' },
  { id: 2, pair: 'ETH/USDC', network: 'Arbitrum', min: 3420, max: 4020, liquidity: 54110, fees24h: 71, apr: 37.2, exposure: 0.62, borrowHealth: 76, leverageRevert: 1.8, status: 'En rango' },
  { id: 3, pair: 'BTC/USDC', network: 'Base', min: 64600, max: 70100, liquidity: 39220, fees24h: 64, apr: 51.8, exposure: 0.81, borrowHealth: 58, leverageRevert: 3.6, status: 'Cerca del borde' },
  { id: 4, pair: 'ETH/USDC', network: 'Base', min: 3600, max: 3880, liquidity: 33680, fees24h: 58, apr: 58.4, exposure: 0.77, borrowHealth: 69, leverageRevert: 2.9, status: 'En rango' },
  { id: 5, pair: 'BTC/USDC', network: 'Optimism', min: 61500, max: 74200, liquidity: 28400, fees24h: 39, apr: 31.7, exposure: 0.49, borrowHealth: 91, leverageRevert: 1.2, status: 'En rango' },
  { id: 6, pair: 'ETH/USDC', network: 'Optimism', min: 3860, max: 4240, liquidity: 24560, fees24h: 22, apr: 24.9, exposure: 0.88, borrowHealth: 38, leverageRevert: 5.1, status: 'Fuera de rango' },
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
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
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

function Login({ onLogin }) {
  const [username, setUsername] = React.useState('admin');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [recovery, setRecovery] = React.useState('');

  function submit(event) {
    event.preventDefault();
    const user = USERS.find((item) => item.username === username.trim() && item.password === password);
    if (!user) {
      setError('Usuario o contraseña incorrectos.');
      setRecovery('');
      return;
    }
    setError('');
    setRecovery('');
    onLogin(user);
  }

  function forgotPassword() {
    setError('');
    setRecovery('Recuperación pendiente: contacta al administrador para restablecer tu contraseña.');
  }

  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-row">
          <div className="brand">Quantum<em>.ia</em></div>
          <span className="pill">Acceso privado</span>
        </div>
        <div className="field">
          <label htmlFor="username">Usuario</label>
          <input id="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label htmlFor="password">Contraseña</label>
          <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </div>
        <button className="primary-btn" type="submit">Entrar</button>
        <button className="link-btn" type="button" onClick={forgotPassword}>¿Olvidaste tu contraseña?</button>
        <p className="error">{error}</p>
        <p className="recovery">{recovery}</p>
      </form>
    </main>
  );
}

function Summary({ pools, bots }) {
  const totalLiquidity = pools.reduce((sum, pool) => sum + pool.liquidity, 0);
  const fees = pools.reduce((sum, pool) => sum + pool.fees24h, 0);
  const avgApy = pools.length > 0
    ? pools.reduce((sum, pool) => sum + (pool.apy ?? 0), 0) / pools.length
    : 0;
  const activeBots = bots.filter((bot) => bot.active).length;
  const walletBalance = WALLETS.reduce((sum, wallet) => sum + wallet.balance, 0);

  return (
    <div className="summary-grid">
      <SummaryItem label="Liquidez monitoreada" value={formatUsd(totalLiquidity)} sub={`${pools.length} pools activos`} />
      <SummaryItem label="Fees 24h" value={formatUsd(fees)} sub="Estimado por rango" />
      <SummaryItem
        label="APY promedio"
        value={pools.length > 0 ? `${avgApy.toFixed(1)}%` : '—'}
        sub={pools.length > 0 ? `${(avgApy / 52).toFixed(2)}% semanal` : 'Sin datos'}
      />
      <SummaryItem label="Wallets monitoreadas" value={`${WALLETS.length}`} sub={`${formatUsd(walletBalance)} total`} />
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
  const byNetwork = ['Arbitrum', 'Base', 'Optimism'].map((network) => {
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

function PoolCard({ pool }) {
  const hasPrice = pool.price != null;
  const pos = hasPrice
    ? Math.max(4, Math.min(96, ((pool.price - pool.min) / (pool.max - pool.min)) * 100))
    : 50;
  const parts = aprParts(pool.apy ?? 0);
  const apyLabel = pool.apyUpdatedAt ? 'APY (DeFiLlama)' : 'APY (estimado)';
  const tone = pool.status === 'Fuera de rango' ? 'red' : pool.status === 'Cerca del borde' ? 'amber' : 'green';
  const borrowTone = pool.borrowHealth < 50 ? 'red' : pool.borrowHealth < 70 ? 'amber' : 'green';
  const borrowLabel = pool.borrowHealth < 50 ? 'Riesgo alto' : pool.borrowHealth < 70 ? 'Vigilar' : 'Saludable';

  return (
    <article className="pool-card">
      <div className="pool-title">
        <div>
          <div className="pair">{pool.pair}</div>
          <div className="network">{pool.network}</div>
        </div>
        <span className={`pill ${tone}`}>{pool.status}</span>
      </div>

      <div className={`borrow-health borrow-health-featured ${borrowTone}`}>
        <div className="borrow-head">
          <span>Salud borrow / revert</span>
          <strong>{borrowLabel}</strong>
        </div>
        <div className="borrow-main">
          <span>{pool.borrowHealth}%</span>
          <strong>{pool.leverageRevert.toFixed(1)}x</strong>
        </div>
        <div className="borrow-track" aria-label="Salud borrow">
          <div className={`borrow-fill ${borrowTone}`} style={{ width: `${pool.borrowHealth}%` }}></div>
        </div>
        <div className="borrow-foot">
          <span>Health factor</span>
          <span>Revert leverage</span>
        </div>
      </div>

      <div className="range-vertical" aria-label="Rango vertical de liquidez">
        <div className="range-axis">
          <span className="range-limit top">${formatPrice(pool.pair, pool.max)}</span>
          <span className="range-limit bottom">${formatPrice(pool.pair, pool.min)}</span>
          <div className="range-window"></div>
          <div className="range-price" style={{ bottom: `${pos}%` }}>
            <span>Precio</span>
            <strong>{hasPrice ? `$${formatPrice(pool.pair, pool.price)}` : '—'}</strong>
          </div>
        </div>
      </div>

      <div className="pool-meta">
        <Metric label="Liquidez monitoreada" value={formatUsd(pool.liquidity)} />
        <Metric label="Fees 24h" value={formatUsd(pool.fees24h)} />
        <Metric label={apyLabel} value={`${parts.annual.toFixed(1)}%`} />
        <Metric label="Cobertura" value={`${Math.round(pool.exposure * 100)}%`} />
        <Metric label="Funding 8h" value={pool.funding != null ? `${(pool.funding * 100).toFixed(4)}%` : '—'} />
      </div>

    </article>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SubscriptionPanel() {
  const current = SUBSCRIPTIONS[2];

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Suscripción</h2>
        <span className="pill">{current.type}</span>
      </div>
      <div className="subscription-current">
        <div>
          <div className="label">Cobertura activa</div>
          <div className="subscription-amount">{formatUsd(current.coverage)}</div>
        </div>
        <span className="pill green">Activa</span>
      </div>
      <div className="subscription-grid">
        {SUBSCRIPTIONS.map((plan) => (
          <div className={`subscription-tier ${plan.type === current.type ? 'active' : ''}`} key={plan.type}>
            <span>{plan.type}</span>
            <strong>{formatUsd(plan.coverage)}</strong>
          </div>
        ))}
      </div>
    </section>
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

function evaluateTrigger(bot, pools, prices) {
  if (!bot.active || !bot.simulationMode) return false;
  if (bot.orderType === 'Trigger manual') return false; // solo disparo manual

  // DCA Auto: evaluar por entryTrigger si existe, sino por trigger text
  const condition = (bot.entryTrigger ?? bot.trigger ?? '').toLowerCase();
  const t = condition;
  if (t.includes('sale del rango') || t.includes('fuera de rango')) {
    return pools.some(p => {
      const asset = p.pair?.split('/')[0];
      const price = prices[asset];
      return price != null && (price < p.min || price > p.max);
    });
  }
  if (t.includes('recupera rango') || t.includes('retorno')) {
    return pools.some(p => {
      const asset = p.pair?.split('/')[0];
      const price = prices[asset];
      return price != null && price >= p.min && price <= p.max;
    });
  }
  if (t.includes('apr') || t.includes('rebalanceo')) {
    const match = t.match(/(\d+(?:\.\d+)?)/);
    const threshold = match ? parseFloat(match[1]) : 18;
    return pools.some(p => p.apy != null && p.apy < threshold);
  }
  return false;
}

function getSignalMeta(bot, pools, prices) {
  const t = (bot.entryTrigger ?? bot.trigger ?? '').toLowerCase();
  const isPrice = t.includes('rango') || t.includes('retorno');
  if (isPrice) {
    const pool = pools.find(p => {
      const asset = p.pair?.split('/')[0];
      const price = prices[asset];
      if (price == null) return false;
      if (t.includes('sale del rango') || t.includes('fuera de rango')) return price < p.min || price > p.max;
      return price >= p.min && price <= p.max;
    }) ?? pools[0];
    const asset = pool?.pair?.split('/')[0] ?? 'BTC';
    return { asset, price: prices[asset] ?? 0, network: pool?.network ?? 'Arbitrum' };
  }
  return { asset: 'POOL', price: 0, network: 'Arbitrum' };
}

function BotCard({ bot, onSetActive, onMode, onConfig, onManualTrigger }) {
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
        <span className={`pill ${tone}`}>{bot.active ? 'Activo' : 'Pausado'}</span>
      </div>
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
          <button className={`mini-btn ${bot.mode === 'Long' ? 'active' : ''}`} onClick={() => onMode(bot.id, 'Long')}>Long</button>
          <button className={`mini-btn ${bot.mode === 'Short' ? 'active' : ''}`} onClick={() => onMode(bot.id, 'Short')}>Short</button>
          <button className={`mini-btn ${bot.mode === 'Long + Short' ? 'active' : ''}`} onClick={() => onMode(bot.id, 'Long + Short')}>Long + Short</button>
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
        <button className={`mini-btn ${!bot.active ? 'active' : ''}`} onClick={() => onSetActive(bot.id, false)}>Pausar</button>
        <button className={`mini-btn ${bot.active ? 'active' : ''}`} onClick={() => onSetActive(bot.id, true)}>Activar</button>
      </div>
      <div className="wallet-actions">
        <button className="mini-btn" onClick={() => setConfigOpen((value) => !value)}>Configurar</button>
        <button className="mini-btn">Escanear wallet</button>
        <button className="mini-btn">Token ID de pool {bot.poolTokenId}</button>
        {bot.simulationMode && (
          <button className="mini-btn amber" onClick={() => onManualTrigger?.(bot)}>
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

function SpotPositions({ prices, connected, userId, simulationMode, tradingEnabled }) {
  const positionsFromDb = useQuery(api.spot_positions.listMyPositions);
  const addPositionMutation = useMutation(api.spot_positions.addPosition);
  const updatePositionMutation = useMutation(api.spot_positions.updatePosition);
  const recordSignalMutation = useMutation(api.tradesHistory.recordSignal);
  const executeHlOrder = useAction(api.hyperliquid.executePerpMarketOrder);
  const [positions, setPositions] = React.useState(() =>
    INITIAL_SPOT_POSITIONS.map(p => ({ ...p, protector: loadProtector(userId, p.asset) }))
  );
  const [openAssets, setOpenAssets] = React.useState({});
  const [addForm, setAddForm] = React.useState({});
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

      if (simulationMode || !tradingEnabled) {
        await recordSignalMutation({ action, asset, amount, price, network: 'Spot', botName: `Bot protector ${asset}`, triggerType });
        return;
      }

      await executeHlOrder({
        asset,
        side,
        tradeAmount: amount,
        price,
        leverage: lev,
        stopLoss: sl,
        triggerType,
        confirmLive: true,
      });
    } catch (error) {
      console.error('Failed to execute spot protector signal', error);
    }
  }, [executeHlOrder, recordSignalMutation, simulationMode, tradingEnabled]);

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

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Posiciones spot</h2>
        <span className={`pill${connected ? ' green' : ''}`}>{connected ? 'HL en vivo' : 'Conectando...'}</span>
        <span className={`pill${!simulationMode && tradingEnabled ? ' green' : ' amber'}`}>
          {!simulationMode && tradingEnabled ? 'Ejecución HL' : 'SIM'}
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
          const invested = position.dca * position.amount;
          const currentVal = hasPrice ? position.currentPrice * position.amount : null;
          const pnl = currentVal != null ? currentVal - invested : null;
          const pnlPositive = pnl != null && pnl >= 0;
          const pnlPct = pnl != null && invested > 0 ? (pnl / invested) * 100 : null;

          return (
            <article className="spot-card" key={position.asset}>
              <div className="spot-collapse-btn">
                <button className="spot-collapse-toggle" onClick={() => toggleAsset(position.asset)}>
                  <span className="spot-collapse-arrow">{isOpen ? '▼' : '▶'}</span>
                  <span className="pair">{position.asset}</span>
                  {hasPrice && <span className="network">${formatPrice(`${position.asset}/USDC`, position.currentPrice)}</span>}
                </button>
                <div className="spot-collapse-inputs">
                  <label className="spot-inline-field">
                    <span>Precio DCA</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={drafts[position.asset]?.dca ?? ''}
                      onChange={(e) => handleDraftChange(position.asset, 'dca', e.target.value)}
                      onBlur={() => commitDraft(position.asset, 'dca')}
                    />
                  </label>
                  <label className="spot-inline-field">
                    <span>Monto ({position.asset})</span>
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      value={drafts[position.asset]?.amount ?? ''}
                      onChange={(e) => handleDraftChange(position.asset, 'amount', e.target.value)}
                      onBlur={() => commitDraft(position.asset, 'amount')}
                    />
                  </label>
                  <div className="spot-inline-field">
                    <span>Invertido</span>
                    <span className="spot-calc-value">{invested > 0 ? formatUsd(invested) : '—'}</span>
                  </div>
                  <div className="spot-inline-field">
                    <span>Valor actual</span>
                    <span className={`spot-calc-value${currentVal != null ? (pnlPositive ? ' positive' : ' negative') : ''}`}>
                      {currentVal != null ? formatUsd(currentVal) : '—'}
                    </span>
                  </div>
                  <div className="spot-inline-field">
                    <span>ROI</span>
                    <span className={`spot-calc-value${pnl != null ? (pnlPositive ? ' positive' : ' negative') : ''}`}>
                      {pnlPct != null
                        ? `${pnlPositive ? '+' : ''}${pnlPct.toFixed(2)}% · ${pnlPositive ? '+' : ''}${formatUsd(pnl)}`
                        : '—'}
                    </span>
                  </div>
                </div>
                <div className="spot-collapse-right">
                  <span className="pill">{position.protector?.active ? 'Bot activo' : 'Bot pausado'}</span>
                </div>
              </div>

              {isOpen && (
                <SpotProtectorBot
                  asset={position.asset}
                  protector={position.protector}
                  currentPrice={position.currentPrice}
                  simulationMode={simulationMode}
                  tradingEnabled={tradingEnabled}
                  onChange={(patch) => updateProtector(position.asset, patch)}
                  onFireSignal={(triggerType, price, amount) => recordSpotSignal(position.asset, triggerType, price, amount, position.protector)}
                />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SimulationHistory({ signals }) {
  if (!signals || signals.length === 0) {
    return (
      <section className="panel">
        <div className="section-head">
          <h2>Historial simulado</h2>
          <span className="pill amber">SIMULACIÓN</span>
        </div>
        <p className="network">Sin señales todavía. Los bots activos en simulación dispararán señales automáticamente.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Historial simulado</h2>
        <span className="pill amber">SIMULACIÓN</span>
        <span className="pill">{signals.length} señales</span>
      </div>
      <div className="signal-list">
        {signals.slice(0, 20).map((s) => {
          const date = new Date(s.timestamp);
          const timeStr = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const dateStr = date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
          return (
            <div key={s._id} className="signal-row">
              <div className="signal-main">
                <span className="signal-bot">{s.botName ?? '—'}</span>
                <span className="signal-action">{s.action}</span>
                <span className={`pill ${s.triggerType === 'manual' ? 'blue' : 'green'}`}>
                  {s.triggerType === 'manual' ? 'Manual' : 'Auto'}
                </span>
              </div>
              <div className="signal-meta">
                <span className="mono">{s.asset} @ ${s.price > 0 ? formatPrice(`${s.asset}/USDC`, s.price) : '—'}</span>
                <span className="network">{s.network}</span>
                <span className="network">{dateStr} {timeStr}</span>
              </div>
            </div>
          );
        })}
      </div>
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
            <option>Arbitrum</option>
            <option>Base</option>
            <option>Optimism</option>
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

function SpotProtectorBot({ asset, protector, onChange, currentPrice, simulationMode, tradingEnabled, onFireSignal }) {
  const hlWallet = protector.hlWallet ?? '';
  const validWallet = EVM_RE_PROTECTOR.test(hlWallet);
  const { account: hlAccount, loading: hlBalLoading, error: hlBalError } = useHLAccountBalance(validWallet ? hlWallet : null);
  const credentialStatus = useQuery(api.hlCredentials.status);
  const saveHlCredential = useAction(api.hlCredentialActions.save);
  const revokeHlCredential = useMutation(api.hlCredentials.revoke);
  const [apiKeyInput, setApiKeyInput] = React.useState('');
  const [apiKeyError, setApiKeyError] = React.useState('');
  const [apiKeySaving, setApiKeySaving] = React.useState(false);

  async function saveApiKey() {
    setApiKeyError('');
    if (!apiKeyInput.trim()) return;
    setApiKeySaving(true);
    try {
      await saveHlCredential({ privateKey: apiKeyInput.trim() });
      setApiKeyInput('');
    } catch (error) {
      setApiKeyError(error?.message ?? 'No se pudo guardar la API wallet');
    } finally {
      setApiKeySaving(false);
    }
  }

  async function revokeApiKey() {
    setApiKeyError('');
    try {
      await revokeHlCredential({});
    } catch (error) {
      setApiKeyError(error?.message ?? 'No se pudo revocar la API wallet');
    }
  }

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
                  {hlAccount.openPositions.slice(0, 4).map((item) => {
                    const position = item.position ?? {};
                    const size = parseFloat(position.szi ?? 0);
                    const entry = parseFloat(position.entryPx ?? 0);
                    const coin = position.coin ?? '—';
                    return (
                      <div className="hl-position-row" key={`${coin}-${position.szi}`}>
                        <span>{coin}</span>
                        <span className="mono">{size > 0 ? 'Long' : 'Short'} {Math.abs(size).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
                        <span className="mono">@ ${entry > 0 ? formatPrice(`${coin}/USDC`, entry) : '—'}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="be-block">
        <div className="be-head">
          <span>API wallet HL</span>
          <span className={`pill${credentialStatus?.connected ? ' green' : ' amber'}`}>
            {credentialStatus?.connected ? 'Conectada' : 'Sin API'}
          </span>
        </div>
        {credentialStatus?.connected && (
          <div className="network" style={{ fontSize: 12, marginTop: 6 }}>
            Agent: {credentialStatus.agentAddress?.slice(0, 8)}...{credentialStatus.agentAddress?.slice(-6)}
          </div>
        )}
        <div className="config-field" style={{ marginTop: 6 }}>
          <span>Private key API wallet</span>
          <input
            type="password"
            className="hl-search"
            style={{ margin: 0 }}
            placeholder="0x... solo se cifra en backend"
            value={apiKeyInput}
            onChange={(event) => setApiKeyInput(event.target.value)}
            autoComplete="off"
          />
        </div>
        {apiKeyError && <span style={{ fontSize: 11, color: 'var(--red,#f44)' }}>{apiKeyError}</span>}
        <div className="wallet-actions" style={{ marginTop: 8 }}>
          <button className="mini-btn" onClick={saveApiKey} disabled={apiKeySaving || !apiKeyInput.trim()}>
            {apiKeySaving ? 'Guardando...' : 'Guardar API'}
          </button>
          {credentialStatus?.connected && (
            <button className="mini-btn" onClick={revokeApiKey}>Revocar API</button>
          )}
        </div>
      </div>

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
        <button className={`mini-btn ${!protector.active ? 'active' : ''}`} onClick={() => onChange({ active: false })}>Pausar</button>
        <button className={`mini-btn ${protector.active ? 'active' : ''}`} onClick={() => onChange({ active: true })}>Activar</button>
        <span className={`pill${!simulationMode && tradingEnabled ? ' green' : ' amber'}`}>
          {!simulationMode && tradingEnabled ? 'LIVE HL' : 'SIM'}
        </span>
        {protector.active && (
          <button className="mini-btn amber" onClick={handleManual}>Disparar manual</button>
        )}
      </div>
    </div>
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
  const { prices, connected } = useHyperliquidPrices();
  const { funding } = useHyperliquidFunding();
  const simModeConfig = useQuery(api.systemConfig.getConfig, { key: "simulationMode" });
  const simulationMode = simModeConfig?.value ?? true;
  const tradingEnabledConfig = useQuery(api.systemConfig.getConfig, { key: "tradingEnabled" });
  const tradingEnabled = tradingEnabledConfig?.value ?? false;
  const recordSignalMutation = useMutation(api.tradesHistory.recordSignal);
  const signals = useQuery(api.tradesHistory.listSignals, {});
  const signalCooldownRef = React.useRef({});

  const userAlerts = useQuery(api.alerts.listAlerts, {});
  const alertHistory = useQuery(api.alerts.listAlertHistory, {});
  const createAlertMutation = useMutation(api.alerts.createAlert);
  const deleteAlertMutation = useMutation(api.alerts.deleteAlert);
  const recordAlertTriggerMutation = useMutation(api.alerts.recordAlertTrigger);
  const [toasts, setToasts] = React.useState([]);
  const alertCooldownRef = React.useRef({});
  const alertDirectionRef = React.useRef({});

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

  // Fusionar config de Convex con campos mock (liquidez/APR) e inyectar precio, funding y APY en tiempo real
  const pools = React.useMemo(() => {
    if (!poolsFromDb || poolsFromDb.length === 0) return [];
    return poolsFromDb.map((p) => {
      const asset = p.pair?.split('/')[0];
      const mock = POOLS.find((m) => m.pair === p.pair && m.network === p.network) ?? {};
      return {
        liquidity: 0,
        apr: 0,
        exposure: 0,
        borrowHealth: 0,
        leverageRevert: 0,
        status: 'Sin datos',
        ...mock,
        ...p,
        id: p._id,
        min: p.minRange,
        max: p.maxRange,
        apy: p.apy ?? mock.apr ?? 0,
        fees24h: p.fees1d ?? mock.fees24h ?? 0,
        price: prices[asset] ?? null,
        funding: funding[asset] ?? null,
      };
    });
  }, [poolsFromDb, prices, funding]);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

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
    const schemaFields = ['capitalPerTrade', 'leverage', 'stop', 'simulationMode', 'walletId', 'orderType', 'entryTrigger', 'triggerPrice', 'autoLeverage', 'collateral'];
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
    await fireSignal(bot, 'manual', pools, prices);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="top-left">
          <span className="status-dot"></span>
          <div className="brand">Quantum<em>.ia</em></div>
          <span className="pill">Liquidity Hedge</span>
        </div>
        <div className="top-actions">
          <button className="ghost-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Modo blanco' : 'Modo oscuro'}
          </button>
          <span className="pill">{user.name}</span>
          <button className="ghost-btn" onClick={onLogout}>Salir</button>
        </div>
      </header>

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
            <div className="segmented">
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

        <div className="content-grid">
          <div className="stack">
            <section className="panel">
              <div className="section-head">
                <h2>
                  Pools de liquidez
                  {hasOutOfRangePools && <span className="badge-alert" title="Hay pools fuera de rango"></span>}
                </h2>
                <span className="pill">{filteredPools.length} visibles</span>
              </div>
              <div className="pool-grid">
                {filteredPools.map((pool) => <PoolCard key={pool.id} pool={pool} />)}
              </div>
            </section>
            <SpotPositions
              prices={prices}
              connected={connected}
              userId={userId}
              simulationMode={simulationMode}
              tradingEnabled={tradingEnabled}
            />
            <SimulationHistory signals={signals} />
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
                {bots.map((bot) => (
                  <BotCard key={bot.id} bot={bot} onSetActive={setBotActive} onMode={setBotMode} onConfig={updateBotConfig} onManualTrigger={handleManualTrigger} />
                ))}
              </div>
            </section>
            <SubscriptionPanel />
            <WalletPanel />
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
