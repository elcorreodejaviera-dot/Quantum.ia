import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery, useMutation, usePaginatedQuery, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { auditUserPools, hlCoin } from '../lib/poolAudit';
import { ExecutionsObservabilityPanel } from './BotPortal';   // (panel-admin-dedup) movido aquí desde el panel inline

// (JAV-80) Pestaña de Administración: KPIs del sistema + usuarios (con desglose por posición) +
// flujo de actividad + gestión de bugs. Solo admin. Reutiliza la paleta del portal (var(--green)…).

function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';   // (JAV-85 #10a) signo ANTES del $: "-$1.5k", no "$-1.5k"
  if (a >= 1_000_000) return sign + '$' + (a / 1_000_000).toFixed(a >= 100_000_000 ? 0 : 1) + 'M';
  if (a >= 1000) return sign + '$' + (a / 1000).toFixed(a >= 100_000 ? 0 : 1) + 'k';
  return sign + '$' + a.toFixed(0);
}
// (JAV-85 #6) baseAsset del bot ↔ símbolo de coin en HL: `hlCoin` se importa de src/lib/poolAudit
// (fuente única; antes estaba duplicado aquí).
// "$ monitoreado" con señal de datos incompletos (nulls): nunca presenta un número como si fuera completo.
// known = cuántos pools aportaron dato; si NINGUNO lo aportó (known===0) y hay incompletos → "—", nunca "$0".
function usdWithUnknown(n, unknown = 0, known = undefined) {
  if (known === 0 && unknown > 0) return `— (${unknown} incompletos)`;
  const base = usd(n);
  if (unknown > 0) return base === '—' ? `— (${unknown} incompletos)` : `${base} (+${unknown})`;
  return base;
}
// Uniswap v3 muestra la posición por tokenId + cadena. Si falta el dato, sin enlace.
const UNI_CHAIN = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism' };
function poolLink(network, tokenId) {
  if (tokenId == null || !network) return null;
  const chain = UNI_CHAIN[String(network).toLowerCase()];
  if (!chain) return null;
  return `https://app.uniswap.org/positions/v3/${chain}/${tokenId}`;
}
// feeTier guardado en unidades crudas de Uniswap (500/3000/10000). Mismo formato que BotPortal: /10000.
function feeTierPct(ft) {
  return typeof ft === 'number' ? `${(ft / 10000).toFixed(2)}%` : null;
}
// Precio legible para el rango: 2 decimales (1636.04), y más dígitos solo si el valor es < 1 (tokens baratos).
function fmtPrice(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  return a >= 1 ? n.toFixed(2) : Number(n.toPrecision(4)).toString();
}
// Sub del KPI de volumen: % vs 24h previas (null → "trades").
function volumeDeltaSub(d) {
  if (d === null || d === undefined || !Number.isFinite(d)) return 'trades';
  return `${d >= 0 ? '▲ +' : '▼ '}${d.toFixed(0)}% vs 24h`;
}
function timeShort(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

// Tiempo relativo compacto ("hace 12s/4m/2h/3d") para la salud de crons. undefined → "nunca".
function agoShort(ms) {
  if (ms == null) return 'nunca';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)}m`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)}h`;
  return `hace ${Math.floor(s / 86400)}d`;
}

