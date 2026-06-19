# Prompt de auditoría Codex — CÓDIGO del panel de salud de crons (Fase 2, recortado)

Eres un auditor senior. Audita un cambio FRONTEND PURO para Quantum.ia: añade una sección read-only
"SALUD DE LOS CRONS" en `AdminView.jsx` que consume `api.cronHealth.listCronHealth` (OBS-2, ya
mergeada). Alcance recortado por decisión del usuario: el feed de `engine_events` se descartó por
solaparse con el "FLUJO DE ACTIVIDAD" existente. CERO cambios de backend.

Revisa el diff:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/obs-panel-fase2-cronhealth -- src/
```

Verificación ya hecha: `npm run typecheck` EXIT 0; `npx vite build` OK.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **Admin-gating correcto.** `listCronHealth` se llama con `isAdmin ? {} : 'skip'` (como el resto de
   AdminView). El componente se renderiza tras el guard `if (!me || me.role !== 'admin') return
   <Navigate>`. ¿Algún no-admin podría disparar la query?

2. **Sin datos sensibles.** La query ya devuelve solo escalares (name/last*/duración/fallos/lastError
   truncado). El componente no añade nada más. ¿Se muestra algo sensible?

3. **Robustez de render.** `CronHealthPanel` maneja `rows === undefined` (cargando) y `length === 0`
   (vacío). El badge del header usa `Array.isArray(cronHealth)`. ¿Algún acceso a campo que pueda
   reventar si un campo opcional viene `undefined` (lastSuccessAt/lastDurationMs/consecutiveFailures/
   lastError)? Revisa `agoShort(undefined)` → "nunca".

4. **Solo presentación, sin lógica de negocio.** El cambio no toca trading ni otras secciones. La
   lógica de estado del badge (red si fallos>0; amber si nunca corrió; green si OK) ¿es coherente?

5. **Convenciones.** Reusa `av-section`/`av-shead`/`av-feed`/`av-pill`/`timeShort`. ¿Introduce estilos
   o duplicación innecesaria? (`agoShort` es nuevo y mínimo, justificado porque `timeShort` da hora de
   reloj, no tiempo relativo.)
