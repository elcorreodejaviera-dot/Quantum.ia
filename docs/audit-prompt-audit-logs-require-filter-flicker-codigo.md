# Auditoría CÓDIGO (addendum) — estado "Cargando…" en logs de auditoría (deuda baja del GO previo)

Audita el **CÓDIGO** del commit que agrega el estado de carga, en la rama `feat/audit-logs-require-filter`
(sobre el GO previo `0c33b52`). Emite **GO / NO-GO**. **Cambio frontend-only** (`src/components/BotPortal.jsx`,
`AuditLogPanel`), no toca `convex/`. Resuelve la única observación BAJA del informe previo
(`docs/audit-codex-audit-logs-require-filter-codigo.md`): el flicker de `0 registros` / "Sin registros…"
mientras Convex resuelve la query tras aplicar un filtro.

## Cambio

1. Nuevo `adminLoading = isAdmin && hasActiveFilter && adminLogs === undefined`.
   Distingue la carga real del `'skip'` (que también deja `adminLogs === undefined` pero sin filtro activo).
2. Pill del contador: `adminLoading ? 'Cargando…' : '{rows.length} registros'` (la condición de visibilidad
   `!isAdmin || hasActiveFilter` no cambió).
3. Estado vacío admin: si `adminLoading` → *"Cargando registros…"*; si no, se mantiene la lógica previa
   (sin filtro → "Usá los filtros…"; con filtro y 0 → "Sin registros con los filtros actuales.").

## Preguntas

1. ¿`adminLogs === undefined` es la señal correcta de "cargando" en Convex `useQuery`, y queda bien excluido
   el caso `'skip'` (sin filtro) gracias a `hasActiveFilter`?
2. ¿Hay algún caso en que `adminLogs` legítimamente devuelva `undefined` con filtro activo y datos ya
   resueltos (que dejaría "Cargando…" pegado)? Confirmar que `listAllSignals` siempre resuelve a un array.
3. ¿El no-admin queda 100% intacto (no entra nunca en `adminLoading`)?

## Verificación

`npx vite build` aislado OK. (Sin tests de este componente.)

Devuelve hallazgos + veredicto **GO / NO-GO**.
