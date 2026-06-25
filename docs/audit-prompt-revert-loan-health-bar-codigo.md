# Prompt de auditoría (Codex) — CÓDIGO: rediseño barra "Loan health" (Revert Lend) en PoolCard

**Cambio solo-UI / display.** Rediseña la barra de salud del préstamo Revert Lend en `PoolCard`
(`src/components/BotPortal.jsx`) y su CSS (`src/styles/bot-portal.css`). Pasa de una barra
gradiente-con-máscara (oscurecía la parte "no alcanzada") a **4 segmentos tipo píldora estáticos**
(rojo/amarillo/verde/menta) con un **marcador triangular ▲** que se mueve según el health factor.
NO toca motor, persistencia, scanner ni money-path. Veredicto **GO / NO-GO**.

## Qué cambia

JSX (`src/components/BotPortal.jsx` ~480-500), solo dentro del bloque que ya se renderizaba bajo
`hasBorrowData` (`pool.borrowHealth > 0`):
- Se **elimina** el badge textual de estado ("Saludable / Vigilar / Riesgo alto") y las variables
  `borrowTone` / `borrowLabel` (antes derivadas de umbrales 50/70 sobre `borrowHealth`).
- La clase del contenedor ya no aplica el tono de color (`${hasBorrowData ? '' : 'inactive'}`).
- El `borrow-track` ahora contiene 4 `<div class="borrow-seg seg-*">` + `<span class="borrow-marker">`.
- La posición del marcador usa **`healthFactor`** (no `borrowHealth`):
  `--hp = clamp(0, 100, (pool.healthFactor - 1) / 2 * 100)`. Es decir HF=1.0 → 0% (extremo izq.,
  rojo, cerca de liquidación) y HF≥3.0 → 100% (extremo der., menta, seguro).
- `aria-label` pasa a `Loan health ${healthFactor.toFixed(2)}`.

CSS (`src/styles/bot-portal.css`):
- Se eliminan los tints `.borrow-health-featured.green/.amber/.red`.
- `.borrow-track` pasa a `display:flex; gap:5px; background:none` (ya no gradiente ni `::after`/`::before`).
- Segmentos: `seg-red` flex 14, `seg-yellow` flex 14, `seg-green` flex 52, `seg-mint` flex 13
  (menta = `color-mix(in srgb, var(--green) 50%, #fff)`). Marcador `▲` con `border-bottom:7px solid #fff`,
  posicionado con `left: var(--hp)`.

## Verifica GO/NO-GO

1. **Null-safety de `healthFactor`**: el bloque solo se renderiza bajo `hasBorrowData` (= `borrowHealth > 0`)
   y `pool.healthFactor` tiene default `0` y se setea con `?? 0` (`BotPortal.jsx:3782`, `3806`, dentro de
   `pd.borrowHealth > 0`). ¿`healthFactor.toFixed(2)` y la aritmética del `--hp` están siempre sobre un
   número (nunca `undefined`/`null`)? ¿El clamp evita `--hp` fuera de [0,100]?
2. **Semántica del mapeo `(HF-1)/2`**: ¿es correcto/coherente que HF bajo → izquierda (rojo) y HF alto →
   derecha (verde/menta)? Los segmentos son **estáticos y decorativos** (su ancho no codifica umbrales de
   HF); solo el marcador es data-driven. ¿Hay riesgo de que el usuario lea el color bajo el marcador como
   un umbral real cuando no lo es? (antes los breakpoints 50/70 de `borrowHealth` sí eran umbrales).
3. **Sin código muerto / sin efectos**: confirmado que ya no quedan referencias a `borrowTone`,
   `borrowLabel` ni a los tints `.green/.amber/.red` (grep limpio). ¿El cambio es puramente de render, sin
   tocar lo que se persiste ni el scanner (`convex/actions/poolScanner.ts` sigue calculando
   `healthFactor`/`borrowHealth` igual)? `AdminView.jsx:122` sigue usando `borrowHealth` aparte —
   ¿intacto?
4. **Reutilización/consistencia**: ¿los colores usan la paleta (`var(--red/amber/green)`) igual que el
   resto? ¿`color-mix` tiene soporte aceptable en los navegadores objetivo? ¿La barra se ve bien en tema
   claro y oscuro (ambos definen `--red/amber/green`)?

Checks: `npx vite build` (compila — verificado OK) + revisión visual de la tarjeta de pool con préstamo
Revert activo. NO `npm run build` (incluye `convex deploy` a prod).
