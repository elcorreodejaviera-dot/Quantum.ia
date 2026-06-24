# Prompt de auditoría (Codex) — CÓDIGO: armar a mercado cuando el precio ya cayó bajo el borde (Benjamin)

**RE-AUDITORÍA (R2).** El commit base `e9f5613` recibió NO-GO (informe en
`docs/audit-codex-arm-market-on-drop-benjamin-codigo.md`: 2 Altos + 1 Medio + 1 Bajo). El commit
`dbd8191` corrige los cuatro. Audita la rama `feat/arm-market-on-drop-benjamin` completa
(`master..dbd8191`): `convex/triggerEngine.ts`, `convex/triggerArms.ts`, `tests/stateMachine.test.ts`.
Cambio **money-path**. Veredicto **GO / NO-GO**.

## Correcciones aplicadas en dbd8191 (verifica que resuelven cada hallazgo)

- **Alto-1 (nocional del IOC):** en `triggerEngine.ts`, justo ANTES del loop de envío, si
  `entryLowerImmediate` se relee el mark FRESCO (`getAssetMeta`) → `immediateMarkPx` y
  `entryImmediateAtSend = !(immediateMarkPx > triggerPxNorm)`. Solo se envía el IOC a mercado si el
  precio SIGUE en/bajo el borde (la banda usa `immediateMarkPx`); si rebotó por encima, se coloca el
  trigger en reposo (válido). Si la lectura fresca falla → `releaseArmReconcile` + return gated.
  ¿Acota de forma DURA `avgPx ≤ notionalCapPx` (= `triggerPxNorm*1.02`), dado que solo se entra con
  `freshMark ≤ triggerPxNorm` y la venta agresiva llena en bids ≤ freshMark? ¿Queda residual y es
  equivalente al ya aceptado en la nota JAV-43 del trigger normal?

- **Alto-2 (rechazo atrapado por cuarentena):** nueva mutation `failArmEntryRejected` en
  `triggerArms.ts`. Ante `stE.error` explícito (`explicitReject`), el motor la llama ANTES de
  `settleArm`: terminaliza a `failed` SIN cuarentena N6 y reprograma vía `markRearmBlockedIfEligible`
  (paridad con `failArmPreOrder`). Guard fail-closed: `status==="submitting"`, sin fill, toda entrada
  sin `oid`/`submittedAt` con `observedStatus` rejected/pending y ≥1 rejected; si no, `ok:false` y el
  caller cae a `settleArm`. ¿Es seguro saltarse la cuarentena (un `stE.error` síncrono prueba que NO
  hubo orden viva ni en vuelo)? ¿El guard impide terminalizar si algo quedó vivo (oid/submittedAt)?

- **Medio (fill parcial):** telemetría `elog("arm","immediate_partial_fill",…)` cuando el IOC llena
  `< size*0.99`. El SL del reconcile ya protege sobre `szi` real; el remanente NO se reintenta en el
  ciclo. ¿Aceptable como mitigación (observabilidad) sin reintroducir riesgo?

- **Bajo (tests):** 4 casos de `failArmEntryRejected` en `stateMachine.test.ts` (rechazo→failed sin
  cuarentena pese a submittedAt reciente; guard oid vivo; guard sin rechazo explícito; fencing).
  258 tests OK. ¿Cobertura suficiente del nuevo path a nivel de mutation?

Confirma además que las correcciones NO introdujeron regresiones en el path normal
(`markPx > triggerPxNorm`) ni en la entrada inmediata feliz (IOC filled completo → settle/reconcile).

## Contexto original del cambio (sin cambios respecto a R1)

Audita el código de la rama `feat/arm-market-on-drop-benjamin`. Plan aprobado en
`~/.claude/plans/serene-dancing-puddle.md` (resumen abajo). Es un cambio **money-path** en el
armado de cobertura (Hyperliquid perps).

## Qué hace el cambio

Antes: en `armBotInternal`, si `markPx ≤ triggerPxNorm` (precio ya en/bajo el borde inferior del
rango), el motor lanzaba `[transient]` y NO armaba — el auto-rearm reintentaba cada 5 min. Problema:
ante un **desplome** que atraviesa el borde de un salto, la cobertura quedaba SIN armar justo en la
caída (caso real Benjamin: `mark 1640.3 ≤ triggerPx 1645.8`, rearmado en bucle sin cubrir).

