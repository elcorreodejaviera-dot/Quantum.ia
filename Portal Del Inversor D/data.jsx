// data.jsx — mock data and helpers for Portal Del Inversor

const ASSETS = {
  BTC: {
    id: 'BTC',
    name: 'Bitcoin',
    glyph: 'btc',
    price: 66832.45,
    change24h: 2.35,
    cap: '1.31T',
    vol: '28.47B',
    aprWeek: 18.62,
    aprDay: 2.51,
    aprYear: 130.47,
    invested: 12450.00,
    minRange: 62500,
    maxRange: 71200,
    color: '#E9923A',
    fairValue: 66832.45,
  },
  ETH: {
    id: 'ETH',
    name: 'Ethereum',
    glyph: 'eth',
    price: 3514.20,
    change24h: -1.18,
    cap: '422.6B',
    vol: '12.84B',
    aprWeek: 24.91,
    aprDay: 3.42,
    aprYear: 168.20,
    invested: 8200.00,
    minRange: 3320,
    maxRange: 3780,
    color: '#6A7EE0',
    fairValue: 3514.20,
  },
};

// Pre-generated price series so we don't redraw randomly each render.
function generateSeries(asset, points = 60) {
  const seed = asset.id.charCodeAt(0) + asset.id.charCodeAt(1);
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const base = asset.price;
  const amp = base * 0.06;
  const out = [];
  let v = base - amp * 0.5;
  for (let i = 0; i < points; i++) {
    const drift = (rand() - 0.48) * amp * 0.10;
    v += drift;
    // gentle pull toward current
    v += (base - v) * 0.04;
    out.push(v);
  }
  // make sure last value is current price
  out[out.length - 1] = base;
  return out;
}

const SERIES = Object.fromEntries(
  Object.entries(ASSETS).map(([k, a]) => [k, generateSeries(a)])
);

const SAVED_RANGES = {
  BTC: [
    { star: true,  range: [0.20, 0.80], price: [62500, 71200], apr: 18.62, date: '23 May 09:15' },
    { star: false, range: [0.30, 1.00], price: [61000, 72000], apr: 16.41, date: '22 May 16:40' },
    { star: false, range: [0.10, 0.60], price: [63500, 69500], apr: 14.28, date: '21 May 18:22' },
    { star: false, range: [0.50, 1.40], price: [58400, 75200], apr: 11.92, date: '20 May 11:05' },
  ],
  ETH: [
    { star: true,  range: [0.30, 0.90], price: [3320, 3780], apr: 24.91, date: '23 May 10:40' },
    { star: false, range: [0.20, 0.70], price: [3380, 3690], apr: 22.18, date: '22 May 14:11' },
    { star: false, range: [0.50, 1.50], price: [3100, 3920], apr: 17.84, date: '21 May 09:00' },
  ],
};

const FEATURED_RANGES = {
  BTC: [
    { range: '0.20% – 0.80%', apr: 18.62, when: '23 May 09:15' },
    { range: '0.30% – 0.80%', apr: 16.41, when: '22 May 16:40' },
    { range: '0.10% – 0.60%', apr: 14.28, when: '21 May 18:22' },
  ],
  ETH: [
    { range: '0.30% – 0.90%', apr: 24.91, when: '23 May 10:40' },
    { range: '0.20% – 0.70%', apr: 22.18, when: '22 May 14:11' },
    { range: '0.50% – 1.20%', apr: 19.30, when: '21 May 11:00' },
  ],
};

const POSITIONS = [
  {
    pair: ['BTC', 'USDC'], tier: '0.30%',
    range: [62500, 71200], current: 66832,
    invested: 12450, value: 12892.34, pnl: 442.34, pnlPct: 3.55,
    fees: 89.42, apr: 18.62, status: 'in-range', age: '14d',
  },
  {
    pair: ['ETH', 'USDC'], tier: '0.30%',
    range: [3320, 3780], current: 3514,
    invested: 8200, value: 8412.10, pnl: 212.10, pnlPct: 2.58,
    fees: 51.18, apr: 24.91, status: 'in-range', age: '9d',
  },
  {
    pair: ['BTC', 'USDC'], tier: '0.05%',
    range: [64200, 69800], current: 66832,
    invested: 6000, value: 6184.20, pnl: 184.20, pnlPct: 3.07,
    fees: 42.80, apr: 22.10, status: 'in-range', age: '21d',
  },
  {
    pair: ['BTC', 'ETH'], tier: '0.30%',
    range: [18.5, 19.6], current: 19.02,
    invested: 6800, value: 6711.20, pnl: -88.80, pnlPct: -1.30,
    fees: 28.14, apr: 9.84, status: 'in-range', age: '32d',
  },
  {
    pair: ['ETH', 'USDC'], tier: '0.05%',
    range: [3580, 3920], current: 3514,
    invested: 3200, value: 3201.40, pnl: 1.40, pnlPct: 0.04,
    fees: 0.00, apr: 0, status: 'out-of-range', age: '4d',
  },
];

const fmtUsd = (n, dec = 2) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmt = (n, dec = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

Object.assign(window, { ASSETS, SERIES, SAVED_RANGES, FEATURED_RANGES, POSITIONS, fmtUsd, fmt });
