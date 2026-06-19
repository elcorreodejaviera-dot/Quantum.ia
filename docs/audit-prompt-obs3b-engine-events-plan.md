# Prompt de auditoría Codex — PLAN de OBS-3b (`engine_events`)

Eres un auditor senior. Audita el PLAN (no hay código aún) de OBS-3b para Quantum.ia (portal de bots
sobre Hyperliquid, capital real). OBS-3 (logs `elog` en el money-path) ya está mergeado; esto persiste
un subconjunto de hitos en una tabla nueva `engine_events` para el panel admin.

Lee el plan:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
sed -n '1,200p' $R/docs/plan-obs3b-engine-events.md
# Contexto: tablas análogas ya mergeadas (mismo patrón a evaluar)
git -C $R show HEAD:convex/schema.ts | sed -n '266,289p'   # admin_logs (OBS-1) + cron_health (OBS-2)
```

Responde **GO / NO-GO del plan** con hallazgos numerados (ALTO/MEDIO/BAJO). Decide en particular:

1. **Transaccional vs desacoplado (LA decisión clave).** El plan recomienda insertar `engine_events`
   DENTRO de la mutation del motor (como `admin_logs` de OBS-1), aceptando que un insert defectuoso
   abortaría la transacción de trading, mitigado por diseño (solo escalares, schema con `v.optional`,
   helper trivial). La alternativa es `ctx.scheduler.runAfter(0, …)` (no aborta, pero pierde la
   garantía "no event sin efecto" y añade complejidad). ¿Apruebas la transaccional? ¿O hay un hito
   concreto (p.ej. dentro del envío a HL en `hyperliquid.ts`, que es un action, no mutation) donde el
   insert NO encaja y debe ser scheduled?

2. **¿Puede el insert abortar trading? (CRÍTICO).** Con esquema de solo escalares + `v.optional` en lo
   no esencial + helper sin lecturas/lógica, ¿queda algún modo de fallo realista del `ctx.db.insert`
   que aborte la mutation? ¿Falta algún `v.optional`? ¿Algún campo debería ser `v.string()` libre en
   vez de `v.id(...)` para no acoplar la validación a la existencia del doc?

3. **Subconjunto de hitos correcto.** El plan persiste solo hitos de valor (transiciones a
   filled/protected/closed/failed + reason, bloqueos de gate, rearm_outcome, cap_rejected,
   emergency_close) y excluye `reserved`/`submitting`/`gate_ok` de cada intento. ¿Es el corte
   adecuado para el panel sin inflar la tabla? ¿Falta o sobra alguno?

4. **Sin secretos.** Mismos campos prohibidos que `elog` (claves, tradingAccountAddress, payloads SDK,
   errores crudos). El esquema solo lleva ids/estados/enums/`reason` (categoría). ¿Algún campo se cuela?

5. **Retención/poda.** Cron diario `pruneEngineEvents` por lotes con `by_at`, envuelto en
   `withCronHealth` (OBS-2) para no afectar money-path. ¿Retención (30d) y batch razonables? ¿Riesgo de
   borrado masivo o de que la poda compita con escrituras?

6. **TS2589.** El helper usa `ctx.db` → riesgo de arrastrar el grafo `api` como pasó en JAV-77. El plan
   propone tipar `{ db: DatabaseWriter }` (como `coverageUsage.ts`). ¿Suficiente, o hay que aislar más?

7. **Índices.** `by_at` (poda + feed global), `by_bot_at`, `by_arm_at` (paneles). ¿Cubren las queries
   previstas sin índices de más?
