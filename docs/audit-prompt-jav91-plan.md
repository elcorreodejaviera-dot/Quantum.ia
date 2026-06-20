# Prompt de auditoría Codex — PLAN de JAV-91 (QSG PR2: schema + backend)

Eres un auditor senior. Audita el **PLAN** (no código) de la Sub-2 de la épica Quantum Spot Grid Live
(JAV-89) en Quantum.ia. Es backend **live-only** que **NO envía órdenes** (el motor/stop van en PR3).
Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO).

## Documentos
- Plan: `docs/plan-jav91-schema-backend.md`
- Connector ya mergeado (PR1/JAV-90): `convex/hyperliquidSpot.ts` + `convex/cloids.ts`.
- Linear JAV-91 (spec base, iterada r1-r4) y comentarios de JAV-89/JAV-91 (invariante cuenta exclusiva).

## Verifica
1. **Esquema completo y correcto.** ¿Las 3 tablas (`spot_grid_bots`/`orders`/`cycles`) + el gate
   mainnet sobre `system_config {key,value}` cubren lo que PR3 (motor) necesitará? ¿Índices suficientes
   (`by_user`, `by_status_updated`, `by_account`, `by_bot_status`, `by_cloid`, `by_bot_cycle`)?
   ¿Falta algún campo para idempotencia/reconcile (generation, cycleId, fillCursor, pendingSellQty)?
2. **Guard live + permiso de gestión + gate mainnet.** `createSpotGridBot`: **requireBotManager
   (canManageBots) + requireTradeLive (canTradeLive) — AMBOS** (crear bots es permiso de gestión, no
   basta canTradeLive) + tradingEnabled + !simulationMode + assertExpectedNetwork + confirm explícito;
   mainnet rechazado salvo `mainnetSpotGridApproved.enabled`. ¿Algún hueco? ¿`setMainnetSpotGridApproval`
   bien protegido (requireAdmin + writeAdminLog)?
3. **🔑 Invariante cuenta HL exclusiva.** ¿El plan exige rechazar una `hlAccountId` cuya
   `tradingAccountAddress` ya use cualquier `bots` (IL/Trading) o `spot_grid_bots`? ¿Es correcta la
   justificación (spot y perp comparten wallet en HL)? ¿Cómo verificar exclusividad eficientemente
   (índices `by_trading_account` en `hl_api_credentials` + `by_account` en ambas tablas de bots)?
4. **Dedupe sin unicidad nativa.** ¿`lookup-before-insert by_cloid` en la misma mutation es suficiente
   en Convex (transacción serializable)? ¿Algún punto de PR2 que inserte orders/cycles y necesite dedupe?
5. **Alcance (NO money-path en PR2).** Confirmar que NINGUNA mutation de PR2 envía/cancela órdenes en HL
   ni programa crons; `stopSpotGridBot` correctamente diferido a PR3.
6. **Ownership/scoping.** list/get/pause/create scoped por `userId`; queries internas para el motor.
7. **Tests.** ¿La cobertura propuesta (guards, gate mainnet, exclusividad de cuenta, inputs, allowlist,
   ownership) congela el contrato? ¿Falta algún caso (p.ej. aceptar mainnet tras aprobación)?
8. **Reuso correcto de PR1.** ¿Usa `resolveSpotAsset`/allowlist y `toHlCloid`/`spotGridCloidInput` del
   connector sin duplicar lógica?
