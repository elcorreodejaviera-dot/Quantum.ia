# Auditoría CÓDIGO — TPs añadir/quitar en el modal compartido (TakeProfitRows)

Audita el **CÓDIGO** del commit `528760b` en la rama `feat/jav109-tps-add-remove` (sobre `master` `033453c`,
post JAV-107). Emite **GO / NO-GO** por hallazgo. **Cambio frontend-only** (`src/components/BotPortal.jsx`),
NO toca `convex/`. Contexto: es un modal **money-path** (configura shorts reales de cobertura/defensa), por eso
se audita aunque sea UI.

## Motivación

Los TPs debían ser **opcionales**, pero `TakeProfitRows` solo pintaba las filas precargadas y dejaba editar
los números: **no había forma de eliminar ni añadir filas**. El único modo de quedarse sin TPs era poner los
valores a 0 a mano (el backend ya filtra `gainPct>0 && closePct>0` al guardar). Decisión del usuario: aplicarlo
al **componente compartido**, afectando a los 3 modales que lo usan.

## Cambio (a verificar)

`TakeProfitRows({ tps, setTps })` (`BotPortal.jsx:2392`):
- `removeRow(i)` → `setTps(tps.filter((_, idx) => idx !== i))`.
- `addRow()` → `setTps([...tps, { gainPct: 0.5, closePct: 50 }])`.
- Cada fila ahora tiene un botón **✕** (`ghost-btn`, `aria-label="Quitar TP{n}"`) en una 3ª columna del grid
  (`gridTemplateColumns: '1fr 1fr auto'`).
- Botón **"+ Añadir Take Profit"** debajo de las filas.
- Si `tps.length === 0`: aviso *"Sin Take Profits — el bot no cerrará parcialmente en ganancia."*

## Consumidores del componente (los 3 deben seguir bien)

- `ProtectionBotModal` (cobertura de pool, ~2573).
- Otro modal de cobertura (~2913).
- `SpotDefenseBotModal` (defensa spot, ~3120).

En los 3, el estado inicial al **crear** sigue precargando 2 TPs
(`bot ? (bot.tps ?? []) : [{gainPct:0.5,closePct:40},{gainPct:1.5,closePct:60}]`); al **reconfigurar** un bot
existente se respeta `bot.tps ?? []` (distingue undefined de [] intencional). El guardado filtra
`tps.filter((t) => t.gainPct > 0 && t.closePct > 0)`.

## Preguntas

1. **Índice `key={i}` con filas mutables:** al eliminar una fila intermedia, ¿el uso de `key={i}` (índice)
   provoca algún desajuste de estado/foco entre filas? ¿Conviene una key estable? ¿Hay riesgo real aquí dado
   que `tps` es un array controlado por el padre?
2. **Integridad del payload money-path:** ¿el cambio puede producir un `tps` que el backend persista mal
   (p. ej. fila a medio rellenar `{gainPct:0.5, closePct:0}`)? Confirmar que el filtro
   `gainPct>0 && closePct>0` lo descarta en los 3 call sites y que `tps: []` es aceptado por
   `persistSpotDefenseBot` y por `getOrCreatePoolBot`.
3. **Regresión en pool:** ¿poder dejar 0 TPs en el bot de cobertura de pool rompe alguna asunción del motor de
   pools (que antes asumía TPs)? ¿O ya era opcional y solo faltaba la UI?
4. **Validación de suma de cierres:** ¿debería la UI avisar si la suma de `closePct` supera 100% o si hay TPs
   duplicados? (¿lo valida el backend o es responsabilidad de la UI?)
5. **Accesibilidad / type:** los botones llevan `type="button"` (no submit) y `aria-label`. ¿Algo más que
   falte para no disparar envíos del form al añadir/quitar?

## Verificación

`npm run typecheck` EXIT 0; `npx vite build` aislado OK. (No hay tests de este componente; señala si conviene
alguno.)

Devuelve hallazgos + veredicto **GO / NO-GO**.
