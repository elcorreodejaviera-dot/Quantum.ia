# Prompt de auditoría (Codex) — CÓDIGO: JAV-110 montos en $ en vivo junto al % de SL/TP

Audita el código de la rama `feat/jav-110-montos-usd-sl-tp` (commit `dda26b6`, 1 archivo:
`src/components/BotPortal.jsx`). Cambio **solo-UI / display** en los modales de configuración de bots:
muestra en vivo el monto en $ estimado al editar el % de Stop Loss y de cada Take Profit. NO toca el
motor, persistencia, sizing de margen ni ninguna ruta money-path del backend. Veredicto **GO / NO-GO**.

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
