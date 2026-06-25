# Auditoria Codex - JAV-116 relabel "Trigger arriba"

## Veredicto

GO.

El cambio es solo de display en `CoberturaViva`: usa una senal ya persistida en el `arm` para decidir si el tile superior representa un trigger real o solamente el borde superior del rango LP. No encontre impacto en motor, persistencia, scanner ni money-path.

## Alcance revisado

- Rama: `feat/jav116-trigger-arriba-label`
- Commit revisado: `edd255c feat(jav116): relabel "Trigger arriba" -> "Borde superior" si no hay entrada por arriba`
- Base local: `master` / `757485f`
- Archivos del diff: `src/components/BotPortal.jsx`, `docs/audit-prompt-jav116-trigger-arriba-label-codigo.md`
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

   `arm.allowReentryFromAbove === true` es una senal correcta para "hay pata superior real en este armado". En `convex/triggerArms.ts:286-294`, `twoEntries` exige `allowReentryFromAbove === true`, `upperEdge != null` y `upperEdge > 0`; solo entonces se persisten `upperEdge` y `allowReentryFromAbove: true`. En `convex/triggerArms.ts:321-328`, el `entry_upper` se inserta solamente bajo ese mismo `twoEntries`.

   El caso de entrada inmediata a mercado queda cubierto: `convex/triggerEngine.ts:253-259` fuerza `upperValid = false` cuando `entryLowerImmediate`, por lo que `twoEntries` queda falso aunque el bot tenga configurado `allowReentryFromAbove`. En ese escenario el `arm` no tiene `allowReentryFromAbove: true` y el portal muestra `Borde superior`, que es lo esperado.

   El fallback sin `arm` a `bot?.allowReentryFromAbove === true` es razonable porque ahi no existe todavia evidencia de un armado concreto; mostrar la intencion configurada del bot no altera estado ni operaciones.

2. Sin regresion visual/funcional

   Un `arm` de dos entradas sigue mostrando `Trigger arriba` porque `hasUpperTrigger` sera true (`src/components/BotPortal.jsx:219`, label en `:255`). El tile sigue mostrando exactamente `pool.max` y la misma distancia con `fmtDist(dist(pool?.max))` (`src/components/BotPortal.jsx:255-257`).

   El tile inferior no cambia: `Trigger abajo` sigue mostrando `pool.min` y su distancia (`src/components/BotPortal.jsx:249-252`).

3. Cambio solo-display

   `git diff --stat master..HEAD` muestra solo el prompt de auditoria y `src/components/BotPortal.jsx`. No hay cambios en `convex/triggerEngine.ts`, `convex/triggerArms.ts`, persistencia, scanner ni paths de dinero. `CoberturaViva` ya recibe `bot` y `arm` por props (`src/components/BotPortal.jsx:177`), retorna `null` si no hay `bot` (`:178`) y cubre `arm` nulo con el ternario de `hasUpperTrigger`.

4. Semantica del label

   `Borde superior` comunica mejor el dato mostrado cuando no hay pata superior: el valor sigue siendo el limite alto del rango LP (`pool.max`), no un disparador operativo del bot. No veo necesidad de otro texto para este cambio; evita la implicacion incorrecta de que existe un trigger superior.

## Checks ejecutados

- `git diff --stat master..HEAD` - OK, diff limitado a prompt + `BotPortal.jsx`.
- `git diff --check master..HEAD` - OK.
- `npx vite build --outDir /tmp/quantum-jav116-audit-build --emptyOutDir` - OK. Vite emitio warnings conocidos de Rollup/chunk size, sin fallar el build.

No ejecute `npm run build`.

