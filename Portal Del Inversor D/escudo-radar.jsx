// escudo-radar.jsx — protected universe radial visualization

function Radar({ assets }) {
  return (
    <div className="radar">
      <svg className="rings" viewBox="0 0 400 380" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="radar-fade" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(79,209,197,0.06)" />
            <stop offset="60%" stopColor="rgba(79,209,197,0.02)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="400" height="380" fill="url(#radar-fade)" />
        {/* concentric rings */}
        {[50, 90, 130, 170].map((r, i) => (
          <circle key={i} cx="200" cy="190" r={r}
            fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1"
            strokeDasharray={i === 3 ? '3 4' : '0'}
          />
        ))}
        {/* spokes — radial lines connecting shield to each asset */}
        {assets.map((a, i) => {
          const x = 200 + (a.pos.x / 100) * 200;
          const y = 190 + (a.pos.y / 100) * 190;
          return (
            <line key={i}
              x1="200" y1="190" x2={x} y2={y}
              stroke="rgba(79,209,197,0.18)" strokeWidth="1"
              strokeDasharray="2 3"
            />
          );
        })}
      </svg>

      <div className="shield" aria-hidden="true">
        <svg viewBox="0 0 64 72" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round">
          <path d="M32 4 L56 14 V36 C56 50 44 62 32 68 C20 62 8 50 8 36 V14 Z" fill="rgba(79,209,197,0.08)" />
          <path d="M22 36 L29 43 L43 28" stroke="currentColor" strokeWidth="2.5" />
        </svg>
      </div>

      {assets.map((a) => {
        const left = `calc(50% + ${a.pos.x}% * 1.0)`;
        const top  = `calc(50% + ${a.pos.y}% * 1.0)`;
        return (
          <div className="asset" key={a.id} style={{
            left: `calc(50% + ${a.pos.x * 0.9}%)`,
            top: `calc(50% + ${a.pos.y * 0.9}%)`,
            transform: 'translate(-50%, -50%)',
          }}>
            <div className={`ag ${a.glyph}`}>
              {glyphLetter(a.id)}
            </div>
            <div className="body">
              <div className="t">{a.label}</div>
              <div className="spot">Spot {a.spot.toFixed(4)}</div>
              <div className="prot">{a.status}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function glyphLetter(id) {
  if (id === 'BTC') return '₿';
  if (id === 'ETH') return 'Ξ';
  if (id === 'ORO') return 'Au';
  if (id === 'PLATA') return 'Ag';
  if (id === 'PETROLEO') return '◐';
  if (id === 'US30') return '🇺';
  if (id === 'NASDAQ100') return 'N';
  if (id === 'SP500') return 'S';
  return id[0];
}

window.Radar = Radar;
window.glyphLetter = glyphLetter;
