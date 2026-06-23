# Auditoria Codex - audit logs require filter flicker (codigo)

Fecha: 2026-06-23

## Veredicto

**GO**

No encontre hallazgos Bloqueantes, Altos, Medios ni Bajos. El commit corrige la deuda baja del GO previo: al aplicar filtros en el panel admin, el estado intermedio ya muestra carga en vez de `0 registros` / `Sin registros...`.

## Alcance auditado

- Prompt: `docs/audit-prompt-audit-logs-require-filter-flicker-codigo.md`
- Rama: `feat/audit-logs-require-filter`
- Base del addendum: `0c33b52` (`docs(jav109): informe de auditoria Codex - GO`)
- Commit auditado: `9e89a52` (`fix(jav109): estado "Cargando..." en logs de auditoria`)
- Archivo de producto modificado: `src/components/BotPortal.jsx`
- Sin cambios en `convex/`

## Hallazgos

### Bloqueante

Ninguno.

### Alto

Ninguno.

### Medio

Ninguno.

### Bajo

Ninguno.

## Respuestas a las preguntas del prompt

1. **`adminLogs === undefined` como carga: GO.** Es la senal correcta para `useQuery`: Convex documenta que `useQuery` devuelve `undefined` mientras carga. El caso `'skip'` queda excluido por `hasActiveFilter`, porque `adminLoading = isAdmin && hasActiveFilter && adminLogs === undefined`.

2. **Riesgo de "Cargando..." pegado: GO.** No veo un caso normal donde `listAllSignals` resuelva legitimamente a `undefined` con filtro activo. El handler siempre retorna un array: obtiene `buffer`, aplica filtros y cierra con `return rows.slice(0, clamped)` en `convex/tradesHistory.ts:139-152`. Con 0 resultados retorna `[]`, por lo que el texto pasa correctamente a `Sin registros con los filtros actuales.`

3. **No-admin intacto: GO.** `adminLoading` no puede activarse para no-admin porque empieza con `isAdmin && ...`. La rama no-admin sigue usando `mySignals`, mantiene contador visible por `!isAdmin || hasActiveFilter`, conserva su mensaje vacio y no ejecuta `listAllSignals` porque la query recibe `'skip'`.

## Evidencia revisada

- `src/components/BotPortal.jsx:1805-1814`: la query admin solo corre con `isAdmin && hasActiveFilter`; si no, usa `'skip'`.
- `src/components/BotPortal.jsx:1817-1821`: `rows` preserva la logica previa y `adminLoading` solo se activa para admin con filtro y query pendiente.
- `src/components/BotPortal.jsx:1828-1830`: el pill muestra `Cargando...` mientras carga, despues muestra `{rows.length} registros`.
- `src/components/BotPortal.jsx:1868-1876`: el estado vacio admin distingue carga, sin filtro y filtro sin resultados.
- `node_modules/convex/src/react/client.ts:860-884`: `useQuery` acepta `"skip"` para no cargar la query y devuelve `undefined` mientras carga.
- `convex/tradesHistory.ts:125-152`: `listAllSignals` requiere admin y siempre retorna array.

## Pruebas y comandos revisados

- `git diff 0c33b52..HEAD -- src/components/BotPortal.jsx docs/audit-prompt-audit-logs-require-filter-flicker-codigo.md`
- `git diff --name-status 0c33b52..HEAD` - solo `src/components/BotPortal.jsx` y el prompt; no `convex/`.
- `rg -n "listAllSignals|AuditLogPanel|adminLoading|hasActiveFilter" src convex tests docs`
- `npm run typecheck` - OK.
- `npm test` - OK: 16 archivos, 254 tests pasados.
- `npx vite build --outDir /tmp/quantum-audit-logs-flicker-build` - OK. Solo warnings habituales de Rollup/chunk size; sin error de build.

## Cierre

**GO para merge.**

El addendum resuelve la observacion baja anterior sin ampliar el alcance ni tocar backend/money-path.
