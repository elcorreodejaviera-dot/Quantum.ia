// dashboard.jsx — main dashboard view

const TF_TABS = ['1 semana', '1 día', '4 horas', '1 hora'];

function Dashboard({ assetId, setAssetId, density }) {
  const asset = ASSETS[assetId];
  const series = SERIES[assetId];
  const [tf, setTf] = React.useState(TF_TABS[0]);
  const [range, setRange] = React.useState([
    SAVED_RANGES[assetId][0].price[0],
    SAVED_RANGES[assetId][0].price[1],
  ]);
  const [rangePct, setRangePct] = React.useState([
    SAVED_RANGES[assetId][0].range[0],
    SAVED_RANGES[assetId][0].range[1],
  ]);

  React.useEffect(() => {
    const r = SAVED_RANGES[assetId][0];
    setRange([r.price[0], r.price[1]]);
    setRangePct([r.range[0], r.range[1]]);
  }, [assetId]);

  const onCalcOptimo = () => {
    // Simulated optimal range: ±6% from current
    const p = asset.price;
    const lo = Math.round(p * 0.945);
    const hi = Math.round(p * 1.065);
    setRange([lo, hi]);
    setRangePct([0.15, 0.85]);
  };

  return (
    <>
      {/* Asset switcher */}
      <div className="asset-switch">
        {Object.values(ASSETS).map((a) => (
          <button
            key={a.id}
            className="opt"
            aria-current={a.id === assetId ? 'true' : 'false'}
            onClick={() => setAssetId(a.id)}
          >
            <span className={`g ${a.glyph}`}>{a.id[0]}</span>
            {a.name}
          </button>
        ))}
      </div>

      <div className="shell-inner" style={{ display: 'grid', gridTemplateColumns: '1fr 264px', gap: 'var(--gap-md)' }}>
        <div className="main">

          {/* Asset hero card */}
          <div className="asset-card">
            <div className="search-row">
              <div className="search">
                <SearchIcon />
                <input placeholder={`Buscar activo (BTC, ETH...)`} />
              </div>
              <button className="portfolio-pill">
                Mi Portafolio
                <PortfolioIcon />
              </button>
              <button className="icon-btn"><MenuIcon /></button>
            </div>

            <div className="asset-header">
              <div className="asset-id">
                <div className={`asset-glyph ${asset.glyph}`}>{asset.id[0]}</div>
                <div className="asset-name">
                  <div className="ticker">{asset.id}</div>
                  <div className="full">{asset.name}</div>
                </div>
              </div>
              <div className="asset-price">
                <div className="label">Precio actual</div>
                <div className="value">
                  ${Math.floor(asset.price).toLocaleString('en-US')}<span className="small">.{(asset.price.toFixed(2)).split('.')[1]}</span>
                  <span className="ccy">USD</span>
                </div>
              </div>
            </div>

            <div className="tabs-row">
              <div className="tabs">
                {TF_TABS.map((t) => (
                  <button key={t} aria-current={tf === t ? 'true' : 'false'} onClick={() => setTf(t)}>{t}</button>
                ))}
              </div>
              <div className="stamp"><span className="dot" />Actualizado May 09:42</div>
            </div>

            <div className="chart-wrap">
              <PriceChart asset={asset} series={series} range={range} dark={true} />
            </div>
          </div>

          {/* Range generator */}
          <div className="range-gen">
            <div className="title">
              Generador de rango de comisiones
              <span className="info">?</span>
            </div>
            <div className="range-grid">
              <div className="field range-pair">
                <div className="lbl">Rango de comisiones</div>
                <div className="val">
                  <input
                    value={rangePct[0].toFixed(2)}
                    onChange={(e) => setRangePct([parseFloat(e.target.value) || 0, rangePct[1]])}
                  />
                  <span className="pct">%</span>
                  <span className="sep">–</span>
                  <input
                    value={rangePct[1].toFixed(2)}
                    onChange={(e) => setRangePct([rangePct[0], parseFloat(e.target.value) || 0])}
                  />
                  <span className="pct">%</span>
                </div>
              </div>
              <div className="field input">
                <div className="lbl">Precio actual</div>
                <div className="val">${fmt(asset.price)}</div>
              </div>
              <div className="field input">
                <div className="lbl">Precio mínimo</div>
                <div className="val">
                  <span>$</span>
                  <input
                    value={fmt(range[0], 0)}
                    onChange={(e) => setRange([parseFloat(e.target.value.replace(/,/g, '')) || 0, range[1]])}
                  />
                </div>
              </div>
              <div className="field input">
                <div className="lbl">Precio máximo</div>
                <div className="val">
                  <span>$</span>
                  <input
                    value={fmt(range[1], 0)}
                    onChange={(e) => setRange([range[0], parseFloat(e.target.value.replace(/,/g, '')) || 0])}
                  />
                </div>
              </div>
            </div>
            <button className="btn-primary" onClick={onCalcOptimo}>Calcular rango óptimo</button>
          </div>

          {/* Saved ranges */}
          <div className="saved">
            <div className="head">
              <h3><BookmarkIcon /> Mejores rangos guardados</h3>
              <a href="#">Ver todos</a>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th></th>
                  <th>Rango de comisiones</th>
                  <th>Rango de precios</th>
                  <th>APR semanal</th>
                  <th>Guardado el</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {SAVED_RANGES[assetId].map((r, i) => (
                  <tr key={i} onClick={() => { setRange([r.price[0], r.price[1]]); setRangePct(r.range); }} style={{ cursor: 'pointer' }}>
                    <td><StarIcon active={r.star} /></td>
                    <td className="range">{r.range[0].toFixed(2)}% – {r.range[1].toFixed(2)}%</td>
                    <td className="price">${fmt(r.price[0], 0)} – ${fmt(r.price[1], 0)}</td>
                    <td className="apr">{r.apr.toFixed(2)}%</td>
                    <td>{r.date}</td>
                    <td><button className="kebab" onClick={(e) => e.stopPropagation()}><KebabIcon /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right rail */}
        <div className="side">
          <div className="rail-card">
            <div className="rail-title">Métricas clave</div>
            <div className="metric">
              <div className="k">Variación 24h</div>
              <div className={`v ${asset.change24h >= 0 ? 'gain' : 'loss'}`}>
                <span className="arr">{asset.change24h >= 0 ? '↗' : '↘'}</span>
                {Math.abs(asset.change24h).toFixed(2)}%
              </div>
            </div>
            <div className="metric">
              <div className="k">Capitalización</div>
              <div className="v">${asset.cap}</div>
            </div>
            <div className="metric">
              <div className="k">Volumen (24h)</div>
              <div className="v">${asset.vol}</div>
            </div>
            <div className="metric">
              <div className="k">APR semanal</div>
              <div className="v gain">{asset.aprWeek.toFixed(2)}%</div>
            </div>
            <div className="metric">
              <div className="k">APR diario</div>
              <div className="v gain">{asset.aprDay.toFixed(2)}%</div>
            </div>
            <div className="metric">
              <div className="k">APR anual</div>
              <div className="v gain">{asset.aprYear.toFixed(2)}%</div>
            </div>
            <div className="metric">
              <div className="k">Capital invertido</div>
              <div className="v">${fmt(asset.invested)}</div>
            </div>
          </div>

          <div className="rail-card featured">
            <div className="rail-title">Rangos destacados</div>
            {FEATURED_RANGES[assetId].map((r, i) => (
              <div className="item" key={i}>
                <div className="top">{r.range}</div>
                <div className="sub">
                  APR semanal <span className="apr">{r.apr.toFixed(2)}%</span>
                  <br />
                  <span className="when">{r.when}</span>
                </div>
              </div>
            ))}
            <button className="btn-ghost">Ver todos los rangos</button>
          </div>
        </div>
      </div>
    </>
  );
}

// Icons --------------------------------------------------------
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function PortfolioIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="14" rx="2" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}
function BookmarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function StarIcon({ active }) {
  return (
    <svg className={`star ${active ? 'active' : ''}`} viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
function KebabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

Object.assign(window, { Dashboard, SearchIcon, PortfolioIcon, MenuIcon, BookmarkIcon, StarIcon, KebabIcon });
