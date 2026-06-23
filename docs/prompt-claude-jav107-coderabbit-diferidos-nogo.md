# Auditoria JAV-107 CodeRabbit diferidos - NO-GO

Commit auditado: `659696c`  
Base: `9ed2358`  
Verificacion local: `npm run typecheck` OK, `npm test` OK (253/253). El fix del engine `"use node"` sigue fuera del harness por diseno.

## Fix 1 - recovery de entry pre-fill muerta

### ALTO / NO-GO - La prueba de muerte no consulta `orderStatus`; puede marcar `failed` una entry disparada/llenada con `userFills` demorado

La nueva rama pre-fill hace: `fillsByCloid` inicial, `openByCloid(frontendOpenOrders)`, grace 60s, `ensureSpotDefenseOrdersDead(frontendOpenOrders)`, re-`fillsByCloid`, y luego `settleSpotDefenseArm(... failed)` (`convex/spotDefenseEngine.ts:647-685`). Eso arregla el caso de entry rechazada/no materializada, pero no distingue estados intermedios reales de HL como `triggered`, `waitingForFill` o `filled` cuando `userFills` todavia no refleja el fill.

Riesgo money-path: una trigger SELL que sale del book porque disparo puede no estar en `frontendOpenOrders`; si `userFills` tarda mas que la cuarentena efectiva, la rama puede terminalizar `failed` y liberar reserva aunque ya exista o este naciendo un short real. Ese short quedaria sin transicion a `filled`, sin SL/TP/reconcile. El propio motor de pools evita ese borde consultando `orderStatus` por CLOID y tratando `open`/`triggered` como vivo, y `filled` sin fill-data como `fill_data_pending` (`convex/triggerEngine.ts:900-945`).

Fix requerido: antes de declarar muerta la entry, consultar `info.orderStatus({ user, oid: entry.cloid })` como en `triggerEngine`. Tratar `open`/`triggered`/`waitingForTrigger`/`waitingForFill` como vivo o pendiente; tratar `filled` sin `fillsByCloid` como `fill_data_pending`; solo fallar si `orderStatus` es terminal/rechazado/unknown, no hay openByCloid, no hay fills y vence la cuarentena. Como ultima defensa, si `clearinghouseState` muestra posicion no-flat del asset, transicionar/esperar `filled`, nunca `failed`.

## Fix 2 - auto-rearm durable tras `failed`

### MEDIO / NO-GO - La agenda de rearm solo corre si el failed pasa por `settleSpotDefenseArm`; otros failed directos quedan fuera

La rama nueva agenda `rearmStatus="pending"` cuando `settleSpotDefenseArm` recibe `status==="failed"` y el bot esta activo/running/autoRearm (`convex/spotDefenseBots.ts:897-920`). Eso cubre los failed que pasan por esa mutation. Pero hay caminos existentes que terminalizan el arm con patch directo a `failed` y no ejecutan esta logica:

- `failSpotDefensePreOrder` parchea `status: "failed"` tras rechazo determinista de `updateLeverage`, limpia lease y retorna (`convex/spotDefenseBots.ts:653-668`), llamado desde `armSpotDefenseInternal` (`convex/spotDefenseEngine.ts:131-144`).
- `markArmSubmitting` y `gateArmBeforeOrder` tambien pueden patchar `failed` directamente en bloqueos de cap/plan (`convex/spotDefenseBots.ts:419-421`, `convex/spotDefenseBots.ts:443-445`).

En rearm-cycle, `settleSpotDefenseRearm` puede manejar algunos `ok:false`/throws del action; pero en armado inicial manual con `autoRearm=true`, esos failed directos dejan el bot activo/running sin arm vivo y sin `rearmStatus`, volviendo al modo "sin armar" manual. Eso no cumple completamente el objetivo declarado de rearm durable tras failed.

Fix requerido: centralizar terminalizacion failed en un helper/mutation comun que ejecute tambien la politica de rearm, o duplicar de forma explicita la agenda/blocked durable en los caminos directos. Para errores `[blocked_config]` deterministas, considerar agendar como `blocked` o pending que escale por `settleSpotDefenseRearm`, pero no dejar `rearmStatus` undefined si `autoRearm` promete recuperacion durable.

### BAJO / GO - Guard `rearmStatus===undefined` no pisa ciclos en curso

El guard de la rama nueva evita sobrescribir `running`/`pending`/`blocked` (`convex/spotDefenseBots.ts:909-920`). Durante un rearm-cycle reclamado, `claimSpotDefenseRearm` deja `rearmStatus="running"` (`convex/spotDefenseBots.ts:567-582`), asi que un `settleSpotDefenseArm(failed)` no resetea attempts ni roba el lease; luego `settleSpotDefenseRearm` aplica backoff/blocked (`convex/spotDefenseBots.ts:588-614`). Correcto.

La precedencia de `disarmPending` tambien es correcta: al terminalizar, primero completa pausa y no agenda rearm (`convex/spotDefenseBots.ts:897-900`).

## Veredicto

NO-GO para el commit `659696c`.

Fix 1: NO-GO por falta de `orderStatus`/posicion como defensa antes de terminalizar `failed`.  
Fix 2: NO-GO por cobertura incompleta de failed directos que no pasan por `settleSpotDefenseArm`; el subcaso de no pisar rearm-cycle esta GO.
