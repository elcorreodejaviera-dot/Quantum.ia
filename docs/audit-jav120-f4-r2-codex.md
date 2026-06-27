# Auditoría Codex — JAV-120 F4 r2 (deuda base al safeHead exacto)

- HEAD auditado: `bd4496e` (`fix(jav120): F4 deuda base al safeHead EXACTO (no al cursor del cache)`)
- Rama: `elcorreodejaviera/jav-120-fees-24h-real`
- Prompt: `docs/audit-prompt-jav120-f4-r2-codigo.md`
- Verificación: `npm run typecheck` OK · `npm test` 265/265
- Veredicto: **GO**

## Bloqueante / Alto / Medio

Sin hallazgos.

## Hallazgo de 148206e ya corregido

- **ALTO**: `aggregatesComplete=true` solo probaba que existían `principalDebt*Raw`, no que la deuda base
  estuviera sincronizada con `refSnap.safeHeadBlock`. Podía certificar `ok` con deuda vieja o adelantada y
  atribuir mal principal vs fee en Collect. Resuelto por `bda6470` (gate `cursorBlock >= safeHead`) + `bd4496e`
  (recompute de deuda a `safeHead` exacto desde `pool_fee_events`).

## Riesgos residuales (no bloqueantes)

- Validación runtime diferida: requiere ≥24h de snapshots + una posición con Collect/Decrease/Increase en la
  ventana. Se valida tras merge en prod.
- Costo DB: `getPoolAggregatesAtBlockInternal` recomputa eventos ≤ safeHead por pool; aceptable, observar pools
  con muchas modificaciones.
- Monitor recomendado: caso `cursorBlock > safeHead` con Collect/Decrease entre ambos bloques.
