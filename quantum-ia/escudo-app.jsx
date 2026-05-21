// escudo-app.jsx — main shell

function ShieldIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <path d="M12 2 L20 5 V12 C20 17 16 21 12 22 C8 21 4 17 4 12 V5 Z" />
      <path d="M9 12 L11 14 L15 10" />
    </svg>
  );
}
function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function PlusIcon() {
  return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>);
}
function SlidersIcon() {
  return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="14" y2="6"/><line x1="18" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="16" y2="18"/><line x1="20" y1="18" x2="20" y2="18"/><circle cx="16" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>);
}
function ChevronDown({ size = 12 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>);
}
function InfoIcon() {
  return <span className="info">i</span>;
}

function TopBar({ onOpenHl }) {
  return (
    <div className="topbar">
      <div className="brand">
        <span className="glyph"><ShieldIcon size={16} /></span>
        Escudo Holder
      </div>
      <button className="btn-cta">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 7v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V7l-8-5z" opacity="0.2"/><circle cx="12" cy="12" r="6" fill="#F7931A"/><text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="700" fill="white" fontFamily="sans-serif">₿</text></svg>
        Comprar BTC
      </button>
      <div className="proteccion-pill">
        <span className="pp-icon"><ShieldIcon size={14} /></span>
        <div className="pp-text">
          <b>Protección automática</b>
          <small>Protección ON</small>
        </div>
      </div>

      <div className="kpi-strip">
        <div className="kpi">
          <span className="k">Exposición neta</span>
          <span className="v">
            +0.18x
            <span className="badge">Baja</span>
          </span>
        </div>
        <div className="kpi">
          <span className="k">PnL protegido (30d)</span>
          <span className="v gain">
            +$3,245.75
            <span className="sub">USDC</span>
          </span>
        </div>
        <div className="kpi">
          <span className="k">Riesgo de liqu.</span>
          <span className="v">
            Bajo
            <span className="shield"><ShieldIcon size={11} /></span>
          </span>
        </div>
        <div className="kpi">
          <span className="k">Colateral disponible</span>
          <span className="v">
            312,430.80
            <span className="sub">USDC ▾</span>
          </span>
        </div>
      </div>

      <div className="select">
        <span className="lbl">Cuenta</span>
        <span className="val">Principal</span>
      </div>

      <button className="hl-trigger" onClick={onOpenHl} title="Ver protección en Hyperliquid">
        <span className="dot"></span>
        <div className="text">
          <b>Hyperliquid</b>
          <small>Conectado · 3 posiciones</small>
        </div>
        <span className="chev">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </span>
      </button>

      <button className="icon-btn"><BellIcon /></button>
      <button className="icon-btn"><GearIcon /></button>
      <div className="avatar">HD</div>
    </div>
  );
}

