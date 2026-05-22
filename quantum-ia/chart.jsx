// chart.jsx — price chart with optional liquidity range overlay

function PriceChart({ asset, series, range, rangeOverlay = true, dark = true, height = 280 }) {
  const fluidHeight = height === 'fluid';
  const W = 920;
  const H = fluidHeight ? 280 : height;
  const padL = 8, padR = 60, padT = 14, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const min = Math.min(...series);
  const max = Math.max(...series);
  // Pad y range to include the user's range too
  const rMin = range ? Math.min(min, range[0]) : min;
  const rMax = range ? Math.max(max, range[1]) : max;
  const span = (rMax - rMin) * 1.08 || 1;
  const yBase = rMin - span * 0.04;

  const x = (i) => padL + (i / (series.length - 1)) * innerW;
  const y = (v) => padT + innerH - ((v - yBase) / span) * innerH;

  // Build path
  const linePath = series.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  const areaPath = linePath + ` L ${x(series.length - 1).toFixed(2)} ${(padT + innerH).toFixed(2)} L ${x(0).toFixed(2)} ${(padT + innerH).toFixed(2)} Z`;

  // y-axis ticks
  const tickCount = 5;
  const ticks = [];
  for (let i = 0; i < tickCount; i++) {
    const v = yBase + (span * i) / (tickCount - 1);
    ticks.push(v);
  }

  // x-axis date labels — every 8 points or so
  const labels = ['17 May', '18 May', '19 May', '20 May', '21 May', '22 May', '23 May'];

  const lineColor = dark ? '#8FC28F' : '#3F7A3F';
  const lineColorLoss = dark ? '#E8917F' : '#A85A48';
  const isUp = series[series.length - 1] >= series[0];
  const stroke = isUp ? lineColor : lineColorLoss;

  const gridColor = dark ? 'rgba(244,239,229,0.08)' : 'rgba(20,18,14,0.08)';
  const textColor = dark ? 'rgba(244,239,229,0.5)' : 'rgba(20,18,14,0.5)';
  const textFaint = dark ? 'rgba(244,239,229,0.35)' : 'rgba(20,18,14,0.4)';

  const lastV = series[series.length - 1];
  const lastY = y(lastV);
  const lastX = x(series.length - 1);

  // Range overlay
  const rangeTop = range ? y(range[1]) : 0;
  const rangeBot = range ? y(range[0]) : 0;
  const inRange = range && lastV >= range[0] && lastV <= range[1];

  const gradId = `g-${asset.id}`;
  const rangeGradId = `gr-${asset.id}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={fluidHeight ? '100%' : H} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={rangeGradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.10" />
          <stop offset="50%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.10" />
        </linearGradient>
      </defs>

      {/* y gridlines + labels */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line
            x1={padL} x2={padL + innerW}
            y1={y(t).toFixed(2)} y2={y(t).toFixed(2)}
            stroke={gridColor} strokeWidth="1"
            strokeDasharray={i === 0 ? '0' : '2 4'}
          />
          <text
            x={padL + innerW + 8} y={y(t).toFixed(2) - 2}
            fill={textColor} fontSize="10.5" fontFamily="Geist Mono, monospace"
            dominantBaseline="middle"
          >
            {Math.round(t).toLocaleString('en-US')}
          </text>
        </g>
      ))}

      {/* Range band overlay */}
      {rangeOverlay && range && (
        <g>
          <rect
            x={padL} y={rangeTop.toFixed(2)}
            width={innerW} height={(rangeBot - rangeTop).toFixed(2)}
            fill={`url(#${rangeGradId})`}
          />
          <line
            x1={padL} x2={padL + innerW}
            y1={rangeTop.toFixed(2)} y2={rangeTop.toFixed(2)}
            stroke={stroke} strokeWidth="1" strokeDasharray="4 3" opacity="0.6"
          />
          <line
            x1={padL} x2={padL + innerW}
            y1={rangeBot.toFixed(2)} y2={rangeBot.toFixed(2)}
            stroke={stroke} strokeWidth="1" strokeDasharray="4 3" opacity="0.6"
          />
          {/* labels */}
          <text
            x={padL + 6} y={rangeTop - 4}
            fill={stroke} fontSize="9.5" fontFamily="Geist Mono, monospace"
            letterSpacing="0.06em"
          >
            MAX {Math.round(range[1]).toLocaleString('en-US')}
          </text>
          <text
            x={padL + 6} y={rangeBot + 12}
            fill={stroke} fontSize="9.5" fontFamily="Geist Mono, monospace"
            letterSpacing="0.06em"
          >
            MIN {Math.round(range[0]).toLocaleString('en-US')}
          </text>
        </g>
      )}

      {/* area + line */}
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />

      {/* current price guide */}
      <line
        x1={padL} x2={padL + innerW}
        y1={lastY.toFixed(2)} y2={lastY.toFixed(2)}
        stroke={stroke} strokeWidth="1" strokeDasharray="2 5" opacity="0.34"
      />
      <g transform={`translate(${padL + innerW + 6}, ${lastY - 11})`}>
        <rect x="0" y="0" width="50" height="20" rx="6" fill={dark ? '#14120E' : '#F4EFE3'} stroke={gridColor} />
        <text x="25" y="13.5" textAnchor="middle" fill={stroke} fontSize="9.5" fontFamily="Geist Mono, monospace" fontWeight="500">
          {Math.round(lastV).toLocaleString('en-US')}
        </text>
      </g>

      {/* last price marker */}
      <g>
        <circle cx={lastX} cy={lastY} r="3.5" fill={stroke} />
        <circle cx={lastX} cy={lastY} r="7" fill={stroke} opacity="0.18" />
      </g>

      {/* x-axis labels */}
      {labels.map((lab, i) => {
        const xx = padL + (i / (labels.length - 1)) * innerW;
        return (
          <text
            key={i} x={xx} y={H - 8}
            textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
            fill={textFaint} fontSize="10.5" fontFamily="Geist, sans-serif"
          >
            {lab}
          </text>
        );
      })}

      {/* In-range status */}
      {rangeOverlay && range && (
        <g transform={`translate(${padL + innerW - 96}, ${padT + 6})`}>
          <rect
            x="0" y="0" width="96" height="22" rx="11"
            fill={inRange ? stroke : (dark ? '#3a342b' : '#d6cfbf')}
            opacity={inRange ? 0.18 : 0.6}
          />
          <circle cx="10" cy="11" r="3" fill={inRange ? stroke : '#999'} />
          <text x="20" y="15" fontSize="10.5" fontFamily="Geist, sans-serif" fontWeight="500"
                fill={inRange ? stroke : textColor} letterSpacing="0.04em">
            {inRange ? 'EN RANGO' : 'FUERA DE RANGO'}
          </text>
        </g>
      )}
    </svg>
  );
}

window.PriceChart = PriceChart;
