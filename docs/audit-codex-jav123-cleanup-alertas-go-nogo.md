# Auditoria Codex - JAV-123 + limpieza backend de alertas

Fecha: 2026-06-27

## Alcance auditado

- Rama actual: `chore/cleanup-backend-alerts`.
- Diff combinado desde `HEAD` para limpieza backend:
  - `D convex/alerts.ts`
  - `M convex/schema.ts`
  - `M convex/_generated/api.d.ts`
- Snapshot `stash@{0}` (`ui/jav123-pool-lifetime-fullwidth: jav123-wip`) para JAV-123:
  - `src/components/AdminView.jsx`
  - `src/components/BotPortal.jsx`
  - `src/styles/bot-portal.css`
- No se auditaron archivos untracked ajenos al alcance salvo como riesgo de commit.
- No se hizo deploy ni commit.

## Hallazgos por severidad

### Bloqueante

Ninguno.

### Alto

#### A1 - El index de Git no representa el cambio completo; un `git commit` ahora seria roto

Evidencia:

- `git status --porcelain=v1` muestra:
  - ` M convex/_generated/api.d.ts`
  - `D  convex/alerts.ts`
  - ` M convex/schema.ts`
- `git diff --cached --name-status` muestra solo:
  - `D convex/alerts.ts`
- El diff real esperado desde `HEAD` es de 3 archivos:
  - `M convex/_generated/api.d.ts`
  - `D convex/alerts.ts`
  - `M convex/schema.ts`

Impacto:

Si se ejecuta `git commit` en el estado actual del index, se commitearia solo el borrado de `convex/alerts.ts`, dejando fuera `convex/_generated/api.d.ts` y `convex/schema.ts`. Eso puede romper typecheck/build porque el `api.d.ts` commiteado desde `HEAD` todavia importa `../alerts.js` y registra `alerts` en `fullApi` (`convex/_generated/api.d.ts:16`, `convex/_generated/api.d.ts:66` en `HEAD`).

Condicion para GO:

Antes de commitear, el index debe contener juntos los tres archivos del cambio backend:

- `convex/alerts.ts`
- `convex/schema.ts`
- `convex/_generated/api.d.ts`

Verificacion esperada antes del commit:

```text
git diff --cached --name-status
M       convex/_generated/api.d.ts
D       convex/alerts.ts
M       convex/schema.ts
```

### Medio

Ninguno.

### Bajo

#### B1 - Hay untracked ajenos al alcance; no usar `git add .`

Evidencia:

`git status --short --branch` lista, ademas de los archivos esperados, estos untracked:

- `docs/audit-prompt-cleanup-alertas-codigo.md`
- `docs/audit-prompt-jav123-codigo.md`
- `espacio gris.png`
- `quantum/`
- `terminos y condiciones.txt`

Impacto:

No afecta runtime ni tests, pero puede ensuciar el PR o filtrar artefactos no relacionados si se usa `git add .`.

Condicion operativa:

Commit explicito por archivo. No incluir untracked salvo que Javier los quiera en ese commit.

#### B2 - JAV-123 esta auditado como stash, no como cambio aplicado en la rama actual

Evidencia:

- `stash@{0}: On ui/jav123-pool-lifetime-fullwidth: jav123-wip`
- El snapshot contiene cambios en `src/components/AdminView.jsx`, `src/components/BotPortal.jsx` y `src/styles/bot-portal.css`.

Impacto:

El arreglo de JAV-123 es GO en el snapshot auditado, pero no forma parte de la rama actual `chore/cleanup-backend-alerts`. Para commitearlo, debe aplicarse en la rama correcta (`ui/jav123-pool-lifetime-fullwidth`) y no mezclarse con la limpieza backend.

## Evidencia tecnica revisada

### Limpieza backend de alertas

