# Prompt de auditoría (Codex) — CÓDIGO: JAV-110 montos en $ en vivo junto al % de SL/TP

Audita el código de la rama `feat/jav-110-montos-usd-sl-tp` (commits `dda26b6` feat + `97938e4` fix
review, 1 archivo de producto: `src/components/BotPortal.jsx`). Cambio **solo-UI / display** en los
modales de configuración de bots: muestra en vivo el monto en $ estimado al editar el % de Stop Loss y
de cada Take Profit. NO toca el motor, persistencia, sizing de margen ni ninguna ruta money-path del
backend. Veredicto **GO / NO-GO**.

**Corrección aplicada en `97938e4` (review local):** los TPs cierran SOLO la fracción del BÚFER
(backend `triggerEngine.ts:705-707`: `bufferSize = realSize×bufferPct/(100+bufferPct)`,
`tpSize = bufferSize×closePct/100`, `Σ closePct ≤ 100 = % del búfer`), no la posición total. Por eso
el $ de cada TP usa ahora `bufferNotional` (IL: `poolCapital×bufferPct/100`; Spot:
`holding×triggerPx×bufferPct/100`), NO `effectiveCapital`/`requestedNotionalUsd`. El SL sí es full-size
→ sigue usando el nocional total. Trading no cambia (no tiene búfer; TPs cierran % de `opCapital`).
**Verifica que el nocional de los TPs ahora coincide con `tpSize×entryPx` del backend** para IL y Spot,
y que el del SL (full-size) sigue correcto.

## Qué hace

- `TakeProfitRows` acepta prop opcional `notional` (USD). Si `Number.isFinite(notional) && notional > 0`,
  cada fila muestra `≈ +$X al cerrar {closePct}% en +{gainPct}%` con `gainUsd = notional × gainPct/100 ×
  closePct/100` (verde, en vivo al editar).
- `ProtectionBotModal` (IL): bajo el SL, `≈ −$X de pérdida si salta (por entrada)` con
  `effectiveCapital × stopLossPct/100`; pasa `notional={effectiveCapital}` a los TPs.
  `effectiveCapital = poolCapital × (1 + bufferPct/100)`.
- `TradingBotModal`: idem con `opCapital = poolCapital × capitalPct/100`.
- `SpotDefenseBotModal`: idem con `requestedNotionalUsd = position.amount × effTriggerPrice ×
  (1 + bufferPct/100)`; el texto dice "(sobre el nocional pedido)" porque el efectivo lo CAPA el backend.

## Verifica GO/NO-GO

1. **Corrección de fórmulas**: ¿`SL$ = nocional × slPct/100` y `TP$ = nocional × gainPct/100 × closePct/100`
   reflejan el riesgo/beneficio real de UNA entrada, coherentes con cómo el motor dimensiona el short
   (nocional por entrada, no total con buffer/2×)? ¿Es correcto que IL use `effectiveCapital` (pool+buffer),
   Trading `opCapital`, y Spot el `requestedNotionalUsd`?
2. **Solo-display / sin efectos**: ¿el cambio es puramente de render? ¿No altera lo que se persiste
   (`tps`, `stopLossPct`, etc.) ni dispara cálculos en el backend?
3. **Guards numéricos**: ¿se evita mostrar montos basura (NaN/∞/negativos) cuando faltan datos
   (pool estimado, capital 0, campos vacíos)? (`Number.isFinite` + `> 0` en cada gate).
4. **Engaño al usuario**: en Spot Defense el efectivo puede ser MENOR que el pedido (cap por margen/plan).
   ¿El texto "(sobre el nocional pedido)" evita prometer un $ que el backend luego recorta? ¿Suficiente o
   conviene mostrar también el efectivo cuando difiere?
5. **Reutilización/consistencia**: ¿`formatUsd2` y los colores `var(--red)`/`var(--green)` se usan igual
   que en el resto del archivo? ¿La firma `notional` opcional no rompe llamadas existentes de
   `TakeProfitRows` (todas pasan el prop o lo omiten sin romper)?

Checks sugeridos: `npx vite build` (compila), revisión visual de los 3 modales. NO `npm run build`
(incluye `convex deploy` a prod).
