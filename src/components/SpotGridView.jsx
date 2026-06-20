import React from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import HLAccountSelect from './HLAccountSelect'
import { useHyperliquidAllMids } from '../hooks/useHyperliquid'

// (JAV-93 / QSG PR4) Pantalla del Quantum Spot Grid: crear, ver y COMPARTIR un grid spot live.
// Estilo BingX pero Quantum. Mayormente frontend + la query read-only getSpotGridDetail (JAV-93).
// La creación/stop son money-path: van por actions con confirmación LIVE no salteable y expectedNetwork.
// La red del backend es la fuente de verdad; aquí solo enviamos la que el frontend cree (VITE_HL_NETWORK)
// y el backend la revalida (assertExpectedNetwork) → si difiere, rechaza.

const HL_NETWORK = import.meta.env.VITE_HL_NETWORK === 'testnet' ? 'testnet' : 'mainnet'

function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  const sign = v < 0 ? '-' : ''
  return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Duración Xd Yh Zm desde createdAt (estilo screenshot BingX).
function durationParts(createdAt, now = Date.now()) {
  const ms = Math.max(0, now - (createdAt ?? now))
  const totalMin = Math.floor(ms / 60000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  return { d, h, m }
}
function durationText(createdAt, now) {
  const { d, h, m } = durationParts(createdAt, now)
  return `${d}d ${h}h ${m}m`
}

const STATUS_LABEL = {
  running: 'Operando', paused: 'Pausado', stopped: 'Detenido', error: 'Error',
}

export default function SpotGridView() {
  const bots = useQuery(api.spotGridBots.listSpotGridBots)
  const [selectedId, setSelectedId] = React.useState(null)

  // Auto-selecciona el primero cuando carga la lista (UX: ver algo sin clic).
  React.useEffect(() => {
    if (selectedId == null && Array.isArray(bots) && bots.length > 0) setSelectedId(bots[0]._id)
  }, [bots, selectedId])

  return (
    <div className="sg-wrap">
      <SpotGridStyles />
      <div className="sg-top">
        <div className="sg-brand"><b>Quantum</b>.ia · Spot Grid</div>
        <div className="sg-tabs">
          <Link to="/dashboard" className="sg-tab">Portal</Link>
          <span className="sg-tab active">Spot Grid ●</span>
        </div>
        <span className={`sg-pill ${HL_NETWORK === 'mainnet' ? 'green' : 'amber'}`}>● {HL_NETWORK}</span>
      </div>

      <div className="sg-grid">
        <aside className="sg-side">
          <div className="sg-shead"><h2>MIS GRIDS</h2></div>
          {bots === undefined && <p className="sg-muted">Cargando…</p>}
          {Array.isArray(bots) && bots.length === 0 && (
            <p className="sg-muted">Aún no tienes ningún grid. Crea uno con el formulario.</p>
          )}
          {Array.isArray(bots) && bots.map((b) => (
            <button
              key={b._id}
              className={`sg-listitem ${selectedId === b._id ? 'active' : ''}`}
              onClick={() => setSelectedId(b._id)}
            >
              <span className="sg-li-pair">{b.symbol}/{b.quoteAsset}</span>
              <span className={`sg-dot sg-${b.status}`} title={STATUS_LABEL[b.status] ?? b.status} />
            </button>
          ))}
          <button
            className={`sg-listitem sg-new ${selectedId === '__new__' ? 'active' : ''}`}
            onClick={() => setSelectedId('__new__')}
          >+ Nuevo grid</button>
        </aside>

        <main className="sg-main">
          {selectedId === '__new__' || (Array.isArray(bots) && bots.length === 0)
            ? <CreateGridForm onCreated={(id) => setSelectedId(id)} />
            : selectedId
              ? <GridDetail botId={selectedId} />
              : <p className="sg-muted">Selecciona un grid o crea uno nuevo.</p>}
        </main>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------------------------------
// Crear grid (money-path: confirmación LIVE no salteable + expectedNetwork)
// ----------------------------------------------------------------------------------------------------
function CreateGridForm({ onCreated }) {
  const accounts = useQuery(api.hlCredentials.list) ?? []
  const createGrid = useAction(api.spotGridActions.createSpotGridBot)
  const { allPrices } = useHyperliquidAllMids()

  const [hlAccountId, setHlAccountId] = React.useState(null)
  const [symbol, setSymbol] = React.useState('BTC')
  const [minPrice, setMinPrice] = React.useState('')
  const [gridProfit, setGridProfit] = React.useState('1')
  const [investment, setInvestment] = React.useState('')
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [orderSize, setOrderSize] = React.useState('')
  const [gridCount, setGridCount] = React.useState('10')
  const [feeRate, setFeeRate] = React.useState('0.0004')
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  const refPrice = allPrices?.[symbol] ?? null

  function validate() {
    if (!hlAccountId) return 'Selecciona la cuenta HL dedicada.'
    const mp = Number(minPrice), gp = Number(gridProfit), inv = Number(investment)
    if (!(mp > 0)) return 'El precio mínimo debe ser > 0.'
    if (!(gp >= 0.5 && gp <= 10)) return 'El profit por cuadrícula debe estar entre 0.5% y 10%.'
    if (!(inv > 0)) return 'La inversión debe ser > 0.'
    if (showAdvanced) {
      if (!(Number(orderSize) > 0)) return 'El tamaño de orden debe ser > 0.'
      if (!(Number(gridCount) >= 2)) return 'El nº de niveles debe ser ≥ 2.'
      if (!(Number(feeRate) >= 0)) return 'El fee rate no puede ser negativo.'
    }
    return null
  }

  function openConfirm() {
    const v = validate()
    if (v) { setError(v); return }
    setError(null)
    setConfirmOpen(true)
  }

  async function doCreate() {
    setBusy(true); setError(null)
    try {
      const inv = Number(investment)
      const count = showAdvanced ? Number(gridCount) : 10
      const size = showAdvanced && Number(orderSize) > 0 ? Number(orderSize) : inv / count
      const res = await createGrid({
        hlAccountId,
        symbol,
        minPrice: Number(minPrice),
        gridProfitPercent: Number(gridProfit),
        investmentAmount: inv,
        orderSize: size,
        gridCount: count,
        feeRate: Number(feeRate),
        expectedNetwork: HL_NETWORK,
        confirm: true,
      })
      setConfirmOpen(false)
      const newId = res?.botId ?? res?._id ?? res
      if (newId && typeof newId === 'string') onCreated(newId)
    } catch (e) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sg-panel">
      <h1>Crear Spot Grid</h1>
      <p className="sg-muted">
        Compra al bajar y vende un poco más arriba, en ciclos, sobre Hyperliquid Spot. Funciona mejor en
        mercados laterales; en tendencia bajista fuerte puede quedar comprado y rendir menos que holdear en bull.
      </p>

      <div className="sg-form">
        <div className="sg-field">
          <span>Par</span>
          <div className="sg-seg">
            {['BTC', 'ETH'].map((s) => (
              <button key={s} className={symbol === s ? 'on' : ''} onClick={() => setSymbol(s)}>{s}/USDC</button>
            ))}
          </div>
          <small className="sg-muted">Precio ref. {refPrice ? usd(refPrice) : '…'}</small>
        </div>

        <HLAccountSelect accounts={accounts} value={hlAccountId} onChange={setHlAccountId} />

        <label className="sg-field"><span>Precio mínimo (suelo del grid)</span>
          <input type="number" inputMode="decimal" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} placeholder="ej. 50000" />
        </label>
        <label className="sg-field"><span>Profit por cuadrícula (%)</span>
          <input type="number" inputMode="decimal" value={gridProfit} onChange={(e) => setGridProfit(e.target.value)} placeholder="0.5 – 10" />
        </label>
        <label className="sg-field"><span>Inversión total (USDC)</span>
          <input type="number" inputMode="decimal" value={investment} onChange={(e) => setInvestment(e.target.value)} placeholder="ej. 100" />
        </label>

        <button className="sg-link" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '▾ Ocultar avanzado' : '▸ Opciones avanzadas'}
        </button>
        {showAdvanced && (
          <div className="sg-adv">
            <label className="sg-field"><span>Tamaño por orden (USDC)</span>
              <input type="number" inputMode="decimal" value={orderSize} onChange={(e) => setOrderSize(e.target.value)} placeholder="auto = inversión / niveles" />
            </label>
            <label className="sg-field"><span>Nº de niveles</span>
              <input type="number" inputMode="numeric" value={gridCount} onChange={(e) => setGridCount(e.target.value)} />
            </label>
            <label className="sg-field"><span>Fee rate efectivo</span>
              <input type="number" inputMode="decimal" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} />
            </label>
          </div>
        )}

        {error && <p className="sg-error">{error}</p>}
        <button className="sg-primary" onClick={openConfirm}>Crear grid</button>
      </div>

      {confirmOpen && (
        <div className="sg-modal-bg" onClick={() => !busy && setConfirmOpen(false)}>
          <div className="sg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Confirmar grid LIVE</h2>
            <p>
              Esto creará <b>órdenes reales</b> en Hyperliquid Spot ({HL_NETWORK}) con tu API wallet
              <b> trade-only</b>. {symbol}/USDC, suelo {usd(Number(minPrice))}, profit {gridProfit}% por
              cuadrícula, inversión {usd(Number(investment))}.
            </p>
            <p className="sg-warn">
              Riesgo: en tendencia bajista el grid acumula posición comprada; en un bull fuerte puede rendir
              menos que simplemente holdear. Solo LIMIT, sin retiros, clave nunca expuesta.
            </p>
            {error && <p className="sg-error">{error}</p>}
            <div className="sg-modal-actions">
              <button className="sg-ghost" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancelar</button>
              <button className="sg-primary" disabled={busy} onClick={doCreate}>{busy ? 'Creando…' : 'Sí, crear órdenes reales'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------------------------------
// Detalle del grid: stats + órdenes + ciclos + acciones + tarjeta para compartir
// ----------------------------------------------------------------------------------------------------
function GridDetail({ botId }) {
  const detail = useQuery(api.spotGridBots.getSpotGridDetail, { botId })
  const pauseBot = useMutation(api.spotGridBots.pauseSpotGridBot)
  const stopBot = useAction(api.spotGridEngine.stopSpotGridBot)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [, forceTick] = React.useReducer((x) => x + 1, 0)

  // Re-render por minuto para que la duración avance sin recargar.
  React.useEffect(() => {
    const t = setInterval(forceTick, 60000)
    return () => clearInterval(t)
  }, [])

  if (detail === undefined) return <p className="sg-muted">Cargando…</p>
  if (detail === null) return <p className="sg-muted">Grid no encontrado o sin acceso.</p>

  const { bot, stats, openOrders, openOrdersTruncated, recentCycles } = detail

  async function onPause() {
    setBusy('pause'); setError(null)
    try { await pauseBot({ botId }) } catch (e) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }
  async function onStop() {
    if (!window.confirm('Detener el grid CANCELA todas sus órdenes reales en Hyperliquid. ¿Continuar?')) return
    setBusy('stop'); setError(null)
    try { await stopBot({ botId, expectedNetwork: HL_NETWORK }) }
    catch (e) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }

  return (
    <div className="sg-panel">
      <div className="sg-detail-head">
        <h1>{bot.symbol}/{bot.quoteAsset} · Spot Grid Infinity</h1>
        <span className={`sg-pill sg-${bot.status}`}>{STATUS_LABEL[bot.status] ?? bot.status}</span>
        <button className="sg-ghost" onClick={() => setShareOpen(true)}>Compartir</button>
      </div>
      {bot.status === 'error' && bot.errorMessage && <p className="sg-error">⚠ {bot.errorMessage}</p>}

      <div className="sg-kpis">
        <Kpi label="Ganancias totales" val={usd(stats.totalNetProfit)} accent={stats.totalNetProfit > 0}
          sub={stats.truncated ? `parcial (≥${stats.cycleCap} ciclos)` : 'profit neto cerrado'} />
        <Kpi label="Arbitrajes" val={stats.truncated ? `≥${stats.cycleCap}` : String(stats.cyclesCount)}
          sub={stats.truncated ? 'tope de lectura alcanzado' : 'ciclos cerrados'} />
        <Kpi label="Duración" val={durationText(bot.createdAt)} sub="desde la creación" />
        <Kpi label="Inversión" val={usd(bot.investmentAmount)} sub={`${bot.gridCount} niveles · ${bot.gridProfitPercent}%`} />
      </div>

      <div className="sg-actions">
        {error && <p className="sg-error">{error}</p>}
        <button className="sg-ghost" disabled={bot.status !== 'running' || !!busy} onClick={onPause}>
          {busy === 'pause' ? '…' : 'Pausar'}
        </button>
        <button className="sg-danger" disabled={bot.status === 'stopped' || !!busy} onClick={onStop}>
          {busy === 'stop' ? '…' : 'Detener'}
        </button>
        <small className="sg-muted">Pausar NO cancela las órdenes vivas; detener sí.</small>
      </div>

      <div className="sg-section">
        <h2>ÓRDENES ABIERTAS {openOrdersTruncated ? `(${openOrders.length}+)` : `(${openOrders.length})`}</h2>
        {openOrders.length === 0 && <p className="sg-muted">Sin órdenes vivas.</p>}
        {openOrders.length > 0 && (
          <table className="sg-table">
            <thead><tr><th>Lado</th><th>Nivel</th><th>Precio</th><th>Cantidad</th><th>Llenado</th><th>Estado</th></tr></thead>
            <tbody>
              {openOrders.map((o, i) => (
                <tr key={i}>
                  <td className={o.side === 'buy' ? 'sg-buy' : 'sg-sell'}>{o.side === 'buy' ? 'COMPRA' : 'VENTA'}</td>
                  <td>{o.gridLevel}</td>
                  <td>{usd(o.price)}</td>
                  <td>{o.quantity}</td>
                  <td>{o.filledQty ?? '—'}</td>
                  <td>{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="sg-section">
        <h2>CICLOS RECIENTES</h2>
        {recentCycles.length === 0 && <p className="sg-muted">Aún no se ha cerrado ningún ciclo.</p>}
        {recentCycles.length > 0 && (
          <table className="sg-table">
            <thead><tr><th>#</th><th>Compra</th><th>Venta</th><th>Cantidad</th><th>Profit neto</th><th>Cerrado</th></tr></thead>
            <tbody>
              {recentCycles.map((c) => (
                <tr key={`${c.cycleId}-${c.sellOrderId ?? c.closedAt ?? ''}`}>
                  <td>{c.cycleId}</td>
                  <td>{usd(c.buyPrice)}</td>
                  <td>{c.sellPrice != null ? usd(c.sellPrice) : '—'}</td>
                  <td>{c.quantity}</td>
                  <td className={c.netProfit > 0 ? 'sg-buy' : ''}>{usd(c.netProfit)}</td>
                  <td>{c.closedAt ? new Date(c.closedAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {shareOpen && (
        <SpotGridShareCard bot={bot} stats={stats} onClose={() => setShareOpen(false)} />
      )}
    </div>
  )
}

function Kpi({ label, val, sub, accent }) {
  return (
    <div className="sg-kpi">
      <div className="sg-kpi-label">{label}</div>
      <div className={`sg-kpi-val ${accent ? 'accent' : ''}`}>{val}</div>
      {sub && <div className="sg-kpi-sub">{sub}</div>}
    </div>
  )
}

// ----------------------------------------------------------------------------------------------------
// Tarjeta para compartir (estilo BingX). CANVAS PROPIO, sin dependencia nueva. (Codex MEDIO#3 + BAJO)
// Descarga: intenta clipboard si existe; SIEMPRE ofrece fallback PNG con toBlob + <a download>.
// Nunca dibuja datos sensibles (ni cuenta ni claves).
// ----------------------------------------------------------------------------------------------------
function SpotGridShareCard({ bot, stats, onClose }) {
  const canvasRef = React.useRef(null)
  const [msg, setMsg] = React.useState(null)
  const W = 600, H = 360

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const { d, h, m } = durationParts(bot.createdAt)
    const profit = Number(stats.totalNetProfit) || 0

    // Fondo degradado (paleta del portal: --bg → --panel, modo oscuro).
    const g = ctx.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, '#050505'); g.addColorStop(1, '#101010')
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)

    // Borde sutil (--green tenue).
    ctx.strokeStyle = 'rgba(0,200,5,0.35)'; ctx.lineWidth = 2
    ctx.strokeRect(8, 8, W - 16, H - 16)

    // Branding.
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 26px system-ui, sans-serif'
    ctx.fillText('Quantum.ia', 36, 56)
    ctx.fillStyle = '#00c805'; ctx.font = '15px system-ui, sans-serif'
    ctx.fillText(`${bot.symbol}/${bot.quoteAsset} · Spot Grid Infinity`, 36, 82)

    // Ganancias totales (héroe).
    ctx.fillStyle = '#b7bdb9'; ctx.font = '14px system-ui, sans-serif'
    ctx.fillText('Ganancias totales', 36, 150)
    ctx.fillStyle = profit >= 0 ? '#00c805' : '#ff5000'
    ctx.font = 'bold 56px system-ui, sans-serif'
    const profitTxt = (profit >= 0 ? '+' : '-') + '$' + Math.abs(profit).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    ctx.fillText(profitTxt, 36, 206)
    if (stats.truncated) {
      ctx.fillStyle = '#b7bdb9'; ctx.font = '12px system-ui, sans-serif'
      ctx.fillText(`(parcial, ≥${stats.cycleCap} ciclos)`, 36, 228)
    }

    // Métricas inferiores.
    function metric(x, label, value) {
      ctx.fillStyle = '#b7bdb9'; ctx.font = '13px system-ui, sans-serif'
      ctx.fillText(label, x, 290)
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px system-ui, sans-serif'
      ctx.fillText(value, x, 316)
    }
    metric(36, 'Duración', `${d}d ${h}h ${m}m`)
    const pairedTxt = stats.truncated ? `≥${stats.cycleCap}` : String(stats.cyclesCount)
    metric(260, 'Órdenes emparejadas', pairedTxt)

    ctx.fillStyle = '#747a76'; ctx.font = '12px system-ui, sans-serif'
    ctx.fillText('quantum.ia', W - 120, H - 28)
  }, [bot, stats])

  React.useEffect(() => { draw() }, [draw])

  function toBlob() {
    return new Promise((resolve) => canvasRef.current?.toBlob(resolve, 'image/png'))
  }
  function downloadPng(blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `quantum-spot-grid-${bot.symbol}.png`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function onShare() {
    setMsg(null)
    const blob = await toBlob()
    if (!blob) { setMsg('No se pudo generar la imagen.'); return }
    // Intenta copiar al portapapeles; SIEMPRE cae a descarga PNG si no existe/falla.
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
        setMsg('Imagen copiada al portapapeles.')
        return
      }
    } catch (_) { /* fallback */ }
    downloadPng(blob)
    setMsg('Imagen descargada.')
  }
  async function onDownload() {
    const blob = await toBlob()
    if (blob) downloadPng(blob)
  }

  return (
    <div className="sg-modal-bg" onClick={onClose}>
      <div className="sg-modal sg-share" onClick={(e) => e.stopPropagation()}>
        <h2>Compartir grid</h2>
        <canvas ref={canvasRef} width={W} height={H} className="sg-canvas" />
        {msg && <p className="sg-muted">{msg}</p>}
        <div className="sg-modal-actions">
          <button className="sg-ghost" onClick={onClose}>Cerrar</button>
          <button className="sg-ghost" onClick={onDownload}>Descargar PNG</button>
          <button className="sg-primary" onClick={onShare}>Copiar / compartir</button>
        </div>
      </div>
    </div>
  )
}

// Estilos scoped (paleta del portal). Autocontenido, como AdminStyles.
function SpotGridStyles() {
  return (
    <style>{`
      .sg-wrap { max-width: 1100px; margin: 0 auto; padding: 16px; color: var(--text); }
      .sg-top { display: flex; align-items: center; gap: 16px; padding: 10px 0 18px; border-bottom: 1px solid var(--line); }
      .sg-brand { font-size: 18px; }
      .sg-tabs { display: flex; gap: 10px; margin-left: auto; }
      .sg-tab { color: var(--muted); text-decoration: none; font-size: 14px; }
      .sg-tab.active { color: var(--green); }
      .sg-pill { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: color-mix(in srgb, var(--text) 6%, transparent); }
      .sg-pill.green, .sg-pill.sg-running { color: var(--green); }
      .sg-pill.amber, .sg-pill.sg-paused { color: var(--amber); }
      .sg-pill.sg-error { color: var(--red); }
      .sg-pill.sg-stopped { color: var(--muted); }
      .sg-grid { display: grid; grid-template-columns: 220px 1fr; gap: 18px; margin-top: 18px; }
      .sg-side { display: flex; flex-direction: column; gap: 6px; }
      .sg-shead h2 { font-size: 12px; letter-spacing: .08em; color: var(--muted); margin: 0 0 6px; }
      .sg-listitem { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; color: inherit; cursor: pointer; text-align: left; }
      .sg-listitem.active { border-color: color-mix(in srgb, var(--green) 45%, transparent); background: color-mix(in srgb, var(--green) 10%, transparent); }
      .sg-listitem.sg-new { color: var(--green); justify-content: center; }
      .sg-li-pair { font-weight: 600; }
      .sg-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
      .sg-dot.sg-running { background: var(--green); } .sg-dot.sg-paused { background: var(--amber); }
      .sg-dot.sg-error { background: var(--red); } .sg-dot.sg-stopped { background: var(--faint); }
      .sg-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
      .sg-panel h1 { font-size: 22px; margin: 0 0 6px; }
      .sg-muted { color: var(--muted); font-size: 13px; }
      .sg-form { display: flex; flex-direction: column; gap: 12px; max-width: 420px; margin-top: 14px; }
      .sg-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
      .sg-field input, .sg-field select { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; color: var(--text); font-size: 14px; }
      .sg-seg { display: flex; gap: 6px; }
      .sg-seg button { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); cursor: pointer; }
      .sg-seg button.on { border-color: var(--green); color: var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
      .sg-adv { display: flex; flex-direction: column; gap: 12px; border-left: 2px solid var(--line); padding-left: 12px; }
      .sg-link { background: none; border: none; color: var(--green); cursor: pointer; text-align: left; padding: 0; font-size: 13px; }
      .sg-primary { background: var(--green); color: #050505; border: none; border-radius: 9px; padding: 11px 16px; font-weight: 700; cursor: pointer; }
      .sg-primary:disabled { opacity: .5; cursor: default; }
      .sg-ghost { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); border: 1px solid var(--line); border-radius: 9px; padding: 9px 14px; cursor: pointer; }
      .sg-danger { background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 40%, transparent); border-radius: 9px; padding: 9px 14px; cursor: pointer; }
      .sg-danger:disabled, .sg-ghost:disabled { opacity: .5; cursor: default; }
      .sg-error { color: var(--red); font-size: 13px; }
      .sg-warn { color: var(--amber); font-size: 12px; }
      .sg-detail-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .sg-detail-head h1 { margin: 0; }
      .sg-detail-head .sg-ghost { margin-left: auto; }
      .sg-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 18px 0; }
      .sg-kpi { background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
      .sg-kpi-label { font-size: 12px; color: var(--muted); }
      .sg-kpi-val { font-size: 24px; font-weight: 700; margin: 4px 0; }
      .sg-kpi-val.accent { color: var(--green); }
      .sg-kpi-sub { font-size: 11px; color: var(--muted); }
      .sg-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
      .sg-section { margin-top: 22px; }
      .sg-section h2 { font-size: 12px; letter-spacing: .08em; color: var(--muted); }
      .sg-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .sg-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
      .sg-table td { padding: 7px 8px; border-bottom: 1px solid var(--line); }
      .sg-buy { color: var(--green); } .sg-sell { color: var(--red); }
      .sg-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
      .sg-modal { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 22px; max-width: 480px; }
      .sg-modal.sg-share { max-width: 640px; }
      .sg-modal h2 { margin: 0 0 12px; }
      .sg-modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
      .sg-canvas { width: 100%; max-width: 600px; border-radius: 10px; display: block; }
      @media (max-width: 760px) {
        .sg-grid { grid-template-columns: 1fr; }
        .sg-kpis { grid-template-columns: repeat(2, 1fr); }
      }
    `}</style>
  )
}