// LEFT — Universo protegido
function UniversoPanel() {
  const [tab, setTab] = React.useState('Todos');
  const tabs = [
    { id: 'Todos', count: 8 },
    { id: 'Cripto', count: 2 },
    { id: 'Materias', count: 3 },
    { id: 'Índices', count: 3 },
  ];

  const filtered = PROTECTED_ASSETS.filter((a) => {
    if (tab === 'Todos') return true;
    if (tab === 'Cripto') return ['BTC','ETH'].includes(a.id);
    if (tab === 'Materias') return ['ORO','PLATA','PETROLEO'].includes(a.id);
    if (tab === 'Índices') return ['US30','NASDAQ100','SP500'].includes(a.id);
    return true;
  });

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Universo protegido <InfoIcon /></h2>
      </div>
      <div className="tabs-row">
        {tabs.map((tb) => (
          <button key={tb.id} className="tab"
            aria-current={tab === tb.id ? 'true' : 'false'}
            onClick={() => setTab(tb.id)}
          >
            {tb.id} <span className="count">{tb.count}</span>
          </button>
        ))}
        <button className="tab add"><PlusIcon /></button>
      </div>

      <Radar assets={filtered} />

      <div className="exposure">
        <h3>Resumen de exposición</h3>
        <table className="exposure-tbl">
          <thead>
            <tr>
              <th>Activo</th>
              <th>Spot</th>
              <th>Cobertura</th>
              <th>Expo. neta</th>
              <th style={{ textAlign: 'left' }}>Riesgo</th>
            </tr>
          </thead>
          <tbody>
            {EXPOSURE_TABLE.map((r) => (
              <tr key={r.id}>
                <td className="activo">
                  <span className={`ag ${r.glyph}`}>{glyphLetter(r.id)}</span>
                  {r.id}
                </td>
                <td>{r.spot}</td>
                <td>{r.cobertura}</td>
                <td className="expo">{r.expo}</td>
                <td><span className={`riesgo ${r.riesgo}`}>{cap(r.riesgo)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="collapsible">
        <span>Correlaciones <InfoIcon /></span>
        <span className="ch"><ChevronDown /></span>
      </div>
    </div>
  );
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// MIDDLE
function ScenariosPanel() {
  const [quick, setQuick] = React.useState('Caída -10%');
  const quickOpts = ['Caída -10%', 'Rally +8%', 'Volatilidad alta'];

  return (
    <div className="panel scenarios">
      <div className="panel-h">
        <h2>Simular escenario <InfoIcon /></h2>
      </div>
      <div className="quick">
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-mute)', marginRight: 4 }}>Escenarios rápidos</span>
        {quickOpts.map((o) => (
          <button key={o} className="qbtn"
            aria-current={quick === o ? 'true' : 'false'}
            onClick={() => setQuick(o)}>{o}</button>
        ))}
        <button className="qbtn custom">Personalizado <SlidersIcon /></button>
      </div>

      <div className="scenario-grid">
        {['caida', 'rally', 'volatilidad'].map((k) => {
          const s = SCENARIOS[k];
          const maxAbs = Math.max(...s.impacts.map((i) => Math.abs(i.val)));
          return (
            <div key={k} className={`scenario ${s.tone}`}>
              <div className="head">
                {s.arrow} {s.label}
              </div>
              <div>
                <div className="pnl-label">PnL neto estimado</div>
                <div className="pnl-value">
                  {s.pnl > 0 ? '+' : ''}{s.pnl.toFixed(2)}
                  <span className="ccy">USDC</span>
                </div>
              </div>
              <div>
                <div className="impact-label">Impacto por activo</div>
                <div className="impact-list">
                  {s.impacts.map((it, i) => (
                    <React.Fragment key={i}>
                      <span className="sym">{it.sym}</span>
                      <span className="num">{it.val > 0 ? '+' : ''}{it.val.toFixed(2)}</span>
                      <span className="bar">
                        <span className="fill" style={{
                          left: it.val >= 0 ? '0%' : 'auto',
                          right: it.val < 0 ? '0%' : 'auto',
                          width: `${Math.min(100, (Math.abs(it.val) / maxAbs) * 100)}%`
                        }} />
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
              <div className="footer">
                <span>Exposición neta</span>
                <span className="v">{s.expo}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pnl-row" style={{ marginTop: 14 }}>
        <div className="pnl-card">
          <div className="ph">
            <div className="t">Curva de PnL proyectada (a 30 días)</div>
          </div>
          <PnlChart />
          <div className="ph" style={{ marginTop: 4 }}>
            <div></div>
            <div className="leg">
              <span className="it"><span className="line dashed"></span> Sin cobertura</span>
              <span className="it con"><span className="line"></span> Con cobertura</span>
            </div>
          </div>
        </div>
        <div className="metrics-card">
          <h4>Métricas clave</h4>
          <div className="m"><span className="k">Max drawdown estimado</span><span className="v loss">-$2,240.50 USDC</span></div>
          <div className="m"><span className="k">Prob. de liqu. (30d)</span><span className="v warn">1.23%</span></div>
          <div className="m"><span className="k">Cobertura actual</span><span className="v">0.58x</span></div>
          <div className="m"><span className="k">Eficiencia de cobertura</span><span className="v gain">87%</span></div>
          <div className="m"><span className="k">Costo de cobertura (30d)</span><span className="v">126.40 USDC</span></div>
        </div>
      </div>
    </div>
  );
}

function ActivityPanel() {
  return (
    <div className="panel activity">
      <div className="panel-h">
        <h2>Automatización · Actividad reciente <InfoIcon /></h2>
      </div>
      <div className="feed">
        {ACTIVITY.map((row, i) => (
          <div className="row" key={i}>
            <div className="when">
              {row.isDay ? (
                <>
                  <span className="day">Ayer</span>
                  {row.time.split('\n')[1]}
                </>
              ) : row.time}
            </div>
            <div className="body">
              <div className="title">{row.title} <span className="info">i</span></div>
              <div className="desc">{row.desc}</div>
              {row.action && (
                <div className="desc"><code>{row.action}</code></div>
              )}
            </div>
            <div className="action">
              {row.pills.map((p, j) => (
                p.status ? (
                  <span key={j} className={`status ${p.status}`}>{p.t}</span>
                ) : (
                  <span key={j} className={`pill ${p.mono ? 'mult' : ''}`}>{p.t}</span>
                )
              ))}
              {row.kvs.map((kv, j) => (
                <div className="kv right" key={`kv-${j}`}>
                  <span className="k">{kv.k}</span>
                  <span className={`v ${kv.gain ? 'gain' : ''}`}>{kv.v}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button className="seemore">Ver historial completo <ChevronDown size={10} /></button>
    </div>
  );
}

// RIGHT — Rules
function RulesPanel() {
  const [rules, setRules] = React.useState(BOT_RULES);
  const toggle = (id) => setRules((r) => r.map((x) => x.id === id ? { ...x, enabled: !x.enabled } : x));

  return (
    <div className="panel rules">
      <div className="panel-h">
        <h2>Reglas del bot</h2>
        <button className="add-rule"><PlusIcon /> Nueva regla</button>
      </div>

      {rules.map((rule) => (
        <div className="rule" key={rule.id}>
          <div className="rh">
            <span className={`rg ${rule.glyph}`}>{rule.glyph === 'vol' ? '↯' : glyphLetter(rule.asset)}</span>
            <span className="title">{rule.condition}</span>
            <button className="switch" aria-checked={rule.enabled ? 'true' : 'false'} onClick={() => toggle(rule.id)}></button>
          </div>
          {rule.expanded && rule.steps.length > 0 && (
            <div className="rule-steps">
              {rule.steps.map((step, i) => (
                <div className="rule-step" key={i}>
                  <span className="n">{i + 1}</span>
                  <div className="content">
                    <div className="label">{step.label}</div>
                    {step.controls && (
                      <div className="controls">
                        {step.controls.map((c, j) => (
                          <button key={j} className={`dd ${c.mono ? 'mono' : ''}`}>{c.v}</button>
                        ))}
                        {step.suffix && <span className="at">{step.suffix}</span>}
                      </div>
                    )}
                    {step.desc && <div className="descline">{step.desc}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="mode-row">
        <span className="lbl">Modo del bot</span>
        <button className="dd">Protección automática</button>
      </div>

      <div className="status-card">
        <span className="si"><ShieldIcon size={16} /></span>
        <div className="text">
          <b>Protección ON</b>
          <small>El bot está activo y monitoreando el mercado.</small>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [hlOpen, setHlOpen] = React.useState(false);
  return (
    <div className="app">
      <TopBar onOpenHl={() => setHlOpen(true)} />
      <div className="layout">
        <UniversoPanel />
        <div className="mid-col">
          <ScenariosPanel />
          <ActivityPanel />
        </div>
        <RulesPanel />
      </div>
      <HyperliquidDrawer open={hlOpen} onClose={() => setHlOpen(false)} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
