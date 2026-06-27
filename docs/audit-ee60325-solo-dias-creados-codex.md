# Auditoria Codex - commit ee60325

## Alcance auditado

- Rama: `chore/solo-dias-creados`
- Commit: `ee60325ca200571da76f70979ffe011ece9bfefb`
- Archivos del commit:
  - `docs/audit-prompt-solo-dias-creados-codigo.md`
  - `src/components/AdminView.jsx`
  - `src/components/BotPortal.jsx`

Objetivo revisado: quitar el tile "Total generado" y conservar solo "Tiempo de vida" en portal y admin, sin tocar motor, persistencia, scanner, schema, crons ni money-path.

## Bloqueante

No hay hallazgos bloqueantes.

## Alto

No hay hallazgos altos.

## Medio

No hay hallazgos medios.

## Bajo

### 1. El prompt de auditoria nuevo referencia un commit incorrecto

Evidencia:

- `docs/audit-prompt-solo-dias-creados-codigo.md:3` dice `Commit ea8ea1e`.
- El commit auditado y actual en `HEAD` es `ee60325ca200571da76f70979ffe011ece9bfefb`.

Impacto: bajo. No afecta runtime ni money-path, pero puede confundir trazabilidad de auditoria/PR.

### 2. Quedan referencias residuales de lifetime fees en el modelo UI del portal

Evidencia:

- `src/components/BotPortal.jsx:3783` mantiene el comentario de agregados lifetime cacheados hacia `feesLifetimeUsd`.
- `src/components/BotPortal.jsx:3848` sigue copiando `pd.feesLifetimeUsd` al objeto `pool`.

Impacto: bajo. El tile "Total generado" ya no se renderiza y no encontre lectura funcional de `feesLifetimeUsd` en `PoolCard`; sin embargo, la UI todavia transporta ese dato muerto y el comentario sigue prometiendo una metrica descartada. Es deuda de limpieza, no bloqueo.

### 3. Las grillas quedan con filas parciales al pasar a un solo tile de vida

Evidencia:

- `src/components/BotPortal.jsx:517` renderiza un unico `Metric` dentro de `.pool-metrics-header`.
- `src/styles/bot-portal.css:1275-1278` define `.pool-metrics-header` como `repeat(6, 1fr)`, por lo que el unico tile ocupa solo la primera columna en desktop.
- `src/components/AdminView.jsx:181-189` deja cinco celdas dentro de `.av-pos-grid`.
- `src/components/AdminView.jsx:711` define `.av-pos-grid` como `repeat(4, 1fr)`, dejando una segunda fila con una sola celda.

Impacto: bajo. No rompe datos ni ejecucion; es solo una posible presentacion visual parcial. Ya existia una fila parcial antes en admin, y el portal tambien usaba la misma grilla para dos tiles. No bloquea el PR.

## Checks realizados

- `git status --short --branch`
  - Rama confirmada: `chore/solo-dias-creados`.
  - `HEAD` confirmado en `ee60325`.
  - Unico cambio fuera de git: directorio no trackeado `quantum/`, fuera del alcance del commit.
- `git diff ee60325^ ee60325 -- docs/audit-prompt-solo-dias-creados-codigo.md src/components/AdminView.jsx src/components/BotPortal.jsx`
- `rg -n "poolAgeDays|lifetimeFees|lifetimeFee|annualYield|initialLiquidityAt|Total generado|Tiempo de vida|days" src/components convex tests docs -g '!convex/_generated/**'`
- `rg -n "feesLifetime|Total generado|lifetimeUsd|lifetimeStatus|lifetimeVal|lifetimeBlocked|lifetimeUsable|lifetimeValueNode|lifetimeTip" src/components/AdminView.jsx src/components/BotPortal.jsx`
- `git diff --check ee60325^ ee60325`
- `npx vite build`
  - OK. Solo warnings conocidos de Rollup/WalletConnect y chunk mayor a 500 kB.
- `npm test`
  - OK: 17 archivos, 265 tests.
- `npm run typecheck`
  - OK: `tsc -p convex/tsconfig.json --noEmit`.

## Veredicto final

GO.

El cambio cumple el objetivo funcional: "Total generado" desaparece del render en portal y admin, "Tiempo de vida" queda intacto, no se toca money-path ni backend en este commit, y build/tests/typecheck pasan. Los hallazgos son bajos y no bloquean push ni PR.
