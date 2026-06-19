# Prompt de auditoría Codex — CÓDIGO de Fase 6-C (auditoría de pool)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de la Fase 6-C de Quantum.ia: "modo auditoría de pool"
(vista admin read-only). El plan ya tiene tu GO (con 2 cautelas que se incorporaron). NO toca money-path.

Revisa el diff:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/fase6c-auditoria-pool -- convex/ src/ tests/ docs/
```

Verificación ya hecha: `npm test` → 83 verdes (incl. `tests/poolAudit.test.ts` 16); `npm run typecheck`
OK; `npx vite build` OK.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **`admin.getUserPoolAuditData` segura (CRÍTICO).** `requireAdmin`, solo lectura DB (bots.by_user →
   pool por poolId → trigger_arms.by_bot_generation `take(5)` → trigger_orders.by_arm_role). ¿Devuelve
   SOLO campos operativos (ids/estados/números/triggers) y NADA sensible (sin credenciales/direcciones)?
   ¿Algún índice mal usado o lectura O(n²) peligrosa? (`take(AUDIT_ARMS_PER_BOT=5)` acota — Codex BAJO#1.)

2. **Checks puros correctos (CRÍTICO).** `src/lib/poolAudit.js`: los 9 checks reflejan inconsistencias
   reales, no falsos positivos. Verifica:
   - terminal vs vivo (ARM_TERMINAL), `pool_closed_with_live_arm` es DB-only.
   - `triggers_vs_edges` usa drift RELATIVO `EDGE_DRIFT_PCT=0.005`, no igualdad.
   - `hedge_vs_exposure` con `HEDGE_BAND=0.25`; `unknown` si falta dato o si cuenta+coin es AMBIGUA
     (varios bots misma cuenta+coin — detectado desde la DATA DB en `auditUserPools`, Codex BAJO#2).
   - `hlCoin(baseAsset)` para mapear `coverageByAccountCoin[hlAccountId][coin]`.
   - veredicto: warn > unknown > ok; ✅ solo si todo verificable. NUNCA falso ✅.

3. **Mapeo live↔bot.** En `PoolAuditPanel`, `liveByBot` deriva `liquidityUsd`/`inRange` de
   `live.positions[botId]` y `coverageUsd` de `live.coverageByAccountCoin[hlAccountId][hlCoin(baseAsset)]`;
   `present=!!live.positions[botId]`. ¿Correcto? ¿`present=false` (pool cerrado/sin tokenId, que el
   snapshot omite) lleva a `unknown` en hedge, no a falso ✅?

4. **Sin duplicar lógica.** `hlCoin` ahora se importa de `poolAudit` (se borró el duplicado de
   AdminView). ¿Alguna referencia rota?

5. **Read-only / sin impacto producción.** El diff toca `convex/admin.ts` (1 query nueva read-only),
   `src/lib/poolAudit.js`, `AdminView.jsx`, `bot-portal.css`, `tests/`, `docs/`. NADA del motor/money-path.
   La query es admin-gated. ¿Confirmado? ¿Algún dato sensible expuesto en la vista?
