# Fase 2 — Panel admin de observabilidad del motor (consume OBS-2/OBS-3b)

## En una frase

Toda la observabilidad backend (OBS-1/2/3/3b) ya está mergeada, pero parte NO se ve en el portal:
`listCronHealth` (OBS-2) no tiene UI, y `engine_events` (OBS-3b) tampoco. Esta fase añade una sección
**read-only** en `AdminView.jsx` que los muestra → el "panel de verdad" del plan de mejoras (Fase 2).

## DECISIÓN (2026-06-19): alcance recortado a SOLO salud de crons

Tras revisar, el "FLUJO DE ACTIVIDAD" (`listActivity`) ya muestra el estado en vivo de ejecuciones y
arms → el panel de eventos del motor (`listEngineEvents`) se SOLAPA y se DESCARTA de esta entrega
(`engine_events` sigue siendo útil como audit trail consultable, pero no necesita feed propio en la UI
por ahora). Se implementa SOLO el panel de **salud de crons** (`listCronHealth`), que es lo único
genuinamente ausente de la UI. El resto (feed de eventos, drilldown bot/arm, panel de riesgo) → diferido.

## Alcance (frontend puro, CERO backend)

NO se toca Convex. Las queries ya existen, admin-gated (`requireAdmin`):
- `api.cronHealth.listCronHealth` (OBS-2) — una fila por cron: last started/success/error, duración,
  fallos consecutivos.
- `api.engineEvents.listEngineEvents` (OBS-3b) — feed global de hitos del motor (sin filtro = últimos N
  por `by_at`). Soporta `{ botId }` o `{ armId }` (excluyentes) — el drilldown por bot/arm queda para
  un follow-up, no en este PR.

## Diseño

Una sección nueva en `AdminView.jsx`, siguiendo las convenciones existentes (`av-section`, `av-shead`,
`av-feed`, `Kpi`, `av-pill`), montada solo si `isAdmin` (igual que las demás). Dos paneles:

### 1. Salud de los crons (`listCronHealth`)
Tabla/lista: nombre del cron, "hace cuánto" del último success, badge de estado:
- verde si `lastSuccessAt` reciente y `consecutiveFailures === 0`.
- ámbar/rojo si `consecutiveFailures > 0` o `lastErrorAt > lastSuccessAt`.
- muestra `lastError` (ya viene truncado del backend) y `lastDurationMs`.
Da de un vistazo "¿está vivo el motor?" (los 6 crons + la poda de engine_events).

### 2. Eventos del motor (`listEngineEvents`, feed global)
Lista de los últimos ~100 eventos: tiempo relativo, `scope` (exec/arm/rearm/hl), `event`,
`fromStatus → toStatus`, `reason`. Badge de color por scope o por estado terminal (failed = rojo,
closed/protected = verde, etc.). Formateo de ids cortos (no exponen nada sensible; la tabla ya es segura).

### Detalles UI
- Reusar helpers de tiempo relativo existentes en el portal si los hay; si no, uno local mínimo.
- `useQuery(api.x, isAdmin ? {} : 'skip')` como el resto de `AdminView`.
- Estados de carga/vacío coherentes con las otras secciones ("Sin registros…").
- Sin polling manual: Convex `useQuery` ya es reactivo.

## Lo que NO entra (follow-ups)
- Drilldown por bot/arm (selector + `listEngineEvents({botId|armId})`).
- Panel por arm con CLOIDs/OIDs/órdenes vivas en HL (necesita lecturas on-chain → otra fase).
- Panel de riesgo (LP/exposición/liquidation).

## Verificación

```bash
npm run typecheck
npx vite build
```
(NO `npm run build`: desplegaría Convex.)

Revisar en el navegador (testnet) que la sección renderiza, los badges reflejan el estado, y que NO
aparece ningún dato sensible.

## Riesgos

- Muy bajo: frontend read-only, sin backend, admin-gated. El único riesgo es de presentación
  (formato/estado de badges) → se valida visualmente.

## Flujo

plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → merge.
