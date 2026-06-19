# Prompt de auditoría Codex — CÓDIGO de los 3 OBS (OBS-1, OBS-2, OBS-3 PR1)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de tres mejoras de observabilidad para Quantum.ia
(portal de bots sobre Hyperliquid, capital real). Los planes ya tienen tu GO. Cada una está en su
rama, basada en `master`. Revisa los diffs:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/obs1-admin-audit -- convex/ src/
git -C $R diff master...elcorreodejaviera/obs2-cron-health -- convex/
git -C $R diff master...elcorreodejaviera/obs3-engine-logging-pr1 -- convex/
```

Verificación ya hecha: `npm run typecheck` EXIT 0 en las tres; OBS-1 además `vite build` OK.

Responde, **por rama**, **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO).

## OBS-1 (rama obs1-admin-audit) — auditoría server-side de acciones admin
Archivos: `helpers.ts` (+`writeAdminLog`), `systemConfig.ts`, `subscriptions.ts`, `users.ts`,
`src/components/BotPortal.jsx`.
1. **Atomicidad:** `writeAdminLog` inserta en `admin_logs` DENTRO de cada mutation admin → ¿confirma
   junto con el efecto (Convex transaccional)? ¿Algún path que aplique el efecto y NO loguee, o
   viceversa?
2. **Cobertura:** ¿están instrumentadas TODAS las sensibles? `set_trading_enabled`,
   `set_simulation_mode`, `set_subscription_plan`, `set_user_suspended`, `grant_permission`,
   `revoke_permission`. ¿`prev`/`prevPlan` se capturan ANTES del patch? ¿`grantPermission`/
   `revokePermission` (helpers compartidos) cubren las 4 mutations grant/revoke?
3. **Sin secretos / coherencia:** `meta` solo lleva ids/plan/booleans (nada de claves/credenciales).
   `admin.clerkId` coherente con `admin_logs.userId: v.string()`.
4. **Frontend:** se eliminó `logAdminAction({kill_switch})` y la declaración de `logAdminActionMutation`.
   El kill switch queda registrado server-side vía `set_trading_enabled`+`set_simulation_mode`. ¿Se
   pierde algún matiz operativo? ¿`logAdminAction` (systemConfig) queda huérfano — eliminar o dejar?

## OBS-2 (rama obs2-cron-health) — health/heartbeat de los crons
Archivos: `schema.ts` (+`cron_health`), `cronHealth.ts` (nuevo), `crons.ts`.
5. **NO romper crons money-path (CRÍTICO):** `crons.ts` apunta a 6 wrapper internalActions; cada uno
   hace `withCronHealth(ctx, name, () => ctx.runAction(internal.<real>, {}))`. ¿`withCronHealth`
   garantiza que un fallo escribiendo `cron_health` NUNCA aborte ni marque como fallido el cron real?
   (`safeHealth` traga con `console.warn`.) ¿El error REAL del cuerpo se re-lanza intacto y se conserva
   el retorno?
6. **Wrappers correctos:** ¿los 6 `internal.<real>` referenciados existen y son los mismos que antes
   apuntaba `crons.ts` (defillama/uniswap/poolScanner/executionsCron/triggerEngine×2)? ¿Algún cambio de
   semántica al pasar por `runAction` (timeouts, reintentos, scheduling de Convex)?
7. **Registro:** `recordCronStart/Success/Error` (upsert por `by_name`); ¿`consecutiveFailures` se
   resetea SOLO en success e incrementa en error? ¿`lastError` truncado (300)? ¿La tabla `cron_health`
   es distinta de las money-path → sin contención OCC con el cuerpo?
8. **Query admin:** `listCronHealth` con `requireAdmin`. OK.

## OBS-3 PR1 (rama obs3-engine-logging-pr1) — logging estructurado (helper + auto-rearm)
Archivos: `log.ts` (nuevo, módulo hoja), `triggerRearm.ts`.
9. **Cero cambio de lógica (CRÍTICO):** los `elog(...)` añadidos en `recordRearmOutcome` — ¿NO alteran
   control de flujo (no en condiciones, no en short-circuits, no capturan/descartan excepciones)? ¿El
   diff solo AÑADE llamadas a `elog`?
10. **Sin secretos:** `elog` acepta SOLO escalares (`Scalar`) → imposible pasar objeto/clave. Los
    campos logueados (`botId` stringificado, `outcome`, `kind`, `attempts`, `nextRearmAt`) — ¿alguno
    sensible? ¿Se evita loguear `error` crudo? ¿`safeError` trunca sin stack/payload?
11. **Módulo hoja:** `log.ts` sin funciones Convex ni imports del grafo `api` → no reintroduce TS2589.
12. **Alcance/troceo:** PR1 = `log.ts` + `triggerRearm.ts`. `coverageUsage.ts` (gates) se difiere a
    tras mergear JAV-79 (PR #78) para evitar conflicto. ¿Razonable?

## Transversal
13. **CLAUDE.md:** ¿los tres respetan "no mezclar refactor amplio con lógica de trading"? ¿Alguno toca
    una decisión money-path? (No deberían: OBS-1 solo añade logs en mutations admin; OBS-2 no toca los
    cuerpos; OBS-3 solo añade `elog`.)

Cita archivo:línea. Para cada rama: si NO-GO, lista EXACTAMENTE qué cambiar. Si GO, dilo para proceder
a push → PR → CodeRabbit (orden de merge sugerido: OBS-1, OBS-2, OBS-3 PR1).
