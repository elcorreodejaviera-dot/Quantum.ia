# Prompt de auditoría (Codex) — CÓDIGO: JAV-120 Fase 5 (UI Fees 24h real)

**RE-AUDITORÍA (r3).** Audita el **código** del commit `6609c74` (rama
`elcorreodejaviera/jav-120-fees-24h-real`). Veredicto **GO / NO-GO**. Fase 5 (UI) del plan
`docs/plan-fees24h-real.md`. Sobre F0–F3 (GO). F4 (getLogs de la ventana) queda como follow-up.
**Cambio solo-UI** (display); no toca backend ni money-path.

> **Corrige tus 2 NO-GO previos** (`docs/audit-jav120-f5-ui-fees24h-codex.md` y `-r2-codex.md`):
> r1 ALTO ($0 como "Real" sin dato) y r2 ALTO (agregado 100% estimado caía en "Real + estimado"). Fix
> final: el subtítulo de `Summary` se decide por conteo `feesRealCount`/`feesEstCount`/`feesHasUnknown`:
> - 0 usable → "—" / "Sin datos aún"
> - 0 medidas → "Estimado" (o "Estimado / acumulando" si hay desconocidas)
> - ≥1 medida y 0 estimadas → "Real (on-chain)" (o "Real / acumulando" si hay desconocidas)
> - ≥1 medida y ≥1 estimada → "Real + estimado"
> "Real" aparece SOLO con ≥1 posición medida; "+ estimado" SOLO si hay estimadas. `NetworkLiquidity`
> muestra "—" si ninguna red tiene valor usable (no $0). Verificá que NINGÚN agregado sin medidas diga
> "Real" y que ningún dato ausente se muestre como $0.

## Qué cambia (`src/components/BotPortal.jsx`)
- **Helper `poolFees24h(pool)`**: fuente única. Devuelve `{usd, real, status}`: REAL medido si
  `pool.fees24hReal.status === 'ok'`; si no, ESTIMADO concentrado `fees1d · feeShareRatio`; **nunca**
  pool-wide. `usd=null` si no hay base.
- **Fetch**: `useAction(getPoolFees24h)` por pool (TTL 5min, junto al de `fetchPositionLiquidity`) →
  `fees24hData` → se inyecta en el objeto pool como `fees24hReal`.
- **Summary "Fees 24h (tu parte)"**: suma `poolFees24h`; sub honesto ("Real (on-chain)" vs "Real +
  estimado"). **NetworkLiquidity**: idem (antes ambos usaban `fees1d · liquidez/TVL` = el bug).
- **PoolCard**: sección "Fees 24h (real on-chain | estimado)". Diario = medido cuando `ok`,
  Semanal/Mensual/Anual = proyección (`≈`). Estados: `warming_up` → "Acumulando… (faltan Xh)";
  `stale`/`partial`/`unavailable` → estimado concentrado. Se elimina `userFees1d` (pool-wide).
- Tooltip del tile "Fees" (stock/uncollected) corregido: ya no dice "del pool entero".

## Verifica GO/NO-GO
1. **Se elimina el bug pool-wide**: ¿queda ALGÚN cálculo `fees1d * (liquidity/tvl)` para fees del usuario?
   (grep esperado: solo `feeApr` pool-wide informativo, no el monto del usuario.) ¿`userFees1d` quedó sin
   referencias colgantes?
2. **Honestidad de labels**: ¿el UI nunca presenta como "real" un valor estimado? `real` solo cuando
   `status==='ok'`. ¿`warming_up`/`stale`/`partial` se comunican sin engañar? ¿El `≈` y "(est.)"/"(proy.)"
   son claros?
3. **Coherencia entre vistas**: Summary, NetworkLiquidity y PoolCard usan el MISMO `poolFees24h` → ¿números
   consistentes entre la tarjeta y los agregados?
4. **Fetch/estado React**: ¿el `useAction` por pool con TTL 5min y `fees24hFetchedRef`/`setFees24hData` es
   correcto (sin loops de render, sin llamadas duplicadas)? ¿`fees24hData` está en las deps del `useMemo`
   de `pools`? ¿Se limpia el ref en `.catch` para reintentar?
5. **Robustez de datos**: ¿`poolFees24h` maneja `fees24hReal` null / campos faltantes / `feeShareRatio`
   null sin romper? ¿`formatUsdCompact`/`dailyFeeApr` con `dailyFeesUsd` null → "—"?
6. **Sin efectos fuera de UI**: confirmar que NO se toca backend/engine/money-path; `getPoolFees24h` es
   read-only y ya auditado (F3). ¿El front solo manda `poolId` de pools propios (la action igual valida
   owner/admin)?
7. **Build**: `npx vite build` (verificado OK). NO `npm run build`.

## Verificación hecha
- `npx vite build` → OK.
- Runtime tras merge: con <24h de snapshots se ve "Acumulando…"/estimado; tras ≥24h, el valor real.
  Validar contra el cobrable on-chain de tokenId 5562243 (Arbitrum).
