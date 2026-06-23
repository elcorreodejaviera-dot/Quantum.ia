# Auditoría CÓDIGO — el panel admin de logs de auditoría no vuelca todo por defecto

Audita el **CÓDIGO** del commit `4633b43` en la rama `feat/audit-logs-require-filter` (sobre `master` `47522f2`).
Emite **GO / NO-GO** por hallazgo. **Cambio frontend-only** (`src/components/BotPortal.jsx`, componente
`AuditLogPanel`), NO toca `convex/`. No es money-path: es solo visualización del panel de auditoría admin.

## Motivación

El panel **"Logs de auditoría"** (solo admin) ejecutaba `api.tradesHistory.listAllSignals` apenas se montaba y
listaba todos los registros de entrada (en la captura, 41) sin que el admin buscara nada. Decisión del usuario:
**no mostrar nada por defecto**; los registros deben aparecer solo cuando el admin acota con alguno de los
filtros que ya existían en el panel (fechas Desde/Hasta, asset, red, real/simulado).

## Cambio (a verificar)

En `AuditLogPanel({ isAdmin, mySignals })` (`BotPortal.jsx:1794`):

1. Nuevo `hasActiveFilter = Boolean(asset || network || simulated || fromDate || toDate)`.
2. La query queda en `'skip'` salvo que `isAdmin && hasActiveFilter`:
   `useQuery(api.tradesHistory.listAllSignals, isAdmin && hasActiveFilter ? {...} : 'skip')`.
3. El contador `N registros` solo se pinta si `!isAdmin || hasActiveFilter`.
4. El estado vacío para admin distingue:
   - sin filtro → *"Usá los filtros (fechas, asset, red o tipo) para buscar registros."*
   - con filtro y 0 resultados → *"Sin registros con los filtros actuales."*

`rows = isAdmin ? (adminLogs ?? []) : (mySignals ?? [])` y el botón **Exportar CSV** (solo si `rows.length > 0`)
quedan **sin cambios**. El usuario **no-admin** ("Historial simulado") queda intacto.

## Preguntas

1. **Gate correcto del filtro:** `simulated` arranca en `''` (opción "Real + Simulado") y solo deja de ser
   vacío al elegir "Solo simulado"/"Solo real". ¿Es correcto que "Real + Simulado" NO cuente como filtro activo
   (es decir, que para ver todo el admin deba poner una fecha u otro filtro)? ¿Coincide con la intención
   "no volcar todo por defecto"?
2. **Flicker de estado vacío durante la carga:** al aplicar el primer filtro, `adminLogs` es `undefined`
   mientras Convex responde → `rows = []` → se muestra brevemente *"Sin registros con los filtros actuales."*
   ¿Es aceptable o conviene distinguir el estado "cargando" (p. ej. `adminLogs === undefined && hasActiveFilter`)?
3. **Coherencia del contador:** con `hasActiveFilter` true pero query aún cargando, el pill muestra `0 registros`
   un instante. ¿Algún problema de UX/correctitud?
4. **Sin fugas de la query:** confirmar que con `'skip'` no se dispara ninguna llamada a `listAllSignals`
   (Convex no ejecuta queries en `'skip'`) y que no queda ningún otro punto que liste todos los registros sin
   filtro.
5. **Regresión no-admin:** confirmar que la rama `!isAdmin` (Historial simulado con `mySignals`) no cambió de
   comportamiento: contador siempre visible, sin gate de filtros.

## Verificación

`npx vite build` aislado OK. (No hay tests de este componente; señala si conviene alguno.)

Devuelve hallazgos + veredicto **GO / NO-GO**.
