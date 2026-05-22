// app.jsx — main shell + nav + tweaks

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "asset": "BTC",
  "theme": "light",
  "density": "regular",
  "accent": "#6B9A6B",
  "rangeOverlay": true
}/*EDITMODE-END*/;

const ACCENT_PALETTES = {
  '#6B9A6B': { gain: '#6B9A6B', gainBright: '#8FC28F', loss: '#B86C5C' }, // sage
  '#C99B5A': { gain: '#C99B5A', gainBright: '#E0B477', loss: '#B86C5C' }, // amber
  '#6A7EE0': { gain: '#6A7EE0', gainBright: '#8C9EE8', loss: '#B86C5C' }, // cobalt
};

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  // Migration: clear SOL if persisted from older version
  React.useEffect(() => {
    if (!ASSETS[t.asset]) setTweak('asset', 'BTC');
  }, [t.asset]);
  const [view, setView] = React.useState('dashboard');
  const setAssetId = (id) => setTweak('asset', id);

  // Apply theme + density to root
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', t.theme);
    document.documentElement.setAttribute('data-density', t.density);
    const p = ACCENT_PALETTES[t.accent] || ACCENT_PALETTES['#6B9A6B'];
    document.documentElement.style.setProperty('--gain', p.gain);
    document.documentElement.style.setProperty('--gain-bright', p.gainBright);
    document.documentElement.style.setProperty('--loss', p.loss);
  }, [t.theme, t.density, t.accent]);

  return (
    <div className="app" data-screen-label={
      view === 'dashboard' ? '01 Dashboard' :
      view === 'portfolio' ? '02 Portafolio' : '03 Crear posición'
    }>
      <div className="shell">
        {/* Top bar */}
        <div className="glow">
          <div className="brand">
            <span className="dot"></span>
            Portal <em>del inversor</em>
          </div>
          <nav className="nav">
            <button aria-current={view === 'dashboard' ? 'true' : 'false'} onClick={() => setView('dashboard')}>Mercados</button>
            <button aria-current={view === 'portfolio' ? 'true' : 'false'} onClick={() => setView('portfolio')}>Portafolio</button>
            <button aria-current={view === 'create' ? 'true' : 'false'} onClick={() => setView('create')}>Crear posición</button>
            <button>Analítica</button>
            <button>Alertas</button>
          </nav>
          <div className="right">
            <button className="icon-btn" style={{
              background: 'rgba(20,18,14,0.04)',
              border: '1px solid var(--line)',
              color: 'var(--text-mute)',
              width: 36, height: 36
            }}>
              <BellIcon />
            </button>
            <div className="acct">
              <div className="ava">JM</div>
              0x4f…a3b1
            </div>
          </div>
        </div>

        {/* View body — fills both columns when not dashboard */}
        {view === 'dashboard' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Dashboard assetId={t.asset} setAssetId={setAssetId} density={t.density} rangeOverlay={t.rangeOverlay} />
          </div>
        )}
        {view === 'portfolio' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Portfolio setView={setView} setAssetId={setAssetId} density={t.density} />
          </div>
        )}
        {view === 'create' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <CreatePosition assetId={t.asset} setView={setView} setAssetId={setAssetId} />
          </div>
        )}
      </div>

      {/* Tweaks panel */}
      <TweaksPanel>
        <TweakSection label="Datos" />
        <TweakRadio
          label="Activo"
          value={t.asset}
          options={['BTC', 'ETH']}
          onChange={(v) => setTweak('asset', v)}
        />
        <TweakToggle
          label="Overlay de rango en gráfico"
          value={t.rangeOverlay}
          onChange={(v) => setTweak('rangeOverlay', v)}
        />

        <TweakSection label="Apariencia" />
        <TweakRadio
          label="Tema"
          value={t.theme}
          options={['light', 'dark']}
          onChange={(v) => setTweak('theme', v)}
        />
        <TweakRadio
          label="Densidad"
          value={t.density}
          options={['compact', 'regular', 'comfy']}
          onChange={(v) => setTweak('density', v)}
        />
        <TweakColor
          label="Acento (ganancias)"
          value={t.accent}
          options={['#6B9A6B', '#C99B5A', '#6A7EE0']}
          onChange={(v) => setTweak('accent', v)}
        />

        <TweakSection label="Navegación" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="twk-btn" style={btnStyle(view === 'dashboard')} onClick={() => setView('dashboard')}>Ver Mercados</button>
          <button className="twk-btn" style={btnStyle(view === 'portfolio')} onClick={() => setView('portfolio')}>Ver Portafolio</button>
          <button className="twk-btn" style={btnStyle(view === 'create')} onClick={() => setView('create')}>Crear posición</button>
        </div>
      </TweaksPanel>
    </div>
  );
}

function btnStyle(active) {
  return {
    appearance: 'none',
    border: '1px solid rgba(41,38,27,.18)',
    background: active ? '#29261b' : 'transparent',
    color: active ? '#f4efe5' : '#29261b',
    padding: '7px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 11.5,
    fontWeight: 500,
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
