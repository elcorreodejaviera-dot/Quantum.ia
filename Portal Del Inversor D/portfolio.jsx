// portfolio.jsx — portfolio overview view

function Portfolio({ setView, setAssetId, density }) {
  const totalInvested = POSITIONS.reduce((s, p) => s + p.invested, 0);
  const totalValue = POSITIONS.reduce((s, p) => s + p.value, 0);
  const totalFees = POSITIONS.reduce((s, p) => s + (p.fees || 0), 0);
  const totalPnl = totalValue - totalInvested;
  const totalPnlPct = (totalPnl / totalInvested) * 100;
  const weightedApr = POSITIONS.reduce((s, p) => s + p.apr * p.value, 0) / totalValue;
  const fees7d = POSITIONS.reduce((s, p) => s + (p.value * p.apr / 100) * (7 / 365), 0);

  const [filter, setFilter] = React.useState('Todas');
  const filtered = POSITIONS.filter((p) => {
    if (filter === 'Todas') return true;
    if (filter === 'En rango') return p.status === 'in-range';
    if (filter === 'Fuera de rango') return p.status === 'out-of-range';
    return true;
  });

  return (
    <>
      <h1 className="section-title">Mi <em>portafolio</em></h1>
      <div className="section-sub">Resumen consolidado de tus posiciones en pools de liquidez · actualizado May 09:42</div>

      <div className="kpi-row">
        <div className="kpi">
          <div className="k">Valor total</div>
          <div className="v">${fmt(totalValue)}</div>
          <div className={`d ${totalPnl >= 0 ? 'gain gain-arr' : 'loss loss-arr'}`}>
            {totalPnl >= 0 ? '+' : ''}${fmt(Math.abs(totalPnl))} · {totalPnlPct.toFixed(2)}%
          </div>
        </div>
        <div className="kpi">
          <div className="k">Capital invertido</div>
          <div className="v">${fmt(totalInvested)}</div>
          <div className="d">{POSITIONS.length} posiciones activas</div>
        </div>
        <div className="kpi">
          <div className="k">Comisiones generadas</div>
          <div className="v">${fmt(totalFees)}</div>
          <div className="d gain">+${fmt(fees7d)} esta semana</div>
        </div>
        <div className="kpi">
          <div className="k">APR ponderado</div>
          <div className="v">{weightedApr.toFixed(2)}<span style={{ fontSize: 18, color: 'var(--text-mute)' }}>%</span></div>
          <div className="d gain gain-arr">+1.84% vs semana anterior</div>
        </div>
      </div>

      <div className="positions">
        <div className="head">
          <h3>Posiciones</h3>
          <div className="filters">
            {['Todas', 'En rango', 'Fuera de rango'].map((f) => (
              <button
                key={f}
                className="chip"
                aria-current={filter === f ? 'true' : 'false'}
                onClick={() => setFilter(f)}
              >{f}</button>
            ))}
          </div>
        </div>

        {/* header row */}
        <div className="position-row" style={{ paddingTop: 4, paddingBottom: 4, borderBottom: '1px solid var(--line)', cursor: 'default' }}>
          <div className="col-label">Par</div>
          <div className="col-label">Rango</div>
          <div className="col-label">Invertido</div>
          <div className="col-label">Valor actual</div>
          <div className="col-label">Comisiones</div>
          <div className="col-label">PnL</div>
          <div className="col-label">APR</div>
          <div></div>
        </div>

        {filtered.map((p, i) => {
          const inRange = p.status === 'in-range';
          const lo = p.range[0], hi = p.range[1];
          const pos = ((p.current - lo) / (hi - lo)) * 100;
          const clamped = Math.max(0, Math.min(100, pos));
          return (
            <div className="position-row" key={i} onClick={() => {
              const id = p.pair[0];
              if (ASSETS[id]) { setAssetId(id); setView('dashboard'); }
            }}>
              <div className="pair">
                <div className="pair-glyphs">
                  <div className={`g ${p.pair[0].toLowerCase()}`}>{p.pair[0][0]}</div>
                  <div className={`g ${p.pair[1].toLowerCase()}`}>{p.pair[1][0]}</div>
                </div>
                <div>
                  <div className="name">{p.pair[0]} / {p.pair[1]}</div>
                  <div className="meta">Tier {p.tier} · {p.age}</div>
                </div>
              </div>
              <div>
                <div className="range-bar">
                  <div className="fill" style={{ left: '10%', right: '10%' }} />
                  <div className="marker" style={{ left: `${clamped}%` }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <span style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)' }}>{fmt(lo, lo > 1000 ? 0 : 2)}</span>
                  <span style={{
                    font: '500 11px var(--font-sans)',
                    color: inRange ? 'var(--gain)' : 'var(--loss)',
                    letterSpacing: '0.04em',
                  }}>{inRange ? '● EN RANGO' : '○ FUERA'}</span>
                  <span style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)' }}>{fmt(hi, hi > 1000 ? 0 : 2)}</span>
                </div>
              </div>
              <div>
                <div className="col-val">${fmt(p.invested)}</div>
                <div style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)', marginTop: 2 }}>capital</div>
              </div>
              <div>
                <div className="col-val">${fmt(p.value)}</div>
                <div style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)', marginTop: 2 }}>actual</div>
              </div>
              <div>
                <div className={`col-val ${p.fees > 0 ? 'gain' : ''}`}>
                  {p.fees > 0 ? '+' : ''}${fmt(p.fees)}
                </div>
                <div style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)', marginTop: 2 }}>acumulado</div>
              </div>
              <div>
                <div className={`col-val ${p.pnl >= 0 ? 'gain' : 'loss'}`}>
                  {p.pnl >= 0 ? '+' : ''}${fmt(Math.abs(p.pnl))}
                </div>
                <div style={{ font: '400 11px var(--font-mono)', color: p.pnl >= 0 ? 'var(--gain)' : 'var(--loss)', marginTop: 2, opacity: 0.7 }}>
                  {p.pnl >= 0 ? '+' : ''}{p.pnlPct.toFixed(2)}%
                </div>
              </div>
              <div>
                <div className={`col-val ${p.apr > 0 ? 'gain' : ''}`}>{p.apr.toFixed(2)}%</div>
                <div style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)', marginTop: 2 }}>anualizado</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <button className="kebab" onClick={(e) => e.stopPropagation()}><KebabIcon /></button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

window.Portfolio = Portfolio;
