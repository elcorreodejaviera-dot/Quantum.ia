// (Fase 6-C) Auditoría de pool: checks PUROS (sin React, testeables) que cruzan config (bot/arm/pool de
// DB) con realidad (exposición LP + hedge real en HL del snapshot) y reportan inconsistencias. Devuelve
// findings {level:'warn'|'unknown', code, msg}; NUNCA un falso ✅ — `unknown` ante datos faltantes.

// Normalizador HL (WETH→ETH, WBTC→BTC). Misma regla que AdminView; fuente única aquí.
export function hlCoin(s) {
  return s === 'WETH' ? 'ETH' : s === 'WBTC' ? 'BTC' : s;
}

const ARM_TERMINAL = new Set(['disarmed', 'closed', 'failed']);
const isTerminal = (st) => ARM_TERMINAL.has(st);

// (Codex BAJO#6) Tolerancias EXPLÍCITAS y documentadas.
export const HEDGE_BAND = 0.25;       // ±25% entre hedge real y exposición LP = warning operativo.
export const EDGE_DRIFT_PCT = 0.005;  // 0.5% RELATIVO entre borde del arm y del pool (no igualdad estricta).

const driftedRel = (a, b, tol) =>
  a != null && b != null && b !== 0 && Math.abs(a - b) / Math.abs(b) > tol;

// Audita UN bot. `acctCoinCount` = mapa "hlAccountId|coin" → nº de bots (para detectar ambigüedad del
// hedge agregado). `live` = datos del snapshot para este bot ({liquidityUsd, inRange, coverageUsd,
// present}) o null si no hay. `currentHlNetwork` = red HL actual ("mainnet"|"testnet") o null si se
// desconoce (snapshot no disponible).
export function auditPool(b, live, acctCoinCount, currentHlNetwork) {
  const f = [];
  const warn = (code, msg) => f.push({ level: 'warn', code, msg });
  const unknown = (code, msg) => f.push({ level: 'unknown', code, msg });

  const pool = b.pool;
  const arms = b.arms ?? [];
  const liveArm = arms.find((a) => !isTerminal(a.status)) ?? null;

  // --- Checks DB-only (no dependen del snapshot live) ---
  if (pool?.closed && liveArm) warn('pool_closed_with_live_arm', 'Pool cerrado pero la cobertura sigue viva.');
  if (b.active && !b.hlAccountId) warn('account_unlinked', 'Bot activo sin cuenta HL vinculada.');
  if (b.active && pool && pool.tokenId == null) warn('pool_no_tokenid', 'Pool sin tokenId: el motor no puede cuantificar la cobertura.');
  if (b.active && !b.baseAsset) warn('base_asset_unmappable', 'Bot activo sin activo base mapeable a HL.');
  // Red HL del armado vs red HL ACTUAL (mainnet/testnet). OJO: `pool.network` es la CHAIN de la LP de
  // Uniswap ("Base"/"Arbitrum"/...), un namespace DISTINTO al entorno HL del arm → no son comparables.
  // Solo se evalúa si conocemos la red HL actual (`currentHlNetwork`); si no, se omite (no falso positivo).
  if (liveArm && currentHlNetwork && liveArm.network !== currentHlNetwork) {
    warn('arm_network_mismatch', `Red HL del armado (${liveArm.network}) distinta a la red HL actual (${currentHlNetwork}).`);
  }
  if (liveArm && pool) {
    if (driftedRel(liveArm.lowerEdge, pool.minRange, EDGE_DRIFT_PCT) ||
        (liveArm.upperEdge != null && pool.maxRange != null && driftedRel(liveArm.upperEdge, pool.maxRange, EDGE_DRIFT_PCT))) {
      warn('triggers_vs_edges', 'El armado se hizo con bordes distintos a los del pool actual (rango reconfigurado).');
    }
  }
  // Órdenes vivas en HL atadas a un arm TERMINAL (dentro del alcance reciente cargado) = posible huérfana.
  if (arms.some((a) => isTerminal(a.status) && (a.orders ?? []).some((o) => o.observedStatus === 'open'))) {
    warn('orphan_orders', 'Órdenes trigger vivas en HL sobre un armado ya terminado (posible huérfana).');
  }

  // --- Checks que dependen del snapshot live ---
  if (live?.present && live.inRange === true && b.active && !liveArm) {
    warn('uncovered_in_range', 'Pool en rango y bot activo, pero sin cobertura armada.');
  }
  // hedge vs exposición: solo si el hedge agregado cuenta+coin es atribuible a UN bot (Codex MEDIO#5).
  const coin = b.baseAsset ? hlCoin(b.baseAsset) : null;
  const key = b.hlAccountId && coin ? `${b.hlAccountId}|${coin}` : null;
  const ambiguous = key && (acctCoinCount?.[key] ?? 0) > 1;
  if (liveArm && b.active) {
    if (ambiguous) {
      unknown('hedge_vs_exposure', 'Cobertura HL agregada por cuenta+activo: no atribuible a un bot concreto.');
    } else if (!live?.present || live.liquidityUsd == null || live.coverageUsd == null || !(live.liquidityUsd > 0)) {
      unknown('hedge_vs_exposure', 'Sin datos suficientes para comparar hedge vs exposición.');
    } else {
      const ratio = live.coverageUsd / live.liquidityUsd;
      if (ratio < 1 - HEDGE_BAND) warn('hedge_vs_exposure', `Hedge menor que la exposición (${Math.round(live.coverageUsd)} vs ${Math.round(live.liquidityUsd)} USD).`);
      else if (ratio > 1 + HEDGE_BAND) warn('hedge_vs_exposure', `Hedge mayor que la exposición (${Math.round(live.coverageUsd)} vs ${Math.round(live.liquidityUsd)} USD).`);
    }
  }
  return f;
}

// Veredicto del bot a partir de sus findings: 'warn' si hay algún warn; 'unknown' si solo faltan datos;
// 'ok' si no hay findings (todo lo verificable pasó).
export function verdictOf(findings) {
  if (findings.some((x) => x.level === 'warn')) return 'warn';
  if (findings.some((x) => x.level === 'unknown')) return 'unknown';
  return 'ok';
}

// Audita TODOS los bots del usuario. `auditData` = getUserPoolAuditData; `liveByBot` = botId → live.
// Detecta duplicados cuenta+coin SOBRE la data de DB (Codex BAJO#2), no sobre el snapshot.
export function auditUserPools(auditData, liveByBot, currentHlNetwork) {
  const acctCoinCount = {};
  for (const b of auditData ?? []) {
    const coin = b.baseAsset ? hlCoin(b.baseAsset) : null;
    if (b.hlAccountId && coin) {
      const key = `${b.hlAccountId}|${coin}`;
      acctCoinCount[key] = (acctCoinCount[key] ?? 0) + 1;
    }
  }
  return (auditData ?? []).map((b) => {
    const findings = auditPool(b, liveByBot?.[b.botId] ?? null, acctCoinCount, currentHlNetwork);
    return { botId: b.botId, pair: b.pool?.pair ?? null, verdict: verdictOf(findings), findings };
  });
}