// (OBS-2 → Fase 2) Salud de los crons del motor: una fila por cron (last success/error, fallos
// consecutivos, duración). Read-only, admin-gated por la query (requireAdmin). Cierra el cabo suelto
// de OBS-2 (listCronHealth existía sin UI). NO muestra nada sensible (la query ya devuelve escalares).
function CronHealthPanel({ rows }) {
  if (rows === undefined) return <div className="faint" style={{ padding: 12 }}>Cargando…</div>;
  if (rows.length === 0) return <div className="faint" style={{ padding: 12 }}>Sin datos de crons todavía.</div>;
  // Orden estable por nombre; los que están fallando primero para que salten a la vista.
  const sorted = [...rows].sort((a, b) => {
    const fa = (a.consecutiveFailures ?? 0) > 0, fb = (b.consecutiveFailures ?? 0) > 0;
    if (fa !== fb) return fa ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  return (
    <>
      {sorted.map((c) => {
        const fails = c.consecutiveFailures ?? 0;
        const ok = c.lastSuccessAt ?? 0;
        const state = fails > 0 ? 'red' : (ok === 0 ? 'amber' : 'green');
        const label = fails > 0 ? `${fails} fallo${fails > 1 ? 's' : ''}` : (ok === 0 ? 's/datos' : 'OK');
        return (
          <div className="av-feed" key={c.name}>
            <span className={`av-pill ${state}`} style={{ flex: 'none' }}>● {label}</span>
            <span className="ev"><b>{c.name}</b></span>
            <span className="who2" title="último éxito">{agoShort(c.lastSuccessAt)}</span>
            <span className="t" title="duración última ejecución">{c.lastDurationMs != null ? `${c.lastDurationMs}ms` : '—'}</span>
            {fails > 0 && c.lastError && (
              <span className="faint" style={{ fontSize: 11, flexBasis: '100%' }} title={c.lastError}>↳ {c.lastError}</span>
            )}
          </div>
        );
      })}
    </>
  );
}

function PositionCard({ pos, live, liveLoading, pnl, hlAccount, coverageLive, hlPosition }) {
  const p = pos.pool;
  const lev = pos.kind === 'il' ? `IL short ${pos.leverage ?? '?'}×` : `${pos.direction ?? ''} ${pos.leverage ?? '?'}×`;
  const ft = feeTierPct(p?.feeTier);
  const sub = p ? `Uniswap v3${ft ? ` · ${ft}` : ''} · ${p.network}` : 'sin pool';
  const link = p ? poolLink(p.network, p.tokenId) : null;
  // Liquidez LP: en vivo (actual) si está, si no la inicial cacheada. Fees: s/cobrar en vivo, si no 1d.
  const hasLiveLiq = live && live.liquidityUsd != null;
  const liqLabel = hasLiveLiq ? 'Liquidez LP' : 'Liquidez LP (inicial)';
  const liqVal = hasLiveLiq ? usd(live.liquidityUsd) : (liveLoading ? '…' : usd(p?.initialLiquidityUsd));
  const feesLabel = live ? 'Fees s/cobrar' : 'Fees 1d';
  const feesVal = live ? (live.feesUncollectedUsd != null ? usd(live.feesUncollectedUsd) : '—') : usd(p?.fees1d);
  // Cobertura (cap): nocional REAL de la posición HL en vivo; fallback al campo del bot (suele ser null).
  const coverageVal = coverageLive != null ? usd(coverageLive)
    : (pos.hedgeNotionalUsd != null ? usd(pos.hedgeNotionalUsd) : (liveLoading ? '…' : '—'));
  // (Fase 4) Revert.finance: live.revertLtv es LTV% (no multiplicador). lev derivado = 1/(1−LTV/100), guarda 0<LTV<100.
  // Distinción (con revertVaultActive/revertLoanKnown): en vault con deuda / en vault sin deuda / en vault
  // deuda no fiable / LP spot (no en vault) / desconocido. Un LTV 0 ya NO significa siempre "LP spot".
  const ltv = live?.revertLtv;
  const bh = live?.borrowHealth;
  const vaultActive = live?.revertVaultActive === true;
  const loanKnown = live?.revertLoanKnown === true;
  const healthCls = bh == null ? '' : bh >= 50 ? 'av-pos-pnl' : bh >= 20 ? 'av-amber' : 'av-neg-pnl';
  let revertTag;
  if (ltv != null && ltv > 0) {
    const lev = ltv < 100 ? 1 / (1 - ltv / 100) : null;
    revertTag = (
      <span className="av-tag revert">⚡ Revert · {lev ? `${lev.toFixed(1)}× · ` : ''}LTV {ltv.toFixed(1)}%
        {bh != null && <> · salud <b className={healthCls}>{bh}%</b></>}</span>
    );
  } else if (vaultActive && !loanKnown) {
    revertTag = <span className="av-tag revert">En Revert · deuda: —</span>;
  } else if (ltv === 0 && vaultActive && loanKnown) {
    revertTag = <span className="av-tag revert">En Revert · sin deuda</span>;
  } else if (ltv === 0 && !vaultActive) {
    revertTag = <span className="av-tag norevert">Sin apalancar (LP spot)</span>;
  } else {
    revertTag = <span className="av-tag norevert">Revert: {liveLoading ? '…' : '—'}</span>;
  }
  // (JAV-114) Posición HL real + cobertura vs exposición del LP (misma base que el audit hedge_vs_exposure).
  const hedgeNotional = hlPosition?.notional ?? coverageLive;
  const lpExposure = live?.liquidityUsd ?? null;
  const covRatio = (hedgeNotional != null && lpExposure != null && lpExposure > 0) ? hedgeNotional / lpExposure : null;
  const covCls = covRatio == null ? '' : Math.abs(covRatio - 1) <= 0.25 ? 'av-pos-pnl' : 'av-amber';
  const sym = pos.baseAsset ?? '';
  return (
    <div className="av-pos">
      <div className="av-pos-top">
        <div className="av-nft"><span>UNI<br />v3</span></div>
        <div className="av-pos-title">{p ? p.pair : '—'}
          <small>{sub}</small></div>
        {p?.tokenId != null && <span className="av-nftid">NFT #{p.tokenId}</span>}
        {link && <a className="av-link" href={link} target="_blank" rel="noreferrer">↗ ver</a>}
        {live?.inRange === true && <span className="av-range in">in range</span>}
        {live?.inRange === false && <span className="av-range out">out of range</span>}
      </div>
      <div className="av-pos-grid">
        <div className="av-cell"><div className="k">{liqLabel}</div><div className="vv">{liqVal}</div></div>
        <div className="av-cell"><div className="k">Rango</div><div className="vv">{p ? `${fmtPrice(p.minRange)} – ${fmtPrice(p.maxRange)}` : '—'}</div></div>
        <div className="av-cell"><div className="k">{feesLabel}</div><div className="vv">{feesVal}</div></div>
        <div className="av-cell"><div className="k">Cobertura (cap)</div><div className="vv">{coverageVal}</div></div>
      </div>
      <div className="av-pos-foot">
        {revertTag}
        <span className="av-tag il">Cobertura HL: {lev}</span>
        {pos.armStatus && <span className="av-tag ok">{pos.armStatus}</span>}
        {hlAccount && <span className="av-tag">Cuenta HL {hlAccount.addressMasked} · colateral {usd(hlAccount.collateralUsd)}</span>}
        {pnl != null && <span className="av-pnl" style={{ marginLeft: 'auto' }}>PnL hedge <b className={pnl >= 0 ? 'av-pos-pnl' : 'av-neg-pnl'}>{pnl >= 0 ? '+' : ''}{usd(pnl)}</b></span>}
      </div>
      {hlPosition ? (
        <div className="av-pos-foot">
          <span className="av-tag">Posición HL: <b>{hlPosition.szi > 0 ? '+' : '−'}{Math.abs(hlPosition.szi).toLocaleString('en-US', { maximumFractionDigits: 4 })} {sym}</b>
            {hlPosition.entryPx != null && <> @ {fmtPrice(hlPosition.entryPx)}</>}
            {hlPosition.liqPx != null && <> · liq {fmtPrice(hlPosition.liqPx)}</>}
            {hlPosition.leverage != null && <> · {hlPosition.leverage}×</>}</span>
          {covRatio != null && (
            <span className="av-tag">Hedge {usd(hedgeNotional)} vs Exposición LP {usd(lpExposure)} = <b className={covCls}>{covRatio.toFixed(2)}×</b></span>
          )}
        </div>
      ) : (live && !liveLoading && (
        <div className="av-pos-foot"><span className="av-tag faint">Sin posición HL abierta para {sym || 'el activo'}</span></div>
      ))}
    </div>
  );
}

// Caché cliente del snapshot en vivo (TTL): re-expandir dentro de la ventana NO re-dispara la acción.
const LIVE_TTL_MS = 30_000;
const liveCache = new Map();

function UserRow({ u }) {
  const [open, setOpen] = React.useState(false);
  const detail = useQuery(api.admin.getUserDetail, open ? { userId: u.userId } : 'skip');
  // (Fase 6-C) Datos de DB para la auditoría de pool (arms/órdenes/pool/bot del usuario auditado).
  const audit = useQuery(api.admin.getUserPoolAuditData, open ? { userId: u.userId } : 'skip');
  // (Fase 2) snapshot EN VIVO (poolScanner + HL Info), bajo demanda al expandir. try/catch → "—", nunca
  // tumba la vista; TTL evita refetch; topes/secuencial en el backend.
  const runLive = useAction(api.adminLive.getUserAdminLiveSnapshot);
  const [live, setLive] = React.useState(null);
  const [liveLoading, setLiveLoading] = React.useState(false);
  React.useEffect(() => {
    if (!open) return undefined;
    const cached = liveCache.get(u.userId);
    if (cached && Date.now() - cached.at < LIVE_TTL_MS) { setLive(cached.data); return undefined; }
    let cancelled = false;
    setLiveLoading(true);
    (async () => {
      try {
        const snap = await runLive({ userId: u.userId });
        if (cancelled) return;
        liveCache.set(u.userId, { at: Date.now(), data: snap });
        setLive(snap);
      } catch {
        if (!cancelled) setLive(null);
      } finally {
        if (!cancelled) setLiveLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, u.userId, runLive]);
  const pct = u.plan && u.plan.cap > 0 && detail?.coverageUsed != null
    ? Math.min(100, (detail.coverageUsed / u.plan.cap) * 100) : 0;
  const statusEl = u.role === 'admin'
    ? <span className="av-st admin">● admin</span>
    : u.suspended ? <span className="av-st block">suspendido</span>
    : u.plan ? <span className="av-st on">● activo</span>
    : <span className="av-st block">◌ sin plan</span>;
  return (
    <div className={`av-urow${open ? ' open' : ''}`}>
      <div className="av-main" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}>
        <div className="av-uname"><span className="av-chev">▶</span>{u.email ?? u.name ?? u.userId.slice(0, 8)}
          {u.hasHlAccount && <span className="av-hl" title="Cuenta HL conectada">HL✓</span>}</div>
        <div className="av-plan">{u.role === 'admin' ? 'Admin · ∞' : u.plan ? `${u.plan.label} · ${usd(u.plan.cap)}` : 'Sin plan'}</div>
        <div className="av-cov">
          {u.plan ? (<><div className="av-bar"><i style={{ width: `${pct}%` }} /></div>
            <small>{detail ? usd(detail.coverageUsed) : '…'} / {usd(u.plan.cap)}</small></>) : <small className="faint">—</small>}
        </div>
        <div className="num">{u.activeBots}</div>
        <div className="num muted" title="Liquidez LP inicial (cacheada) de pools con bot activo">
          {usdWithUnknown(u.monitoredInitialUsd, u.unknownLiquidityCount ?? 0, u.knownLiquidityCount)}</div>
        <div>{statusEl}</div>
      </div>
      {open && (
        <div className="av-detail">
          {detail === undefined && <div className="faint" style={{ padding: 8 }}>Cargando…</div>}
          {detail && detail.positions.length === 0 && <div className="faint" style={{ padding: 8 }}>Sin bots activos.</div>}
          {detail && detail.positions.map((pos) => {
            const lp = live?.positions?.[pos.botId] ?? null;
            const acctPnl = (live && pos.hlAccountId && live.pnlByAccountCoin)
              ? live.pnlByAccountCoin[pos.hlAccountId] : null;
            const coin = hlCoin(pos.baseAsset);
            const pnl = (acctPnl && coin && acctPnl[coin] != null)
              ? acctPnl[coin] : null;
            const acctCov = (live && pos.hlAccountId && live.coverageByAccountCoin)
              ? live.coverageByAccountCoin[pos.hlAccountId] : null;
            const coverageLive = (acctCov && coin && acctCov[coin] != null)
              ? acctCov[coin] : null;
            const hlAccount = (live && pos.hlAccountId && live.hlAccounts)
              ? (live.hlAccounts.find((a) => a.id === pos.hlAccountId) ?? null) : null;
            // (JAV-114) Detalle de la posición HL real (tamaño/entry/liq/lev) para verla en la tarjeta.
            const acctPos = (live && pos.hlAccountId && live.positionByAccountCoin)
              ? live.positionByAccountCoin[pos.hlAccountId] : null;
            const hlPosition = (acctPos && coin && acctPos[coin] != null) ? acctPos[coin] : null;
            return <PositionCard key={pos.botId} pos={pos} live={lp} liveLoading={liveLoading} pnl={pnl} hlAccount={hlAccount} coverageLive={coverageLive} hlPosition={hlPosition} />;
          })}
          <PoolAuditPanel audit={audit} live={live} />
        </div>
      )}
    </div>
  );
}

// (Fase 6-C) Auditoría de pool: cruza la data de DB (getUserPoolAuditData) con el snapshot live y
// muestra ✅/⚠️/«sin datos» + las inconsistencias por bot. Read-only; la lógica vive en src/lib/poolAudit.
function PoolAuditPanel({ audit, live }) {
  if (audit === undefined) return null;
  // Derivar `live` por bot del snapshot (liquidez/inRange/hedge). present = el pool estaba en el snapshot
  // (adminLive omite pools cerrados/sin tokenId → ese caso lo cubren los checks DB-only).
  const liveByBot = {};
  for (const b of audit) {
    const coin = b.baseAsset ? hlCoin(b.baseAsset) : null;
    const cov = (live && b.hlAccountId && live.coverageByAccountCoin) ? live.coverageByAccountCoin[b.hlAccountId] : null;
    liveByBot[b.botId] = {
      // (JAV-99) Fallback al LP persistido (initialLiquidityUsd) cuando la lectura LIVE de liquidez no
      // llega — igual que la tarjeta — para que hedge_vs_exposure compare en vez de decir "sin datos".
      liquidityUsd: live?.positions?.[b.botId]?.liquidityUsd ?? b.pool?.initialLiquidityUsd ?? null,
      inRange: live?.positions?.[b.botId]?.inRange ?? null,
      coverageUsd: (cov && coin && cov[coin] != null) ? cov[coin] : null,
      present: !!live?.positions?.[b.botId],
    };
  }
  const results = auditUserPools(audit, liveByBot, live?.network ?? null).filter((r) => r.findings.length > 0);
  return (
    <div className="av-audit">
      <div className="av-audit-head">AUDITORÍA DE POOLS
        <span className={`av-pill ${results.some((r) => r.verdict === 'warn') ? 'red' : results.length ? 'amber' : 'green'}`}>
          {results.some((r) => r.verdict === 'warn') ? '● inconsistencias' : results.length ? '● revisar' : '● todo coherente'}
        </span>
      </div>
      {results.length === 0 && <div className="faint" style={{ fontSize: 12 }}>Sin inconsistencias detectadas.</div>}
      {results.map((r) => (
        <div className="av-audit-row" key={r.botId}>
          <span className={`av-pill ${r.verdict === 'warn' ? 'red' : 'amber'}`} style={{ flex: 'none' }}>
            {r.verdict === 'warn' ? '⚠' : '?'}
          </span>
          <div>
            <b style={{ fontSize: 12 }}>{r.pair ?? r.botId.slice(0, 8)}</b>
            {r.findings.map((fd, i) => <div key={i} className="faint" style={{ fontSize: 11.5 }}>↳ {fd.msg}</div>)}
          </div>
        </div>
      ))}
    </div>
  );
}

// (Fase 3) Fila de control de UN usuario: toggles de permiso, selector de plan y suspender/reactivar.
// Reutiliza mutations ya auditadas; admins no son asignables (backend lo bloquea) → fila informativa.
function UserControlRow({ u, plans }) {
  const grantManage = useMutation(api.users.grantManageBots);
  const revokeManage = useMutation(api.users.revokeManageBots);
  const grantLive = useMutation(api.users.grantTradeLive);
  const revokeLive = useMutation(api.users.revokeTradeLive);
  const setPlan = useMutation(api.subscriptions.setSubscriptionPlan);
  const setSuspended = useMutation(api.subscriptions.setUserSuspended);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const run = (fn) => async (arg) => {
    setBusy(true); setErr('');
    try { await fn(arg); } catch (e) { setErr(e?.message ?? 'Error'); } finally { setBusy(false); }
  };
  const name = u.email ?? u.name ?? u.userId.slice(0, 8);
  if (u.role === 'admin') {
    return (
      <div className="av-ctl">
        <span className="av-ctl-name">{name}</span>
        <span className="faint" style={{ gridColumn: '2 / -1', fontSize: 12 }}>Admin · ∞ — sin controles (no asignable)</span>
      </div>
    );
  }
  return (
    <div className="av-ctl">
      <span className="av-ctl-name">{name}</span>
      <button className={`av-tgl ${u.canManageBots ? 'on' : 'off'}`} disabled={busy}
        onClick={() => run(u.canManageBots ? revokeManage : grantManage)({ userId: u.userId })}>Manage</button>
      <button className={`av-tgl ${u.canTradeLive ? 'on' : 'off'}`} disabled={busy}
        onClick={() => run(u.canTradeLive ? revokeLive : grantLive)({ userId: u.userId })}>Live</button>
      <select className="av-mini" disabled={busy} value={u.plan?.id ?? ''}
        onChange={(e) => run((a) => setPlan(a))({ userId: u.userId, plan: e.target.value || null })}>
        <option value="">Sin plan</option>
        {(plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <button className="av-mini" disabled={busy}
        onClick={() => run(() => setSuspended({ userId: u.userId, suspended: !u.suspended }))()}>
        {u.suspended ? 'Reactivar' : 'Suspender'}</button>
      {err && <span className="av-ctl-err" title={err}>⚠</span>}
    </div>
  );
}

export default function AdminView() {
  const me = useQuery(api.users.getUser, {});
  // (CodeRabbit) Gatear las queries admin con 'skip' hasta confirmar rol admin: un no-admin NO debe
  // disparar consultas admin (que el servidor rechazaría con Forbidden) antes del redirect.
  const isAdmin = me?.role === 'admin';
  const stats = useQuery(api.admin.getSystemStats, isAdmin ? {} : 'skip');
  const activity = useQuery(api.admin.listActivity, isAdmin ? { limit: 40 } : 'skip');
  const users = usePaginatedQuery(api.admin.listUsersOverview, isAdmin ? {} : 'skip', { initialNumItems: 25 });
  const [bugFilter, setBugFilter] = React.useState('');
  const bugs = usePaginatedQuery(api.bugReports.listBugReports,
    isAdmin ? (bugFilter ? { status: bugFilter } : {}) : 'skip', { initialNumItems: 20 });
  const bugCounts = useQuery(api.bugReports.countBugReportsByStatus, isAdmin ? {} : 'skip');
  const setBugStatus = useMutation(api.bugReports.setBugStatus);
  // (Fase 3) Búsqueda + filtro de usuarios (cliente, sobre la página cargada) y catálogo de planes.
  const [userQ, setUserQ] = React.useState('');
  const [userFilter, setUserFilter] = React.useState('all');
  const plans = useQuery(api.subscriptions.listPlans, isAdmin ? {} : 'skip');
  // (OBS-2 → Fase 2) Salud de los crons del motor (read-only). La query ya es admin-gated.
  const cronHealth = useQuery(api.cronHealth.listCronHealth, isAdmin ? {} : 'skip');

  // (quitar-simulacion B1) Producto solo-real: sin controles de simulación. El kill-switch global es `tradingEnabled`.
  const tradingConfig = useQuery(api.systemConfig.getConfig, { key: 'tradingEnabled' });
  const setTrading = useMutation(api.systemConfig.setTradingEnabled);
  const sgGate = useQuery(api.spotGridBots.getMainnetSpotGridApproval, isAdmin ? {} : 'skip');
  const setSgGate = useMutation(api.spotGridBots.setMainnetSpotGridApproval);
  const sgGateOn = sgGate?.enabled === true;
  const [sgGatePending, setSgGatePending] = React.useState(false);
  // (JAV-107) Gate de aprobación mainnet del bot de Defensa Spot (espejo del de Spot Grid). CERRADO por
  // defecto: sin esto, ningún bot de defensa opera en mainnet (assertSpotDefenseLiveAdmissible lo exige).
  const sdGate = useQuery(api.spotDefenseBots.getMainnetSpotDefenseApproval, isAdmin ? {} : 'skip');
  const setSdGate = useMutation(api.spotDefenseBots.setMainnetSpotDefenseApproval);
  const sdGateOn = sdGate?.enabled === true;
  const [sdGatePending, setSdGatePending] = React.useState(false);
  // (JAV-94) Feature flag GLOBAL del módulo Spot Grid (testnet+mainnet). Ausente = encendido.
  const sgModule = useQuery(api.spotGridBots.getSpotGridModuleEnabled, isAdmin ? {} : 'skip');
  const setSgModule = useMutation(api.spotGridBots.setSpotGridModuleEnabled);
  const sgModuleOn = sgModule?.enabled !== false;
  const [sgModulePending, setSgModulePending] = React.useState(false);
  const tradingOn = tradingConfig?.value === true;

  if (me === undefined) return <div className="av-wrap"><p className="faint">Cargando…</p></div>;
  if (!me || me.role !== 'admin') return <Navigate to="/dashboard" replace />;

  // Filtro/búsqueda cliente sobre la página cargada (beta; sin re-query). Afecta tabla y controles.
  const visibleUsers = users.results.filter((u) => {
    const hay = (u.email || u.name || '').toLowerCase();
    const okQ = !userQ || hay.includes(userQ.toLowerCase());
    // "activos" = mismo criterio que el estado visual "● activo" de la fila: no-admin, no suspendido y con plan.
    const okF = userFilter === 'all'
      || (userFilter === 'active' && u.role !== 'admin' && !u.suspended && !!u.plan)
      || (userFilter === 'noplan' && !u.plan && u.role !== 'admin')
      || (userFilter === 'suspended' && u.suspended);
    return okQ && okF;
  });

  return (
    <div className="av-wrap">
      <AdminStyles />
      <div className="av-top">
        <div className="av-brand"><b>Quantum</b>.ia</div>
        <div className="av-tabs">
          <Link to="/dashboard" className="av-tab">Portal</Link>
          <span className="av-tab active">Admin ●</span>
        </div>
        <div className="av-who">{me.email ?? 'admin'} <b>(admin)</b></div>
      </div>

      <div className="av-head">
        <h1>Panel de Administración</h1>
        {stats?.network && <span className={`av-pill ${stats.network === 'mainnet' ? 'green' : 'amber'}`}>● {stats.network}</span>}
        <span className={`av-pill ${tradingOn ? 'green' : 'faint'}`}>{tradingOn ? 'Trading LIVE' : 'Trading OFF'}</span>
        <span className={`av-pill ${sgGateOn ? 'green' : 'faint'}`}>{sgGateOn ? 'Spot Grid mainnet ✓' : 'Spot Grid mainnet ✗'}</span>
        <span className={`av-pill ${sdGateOn ? 'green' : 'faint'}`}>{sdGateOn ? 'Defensa Spot mainnet ✓' : 'Defensa Spot mainnet ✗'}</span>
        <span className={`av-pill ${sgModuleOn ? 'green' : 'amber'}`}>{sgModuleOn ? 'Módulo Spot Grid ON' : 'Módulo Spot Grid OFF'}</span>
        <div className="av-actions">
          <button className="av-mini" onClick={() => setTrading({ enabled: !tradingOn })}>{tradingOn ? 'Desactivar LIVE' : 'Activar LIVE'}</button>
          <button
            className="av-mini"
            disabled={sgGatePending}
            onClick={async () => {
              if (sgGatePending) return;
              if (!sgGateOn && !window.confirm('Aprobar Spot Grid en mainnet permite crear bots que operan con DINERO REAL en Hyperliquid. ¿Continuar?')) return;
              setSgGatePending(true);
              try {
                await setSgGate({ enabled: !sgGateOn });
              } finally {
                setSgGatePending(false);
              }
            }}
          >{sgGatePending ? 'Aplicando…' : (sgGateOn ? 'Revocar Spot Grid mainnet' : 'Aprobar Spot Grid mainnet')}</button>
          <button
            className="av-mini"
            disabled={sdGatePending}
            onClick={async () => {
              if (sdGatePending) return;
              if (!sdGateOn && !window.confirm('Aprobar la Defensa Spot en mainnet permite crear bots que abren un SHORT con DINERO REAL en Hyperliquid. ¿Continuar?')) return;
              setSdGatePending(true);
              try {
                await setSdGate({ enabled: !sdGateOn });
              } finally {
                setSdGatePending(false);
              }
            }}
          >{sdGatePending ? 'Aplicando…' : (sdGateOn ? 'Revocar Defensa Spot mainnet' : 'Aprobar Defensa Spot mainnet')}</button>
          <button
            className="av-mini"
            disabled={sgModulePending || sgModule === undefined}
            onClick={async () => {
              if (sgModulePending || sgModule === undefined) return;
              if (sgModuleOn && !window.confirm('Apagar el módulo Spot Grid PAUSA todos los grids (testnet y mainnet) y bloquea crear nuevos. ¿Continuar?')) return;
              setSgModulePending(true);
              try {
                await setSgModule({ enabled: !sgModuleOn });
              } finally {
                setSgModulePending(false);
              }
            }}
          >{sgModulePending ? 'Aplicando…' : (sgModuleOn ? 'Apagar módulo Spot Grid' : 'Encender módulo Spot Grid')}</button>
          <button className="av-kill" onClick={() => setTrading({ enabled: false })}>🛑 DETENER TODO</button>
        </div>
      </div>

      {/* KPIs */}
      <div className="av-kpis">
        <Kpi label="Capital en HL ahora" val={usd(stats?.capitalInHL)} sub="armado + ejecutándose" accent />
        <Kpi label="En movimiento" val={usd(stats?.marginCommitted)} sub="margen comprometido" />
        <Kpi label="TVL en pools (LP)" val={usdWithUnknown(stats?.monitoredInitialUsd, stats?.unknownLiquidityCount ?? 0, stats?.knownLiquidityCount)}
          sub={stats?.unknownLiquidityCount ? `LP inicial · ${stats.unknownLiquidityCount} incompletos` : 'LP inicial · Σ posiciones'} />
        <Kpi label="Volumen 24h" val={usd(stats?.volume24h)} sub={volumeDeltaSub(stats?.volume24hDelta)} />
        <Kpi label="Bots activos" val={stats?.activeBots ?? '—'} sub={`${stats?.activeUsers ?? '–'} / ${stats?.totalUsers ?? '–'} usuarios`} />
      </div>

      {/* Usuarios */}
      <div className="av-section">
        <div className="av-shead"><h2>USUARIOS</h2>
          <input className="av-inp" placeholder="buscar usuario…" value={userQ} onChange={(e) => setUserQ(e.target.value)} />
          <select className="av-mini" value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
            <option value="all">todos</option><option value="active">activos</option>
            <option value="noplan">sin plan</option><option value="suspended">suspendidos</option>
          </select>
        </div>
        <div className="av-uhead">
          <span>Usuario</span><span>Plan</span><span>Cobertura</span><span>Bots</span><span>$ monit.</span><span>Estado</span>
        </div>
        {visibleUsers.map((u) => <UserRow key={u.userId} u={u} />)}
        {visibleUsers.length === 0 && <div className="faint" style={{ padding: 12 }}>Sin usuarios que coincidan.</div>}
        {users.status === 'CanLoadMore' && <button className="av-more" onClick={() => users.loadMore(25)}>Cargar más</button>}
      </div>

      {/* (Fase 3) Controles por usuario: permisos · plan · suspensión (reusa mutations auditadas) */}
      <div className="av-section">
        <div className="av-shead"><h2>CONTROLES POR USUARIO</h2>
          <span className="faint" style={{ fontSize: 11 }}>Manage · Live · plan · suspender — admin only</span></div>
        <div className="av-ctlhead">
          <span>Usuario</span><span>Manage</span><span>Live</span><span>Plan</span><span>Estado</span>
        </div>
        {visibleUsers.map((u) => <UserControlRow key={u.userId} u={u} plans={plans} />)}
        {visibleUsers.length === 0 && <div className="faint" style={{ padding: 12 }}>Sin usuarios que coincidan.</div>}
      </div>

      {/* (OBS-2 → Fase 2) Salud de los crons del motor — "¿está vivo el motor?" */}
      <div className="av-section">
        <div className="av-shead"><h2>SALUD DE LOS CRONS</h2>
          {Array.isArray(cronHealth) && (
            (() => {
              const failing = cronHealth.filter((c) => (c.consecutiveFailures ?? 0) > 0).length;
              return <span className={`av-pill ${failing > 0 ? 'red' : 'green'}`}>
                {failing > 0 ? `● ${failing} con fallos` : '● todos OK'}
              </span>;
            })()
          )}
        </div>
        <CronHealthPanel rows={cronHealth} />
      </div>

      <div className="av-cols">
        {/* Actividad */}
        <div className="av-section">
          <div className="av-shead"><h2>FLUJO DE ACTIVIDAD</h2><span className="av-pill green">● en vivo</span></div>
          {(activity ?? []).map((e, i) => (
            <div className="av-feed" key={i}>
              <span className="t">{timeShort(e.at)}</span>
              <span className="who2">{e.who ?? (e.type === 'admin' ? 'admin' : '—')}</span>
              <span className="ev">{e.text}</span>
            </div>
          ))}
          {activity && activity.length === 0 && <div className="faint" style={{ padding: 12 }}>Sin actividad reciente.</div>}
        </div>

        {/* Bugs */}
        <div className="av-section">
          <div className="av-shead"><h2>🐛 BUGS</h2>
            {bugCounts && <span className="av-pill red">{bugCounts.new}{bugCounts.capped?.new ? '+' : ''} nuevos</span>}
            <select className="av-mini" value={bugFilter} onChange={(e) => setBugFilter(e.target.value)}>
              <option value="">todos</option><option value="new">nuevos</option>
              <option value="in_review">en revisión</option><option value="resolved">resueltos</option>
            </select>
          </div>
          {bugs.results.map((b) => (
            <div className="av-bug" key={b.id}>
              <span className={`av-bst ${b.status}`}>{b.status === 'new' ? 'NUEVO' : b.status === 'in_review' ? 'REVISIÓN' : 'RESUELTO'}</span>
              <div className="av-bugtxt">
                <b>{b.userEmail ?? b.userName ?? '—'}</b> — {b.message}
                {b.attachments.map((a, i) => a.url && <a key={i} className="av-clip" href={a.url} target="_blank" rel="noreferrer"> 📎 ver</a>)}
                <div className="faint" style={{ fontSize: 11 }}>{timeShort(b.createdAt)}{b.context?.url ? ` · ${b.context.url}` : ''}</div>
              </div>
              <div className="av-bugact">
                {b.status !== 'in_review' && <button className="av-mini" onClick={() => setBugStatus({ id: b.id, status: 'in_review' })}>revisión</button>}
                {b.status !== 'resolved' && <button className="av-mini" onClick={() => setBugStatus({ id: b.id, status: 'resolved' })}>✓</button>}
              </div>
            </div>
          ))}
          {bugs.results.length === 0 && <div className="faint" style={{ padding: 12 }}>Sin bugs.</div>}
          {bugs.status === 'CanLoadMore' && <button className="av-more" onClick={() => bugs.loadMore(20)}>Cargar más</button>}
        </div>

        {/* (panel-admin-dedup) Observabilidad de ejecuciones reales — movida desde el Panel Admin inline. */}
        <div className="av-section">
          <div className="av-shead"><h2>⚙️ EJECUCIONES</h2></div>
          <ExecutionsObservabilityPanel />
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, val, sub, accent }) {
  return (
    <div className={`av-card${accent ? ' accent' : ''}`}>
      <div className="k">{label}</div>
      <div className="vbig">{val}</div>
      <div className="s">{sub}</div>
    </div>
  );
}

// Estilos scoped de la vista admin — usan los tokens globales del portal (var(--green)…).
function AdminStyles() {
  return (<style>{`
  .av-wrap{max-width:1180px;margin:0 auto;padding:0 20px 60px;color:var(--text);font-family:var(--font)}
  .av-top{display:flex;align-items:center;gap:20px;padding:16px 0;border-bottom:1px solid var(--line)}
  .av-brand{font-weight:700}.av-brand b{color:var(--green)}
  .av-tabs{display:flex;gap:6px}.av-tab{padding:7px 16px;border-radius:10px;color:var(--muted);font-weight:600;text-decoration:none}
  .av-tab.active{background:var(--panel);color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
  .av-who{margin-left:auto;color:var(--muted);font-size:13px}.av-who b{color:var(--text)}
  .av-head{display:flex;align-items:center;gap:12px;margin:24px 0 16px;flex-wrap:wrap}
  .av-head h1{font-size:20px;margin:0}
  .av-pill{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px}
  .av-pill.green{background:rgba(0,200,5,.14);color:var(--green)}
  .av-pill.amber{background:rgba(255,220,0,.16);color:var(--amber)}
  .av-pill.red{background:rgba(255,80,0,.16);color:var(--red)}
  .av-pill.faint{background:#1a1a1a;color:var(--faint)}
  .av-actions{margin-left:auto;display:flex;gap:8px}
  .av-mini{background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}
  .av-mini:hover{border-color:var(--green)}.av-mini:disabled{opacity:.4;cursor:not-allowed}
  .av-kill{background:var(--red);color:#fff;border:none;padding:8px 14px;border-radius:9px;font-weight:700;cursor:pointer}
  .av-kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px}
  .av-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
  .av-card.accent{border-left:3px solid var(--green)}
  .av-card .k{color:var(--muted);font-size:12px;font-weight:600}
  .av-card .vbig{font-size:23px;font-weight:750;margin-top:8px}
  .av-card .s{font-size:11px;color:var(--faint);margin-top:4px}
  .av-section{background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-bottom:18px;overflow:hidden}
  .av-shead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}
  .av-shead h2{font-size:14px;margin:0;font-weight:700}
  .av-shead select{margin-left:auto}
  .av-inp{margin-left:auto;background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;font-size:12px}
  .av-inp+select{margin-left:8px}
  .av-ctlhead{display:grid;grid-template-columns:1.6fr .8fr .8fr 1.2fr .9fr;gap:10px;padding:8px 18px;color:var(--faint);font-size:11px;text-transform:uppercase;border-bottom:1px solid var(--line)}
  .av-ctl{display:grid;grid-template-columns:1.6fr .8fr .8fr 1.2fr .9fr;gap:10px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line);font-size:13px}
  .av-ctl:last-child{border-bottom:none}
  .av-ctl-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .av-tgl{border:1px solid var(--line);border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer}
  .av-tgl.on{background:rgba(0,200,5,.14);color:var(--green);border-color:rgba(0,200,5,.3)}
  .av-tgl.off{background:#1a1a1a;color:var(--faint)}
  .av-tgl:disabled,.av-ctl select:disabled,.av-ctl button:disabled{opacity:.5;cursor:not-allowed}
  .av-ctl-err{color:var(--red)}
  @media(max-width:900px){.av-ctlhead{display:none}.av-ctl{grid-template-columns:1fr auto auto;row-gap:6px}.av-ctl>select,.av-ctl>button:last-of-type{grid-column:span 1}}
  .av-uhead,.av-main{display:grid;grid-template-columns:1.6fr 1.1fr 1.5fr .5fr .5fr .9fr;gap:10px;align-items:center}
  .av-uhead{padding:8px 18px;color:var(--faint);font-size:11px;text-transform:uppercase;border-bottom:1px solid var(--line)}
  .av-urow{border-bottom:1px solid var(--line)}
  .av-main{padding:12px 18px;cursor:pointer}.av-main:hover{background:var(--panel-2)}
  .av-uname{font-weight:600;display:flex;align-items:center;gap:8px}
  .av-chev{color:var(--faint);font-size:11px;transition:transform .15s}.av-urow.open .av-chev{transform:rotate(90deg)}
  .av-plan{font-size:12px;color:var(--muted)}
  .av-cov{display:flex;align-items:center;gap:8px}
  .av-bar{flex:1;height:6px;background:#1a1a1a;border-radius:99px;overflow:hidden;min-width:50px}
  .av-bar>i{display:block;height:100%;background:var(--green)}
  .av-cov small{color:var(--faint);font-size:11px}
  .num{font-variant-numeric:tabular-nums}.faint{color:var(--faint)}
  .av-st{font-size:12px;font-weight:600}.av-st.on{color:var(--green)}.av-st.block{color:var(--amber)}.av-st.admin{color:var(--green)}
  .av-detail{background:#0c0c0c;padding:12px 18px 14px 38px}
  .av-pos{background:var(--panel-2);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
  .av-pos:last-child{margin-bottom:0}
  .av-pos-top{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line)}
  .av-nft{width:32px;height:32px;border-radius:9px;flex:none;background:conic-gradient(from 200deg,#ff007a,#fc72ff,#ff007a,#d633ff,#ff007a);position:relative}
  .av-nft span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;color:#fff;text-align:center;line-height:1}
  .av-pos-title{font-weight:700}.av-pos-title small{color:var(--faint);font-weight:500;font-size:11px;margin-left:6px}
  .av-nftid{font-size:11px;color:#fc72ff;background:rgba(252,114,255,.13);padding:2px 8px;border-radius:6px}
  .av-link{color:var(--green);font-size:11px;text-decoration:none}.av-link:hover{text-decoration:underline}
  .av-hl{font-size:10px;color:var(--faint);background:#1a1a1a;border-radius:5px;padding:1px 5px;margin-left:6px;font-weight:600}
  .av-range{margin-left:auto;font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px}
  .av-range.in{background:rgba(0,200,5,.14);color:var(--green)}
  .av-range.out{background:rgba(255,80,0,.14);color:var(--red)}
  .av-pnl{font-size:12px;color:var(--muted)}.av-pos-pnl{color:var(--green)}.av-neg-pnl{color:var(--red)}.av-amber{color:var(--amber)}
  .av-pos-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line)}
  .av-cell{background:var(--panel-2);padding:10px 14px}
  .av-cell .k{font-size:10px;color:var(--faint);text-transform:uppercase}
  .av-cell .vv{font-size:14px;font-weight:700;margin-top:3px}
  .av-pos-foot{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--line);flex-wrap:wrap}
  .av-tag{font-size:10px;font-weight:700;padding:3px 9px;border-radius:6px;background:rgba(255,255,255,.06);color:var(--muted)}
  .av-tag.ok{background:rgba(0,200,5,.14);color:var(--green)}
  .av-tag.norevert{background:#1a1a1a;color:var(--faint)}
  .av-tag.revert{background:rgba(255,220,0,.16);color:var(--amber)}
  .av-cols{display:grid;grid-template-columns:1.4fr 1fr;gap:18px}
  .av-feed{display:flex;gap:10px;padding:10px 18px;border-bottom:1px solid var(--line);font-size:13px;align-items:baseline}
  .av-feed .t{color:var(--faint);width:42px;flex:none;font-variant-numeric:tabular-nums}
  .av-feed .who2{font-weight:600;width:90px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .av-feed .ev{color:var(--muted)}
  .av-bug{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:11px 18px;border-bottom:1px solid var(--line);font-size:13px}
  .av-bst{font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;white-space:nowrap;margin-top:2px}
  .av-bst.new{background:rgba(255,80,0,.16);color:var(--red)}
  .av-bst.in_review{background:rgba(255,220,0,.16);color:var(--amber)}
  .av-bst.resolved{background:rgba(0,200,5,.14);color:var(--green)}
  .av-bugtxt{color:var(--muted)}.av-bugtxt b{color:var(--text)}
  .av-clip{color:var(--green);font-size:11px;text-decoration:none}
  .av-bugact{display:flex;gap:6px}
  .av-more{width:100%;background:transparent;color:var(--green);border:none;border-top:1px solid var(--line);padding:10px;cursor:pointer;font-size:12px}
  @media(max-width:900px){.av-kpis{grid-template-columns:repeat(2,1fr)}.av-cols{grid-template-columns:1fr}
    .av-uhead,.av-main{grid-template-columns:1.4fr 1fr .6fr}.av-uhead span:nth-child(n+4),.av-main>*:nth-child(n+4){display:none}}
  `}</style>);
}
