# Auditoria JAV-107 CodeRabbit diferidos r2 - NO-GO

Commit auditado: `d60dc55`  
Base previa: `9ed2358` / NO-GO sobre `659696c`  
Verificacion local: `npm run typecheck` OK, `npm test` OK (253/253). El engine `"use node"` sigue fuera del harness.

## Fix 1 - entry pre-fill muerta

### ALTO / NO-GO - La cascada de estados esta bien, pero depende de un `entry.cloid` que no es CLOID HL valido

La correccion r2 agrega la defensa que faltaba: antes de declarar muerta la entry consulta `orderStatus`, `openByCloid` y `fillsByCloid`; conserva como viva/pendiente `open`, `triggered`, `waitingForTrigger`, `waitingForFill`; y si `orderStatus` dice `filled` espera `entry_fill_pending` hasta que aparezca fill data (`convex/spotDefenseEngine.ts:647-694`). Esa cascada cierra el NO-GO anterior en lo logico: ya no depende solo de `frontendOpenOrders`.

Bloqueante: el identificador usado por esa cascada es `entry.cloid`, pero la entry se crea con `spotDefenseCloidInput(...)` crudo (`convex/spotDefenseBots.ts:411-421`) y se envia a HL con un cast TypeScript (`c: cloid as \`0x${string}\``) sin pasar por `toHlCloid` (`convex/spotDefenseEngine.ts:160-164`). `spotDefenseCloidInput` devuelve strings tipo `spot-defense:...` (`convex/cloids.ts:67-88`), mientras que el mismo archivo documenta que HL exige exactamente `0x` + 32 hex y provee `toHlCloid` para convertirlo (`convex/cloids.ts:1-20`). SL/BE/TP si usan `toHlCloid` antes de tocar HL (`convex/spotDefenseEngine.ts:384`, `467`, `518`, `610`).

Impacto: no puedo confirmar que `info.orderStatus({ oid: entry.cloid })`, `openByCloid`, `cancelByCloid` o `fillsByCloid` resuelvan la misma orden real de HL. Peor: si HL valida el formato como indica el helper, la entry puede rechazarse o no ser reconciliable por CLOID. Esto es preexistente al r2, pero el Fix 1 depende directamente de ese identificador; por eso no recibe GO money-path.

Fix requerido: usar un CLOID HL real para la entry igual que SL/TP. Generar `entryCloid = await toHlCloid(spotDefenseCloidInput(..., "entry"))`, persistir/enviar/reconciliar ese valor, y mantener el input logico solo si hace falta como fuente determinista. Cubrir con test que el cloid de entry persistido/enviado cumple `^0x[0-9a-f]{32}$`.

## Fix 2 - auto-rearm durable tras `failed`

### MEDIO / GO - Helper centralizado cubre los caminos directos a `failed`

El NO-GO anterior queda cerrado. `scheduleDurableRearmAfterFailed` aplica una politica unica con guard `!disarmPending && active && running && autoRearm===true && rearmStatus===undefined` (`convex/spotDefenseBots.ts:62-78`). El helper se llama desde:

- `markArmSubmitting` cuando falla admisibilidad de cobertura/cap (`convex/spotDefenseBots.ts:435-441`).
- `gateArmBeforeOrder` cuando falla el gate de cobertura justo antes del envio (`convex/spotDefenseBots.ts:463-470`).
- `failSpotDefensePreOrder` tras rechazo determinista pre-orden (`convex/spotDefenseBots.ts:675-692`).
- `settleSpotDefenseArm` para cualquier terminal `failed` que pase por la maquina de estados (`convex/spotDefenseBots.ts:920-937`).

Durante un rearm-cycle, `rearmStatus==="running"` hace que el helper no pise el ciclo; `settleSpotDefenseRearm` conserva la responsabilidad de backoff/blocked/attempts. `disarmPending` tiene precedencia y no agenda rearm mientras se pausa. Correcto.

## Veredicto

Fix 1: NO-GO por CLOID de entry no-HL, aunque la cascada `orderStatus/open/fills` del r2 corrige el falso `failed` en abstracto.  
Fix 2: GO.

Veredicto global para `d60dc55`: NO-GO hasta corregir el CLOID real de la entry y validar que `orderStatus/openByCloid/fills/cancelByCloid` operan sobre el mismo identificador HL.
