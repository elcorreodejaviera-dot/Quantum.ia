# Plan JAV-94 — Hardening del Spot Grid (PR5)

Épica JAV-89. Seguridad operativa antes de producción amplia. **Toca el gate del motor (puede pausar
bots) → money-path adyacente** → flujo completo: plan → GO Codex → PR → CodeRabbit → GO → deploy.
DoD: typecheck OK · tests de no-duplicación pasan · auditoría de secretos limpia · **mainnet solo con GO
explícito de Javier**.

## Estado verificado (2026-06-22)

| Área del issue | Estado | Acción |
|---|---|---|
| 1. Alertas de error | ❌ no existe | **Implementar** |
| 2. Test no-duplicación post-restart | 🟡 hay idempotencia (cloid+generation+lease) sin test de restart | **Añadir test** |
| 3. Secretos en `elog` | 🟡 ~10 llamadas sin auditar | **Auditar + guard** |
| 4. dead-man-switch / scheduleCancel | ❌ no existe ("si encaja") | **Defer** (justificado) |
| 5. Feature flag global del módulo | 🟡 solo gate de mainnet | **Implementar** |

## Cambios

### Área 1 — Alertas de error (principal)
Cuando un grid pasa a `status="error"`, registrar un mensaje en **`alert_history`** (tabla existente:
`userId, alertType, pair, message, timestamp`) para que el dueño/admin se entere.

- Punto único: dentro de `setSpotGridStatus` (`convex/spotGridBots.ts`) cuando `status === "error"` **Y**
  el estado anterior NO era "error" (solo en la transición → no spamear cada ronda del cron). Insertar:
  `{ userId: bot.userId, alertType: "spot_grid_error", pair: bot.symbol, message: errorMessage ?? "Spot Grid en error", timestamp: Date.now() }`.
- `setSpotGridBootstrap` también setea `status:"error"` (fase semilla): que enrute por el mismo helper o
  duplique la inserción con la misma guarda de transición.
- Sin secretos en `message` (solo `errorMessage`, que ya es `safeError`/string acotado).

### Área 5 — Feature flag global del módulo
Apagar TODO el Spot Grid (testnet + mainnet), más allá del gate de mainnet.

- `system_config` key nueva `spotGridModuleEnabled` (ausente/true = encendido; legacy-safe).
- Chequear en `assertCreateGuards` (`spotGridBots.ts`) → bloquea **crear** si está off.
- Chequear en `assertSpotGridLiveAdmissibleInternal` → si off, `policy:"paused"` (pausa los vivos, no los
  borra; mismo patrón que el gate mainnet).
- Mutation admin `setSpotGridModuleEnabled({enabled})` (requireAdmin + `writeAdminLog`), como
  `setMainnetSpotGridApproval`. (UI admin opcional en este PR o follow-up.)

### Área 2 — Test no-duplicación post-restart
Test que simule un reinicio del worker a mitad de reconcile: nueva ronda con el mismo estado de DB y
lease re-tomado → verificar que `recordSpotGridOrder` (cloid determinista) y `closeCycleAndRepost`
(idempotente por `cycleSettled`) **no duplican** órdenes ni ciclos. Reusa el harness de
`tests/spotGridMutations.test.ts`.

### Área 3 — Auditoría de secretos en `elog`
- Revisar las ~10 llamadas `elog` de `spotGridEngine.ts`/`spotGridBots.ts`/`spotGridActions.ts`:
  confirmar que ninguna pasa `privKey`/`signature`/credencial (solo escalares allowlisted, patrón OBS-3).
- Añadir un **test/guard** que falle si un `elog` del spot grid recibe una clave sospechosa (o un grep en
  CI). Objetivo: que una regresión futura no filtre secretos.

### Área 4 — dead-man-switch (DEFER)
No se implementa: el `reconcileLease` (fencing por bot) + el gate live + el kill-switch global
(`tradingEnabled`) ya acotan el riesgo de un worker colgado, y un `scheduleCancel` real necesitaría un
scheduler dedicado fuera de la arquitectura actual del cron. Se documenta como follow-up si hace falta.

## Verificaciones para Codex
1. ¿La guarda "solo en transición a error" evita el spam del cron (1/min) pero captura todos los caminos
   (`setSpotGridStatus` + `setSpotGridBootstrap`)?
2. ¿El feature flag global cubre crear Y pausar vivos sin romper grids legacy (flag ausente = on)?
3. ¿`alert_history` es la tabla correcta (vs `alerts`, que es config de usuario)? ¿El dueño lo ve en su UI?
4. ¿El test de restart cubre de verdad el escenario (no solo idempotencia ya probada)?
5. ¿La auditoría de secretos necesita guard automatizado o basta la revisión manual?

## Refinamientos Codex (GO para implementar; mainnet sigue NO-GO hasta revisar diff)

1. **Flag bloquea ANTES del RPC:** el chequeo de `spotGridModuleEnabled` va en `assertCreateGuards`, que
   lo llama `preflightCreateSpotGridBot` (antes de tocar HL) **y** `persistSpotGridBot` → cubre el
   preflight, no solo el insert final. ✔ (confirmado: `spotGridBots.ts` preflight usa `assertCreateGuards`).
2. **Flag ausente = enabled** (legacy-safe): tratar `value?.enabled !== false` como encendido.
3. **Visibilidad de la alerta = DUEÑO** (no admin): `alert_history` es del usuario y lo ve en su UI. La
   visibilidad para admin se baja de alcance (follow-up; el admin ya ve `status=error`+`errorMessage` del
   bot). No prometer panel admin en este PR.
4. **Sanitizar `alert_history.message`:** el guard de secretos NO cubre `message` automáticamente. Como
   metemos `errorMessage` en el historial, pasar SIEMPRE por `safeError` + **truncar** (p.ej. 300 chars)
   antes de insertar. Aplica además del audit de `elog`.
5. **UI label:** añadir `spot_grid_error` a `ALERT_TYPE_LABELS` (`src/components/BotPortal.jsx`) para que
   no se vea crudo el `alertType` en el historial.
6. **Test de restart = takeover real:** simular **lease vencido reclamado por otro worker** en una 2ª
   ronda (no dos llamadas con el mismo token) → demostrar el caso "worker murió y otro retomó" sin
   duplicar. El harness actual ya cubre idempotencia básica.

## Comprobaciones
- `npm run typecheck` limpio.
- `npm test -- --run` verde (incl. test de restart/takeover nuevo).
- Auditoría de secretos limpia (`elog` + `alert_history.message` saneado).