Ahora, cuando `markPx ≤ triggerPxNorm` (`entryLowerImmediate = true`):
1. **No bloquea**: levanta el flag `entryLowerImmediate` en vez de lanzar `[transient]`.
2. **Sin 2ª entrada**: `upperValid` incluye `!entryLowerImmediate` → no hay `entry_upper`
   (breakout/reentry), `factor = 1`, sin OCO ni pata superior en reposo.
3. **Entrada a MERCADO**: para `entry_lower`, en el loop de envío, en vez de un trigger en reposo
   (`t: { trigger: {…} }`) manda una venta IOC agresiva contra el `markPx` actual
   (`t: { limit: { tif: "Ioc" } }`, `enLimitPx = aggressiveHlPriceStr(markPx*(1-slip), …, false)`).

El caso normal (`markPx > triggerPxNorm`) queda **idéntico**: trigger en reposo, OCO, etc.

## Verifica GO/NO-GO

1. **Sizing / margen**: `size` y `notionalCapPx` SIGUEN calculados con `triggerPxNorm` (no markPx).
   El fill IOC ocurre a `markPx < triggerPxNorm` ⇒ ¿el nocional REAL (`size*markPx`) es siempre
   ≤ lo reservado por `reserveArm` (`orderNotional = size*notionalCapPx`)? ¿Confirmas que NUNCA
   puede exceder margen/reserva por este camino (conservador), incluido el slippage del IOC?

2. **IOC vs trigger**: ¿el shape `t: { limit: { tif: "Ioc" } }` con `b:false, r:false, p:enLimitPx`
   es correcto para una venta a mercado en el SDK de HL (mismo patrón que el cierre IOC de la fase
   post-fill, ~línea 627)? ¿La banda agresiva floor contra markPx garantiza fill sin cruzar a un
   precio peor que el esperado de forma peligrosa?

3. **OCO / 2ª entrada eliminada**: con `entryLowerImmediate`, `twoEntries=false`, `factor=1`,
   `reservedNotional = orderNotional`. ¿Queda algún camino donde `entry_upper`/`cloidUpper` se
   genere o se reserve 2× pese al flag? ¿`reserveArm` recibe coherentemente `armMode:"oco"` SIN
   `upperEdge`/`entryUpperMode`/`allowReentryFromAbove`?

4. **Fill inmediato → settle → reconcile**: el IOC llena al instante ⇒ `anyFilled=true`,
   `settleArm(status:"filled")`, `setArmFilledEntryRole("entry_lower")`. ¿El reconcile post-fill
   coloca SL/TPs sobre `szi`/`entryPx` REALES sin asumir que la entrada fue un trigger? ¿Algún
   invariante posterior (TP-final, breakeven, armed_lower_only) se rompe al no existir `entry_upper`?

5. **Idempotencia de re-armado**: con `rearmToken`/CLOID determinista, si el IOC se confirma fuera
   de banda (TransportError) ¿se evita el doble-envío/doble-posición en el siguiente ciclo? ¿La ruta
   `transportUncertain`/`unknown` reconcilia bien un IOC (que NO queda "waitingForTrigger")?

6. **Rechazo del IOC** (sin liquidez/precio fuera de banda): cae en `stE?.error` → `rejected/failed`
   + `releaseArmReconcile`. ¿Confirmas que NO deja reserva de margen colgada?

7. **Regresión**: ¿el path `markPx > triggerPxNorm` es byte-equivalente al anterior (mismo trigger,
   mismo OCO, mismo sizing)? ¿`entryLowerImmediate` no afecta `reentry_coexist` ni la perforación
   `entryLowerTriggerPx`?

8. **Precondiciones flat**: el gate flat (sin posición/órdenes abiertas, líneas ~183-191) sigue
   ANTES del armado ⇒ la entrada a mercado no abre sobre una posición preexistente. ¿Correcto?

Señala cualquier riesgo de sobre-ejecución de nocional/margen, doble posición, o estado colgado.
