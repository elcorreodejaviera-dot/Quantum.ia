# Auditoria Codex - JAV-116 R2 ocultar "Trigger arriba"

## Veredicto

GO.

El enfoque R2 corrige mejor el problema original: cuando no hay entrada por arriba, el tile superior deja de renderizarse en vez de mostrar un borde de rango como si fuera parte de la cobertura. El cambio sigue siendo solo-display y no toca motor, persistencia, scanner ni money-path.

## Alcance revisado

- Rama: `feat/jav116-trigger-arriba-label`
- Commit revisado: `552329f feat(jav116): ocultar el tile del borde superior si no hay entrada por arriba`
- Base local: `master` / `757485f`
- Archivos del diff final contra `master`: `src/components/BotPortal.jsx`, `src/styles/bot-portal.css`, `docs/audit-prompt-jav116-trigger-arriba-label-codigo.md`
- Referencias leidas para validar la senal: `convex/triggerArms.ts`, `convex/triggerEngine.ts`, `src/lib/armView.js`

## Hallazgos

### Bloqueante

Sin hallazgos.

### Alto

Sin hallazgos.

### Medio

Sin hallazgos.

### Bajo

Sin hallazgos.

## Verificaciones

1. Correctitud de la senal

   `hasUpperTrigger` usa `arm ? arm.allowReentryFromAbove === true : bot?.allowReentryFromAbove === true` en `src/components/BotPortal.jsx:219`. Con `arm` presente, la decision sale del armado real, no de la configuracion historica del bot.

   En `convex/triggerArms.ts:286-294`, `allowReentryFromAbove: true` se persiste solo si `twoEntries` es verdadero; el mismo `twoEntries` es el que habilita la creacion de la orden `entry_upper` en `convex/triggerArms.ts:321-328`. En `convex/triggerEngine.ts:253-259`, la entrada inmediata a mercado fuerza que no haya pata superior aunque el bot tenga la opcion configurada. Por eso la senal cubre el caso benjamin y el caso "bot configurado con proteccion arriba pero este arm concreto no tiene entry_upper".

   Sin `arm`, el fallback a `bot.allowReentryFromAbove` es razonable: no existe aun evidencia de un armado concreto y el portal solo puede reflejar la intencion configurada.

2. Sin regresion para bots con entrada por arriba

   Si `hasUpperTrigger` es true, el contenedor mantiene la clase base sin `tiles-3` (`src/components/BotPortal.jsx:248`), por lo que conserva el grid de 4 columnas. El tile `Trigger arriba` sigue renderizando `pool.max` y la distancia previa (`src/components/BotPortal.jsx:254-259`).

   El tile `Trigger abajo` queda intacto y sigue renderizando `pool.min` (`src/components/BotPortal.jsx:249-253`).

3. Layout

   Con `hasUpperTrigger=false`, el JSX renderiza 3 tiles: `Trigger abajo`, `Capital`, `Wallet`; no queda una celda React vacia porque el bloque superior directamente no existe (`src/components/BotPortal.jsx:254-260`).

   El CSS agrega `.cobertura-tiles.tiles-3 { grid-template-columns: repeat(3, 1fr); }` en `src/styles/bot-portal.css:2551`, asi que desktop queda alineado en 3 columnas. La media query mantiene tanto `.cobertura-tiles` como `.cobertura-tiles.tiles-3` en 2 columnas bajo `560px` (`src/styles/bot-portal.css:2552-2554`), sin romper el caso normal de 4 tiles.

4. Solo-display / scope

   El diff contra `master` se limita al prompt, `BotPortal.jsx` y CSS. No hay cambios en `convex/triggerEngine.ts`, `convex/triggerArms.ts`, persistencia, scanner ni rutas de dinero. `CoberturaViva` recibe `bot` y `arm` por props (`src/components/BotPortal.jsx:177`), retorna `null` si falta `bot` (`:178`) y cubre `arm` nulo con el ternario de `hasUpperTrigger`.

## Checks ejecutados

- `git diff --stat master..HEAD` - OK, diff limitado a prompt + UI/CSS.
- `git diff --check master..HEAD` - OK.
- `npx vite build --outDir /tmp/quantum-jav116-r2-audit-build --emptyOutDir` - OK. Vite emitio warnings conocidos de Rollup/chunk size, sin fallar el build.

No ejecute `npm run build`.

