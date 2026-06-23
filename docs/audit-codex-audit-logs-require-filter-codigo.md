# Auditoria Codex - audit logs require filter (codigo)

Fecha: 2026-06-23

## Veredicto

**GO**

No encontre hallazgos Bloqueantes, Altos ni Medios. El cambio cumple la intencion: el panel admin de "Logs de auditoria" ya no ejecuta `listAllSignals` ni muestra registros por defecto; solo consulta cuando hay al menos un filtro activo.

Queda un unico hallazgo **Bajo** de UX transitoria durante la carga, no bloqueante.

## Alcance auditado

- Prompt: `docs/audit-prompt-audit-logs-require-filter-codigo.md`
- Rama: `feat/audit-logs-require-filter`
- Base indicada: `master` `47522f2`
- Commit indicado por prompt: `4633b43` (`feat(audit): el panel admin de logs no vuelca todo por defecto`)
- HEAD actual de la rama: `ad150b1` (`docs(jav109): audit-prompt para Codex del gate de filtros en logs`)
- Commit de codigo equivalente en la rama actual: `beef808` (`feat(jav109): el panel admin de logs no vuelca todo por defecto`)
- Archivo de producto modificado: `src/components/BotPortal.jsx`
- Sin cambios en `convex/`

Nota de trazabilidad: `4633b43` existe localmente y su diff de `src/components/BotPortal.jsx` contra `47522f2` es equivalente al commit `beef808` presente en la rama actual.

## Hallazgos

### Bloqueante

Ninguno.

### Alto

Ninguno.

### Medio

Ninguno.

### Bajo

#### BAJO-1 - Estado de carga admin se muestra como cero resultados

**Veredicto del hallazgo: GO**

Evidencia:

- `src/components/BotPortal.jsx:1805-1815`: `useQuery` devuelve `undefined` mientras carga una query activa.
- `src/components/BotPortal.jsx:1817`: `rows = isAdmin ? (adminLogs ?? []) : (mySignals ?? [])`.
- `src/components/BotPortal.jsx:1825`: con filtro activo, el contador puede mostrar temporalmente `0 registros`.
- `src/components/BotPortal.jsx:1863-1869`: con filtro activo y `adminLogs === undefined`, el estado vacio puede mostrar temporalmente `Sin registros con los filtros actuales.`

Impacto:

Es un flicker/estado intermedio de UX cuando el admin aplica el primer filtro o cambia filtros. No fuga datos, no dispara la query sin filtro, no afecta a usuarios no-admin y no cambia el resultado final.

Recomendacion no bloqueante:

Agregar un estado de carga explicito, por ejemplo `const adminLoading = isAdmin && hasActiveFilter && adminLogs === undefined`, y usarlo para mostrar `Cargando registros...` en vez de `0 registros` / `Sin registros...` mientras Convex responde.

## Respuestas a las preguntas del prompt

1. **Gate correcto del filtro: GO.** `simulated === ''` representa "Real + Simulado", no acota nada y no debe contar como filtro activo. Esto coincide con "no volcar todo por defecto": para ver todo el admin debe acotar por fecha, asset, red o elegir "Solo real"/"Solo simulado".

2. **Flicker de estado vacio: GO con hallazgo Bajo.** Es aceptable para merge porque es solo UX transitoria, pero conviene distinguir carga con `adminLogs === undefined && hasActiveFilter`.

3. **Coherencia del contador: GO con hallazgo Bajo.** El pill puede mostrar `0 registros` mientras carga. No es incorrecto a nivel de datos persistidos ni seguridad, pero seria mas claro ocultarlo o mostrar carga hasta tener respuesta.

4. **Sin fugas de la query: GO.** La llamada queda en `'skip'` cuando `!isAdmin || !hasActiveFilter`. En la implementacion local de Convex, `useQuery` trata `args[0] === "skip"` como `skip = true` y arma `queries = {}` (`node_modules/convex/src/react/client.ts:871-884`), por lo que no suscribe ni ejecuta la query. `rg` encontro un solo consumo frontend de `api.tradesHistory.listAllSignals`, en `AuditLogPanel`, y el backend mantiene `requireAdmin` en `convex/tradesHistory.ts:125-135`.

5. **Regresion no-admin: GO.** La rama no-admin sigue usando `mySignals`, mantiene el contador visible por `!isAdmin`, conserva el mensaje de historial simulado y nunca habilita la query admin porque `isAdmin && hasActiveFilter` es falso.

## Pruebas y comandos revisados

- `git diff 47522f2 4633b43 -- src/components/BotPortal.jsx` - confirma el cambio exacto auditado.
- `git diff --stat 4633b43 beef808` - sin diferencias de codigo entre ambos commits.
- `git diff --name-status master...HEAD` - solo `src/components/BotPortal.jsx` y el prompt de auditoria; no `convex/`.
- `rg -n "listAllSignals|AuditLogPanel|mySignals|tradesHistory" src convex tests docs` - confirma unico consumo frontend de `listAllSignals`.
- `npm run typecheck` - OK.
- `npm test` - OK: 16 archivos, 254 tests pasados.
- `npx vite build --outDir /tmp/quantum-audit-logs-require-filter-build` - OK. Solo warnings habituales de Rollup/chunk size; sin error de build.

## Cierre

**GO para merge.**

El unico ajuste sugerido es mejorar el estado de carga del panel admin, pero no lo considero condicion necesaria para avanzar porque el objetivo principal de seguridad/privacidad operativa del panel se cumple: no hay volcado inicial de logs sin filtro.
