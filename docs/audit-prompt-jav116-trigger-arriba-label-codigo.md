# Prompt de auditoría (Codex) — CÓDIGO: JAV-116 relabel "Trigger arriba" → "Borde superior"

Rama `feat/jav116-trigger-arriba-label`. Cambio **solo-display / 1 archivo** (`src/components/BotPortal.jsx`).
Veredicto **GO / NO-GO**.

## Bug

En `CoberturaViva` el tile **"Trigger arriba"** se renderizaba SIEMPRE con `pool.max` (borde superior del
RANGO del LP), sin mirar si el bot tiene 2ª entrada (`allowReentryFromAbove`). Para un bot SIN "proteger
por arriba" no existe trigger superior, pero el portal lo mostraba como si lo hubiera (caso benjamin:
`allowReentryFromAbove=false`, sin entry_upper).

## Fix

```jsx
const hasUpperTrigger = arm ? arm.allowReentryFromAbove === true : bot?.allowReentryFromAbove === true;
...
<span className="cv-label">{hasUpperTrigger ? 'Trigger arriba' : 'Borde superior'}</span>
```
- Señal: `arm.allowReentryFromAbove` se persiste `true` SOLO cuando `twoEntries` (hay 2 entradas reales —
  `convex/triggerArms.ts:293-294`), así que refleja si ESE armado tiene pata superior (cubre el caso de la
  entrada inmediata a mercado, donde no hay pata superior aunque el bot la tenga configurada). Sin arm, cae
  a la intención del bot (`bot.allowReentryFromAbove`).
- Solo cambia la ETIQUETA; el valor mostrado (el borde superior del rango y su distancia) es el mismo. El
  tile "Trigger abajo" (entry_lower, siempre presente) no se toca.

## Verifica GO/NO-GO

1. **Correctitud de la señal**: ¿`arm.allowReentryFromAbove === true` ⟺ hay realmente entry_upper en ese
   arm? (en `triggerArms` se setea solo con `twoEntries`; en entrada inmediata a mercado `twoEntries=false`
   → `undefined` → "Borde superior", correcto). ¿El fallback a `bot.allowReentryFromAbove` cuando no hay
   arm es razonable (intención del usuario)?
2. **Sin regresión**: ¿un bot CON "proteger por arriba" y arm de 2 entradas sigue mostrando "Trigger
   arriba"? ¿El tile sigue mostrando `pool.max` y la distancia igual que antes?
3. **Solo-display**: ¿no toca motor, persistencia ni money-path? ¿`bot`/`arm` están siempre en scope en
   `CoberturaViva` (props)? ¿`arm` puede ser null y el `?.` lo cubre?
4. **Semántica del label**: ¿"Borde superior" comunica bien que es el límite del rango del LP (no un
   trigger del bot)? ¿Conviene otro texto?

Checks: `npx vite build` (OK). NO `npm run build`.
