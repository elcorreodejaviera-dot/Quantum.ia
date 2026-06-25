# Prompt de auditoría (Codex) — CÓDIGO: JAV-116 ocultar "Trigger arriba" sin entrada por arriba

**R2 — cambió el enfoque.** El GO previo era para RELABELAR a "Borde superior". Por decisión del usuario,
ahora se **OCULTA** el tile cuando el bot no eligió proteger desde arriba (no es un elemento de su
cobertura). Rama `feat/jav116-trigger-arriba-label`. Solo-display. Veredicto **GO / NO-GO**.

## Bug

En `CoberturaViva` (`src/components/BotPortal.jsx`) el tile **"Trigger arriba"** se renderizaba SIEMPRE con
`pool.max` (borde superior del RANGO del LP), aunque el bot no tuviera 2ª entrada. Caso benjamin
(`allowReentryFromAbove=false`): veía un "trigger arriba" inexistente.

## Fix

```jsx
const hasUpperTrigger = arm ? arm.allowReentryFromAbove === true : bot?.allowReentryFromAbove === true;
...
<div className={`cobertura-tiles${hasUpperTrigger ? '' : ' tiles-3'}`}>
  <div className="cv-tile"> ...Trigger abajo... </div>
  {hasUpperTrigger && (
    <div className="cv-tile"> ...Trigger arriba (pool.max)... </div>
  )}
  ...Capital... ...Wallet...
</div>
```
- Señal `arm.allowReentryFromAbove === true` se setea SOLO con 2 entradas reales
  (`convex/triggerArms.ts:293-294`, `twoEntries`) → refleja si ESE armado tiene pata superior (cubre la
  entrada inmediata a mercado). Sin arm, cae a `bot.allowReentryFromAbove` (intención).
- Si NO hay trigger arriba: el tile **no se renderiza** y el grid pasa a 3 columnas (`tiles-3`) para no
  dejar celda vacía. CSS: `.cobertura-tiles.tiles-3 { grid-template-columns: repeat(3, 1fr); }` (móvil
  sigue en 2 columnas). El tile "Trigger abajo" (entry_lower) no se toca.

## Verifica GO/NO-GO

1. **Correctitud de la señal**: ¿`arm.allowReentryFromAbove === true` ⟺ hay entry_upper real en ese arm?
   ¿El fallback a `bot.allowReentryFromAbove` sin arm es razonable?
2. **Sin regresión**: bot CON entrada por arriba → el tile "Trigger arriba" SIGUE apareciendo y el grid es
   de 4 columnas (igual que antes). ¿Confirmado?
3. **Layout**: con el tile oculto quedan 3 tiles (Trigger abajo / Capital / Wallet). ¿`tiles-3` (3 col
   desktop, 2 col móvil) los acomoda sin celda vacía ni desalineación? ¿La media query nueva no rompe el
   caso de 4 tiles?
4. **Solo-display**: ¿no toca motor, persistencia ni money-path? ¿`bot`/`arm` en scope; `arm` puede ser
   null y el `?.` lo cubre?

Checks: `npx vite build` (OK). NO `npm run build`.
