# Prompt de auditoría (Codex) — CÓDIGO: JAV-110 montos en $ en vivo junto al % de SL/TP

**RE-AUDITORÍA (R2).** El commit `97938e4` recibió NO-GO (informe en
`docs/audit-codex-jav110-montos-usd-sl-tp-codigo.md`: 1 Alto en Spot Defense). El commit `fcacdc8` lo
corrige. Audita la rama `feat/jav-110-montos-usd-sl-tp` completa (commits `dda26b6` + `97938e4` +
`fcacdc8`, 1 archivo de producto: `src/components/BotPortal.jsx`). Cambio **solo-UI / display** en los
modales de configuración de bots: muestra en vivo el $ estimado al editar el % de SL y de cada TP. NO
toca motor, persistencia ni money-path del backend. Veredicto **GO / NO-GO**.

**Clave: cada motor dimensiona los TPs distinto, así que el nocional del TP$ depende del modal:**
- **IL (`ProtectionBotModal`)** → motor `triggerEngine`: los TPs cierran fracción del **BÚFER**
  (`triggerEngine.ts:705-707`: `bufferSize = realSize×bufferPct/(100+bufferPct)`, `tpSize =
  bufferSize×closePct/100`). TP$ usa `bufferNotional = poolCapital×bufferPct/100`. SL full-size →
  `effectiveCapital`.
- **Defensa Spot (`SpotDefenseBotModal`)** → motor `spotDefenseEngine` (DISTINTO): SL y TPs son
  **full-size** sobre `arm.size` (`spotDefenseEngine.ts:612`: `tpSize = arm.size×closePct/100`). TP$ y
  SL$ usan el nocional **completo** `requestedNotionalUsd` (texto "sobre el nocional pedido"; el efectivo
  lo capa el backend). **(Esta es la corrección de `fcacdc8`: antes usaba bufferNotional por error.)**
- **Trading (`TradingBotModal`)** → sin búfer: SL y TPs usan `opCapital = poolCapital×capitalPct/100`.

**Verifica que el nocional del TP$ coincide con `tpSize×entryPx` de CADA motor** (búfer en IL, `arm.size`
completo en Spot, `opCapital` en Trading) y que los SL (full-size) son correctos.

## Qué hace

- `TakeProfitRows` acepta prop opcional `notional` (USD). Si `Number.isFinite(notional) && notional > 0`,
  cada fila muestra `≈ +$X al cerrar {closePct}% en +{gainPct}%` con `gainUsd = notional × gainPct/100 ×
  closePct/100` (verde, en vivo al editar). El comentario aclara que `notional` es el nocional sobre el
  que cierran los TPs (distinto por motor).
- `ProtectionBotModal` (IL): SL `≈ −$X (por entrada)` con `effectiveCapital × slPct/100`; TPs con
  `notional={bufferNotional}`.
- `TradingBotModal`: SL y TPs con `opCapital`.
- `SpotDefenseBotModal`: SL `≈ −$X (sobre el nocional pedido)` y TPs con `requestedNotionalUsd`
  (full-size, ambos).

## Verifica GO/NO-GO

1. **Corrección de fórmulas (foco del NO-GO previo)**: ¿el TP$ de cada modal coincide con `tpSize×entryPx`
   de su motor? IL → búfer (`bufferNotional`); Spot → `arm.size` completo (`requestedNotionalUsd`); Trading
   → `opCapital`. ¿Y los SL full-size correctos? Confirma que la regresión de Spot quedó resuelta.
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
