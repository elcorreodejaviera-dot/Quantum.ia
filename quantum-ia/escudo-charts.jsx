// escudo-charts.jsx — PnL projected curve

function PnlChart() {
  // Simulated curves: dashed = without coverage (volatile, down), solid = with coverage (steady, slight up)
  const W = 580, H = 200;
  const padL = 40, padR = 12, padT = 14, padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const points = 41;
  const xPct = (i) => -10 + (i / (points - 1)) * 20; // -10% to +10%
  const xPx = (i) => padL + (i / (points - 1)) * innerW;

  // Mock data values (USDC)
  const yMin = -4000, yMax = 4000;
  const yPx = (v) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Without coverage (linear with scenario)
  const without = [];
  for (let i = 0; i < points; i++) {
    const p = xPct(i);
    const v = p * 280 + (Math.sin(i * 0.5) * 80); // roughly linear
    without.push({ x: xPx(i), y: yPx(v) });
  }
  // With coverage (mostly flat with mild positive drift)
  const withC = [];
  for (let i = 0; i < points; i++) {
    const p = xPct(i);
    const v = 200 + p * 35 + (Math.sin(i * 0.4) * 25);
    withC.push({ x: xPx(i), y: yPx(v) });
  }

  const toPath = (pts) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

  const yTicks = [4000, 2000, 0, -2000, -4000];
  const xTicks = [-10, -5, 0, 5, 10];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      {/* y gridlines */}
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={padL + innerW} y1={yPx(t)} y2={yPx(t)}
                stroke="rgba(255,255,255,0.05)" strokeWidth="1"
                strokeDasharray={t === 0 ? '0' : '2 4'} />
          <text x={padL - 6} y={yPx(t) + 3} textAnchor="end"
                fontSize="10" fontFamily="Geist Mono, monospace" fill="#8B95A8">
            {t === 0 ? '0' : (t > 0 ? `${t/1000}K` : `-${Math.abs(t)/1000}K`)}
          </text>
        </g>
      ))}

      {/* without coverage — dashed */}
      <path d={toPath(without)} fill="none" stroke="#8B95A8" strokeWidth="1.6"
            strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />

      {/* with coverage — solid cyan */}
      <path d={toPath(withC)} fill="none" stroke="#4FD1C5" strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round"
            filter="drop-shadow(0 0 4px rgba(79,209,197,0.3))" />

      {/* x labels */}
      {xTicks.map((t, i) => {
        const x = padL + ((t + 10) / 20) * innerW;
        return (
          <text key={t} x={x} y={H - 10} textAnchor="middle"
                fontSize="10" fontFamily="Geist, sans-serif" fill="#8B95A8">
            {t > 0 ? `+${t}%` : `${t}%`}
          </text>
        );
      })}
    </svg>
  );
}

window.PnlChart = PnlChart;
