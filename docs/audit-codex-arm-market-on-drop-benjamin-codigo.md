# Auditoria Codex R2 - arm market on drop Benjamin

Fecha: 2026-06-24

## Veredicto

**GO condicionado**

Los dos hallazgos **Altos** del NO GO anterior quedan mitigados en el codigo de `dbd8191`: el IOC inmediato ya no usa un mark rancio y el rechazo explicito de HL ya no queda atrapado por la cuarentena generica. No encontre bloqueantes ni altos nuevos.

Condicion antes de operacion real: agregar una comprobacion/telemetria post-fill para detectar `entryPrice/avgPx > notionalCapPx` en el IOC inmediato, porque el codigo acota el riesgo con `freshMark <= triggerPxNorm`, pero no verifica en datos el precio medio finalmente reportado por HL.

## Alcance auditado

- Prompt R2: `docs/audit-prompt-arm-market-on-drop-benjamin-codigo.md`
- Plan aprobado: `/home/bicho/.claude/plans/serene-dancing-puddle.md`
- Rama: `feat/arm-market-on-drop-benjamin`
- HEAD revisado: `4d0ae26` (`docs(benjamin): audit-prompt R2 para re-revisión Codex`)
- Commit de codigo auditado: `dbd8191` (`fix(benjamin): corregir 2 Altos + Medio del NO-GO de Codex`)
- Rango de codigo: `master..dbd8191`
- Archivos de codigo/test: `convex/triggerEngine.ts`, `convex/triggerArms.ts`, `tests/stateMachine.test.ts`

Nota: el working tree tiene cambios locales ajenos al money-path (`src/components/BotPortal.jsx`, `convex/_generated/api.d.ts`, imagenes/screenshot). No forman parte de esta auditoria.

## Hallazgos

### Bloqueante

Ninguno.

### Alto

Ninguno.

### Medio

1. **La cota de nocional del IOC esta mitigada, pero no verificada contra el fill real.**

   El fix relee `markPx` fresco justo antes del envio (`convex/triggerEngine.ts:349-365`) y solo mantiene el IOC si `immediateMarkPx <= triggerPxNorm`; si el precio reboto por encima, cae al trigger en reposo (`convex/triggerEngine.ts:389-395`). Esto elimina el riesgo principal del R1: enviar un IOC con un mark viejo tras un rebote.

   Riesgo residual: el codigo asume que una venta IOC ejecuta contra bids `<= freshMark`, pero no comprueba despues del fill que `avgPx/entryPrice <= notionalCapPx`. Para una venta, un fill mas alto es mejor en PnL, pero puede superar la cota contable `orderNotional = size * notionalCapPx` si HL reporta un `avgPx` por encima de esa cota. Recomiendo registrar o bloquear explicitamente esa desviacion post-fill.

2. **Fallo al releer mark fresco queda en ruta reconciliable con cuarentena aunque no se envio orden.**

   Si `getAssetMeta` falla en la relectura fresca, el motor libera el lease y devuelve `fresh_mark_unavailable` (`convex/triggerEngine.ts:358-364`). Como esto ocurre despues de `markArmSubmitting`, el arm queda no terminal y depende del reconciliador/cuarentena, aunque no salio ninguna entrada. Es consistente con rutas existentes de gate fallido, pero en este nuevo branch es una fuente adicional de espera sin hedge.

### Bajo

1. **La cobertura nueva de tests es buena para la mutation, pero no cubre el branch completo del action.**

   Los 4 tests nuevos validan `failArmEntryRejected` con rechazo explicito, guard con `oid`, guard sin rechazo y fencing (`tests/stateMachine.test.ts:142-203`). Falta cobertura directa de `armBotInternal` para: relectura de mark que mantiene IOC, rebote que cambia a trigger en reposo, `TransportError` del IOC y telemetria de fill parcial.

## Respuestas a los chequeos R2

1. **Sizing / margen: GO condicionado.** La relectura fresca antes del envio corrige el Alto R1 (`convex/triggerEngine.ts:349-365`). La reserva sigue usando `notionalCapPx = ceil(triggerPxNorm * 1.02)` y `orderNotional = size * notionalCapPx` (`convex/triggerEngine.ts:241-244`). Condicion residual: verificar el `avgPx` real reportado por HL frente a `notionalCapPx`.

2. **Shape IOC: GO.** `t: { limit: { tif: "Ioc" } }`, `b:false`, `r:false` es shape valido del SDK (`node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/order.ts:36-49`) y coincide con patrones IOC locales (`convex/hyperliquid.ts:314-315`, `convex/hyperliquid.ts:617-622`).

3. **OCO / segunda entrada eliminada: GO.** `upperValid` queda condicionado por `!entryLowerImmediate`, por lo que el modo inmediato no genera `entry_upper`, `cloidUpper` ni reserva 2x (`convex/triggerEngine.ts:253-283`).

4. **Fill inmediato -> settle -> reconcile: GO.** El fill persiste `filledSize`, `entryPrice` y `filledEntryRole`; el reconciliador usa `szi`/`entryPx` reales para SL/TPs (`convex/triggerEngine.ts:408-446`, `convex/triggerEngine.ts:525-532`).

5. **Idempotencia / TransportError: GO.** `reserveArm` conserva unicidad por generacion y consume el `rearmToken` atomicamente; `TransportError` cae en `unknown/armed` reconciliable sin abrir otra generacion mientras el arm siga vivo (`convex/triggerArms.ts:233-315`, `convex/triggerEngine.ts:424-450`).

6. **Rechazo del IOC: GO.** `failArmEntryRejected` terminaliza sin cuarentena solo bajo guards estrictos: `submitting`, lease vigente, sin fill, sin `oid/submittedAt`, y al menos una entrada `rejected` (`convex/triggerArms.ts:847-883`). El caller la usa antes de `settleArm` cuando hubo `stE.error` (`convex/triggerEngine.ts:419-464`).

7. **Regresion path normal: GO.** Si el mark inicial esta por encima del borde, `entryLowerImmediate=false`; no se ejecuta la relectura inmediata y se mantiene el trigger normal con `t.trigger` (`convex/triggerEngine.ts:201`, `convex/triggerEngine.ts:389-395`).

8. **Precondicion flat: GO.** La validacion de posicion neta cero y ausencia de ordenes abiertas sigue antes de reservar/enviar (`convex/triggerEngine.ts:179-190`).

## Pruebas y comandos revisados

- `git status --short --branch`
- `git log --oneline --decorate -5`
- `git diff --stat e9f5613..HEAD`
- `git diff --stat master..dbd8191`
- `git diff --unified=100 e9f5613..HEAD -- convex/triggerEngine.ts convex/triggerArms.ts tests`
- `sed -n '1,260p' docs/audit-prompt-arm-market-on-drop-benjamin-codigo.md`
- `rg -n "failArmEntryRejected|entryImmediateAtSend|immediatePartial|Ioc|settleArm|rearmToken" convex tests`
- `git diff --check master..dbd8191` - OK
- `npm run typecheck` - OK
- `npm test` - OK: 16 archivos, 258 tests pasados

No ejecute `npm run build` porque el script despliega Convex. No ejecute `npx convex codegen` porque puede modificar archivos generados y Codex actua solo como auditor salvo pedido explicito.

## Cierre

**GO condicionado** para avanzar con la rama tras dbd8191.

Condicion recomendada antes de produccion real: en el branch de IOC inmediato, si `filled.avgPx` supera `notionalCapPx`, registrar evento/alerta especifica y considerar reconciliar la reserva contable; esto convierte la cota asumida en una invariante observable.
