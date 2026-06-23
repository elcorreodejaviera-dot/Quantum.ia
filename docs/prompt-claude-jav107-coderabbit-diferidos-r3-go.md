# Auditoria JAV-107 CodeRabbit diferidos r3 - GO

Commit auditado: `4a93335`  
Base previa: NO-GO r2 sobre `d60dc55`  
Verificacion local: `npm run typecheck` OK, `npm test` OK (254/254). El engine `"use node"` sigue fuera del harness.

## Fix 1 - entry pre-fill muerta + CLOID HL valido

### ALTO / GO - El CLOID de entry queda consistente para persistencia, envio y reconcile

El bloqueo r2 queda cerrado. `reserveSpotDefenseArm` ahora genera el CLOID de entry con `await toHlCloid(spotDefenseCloidInput(String(armId), generation, "entry"))` (`convex/spotDefenseBots.ts:411-424`). Ese mismo valor:

- se persiste en `spot_defense_orders` como role `entry`,
- se devuelve en la reserva,
- se usa en el envio a HL como `c: cloid` (`convex/spotDefenseEngine.ts:160-164`),
- y luego es el identificador de `orderStatus`, `openByCloid`, `cancelByCloid`/`ensureSpotDefenseOrdersDead` y `fillsByCloid` (`convex/spotDefenseEngine.ts:647-695`).

La busqueda global no muestra ningun path productivo que vuelva a derivar la entry por el input crudo; los usos crudos restantes son tests del helper `spotDefenseCloidInput`. El test nuevo valida que el cloid persistido y el devuelto por la reserva coinciden y cumplen `^0x[0-9a-f]{32}$` (`tests/spotDefenseBackend.test.ts:724-735`).

Con el identificador ya valido, la cascada r2 tambien queda GO: `orderStatus` cubre `open`, `triggered`, `waitingForTrigger`, `waitingForFill` y `filled` con fill-data demorada; `openByCloid` queda como red positiva adicional; solo se llega a `failed` tras grace, prueba negativa por CLOID y re-fill final. La cuarentena de 90s en `settleSpotDefenseArm` sigue actuando como defensa si la rama intenta terminalizar entre 60s y 90s.

## Fix 2 - auto-rearm durable tras failed

### MEDIO / GO - Se mantiene el GO de r2

`scheduleDurableRearmAfterFailed` cubre `settleSpotDefenseArm`, `markArmSubmitting`, `gateArmBeforeOrder` y `failSpotDefensePreOrder`, con guard `!disarmPending && active && running && autoRearm===true && rearmStatus===undefined`. No pisa ciclos `running/pending/blocked` del cron y respeta pausa.

## Nota

Si se hubieran creado arms reales con commits previos que persistian `entry.cloid` crudo (`spot-defense:...`), esos arms viejos no quedan arreglados por este cambio. Como `d60dc55` no estaba pusheado segun el prompt, no lo considero bloqueante para el PR; si existio despliegue manual/testnet, limpiar o cerrar esos arms antes de operar.

## Veredicto

GO para `4a93335`. Los dos diferidos de CodeRabbit quedan cerrados: Fix 1 GO y Fix 2 GO.
