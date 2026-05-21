// escudo-data.jsx — mock data for Escudo Holder

const PROTECTED_ASSETS = [
  // positioned in radar (x, y as % from center, where 0 = center, +/- = direction)
  { id: 'NASDAQ100', label: 'NASDAQ100', glyph: 'nasdaq', spot: 1.5000, status: 'Protegido', flag: '🇺🇸', pos: { x: -42, y: -30 } },
  { id: 'BTC',       label: 'BTC',       glyph: 'btc',    spot: 5.2500, status: 'Protegido', flag: null,   pos: { x:  18, y: -36 } },
  { id: 'SP500',     label: 'SP500',     glyph: 'sp500',  spot: 1.2000, status: 'Protegido', flag: '🇺🇸', pos: { x:  44, y: -12 } },
  { id: 'US30',      label: 'US30',      glyph: 'us30',   spot: 2.0000, status: 'Protegido', flag: '🇺🇸', pos: { x: -46, y:  10 } },
  { id: 'ETH',       label: 'ETH',       glyph: 'eth',    spot: 12.3000,status: 'Protegido', flag: null,   pos: { x:  46, y:  22 } },
  { id: 'PETROLEO',  label: 'PETROLEO',  glyph: 'petroleo',spot: 75.2000,status:'Protegido', flag: null,   pos: { x: -40, y:  34 } },
  { id: 'PLATA',     label: 'PLATA',     glyph: 'plata',  spot: 85.0000, status: 'Protegido', flag: null,   pos: { x:  -6, y:  40 } },
  { id: 'ORO',       label: 'ORO',       glyph: 'oro',    spot: 3.2500,  status: 'Protegido', flag: null,   pos: { x:  30, y:  36 } },
];

const EXPOSURE_TABLE = [
  { id: 'BTC',       glyph: 'btc',      spot: '5.2500',   cobertura: 'Short 0.88x', expo: '+0.18x', riesgo: 'bajo' },
  { id: 'ETH',       glyph: 'eth',      spot: '12.3000',  cobertura: 'Short 0.75x', expo: '+0.25x', riesgo: 'bajo' },
  { id: 'ORO',       glyph: 'oro',      spot: '3.2500',   cobertura: 'Short 0.40x', expo: '+0.60x', riesgo: 'moderado' },
  { id: 'PLATA',     glyph: 'plata',    spot: '85.0000',  cobertura: 'Short 0.30x', expo: '+0.70x', riesgo: 'moderado' },
  { id: 'PETROLEO',  glyph: 'petroleo', spot: '15.0000',  cobertura: 'Short 0.20x', expo: '+0.80x', riesgo: 'moderado' },
  { id: 'US30',      glyph: 'us30',     spot: '2.0000',   cobertura: 'Short 0.50x', expo: '+0.50x', riesgo: 'bajo' },
  { id: 'NASDAQ100', glyph: 'nasdaq',   spot: '1.5000',   cobertura: 'Short 0.45x', expo: '+0.55x', riesgo: 'bajo' },
  { id: 'SP500',     glyph: 'sp500',    spot: '1.2000',   cobertura: 'Short 0.40x', expo: '+0.60x', riesgo: 'bajo' },
];

