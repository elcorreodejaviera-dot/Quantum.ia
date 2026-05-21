// create.jsx — create new position drawer

const PRESETS = [
  { label: 'Conservador', sub: '±2%', pct: 0.02, apr: 8.4 },
  { label: 'Balanceado',  sub: '±6%', pct: 0.06, apr: 18.6 },
  { label: 'Agresivo',    sub: '±15%', pct: 0.15, apr: 42.1 },
  { label: 'Personalizado', sub: 'manual', pct: null, apr: null },
];

const PAIRS = [
  { a: 'BTC', b: 'USDC', tier: '0.30%' },
  { a: 'ETH', b: 'USDC', tier: '0.30%' },
  { a: 'BTC', b: 'ETH',  tier: '0.30%' },
  { a: 'BTC', b: 'USDC', tier: '0.05%' },
];

function CreatePosition({ assetId, setView, setAssetId }) {
  const [pair, setPair] = React.useState(PAIRS.find((p) => p.a === assetId) || PAIRS[0]);
  const [amount, setAmount] = React.useState('5,000');
  const [preset, setPreset] = React.useState(1);

  const baseAsset = ASSETS[pair.a];
  const series = SERIES[pair.a] || SERIES.BTC;
  const p = baseAsset?.price || 66832;
  const pct = PRESETS[preset].pct ?? 0.06;
  const range = [Math.round(p * (1 - pct)), Math.round(p * (1 + pct))];

  const amt = parseFloat(amount.replace(/,/g, '')) || 0;
  const aprAdj = PRESETS[preset].apr ?? 18.6;
  const feesYear = amt * aprAdj / 100;
  const feesDay = feesYear / 365;

  return (
    <div className="create">
      <div className="create-head">
        <div>
          <h1 className="section-title" style={{ marginBottom: 2 }}>Nueva <em>posición</em></h1>
          <div className="section-sub" style={{ marginBottom: 0 }}>Configura tu pool de liquidez en tres pasos</div>
        </div>
        <div className="steps">
          <div className="step done"><span className="n">✓</span>Par</div>
          <div className="step" aria-current="true"><span className="n">2</span>Rango</div>
          <div className="step"><span className="n">3</span>Confirmar</div>
        </div>
      </div>

      <div className="create-body">
        <div className="create-form">

          <div className="form-row">
            <label>Selecciona el par</label>
            <div className="pair-pick">
              {PAIRS.map((p) => (
                <button
                  key={p.a + p.b}
                  className="opt"
                  aria-current={pair.a === p.a && pair.b === p.b ? 'true' : 'false'}
                  onClick={() => setPair(p)}
                >
                  <span className="pair-glyphs">
                    <span className={`g ${p.a.toLowerCase()}`} style={{ width: 22, height: 22, fontSize: 10 }}>{p.a[0]}</span>
                    <span className={`g ${p.b.toLowerCase()}`} style={{ width: 22, height: 22, fontSize: 10 }}>{p.b[0]}</span>
                  </span>
                  {p.a} / {p.b}
                  <span style={{ font: '400 10px var(--font-mono)', color: 'var(--text-faint)', marginLeft: 'auto' }}>{p.tier}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label>Cantidad a invertir</label>
            <div className="amount-input">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="ccy">USD</span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {['$1,000', '$5,000', '$10,000', 'Máx'].map((v) => (
                <button key={v} className="chip" onClick={() => v !== 'Máx' && setAmount(v.replace('$', ''))}>{v}</button>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label>Estrategia de rango</label>
            <div className="preset-row">
              {PRESETS.map((p, i) => (
                <button
                  key={p.label}
                  className="preset"
                  aria-current={preset === i ? 'true' : 'false'}
                  onClick={() => setPreset(i)}
                >
                  {p.label}
                  <span className="sub">{p.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn-ghost" onClick={() => setView('dashboard')} style={{ flex: 1, marginTop: 0 }}>← Atrás</button>
            <button className="btn-primary" style={{ flex: 2 }}>Continuar → Revisar y confirmar</button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="range-visual">
            <div className="rv-head">
              <span>Vista previa del rango</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>${fmt(p, p > 1000 ? 0 : 2)}</span>
            </div>
            <div className="canvas">
              <PriceChart asset={baseAsset || ASSETS.BTC} series={series} range={range} dark={true} height={90} />
            </div>
            <div className="rv-foot">
              <div className="col">
                <span className="k">Mín</span>
                <span className="v">${fmt(range[0], range[0] > 1000 ? 0 : 2)}</span>
              </div>
              <div className="col" style={{ textAlign: 'center' }}>
                <span className="k">Ancho</span>
                <span className="v">±{(pct * 100).toFixed(1)}%</span>
              </div>
              <div className="col" style={{ textAlign: 'right' }}>
                <span className="k">Máx</span>
                <span className="v">${fmt(range[1], range[1] > 1000 ? 0 : 2)}</span>
              </div>
            </div>
          </div>

          <div className="summary">
            <h4>Resumen estimado</h4>
            <div className="row"><span className="k">APR estimado</span><span className="v gain">{aprAdj.toFixed(2)}%</span></div>
            <div className="row"><span className="k">Comisiones / día</span><span className="v">${fmt(feesDay)}</span></div>
            <div className="row"><span className="k">Comisiones / año</span><span className="v">${fmt(feesYear, 0)}</span></div>
            <div className="row"><span className="k">Gas estimado</span><span className="v">~$4.20</span></div>
            <div className="row"><span className="k">Probabilidad en rango</span><span className="v">
              {preset === 0 ? '62%' : preset === 1 ? '78%' : preset === 2 ? '91%' : '—'}
            </span></div>
            <div className="total">
              <span className="k">Capital total</span>
              <span className="v">${fmt(amt)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.CreatePosition = CreatePosition;
