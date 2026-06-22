# Auditoría de CÓDIGO — JAV-107 Fase 2: backend creación/config + reserva atómica + cap

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de la Fase 2 (ya
implementado). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas el
código; señala fallos de corrección, carreras, regresiones y huecos money-path. Trabaja sobre la rama
`feat/jav107-spot-defense` (checkout hecho). El plan con GO de Codex está en
`docs/plan-jav107-spot-defense.md`; la Fase 1 (schema+cloid) ya tuvo GO.

## Alcance de la Fase 2 (capa NON-node; NO envía órdenes a HL todavía)

La colocación real de órdenes y el reconcile son Fase 3 (`spotDefenseEngine.ts`, "use node"). Aquí está
la **fuente de verdad de reserva/cap/exclusividad** y los gates CAS. El bot defiende un holding spot con
un SHORT que dispara al CAER el precio a un trigger explícito (manual o anclado al DCA); reglas de cuenta
(JAV-102 por baseAsset) y tope de plan (JAV-77) como la cobertura.

## Diff a auditar (commit `f204445`)

### `convex/spotDefenseBots.ts` (nuevo)
- **Gate mainnet** `mainnetSpotDefenseApproved` (`getMainnetSpotDefenseApproval`/`setMainnetSpotDefenseApproval`
  admin + `getMainnetSpotDefenseApprovedInternal`). Espejo de `setMainnetSpotGridApproval`.
- **`validateSpotDefenseConfig`**: leverage [1,25], stopLossPct (0,100), bufferPct [0,100], triggerPrice>0,
  minCoveragePct [0,100], tps (gainPct>0, closePct∈(0,100]).
- **Exclusividad** `assertSpotDefenseAccountExclusivity(userId, hlAccountId, baseAsset, self?)`: rechaza
  mismo `baseAsset` en `bots` (cobertura/trading) o en otra `spot_defense_bots` viva de la cuenta, y
  cualquier `spot_grid_bots` no-`stopped`. Escanea por `by_user_account` / `by_account`.
- **`persistSpotDefenseBot`** (mutation): `requireBotManager` + `canTradeLive`; ownership de la posición
  (`spot_positions.userId === user.clerkId`) y de la credencial; gate mainnet si red mainnet; `baseAsset`
  vía `deriveBaseAsset(\`${pos.asset}/USDC\`)`; upsert por `(userId, spotPositionId)`; rechaza
  reconfigurar con arm vivo si `active`.
- **`reserveSpotDefenseArm`** (internalMutation, OCC — CORAZÓN): unicidad (1 arm no-terminal por bot);
  `generation=max+1`; gate mainnet + red; `usableReal = availableCollateral×(1−MARGIN_SAFETY_BUFFER) −
  committedMarginForAccount`; `appliedLeverage` = manual validado y `min(., maxLev)` o
  `min(AUTO_LEVERAGE_CAP, maxLev)`; **sizing CAPADO** `target = min(requested, usableReal×lev,
  remainingCoverageForKey)`, `size = floor(target/triggerPx, szDecimals)`,
  `effectiveNotionalUsd = size×triggerPx`; bloqueos por **min-notional ($10)** y **`minCoveragePct`**;
  `assertWithinPlanCoverageForKey` autoritativo con el nocional EFECTIVO; inserta arm (arming,
  desiredState armed) + orden `entry` (pending) con cloid `spotDefenseCloidInput(armId, gen, "entry")`.
- **CAS** `markArmSubmitting` (arming→submitting, token+lease, revalida desiredState/bot/red/gate/cap) y
  `gateArmBeforeOrder` (revalida bajo lease justo antes del envío; bloqueo→failed + libera lease).
- Queries `listMySpotDefenseBots`, `getSpotDefenseDetail` (ownership, órdenes topadas a 50),
  `pauseSpotDefenseBot` (marca disarmPending).

### `convex/coverageUsage.ts` (rediseño namespaced)
- Claves `poolCoverageKey(poolId)="pool:<id>"` y `spotDefenseCoverageKey(botId)="spot-defense:<id>"`.
- `consumedCoverageByPool` → **`consumedCoverageByKey`** (alias retro-compatible exportado): suma arms IL
  + execs legacy bajo `pool:<id>` (dedupe por pool con max) y `spot_defense_arms` vivos bajo
  `spot-defense:<id>` (unidad = `effectiveNotionalUsd`, fail-closed si falta). Guard de exhaustividad
  `SPOT_DEFENSE_ALL_STATUSES` (incluye `manual_intervention` como VIVO).
