# Auditoria Codex R2 - JAV-110 montos USD SL/TP

Fecha: 2026-06-24

## Veredicto

**GO**

El NO GO previo queda corregido por `fcacdc8`: `SpotDefenseBotModal` ya no usa el nocional del buffer para los TPs y ahora pasa `requestedNotionalUsd`, alineado con el motor de Defensa Spot, donde los TPs cierran porcentaje de `arm.size` completo. No encontre bloqueantes, altos ni medios.

## Alcance auditado

- Prompt R2: `docs/audit-prompt-jav110-montos-usd-sl-tp-codigo.md`
- Rama: `feat/jav-110-montos-usd-sl-tp`
- Commits de codigo auditados: `dda26b6`, `97938e4`, `fcacdc8`
- HEAD revisado: `1212d2c`
- Archivo de producto: `src/components/BotPortal.jsx`
- Referencias backend revisadas: `convex/triggerEngine.ts`, `convex/spotDefenseEngine.ts`, `convex/spotDefenseBots.ts`

## Hallazgos

### Bloqueante

Ninguno.

### Alto

Ninguno.

### Medio

Ninguno.

### Bajo

1. **Spot muestra nocional pedido, no nocional efectivo final cuando el backend capa.**

   `SpotDefenseBotModal` usa `requestedNotionalUsd` para SL$ y TP$ y etiqueta el SL como "sobre el nocional pedido" (`src/components/BotPortal.jsx:3027-3030`, `src/components/BotPortal.jsx:3160-3163`, `src/components/BotPortal.jsx:3182-3183`). Esto es coherente con un modal de configuracion pre-armado y el modal ya muestra cobertura estimada/parcial (`src/components/BotPortal.jsx:3148-3153`, `src/components/BotPortal.jsx:3191-3194`). Si el backend recorta por margen/cap, el efectivo real puede ser menor (`convex/spotDefenseBots.ts:360-406`). Riesgo bajo: tras armar, convendria mostrar el efectivo real en la tarjeta viva si difiere.

2. **Sin tests de componente para el display de montos.**

   La build y tests actuales pasan, pero no hay cobertura automatizada que valide los tres nocionales esperados: IL = buffer, Spot = requested/full-size, Trading = opCapital. Para un cambio solo-display es aceptable, pero seria una buena proteccion futura.

## Respuestas a los chequeos

1. **Correccion de formulas: GO.**

   - IL: SL usa `effectiveCapital = poolCapital * (1 + bufferPct/100)` y TPs usan `bufferNotional = poolCapital * bufferPct/100` (`src/components/BotPortal.jsx:2483-2487`, `src/components/BotPortal.jsx:2603-2623`). Esto coincide con `triggerEngine`: posicion total `hedgeNotionalUsd * (1 + bufferPct/100)` y TPs sobre `bufferSize = realSize * bufferPct/(100+bufferPct)` (`convex/triggerEngine.ts:207-241`, `convex/triggerEngine.ts:705-728`).
   - Defensa Spot: SL y TPs usan `requestedNotionalUsd` (`src/components/BotPortal.jsx:3027-3030`, `src/components/BotPortal.jsx:3160-3183`). Esto corrige el NO GO previo y coincide con el motor actual, que reserva `arm.size` full-size y coloca `tpSize = arm.size * closePct/100` (`convex/spotDefenseBots.ts:360-406`, `convex/spotDefenseEngine.ts:560-624`).
   - Trading: SL y TPs usan `opCapital = poolCapital * capitalPct/100` (`src/components/BotPortal.jsx:2852`, `src/components/BotPortal.jsx:2939-2968`), sin buffer.

2. **Solo-display / sin efectos: GO.**

   El rango `master..fcacdc8` modifica solo `src/components/BotPortal.jsx` como archivo de producto y el prompt de auditoria. Los payloads persistidos siguen enviando los mismos campos (`tps`, `stopLossPct`, `bufferPct`, `requestedNotionalUsd`, etc.) sin cambios semanticos (`src/components/BotPortal.jsx:2504-2512`, `src/components/BotPortal.jsx:2858-2865`, `src/components/BotPortal.jsx:3053-3063`).

3. **Guards numericos: GO.**

   `TakeProfitRows` solo muestra TP$ si `Number.isFinite(notional) && notional > 0` y el valor calculado es positivo (`src/components/BotPortal.jsx:2410-2439`). Los SL tambien se gatean con nocional `> 0` y `stopLossPct > 0` en los tres modales (`src/components/BotPortal.jsx:2605-2609`, `src/components/BotPortal.jsx:2941-2945`, `src/components/BotPortal.jsx:3160-3164`).

4. **Engano al usuario en Spot parcial: GO.**

   El texto explicita "sobre el nocional pedido" para SL y los TPs usan el mismo nocional pedido. El modal ya muestra cobertura estimada y exige aceptar cobertura parcial cuando aplica (`src/components/BotPortal.jsx:3148-3153`, `src/components/BotPortal.jsx:3191-3194`). No promete que el backend no recorte; la verdad efectiva queda para el estado vivo post-armado.

5. **Reutilizacion/consistencia: GO.**

   Se usa `formatUsd2`, `var(--red)` y `var(--green)` en la misma linea visual del resto del archivo. La prop `notional` es opcional, por lo que llamadas existentes sin prop no rompen; en la rama actual los tres modales auditados la pasan explicitamente (`src/components/BotPortal.jsx:2622-2623`, `src/components/BotPortal.jsx:2966-2968`, `src/components/BotPortal.jsx:3182-3183`).

## Pruebas y comandos revisados

- `git status --short --branch`
- `git log --oneline --decorate -8`
- `git show --stat --oneline --decorate fcacdc8`
- `git diff --stat master..fcacdc8`
- `git diff --name-status master..fcacdc8`
- `git diff --unified=80 97938e4..fcacdc8 -- src/components/BotPortal.jsx`
- `git diff --unified=100 master..fcacdc8 -- src/components/BotPortal.jsx`
- `rg -n "TakeProfitRows|bufferNotional|requestedNotionalUsd|effectiveCapital|opCapital|SpotDefenseBotModal|ProtectionBotModal|TradingBotModal" src/components/BotPortal.jsx`
- `rg -n "reserveSpotDefenseArm|requestedNotionalUsd|effectiveNotional|arm.size|tpSize" convex/spotDefenseBots.ts convex/spotDefenseEngine.ts`
- `git diff --check master..fcacdc8` - OK
- `npx vite build --outDir /tmp/quantum-jav110-r2-vite-build-1212d2c` - OK, con warnings existentes de Rollup/chunk size
- `npm test` - OK: 16 archivos, 254 tests pasados

No ejecute `npm run build` porque incluye `convex deploy` a prod. La build de Vite se envio a `/tmp` para no modificar `dist/`.

## Cierre

**GO** para la rama `feat/jav-110-montos-usd-sl-tp` tras `fcacdc8`.
