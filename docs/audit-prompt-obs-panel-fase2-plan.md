# Prompt de auditoría Codex — PLAN del panel admin Fase 2 (observabilidad)

Eres un auditor senior. Audita el PLAN (no hay código aún) del panel admin de observabilidad para
Quantum.ia (portal de bots sobre Hyperliquid). Toda la observabilidad backend (OBS-1/2/3/3b) ya está
mergeada; esta fase es **frontend puro** que la muestra en `AdminView.jsx`.

Lee el plan y el contexto:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
sed -n '1,200p' $R/docs/plan-obs-panel-fase2.md
# Queries que consume (ya mergeadas, admin-gated):
git -C $R show HEAD:convex/engineEvents.ts | sed -n '80,120p'   # listEngineEvents
git -C $R show HEAD:convex/cronHealth.ts | sed -n '123,132p'    # listCronHealth
# Convenciones del panel admin actual:
grep -nE "av-section|av-shead|av-feed|Kpi|useQuery\(api\." $R/src/components/AdminView.jsx | head -30
```

Responde **GO / NO-GO del plan** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **¿Frontend puro de verdad?** El plan afirma cero cambios de backend. ¿`listEngineEvents` y
   `listCronHealth` cubren TODO lo que el plan quiere mostrar sin añadir/ampliar queries? Si falta algún
   campo (p.ej. nombre de bot para un evento), ¿lo dice el plan o se cuela un cambio backend?

2. **Seguridad/exposición.** Las dos queries ya hacen `requireAdmin` y devuelven solo escalares no
   sensibles. La sección se monta solo si `isAdmin`. ¿Hay riesgo de mostrar algo sensible o de que un
   no-admin dispare la query (el `'skip'` debe usarse como en el resto de AdminView)?

3. **Alcance correcto.** ¿Es razonable dejar el drilldown por bot/arm y el panel de riesgo para
   follow-ups, y entregar primero cron-health + feed global de eventos? ¿O hay algo de bajo coste que
   debería entrar ya?

4. **Coherencia de convenciones.** El plan dice reusar `av-section`/`av-shead`/`av-feed`/`Kpi`/`av-pill`
   y `useQuery(api.x, isAdmin ? {} : 'skip')`. ¿Suficiente para no introducir estilos/duplicación
   innecesaria?

5. **Verificación.** `npm run typecheck` + `npx vite build` (NO `npm run build`, que despliega Convex).
   ¿Correcto para un cambio frontend?