- `assertWithinPlanCoverageForKey(key, hedge)` (núcleo) + `assertWithinPlanCoverage(poolId,...)` delega;
  `coverageAdmissibleForKey` + `coverageAdmissible` delega; **`remainingCoverageForKey`** (cap restante
  para el sizing capado; Infinity=admin, 0=suspendido/sin plan).

### `convex/executions.ts`
- `committedMarginForAccount` ahora suma también el margen de `spot_defense_arms`
  (`SPOT_DEFENSE_OPEN_MARGIN_STATES`, `manual_intervention` incluido) → ningún motor doble-asigna colateral.

### Tests (`tests/spotDefenseBackend.test.ts`, harness actualizado)
Sizing capado por margen, bloqueo bajo `minCoveragePct`, bloqueo bajo min-notional, unicidad del arm,
regresión de `consumedCoverageByKey` (claves `pool:`/`spot-defense:` sin colisión, total correcto).

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **Atomicidad reserva/cap (Codex r2#1/#3):** ¿`reserveSpotDefenseArm` es realmente la fuente única de
   verdad y resiste carreras? Dos reservas concurrentes en la misma cuenta/plan: el OCC de Convex (las
   lecturas registradas de `committedMarginForAccount`/`consumedCoverageByKey`) ¿garantiza que una aborte,
   o hay una ventana de sobre-asignación de margen o sobre-cap? ¿El cap se revalida en
   `markArmSubmitting`+`gateArmBeforeOrder` con el nocional efectivo (no el pedido)?
2. **Sizing capado:** ¿es correcto `floor(target/triggerPx, szDecimals)` y recomputar
   `effectiveNotionalUsd = size×triggerPx` (siempre ≤ target, conservador)? ¿`appliedLeverage` manual
   acotado a `maxLev` y auto `min(AUTO_LEVERAGE_CAP, maxLev)` es coherente con `resolveLeverage`? ¿Puede
   `marginReserved` exceder `usableReal` por redondeo? ¿`MIN_PERP_NOTIONAL_USD=10` es el mínimo real de HL?
3. **Regresión coverageUsage (Codex test obligatorio):** el cambio de keying a `pool:<id>` ¿conserva
   EXACTAMENTE la dedupe por pool y los totales del bot de pool/grid vivos? ¿El alias
   `consumedCoverageByPool = consumedCoverageByKey` no rompe `admin.ts` (suma de `.values()`)? ¿Algún
   call-site de `assertWithinPlanCoverage`/`coverageAdmissible` cambia de comportamiento?
4. **committedMarginForAccount:** incluir `spot_defense_arms` ¿afecta el margen contado para el bot de
   pool/ejecuciones legacy (sobre-conteo que bloquee de más)? ¿`SPOT_DEFENSE_OPEN_MARGIN_STATES` cubre
   todos los estados que retienen margen (incl. `manual_intervention`, `unknown`)? ¿Fail-closed correcto?
5. **Exclusividad JAV-102:** ¿escanear por `hlAccountId` (no por `tradingAccountAddress`) basta, dado que
   la credencial es 1:1 con la cuenta? ¿`self` excluye el propio bot en upsert sin abrir un hueco? ¿Un
   spot-defense BTC + cobertura de pool BTC en la misma cuenta quedan correctamente rechazados?
6. **persist/ownership:** ¿`spot_positions.userId === user.clerkId` es la comparación correcta de
   propiedad? ¿El upsert por `(userId, spotPositionId)` impide duplicados, y el rechazo de reconfigurar
   con arm vivo evita dejar un trigger huérfano? ¿Falta revalidar exclusividad en `reserveSpotDefenseArm`
   (la cuenta podría haberse ocupado entre persist y reserve)?
7. **Gate mainnet:** ¿está en persist + reserve + ambos CAS? ¿Cerrado por defecto (ausente = no aprobado)?
8. **Huecos hacia Fase 3:** ¿falta algún campo/mutation que el motor necesitará y que obligue a tocar
   esta capa de nuevo (p.ej. liberar reserva al fallar, mutation de record/mark de órdenes, drift)?

Devuelve: lista de hallazgos (severidad + descripción + fix sugerido) y veredicto **GO / NO-GO**.
Verde actual: `npm run typecheck` EXIT 0, `npm test` 209/209.
