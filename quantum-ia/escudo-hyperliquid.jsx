// escudo-hyperliquid.jsx — Hyperliquid wallet + positions drawer

function HyperliquidDrawer({ open, onClose }) {
  const [adjusting, setAdjusting] = React.useState(null); // position id being adjusted
  const [adjustSize, setAdjustSize] = React.useState({}); // map: posId -> %

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && open) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const w = HYPERLIQUID_WALLET;
  const positions = HEDGE_POSITIONS;
  const history = WALLET_HISTORY;

  return (
    <>
      <div className="hl-backdrop" data-open={open ? 'true' : 'false'} onClick={onClose} />
      <aside className="hl-drawer" data-open={open ? 'true' : 'false'} aria-hidden={!open}>
        <div className="hl-h">
          <div className="hl-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round">
              <path d="M12 2 L20 5 V12 C20 17 16 21 12 22 C8 21 4 17 4 12 V5 Z" fill="rgba(20,30,30,0.3)" />
              <path d="M9 12 L11 14 L15 10" />
            </svg>
          </div>
          <div className="text">
            <b>Hyperliquid · Protección</b>
            <small>Conectado · {w.address}</small>
          </div>
          <button className="close" onClick={onClose} aria-label="Cerrar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <div className="hl-body">
          {/* Equity / wallet summary */}
          <section className="hl-section">
            <h3>Wallet</h3>
            <div className="hl-equity">
              <div className="row1">
                <span className="lbl">Patrimonio total (equity)</span>
                <span className="pnl">+${fmtUSD(w.unrealizedPnl)} no realizado</span>
              </div>
              <div className="big">
                ${fmtUSD(w.totalEquity)}<span className="ccy">USDC</span>
              </div>
              <div className="hl-bars">
                <div className="bar">
                  <span className="k">Margen disponible</span>
                  <span className="v">${fmtUSD(w.availableMargin)}</span>
                  <span className="sub">{((w.availableMargin / w.totalEquity) * 100).toFixed(1)}% del equity</span>
                </div>
                <div className="bar">
                  <span className="k">Margen usado</span>
                  <span className="v">${fmtUSD(w.usedMargin)}</span>
                  <span className="sub">{w.marginRatio.toFixed(2)}% del equity</span>
                </div>
              </div>
            </div>
          </section>

          {/* Health */}
          <section className="hl-section">
            <h3>Salud de la cuenta</h3>
            <div className="hl-health">
              <div className="row">
                <span className="k">Health factor</span>
                <span className="v gain">{w.healthFactor.toFixed(1)} / 100</span>
              </div>
              <div className="meter"><div className="fill" style={{ width: `${w.healthFactor}%` }} /></div>
              <div className="row" style={{ marginTop: 4 }}>
                <span className="k">Total depositado · retirado</span>
                <span className="v">${fmtUSD(w.totalDeposited)} · ${fmtUSD(w.totalWithdrawn)}</span>
              </div>
            </div>
          </section>

          {/* Quick actions */}
          <section className="hl-section">
            <div className="hl-actions">
              <button className="hl-action">
                <span className="ico">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                  </svg>
                </span>
                Depositar
              </button>
              <button className="hl-action">
                <span className="ico">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" />
                  </svg>
                </span>
                Retirar
              </button>
              <button className="hl-action">
                <span className="ico">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                </span>
                Transferir
              </button>
            </div>
          </section>

          {/* Active hedge positions */}
          <section className="hl-section">
            <h3>Posiciones de cobertura activas ({positions.length})</h3>
            {positions.map((p) => {
              const isAdjusting = adjusting === p.id;
              const pct = adjustSize[p.id] != null ? adjustSize[p.id] : 100;
              return (
                <div className="hl-position" key={p.id}>
                  <div className="ph">
                    <span className={`ag ${p.glyph}`}>{glyphLetter(p.asset)}</span>
                    <div className="meta">
                      <div className="name">
                        {p.asset} <span className={`side ${p.side.toLowerCase()}`}>{p.side}</span> {p.leverage}
                      </div>
                      <div className="trig">Trigger: {p.triggeredBy} · {p.age}</div>
                    </div>
                    <div className="pnl">
                      <span className={`main ${p.pnl >= 0 ? 'gain' : 'loss'}`}>
                        {p.pnl >= 0 ? '+' : ''}${fmtUSD(Math.abs(p.pnl))}
                      </span>
                      <span className={`pct ${p.pnl >= 0 ? 'gain' : 'loss'}`}>
                        {p.pnl >= 0 ? '+' : ''}{p.pnlPct.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  <div className="grid">
                    <div className="col"><span className="k">Tamaño</span><span className="v">{p.size} {p.asset}</span></div>
                    <div className="col"><span className="k">Valor</span><span className="v">${fmtUSD(p.sizeUsd)}</span></div>
                    <div className="col"><span className="k">Entrada</span><span className="v">${fmtUSD(p.entryPrice)}</span></div>
                    <div className="col"><span className="k">Liquid.</span><span className="v loss">${fmtUSD(p.liquidationPrice)}</span></div>
                  </div>

                  {isAdjusting && (
                    <div className="hl-slider">
                      <div className="head">
                        <span>Ajustar tamaño</span>
                        <span className="v">{pct}% · {(p.size * pct / 100).toFixed(4)} {p.asset}</span>
                      </div>
                      <div className="track" onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        const v = Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100)));
                        setAdjustSize({ ...adjustSize, [p.id]: v });
                      }}>
                        <div className="fill" style={{ width: `${pct}%` }} />
                        <div className="thumb" style={{ left: `${pct}%` }} />
                      </div>
                    </div>
                  )}

                  <div className="actions">
                    <button onClick={() => setAdjusting(isAdjusting ? null : p.id)}>
                      {isAdjusting ? 'Listo' : 'Ajustar'}
                    </button>
                    <button>Take profit</button>
                    <button className="danger">Cerrar</button>
                  </div>
                </div>
              );
            })}
          </section>

          {/* Recent wallet movements */}
          <section className="hl-section">
            <h3>Movimientos recientes</h3>
            <div className="hl-history">
              {history.map((h, i) => {
                const sign = h.amount >= 0 ? '+' : '−';
                const cls = h.amount >= 0 ? 'gain' : 'loss';
                const labelMap = {
                  deposit: 'Depósito',
                  withdraw: 'Retiro',
                  pnl: 'PnL realizado',
                  funding: 'Funding',
                };
                const icoMap = {
                  deposit: '↓',
                  withdraw: '↑',
                  pnl: '✓',
                  funding: 'ƒ',
                };
                return (
                  <div className="h-row" key={i}>
                    <span className={`ico ${h.type}`}>{icoMap[h.type]}</span>
                    <div className="label">
                      <span className="t">{labelMap[h.type]}</span>
                      <span className="s">{h.date} · {h.tx}</span>
                    </div>
                    <span className={`amt ${cls}`}>{sign}${fmtUSD(Math.abs(h.amount))}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

function fmtUSD(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

window.HyperliquidDrawer = HyperliquidDrawer;
window.fmtUSD = fmtUSD;