const SCENARIOS = {
  caida: {
    label: 'Caída -10%',
    tone: 'red',
    arrow: '↘',
    pnl: -1842.20,
    impacts: [
      { sym: 'BTC',      val: -1350.40, pct: 1.00 },
      { sym: 'ETH',      val:  -320.15, pct: 0.24 },
      { sym: 'ORO',      val:  -110.25, pct: 0.08 },
      { sym: 'PLATA',    val:   -40.35, pct: 0.03 },
      { sym: 'PETROLEO', val:   -20.60, pct: 0.015 },
      { sym: 'US30',     val:   -15.40, pct: 0.011 },
      { sym: 'NASDAQ100',val:    +5.40, pct: 0.004, sign: 1 },
      { sym: 'SP500',    val:    +8.60, pct: 0.006, sign: 1 },
    ],
    expo: '+0.42x',
  },
  rally: {
    label: 'Rally +8%',
    tone: 'green',
    arrow: '↗',
    pnl: 2915.60,
    impacts: [
      { sym: 'BTC',      val: 2120.50, pct: 1.00 },
      { sym: 'ETH',      val:  560.40, pct: 0.26 },
      { sym: 'ORO',      val:  140.20, pct: 0.07 },
      { sym: 'PLATA',    val:   55.10, pct: 0.03 },
      { sym: 'PETROLEO', val:   24.80, pct: 0.012 },
      { sym: 'US30',     val:    9.40, pct: 0.005 },
      { sym: 'NASDAQ100',val:    4.30, pct: 0.002 },
      { sym: 'SP500',    val:    1.90, pct: 0.001 },
    ],
    expo: '-0.12x',
  },
  volatilidad: {
    label: 'Volatilidad alta',
    tone: 'orange',
    arrow: '↯',
    pnl: -156.30,
    impacts: [
      { sym: 'BTC',      val: -210.40, pct: 1.00 },
      { sym: 'ETH',      val:  -85.20, pct: 0.40 },
      { sym: 'ORO',      val:   22.10, pct: 0.10, sign: 1 },
      { sym: 'PLATA',    val:   12.30, pct: 0.06, sign: 1 },
      { sym: 'PETROLEO', val:  -18.50, pct: 0.09 },
      { sym: 'US30',     val:   -6.70, pct: 0.03 },
      { sym: 'NASDAQ100',val:    3.40, pct: 0.015, sign: 1 },
      { sym: 'SP500',    val:    1.90, pct: 0.008, sign: 1 },
    ],
    expo: '+0.05x',
  },
};

const ACTIVITY = [
  {
    time: '10:15:32',
    title: 'BTC cayó 3.12%',
    desc: 'Se activó regla: Si BTC baja 3%',
    action: 'Abriendo short 0.35x en Hyperliquid',
    pills: [{ t: 'Short defensivo' }, { t: '0.35x', mono: true }, { t: 'Abierta', status: 'abierta' }],
    kvs: [
      { k: 'Precio entrada', v: '66,250.0' },
      { k: 'Tamaño', v: '0.35 BTC' },
    ],
  },
  {
    time: '09:48:21',
    title: 'ETH subió 6.08%',
    desc: 'Se activó regla: Si ETH sube 6%',
    action: 'Abriendo short 0.25x en Hyperliquid',
    pills: [{ t: 'Short defensivo' }, { t: '0.25x', mono: true }, { t: 'Abierta', status: 'abierta' }],
    kvs: [
      { k: 'Precio entrada', v: '3,610.5' },
      { k: 'Tamaño', v: '0.25 ETH' },
    ],
  },
  {
    time: '08:22:10',
    title: 'Toma de ganancia alcanzada',
    desc: 'BTC short cerró con +2.51%',
    action: '',
    pills: [{ t: 'Take profit' }, { t: 'Cerrada', status: 'cerrada' }],
    kvs: [
      { k: 'PnL realizado', v: '+$85.40 USDC', gain: true },
    ],
  },
  {
    time: 'Ayer\n22:14:05',
    isDay: true,
    title: 'Regla de volatilidad activada',
    desc: 'Volatilidad: 72.3 > 70',
    action: 'Aumentando cobertura general +0.10x',
    pills: [{ t: 'Ajuste cobertura' }, { t: 'Completado', status: 'completado' }],
    kvs: [
      { k: 'Nueva cobertura', v: '0.58x' },
    ],
  },
];