- `convex/alerts.ts` elimina 5 funciones publicas huerfanas: `listAlerts`, `createAlert`, `deleteAlert`, `recordAlertTrigger`, `listAlertHistory`.
- `convex/schema.ts:307-318` elimina la tabla `alerts` y conserva `alert_history` con indice `by_user_timestamp`.
- `convex/_generated/api.d.ts:11-65` ya no importa ni expone el modulo `alerts`.
- Busqueda de referencias vivas:
  - No quedan callers de `api.alerts`, `listAlerts`, `createAlert`, `deleteAlert`, `recordAlertTrigger` ni `listAlertHistory` en `src`, `convex` o `tests`.
  - Las referencias restantes son `alert_history` para Spot Grid y tests.
- `convex/spotGridBots.ts:97-104` conserva `emitSpotGridErrorAlert`, que inserta en `alert_history`.
- Callers conservados de `emitSpotGridErrorAlert`:
  - `convex/spotGridBots.ts:529`
  - `convex/spotGridBots.ts:666`
  - `convex/spotGridBots.ts:701`
- Convex local confirma que tablas fuera del schema no se validan aunque `strictTableNameTypes` sea `true`: `node_modules/convex/src/server/schema.ts:762-764`.

Conclusion tecnica:

El diff combinado de limpieza backend es correcto. `alert_history` queda consistente con su escritor restante (`emitSpotGridErrorAlert`) y sus tests.

### JAV-123

- `stash@{0}:src/components/AdminView.jsx:186` agrega `av-cell-wide` a la celda "Tiempo de vida".
- `stash@{0}:src/components/AdminView.jsx:711-713` mantiene `.av-pos-grid` en 4 columnas y agrega `.av-cell-wide{grid-column:1/-1}`. Esto elimina las 3 columnas grises vacias de la segunda fila.
- `stash@{0}:src/components/BotPortal.jsx:534` agrega `pool-lifetime-row`.
- `stash@{0}:src/styles/bot-portal.css:1275-1286` define `.pool-metrics-header.pool-lifetime-row { grid-template-columns: 1fr; }`.
- `stash@{0}:src/styles/bot-portal.css:1288-1298` mantiene media queries con selector de una clase (`.pool-metrics-header`), por lo que la regla de doble clase de JAV-123 gana por especificidad tambien en 900px y 640px.

Conclusion tecnica:

El fix elimina el hueco gris y es minimo. No vi colision de clases ni efecto lateral sobre otras metricas, porque las nuevas clases solo se aplican a la fila "Tiempo de vida".

## Pruebas y comandos revisados

### Rama actual `chore/cleanup-backend-alerts`

- `git diff HEAD --name-status` -> solo los 3 archivos esperados del backend.
- `rg` de callers de `alerts` / `api.alerts` / funciones borradas -> sin referencias vivas.
- `git diff --check` -> OK.
- `git diff --cached --check` -> OK.
- `npm run typecheck` -> OK.
- `npm test` -> 18 archivos, 286 tests OK.
- `npx vite build --outDir /tmp/quantum-audit-vite-dist --emptyOutDir` -> OK. Solo warnings conocidos de Rollup por comentarios `/*#__PURE__*/` y chunk > 500 kB.

### Snapshot `stash@{0}` de JAV-123

Se exporto el stash a `/tmp/quantum-jav123-audit.LljuYy` sin aplicarlo al repo.

- `git diff stash@{0}^1 stash@{0} --check` -> OK.
- `npm run typecheck` -> OK.
- `npm test` -> 18 archivos, 286 tests OK.
- `npx vite build --outDir /tmp/quantum-jav123-vite-dist --emptyOutDir` -> OK. Solo warnings conocidos de Rollup.

## Veredicto final

**GO condicionado**

No hay hallazgos funcionales contra el codigo combinado ni contra el stash JAV-123. La condicion es de entrega/commit:

1. No commitear el index actual tal como esta.
2. Stagear juntos `convex/alerts.ts`, `convex/schema.ts` y `convex/_generated/api.d.ts` para la limpieza backend.
3. No incluir untracked ajenos con `git add .`.
4. Mantener JAV-123 separado en su rama/stash correspondiente.

Si se cumple esa condicion de staging, el cambio backend es **GO** y JAV-123 es **GO**.