const BOT_RULES = [
  {
    id: 'btc-baja-3',
    asset: 'BTC',
    glyph: 'btc',
    condition: 'Si BTC baja 3%',
    enabled: true,
    expanded: true,
    steps: [
      { label: 'Abrir cobertura', controls: [{ v: 'Short defensivo' }, { v: '0.35x', mono: true }], suffix: 'en Hyperliquid' },
      { label: 'Tomar ganancia', desc: 'Cuando el short gane 2.5%' },
      { label: 'Cerrar cobertura', desc: 'Cuando BTC se recupere 1.5%' },
    ],
  },
  {
    id: 'eth-sube-6',
    asset: 'ETH',
    glyph: 'eth',
    condition: 'Si ETH sube 6%',
    enabled: true,
    expanded: true,
    steps: [
      { label: 'Abrir cobertura', controls: [{ v: 'Short defensivo' }, { v: '0.25x', mono: true }], suffix: 'en Hyperliquid' },
      { label: 'Tomar ganancia', desc: 'Cuando el short gane 2%' },
      { label: 'Cerrar cobertura', desc: 'Cuando ETH retroceda 1%' },
    ],
  },
  { id: 'oro-baja-2.5', asset: 'ORO',       glyph: 'oro',     condition: 'Si ORO baja 2.5%',     enabled: true, expanded: false, steps: [] },
  { id: 'nq-cae-4',     asset: 'NASDAQ100', glyph: 'nasdaq',  condition: 'Si NASDAQ100 cae 4%',  enabled: true, expanded: false, steps: [] },
  { id: 'vol-70',       asset: 'VOL',       glyph: 'vol',     condition: 'Si volatilidad > 70',  enabled: true, expanded: false, steps: [] },
];

const HYPERLIQUID_WALLET = {
  address: '0x4f3b...a3b1',
  totalEquity: 312430.80,
  availableMargin: 287194.55,
  usedMargin: 25236.25,
  unrealizedPnl: 3245.75,
  marginRatio: 8.07,         // % of equity used as margin
  healthFactor: 92.3,        // 0-100
  totalDeposited: 305000.00,
  totalWithdrawn: 0.00,
};

const HEDGE_POSITIONS = [
  {
    id: 'btc-short-1',
    asset: 'BTC', glyph: 'btc',
    side: 'SHORT', leverage: '0.35x',
    size: 0.35, sizeUsd: 23187.50,
    entryPrice: 66250.00, currentPrice: 65420.00,
    liquidationPrice: 89500.00,
    pnl: 290.50, pnlPct: 1.25,
    funding: -2.40, age: '2h 14m',
    triggeredBy: 'Si BTC baja 3%',
    status: 'active',
  },
  {
    id: 'eth-short-1',
    asset: 'ETH', glyph: 'eth',
    side: 'SHORT', leverage: '0.25x',
    size: 0.25, sizeUsd: 902.63,
    entryPrice: 3610.50, currentPrice: 3580.20,
    liquidationPrice: 4520.00,
    pnl: 7.58, pnlPct: 0.84,
    funding: -0.15, age: '2h 41m',
    triggeredBy: 'Si ETH sube 6%',
    status: 'active',
  },
  {
    id: 'oro-short-1',
    asset: 'ORO', glyph: 'oro',
    side: 'SHORT', leverage: '0.40x',
    size: 1.30, sizeUsd: 4225.00,
    entryPrice: 3265.00, currentPrice: 3250.40,
    liquidationPrice: 3580.00,
    pnl: 18.98, pnlPct: 0.45,
    funding: -1.20, age: '6h 02m',
    triggeredBy: 'Si ORO baja 2.5%',
    status: 'active',
  },
];

const WALLET_HISTORY = [
  { type: 'deposit',   amount:  50000.00, date: 'Hoy 06:12',   tx: '0x8a...' },
  { type: 'pnl',       amount:  85.40,    date: '08:22:10',    tx: 'TP BTC short' },
  { type: 'funding',   amount: -2.40,     date: '06:00',       tx: 'BTC short funding' },
  { type: 'deposit',   amount: 150000.00, date: 'Ayer 14:08',  tx: '0x3e...' },
  { type: 'deposit',   amount: 105000.00, date: '21 May',      tx: '0xb1...' },
];

Object.assign(window, { PROTECTED_ASSETS, EXPOSURE_TABLE, SCENARIOS, ACTIVITY, BOT_RULES, HYPERLIQUID_WALLET, HEDGE_POSITIONS, WALLET_HISTORY });
