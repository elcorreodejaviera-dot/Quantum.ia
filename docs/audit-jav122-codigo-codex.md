# Auditoria de codigo Codex - JAV-122 Spot Grid transient recovery

Fecha: 2026-06-27  
Rama auditada: `spot-grid/jav122-transient-recovery`  
Commit de codigo auditado: `c070b49`  
Prompt auditado: `docs/audit-prompt-jav122-codigo.md`

## Alcance

Audite el codigo de `c070b49` para verificar fidelidad contra el diseno Rev.7 de JAV-122:

- `convex/schema.ts`
- `convex/spotGridConstants.ts`
- `convex/spotGridEngine.ts`
- `convex/spotGridBots.ts`
- `convex/spotGridActions.ts`
- `tests/spotGridTransientRecovery.test.ts`
- referencias de UI/criterio canonico: `src/components/SpotGridView.jsx`, `convex/hyperliquid.ts`

No re-ejecute la suite porque el prompt ya reporta `npx convex codegen` OK, `npm run typecheck` OK y 286/286 tests verdes. Si revise que no hay cambios de codigo locales respecto de `c070b49` en los archivos auditados.

## Veredicto final

**GO condicionado.**

No encontre bloqueantes ni evidencia de HTML persistido/visible, perdida de `instanceof` por cruzar `runMutation`, recovery infinito, doble-alerta, revive incorrecto de `paused` a `running`, ni divergencia entre `claim` y query.

La condicion es corregir o declarar explicitamente el comportamiento de `placeOrder`: hoy captura errores de HL antes del `catch` central del cron, por lo que esos transitorios no participan de los contadores/backoff/escalada de JAV-122. Si la intencion del diseno es que "ordenes" lleguen vivas al `catch` central, el codigo no lo cumple.

## Hallazgos bloqueantes

Ninguno.

## Hallazgos altos

### ALTO-1 - NO-GO condicionado: `placeOrder` intercepta errores HL antes del `catch` central

**Hecho verificado**

`gatedPlace` es el punto que envia la orden real a HL y puede recibir `TransportError` desde `placeSpotLimit`:

- `convex/spotGridEngine.ts:330` define `gatedPlace`.
- `convex/spotGridEngine.ts:341` llama `placeSpotLimit(...)`.

Pero `placeOrder` captura cualquier excepcion de `gatedPlace`, loguea `safeError(e)` y devuelve `{ ok:false }`:

- `convex/spotGridEngine.ts:388` define `placeOrder`.
- `convex/spotGridEngine.ts:405-413` envuelve `gatedPlace` en `try/catch` y no re-lanza.

Los callers de `placeOrder` no usan el resultado para activar el flujo JAV-122:

- `convex/spotGridEngine.ts:506` y `convex/spotGridEngine.ts:527` lo usan en bootstrap de sells/buys.
- `convex/spotGridEngine.ts:587` lo usa en colocacion inicial legacy.
- `convex/spotGridEngine.ts:668` lo usa al crear una SELL pareada por fill de BUY.

El `catch` central que clasifica y hace `bumpSpotGridTransient` / `bumpSpotGridErrorRecovery` esta en:

- `convex/spotGridEngine.ts:748-761`

Ese `catch` no ve las excepciones ya consumidas por `placeOrder`. Por lo tanto, esos errores de transporte no incrementan `transientFailCount`, no aplican `nextRetryAt` de bot y no pueden escalar por `MAX_TRANSIENT_FAILS`.

**Impacto**

No veo riesgo directo de doble orden en este path porque la orden se registra antes del envio y usa CLOID deterministico/idempotente:

- `convex/spotGridBots.ts:582-614`

Tampoco veo HTML persistido desde este catch local: solo se loguea `safeError(e)` en `convex/spotGridEngine.ts:412`.

El riesgo real es de cobertura y accionabilidad: una secuencia de 502/timeouts durante colocacion inicial o SELL pareada puede quedar fuera del mecanismo de backoff/escalada del bot. En los retries de `submitting`, el codigo clasifica el mensaje de la orden, pero sigue sin tocar contadores de bot:

- `convex/spotGridEngine.ts:608-615`

Y en repost ocurre lo mismo:

- `convex/spotGridEngine.ts:685-690`

Si el diseno quiere que todos los fallos transitorios de orden cuenten como fallo transitorio de ronda, hay que re-lanzar el transitorio despues de dejar el intento idempotente registrado, o mover ese resultado a una mutation de bump bajo lease. Si se decide que las ordenes tienen retry local separado, debe quedar documentado y testeado como excepcion al requisito "ordenes llegan al catch central".

## Hallazgos medios

Ninguno adicional.

## Hallazgos bajos

Ninguno adicional.

## Checklist GO / NO-GO por punto del prompt

1. **Clasificacion correcta y completa: GO condicionado.**  
   `classifySpotGridError` vive en `spotGridEngine.ts`, modulo `"use node"`, y clasifica `TransportError` como transitorio con mensaje fijo (`convex/spotGridEngine.ts:1`, `convex/spotGridEngine.ts:11`, `convex/spotGridEngine.ts:29-31`). El criterio coincide con el uso canonico del repo (`convex/hyperliquid.ts:238-248`, `convex/hyperliquid.ts:591-598`). No detecte perdida de `instanceof` por cruzar `runMutation` antes del catch central para los errores que llegan ahi: `getUserFees` y `reconcileOneBot` corren en el mismo action node (`convex/spotGridEngine.ts:741-742`, `convex/spotGridEngine.ts:748-750`). Condicion: `placeOrder` consume excepciones de orden antes de ese catch (`convex/spotGridEngine.ts:405-413`).

2. **Nunca HTML persistido/UI: GO.**  
   El catch central persiste solo mensajes clasificados (`convex/spotGridEngine.ts:750-761`). Los catches de orden que persisten `spot_grid_orders.errorMessage` usan `classifySpotGridError(e).message` (`convex/spotGridEngine.ts:612-615`, `convex/spotGridEngine.ts:688-690`). `stopSpotGridBot` re-lanza clasificado (`convex/spotGridEngine.ts:877-880`) y `createSpotGridBot` tambien (`convex/spotGridActions.ts:88-92`). La UI muestra `bot.errorMessage` (`src/components/SpotGridView.jsx:350`), pero los paths revisados que pueden ver `TransportError` usan mensaje limpio.

3. **Predicate claim == query: GO.**  
   `isRecoverableError` exige `status:"error"`, `errorKind:"transient"`, `recoverToStatus` valido y `errorRecoveryAttempts < MAX` (`convex/spotGridBots.ts:473-477`). `claimSpotGridReconcile` usa ese mismo helper y ademas gatea `nextRetryAt` (`convex/spotGridBots.ts:483-494`). `listRecoverableErrorSpotGridBotsInternal` usa el mismo helper y el mismo gate de `nextRetryAt` (`convex/spotGridBots.ts:856-861`).

4. **`wasError` autoritativo: GO.**  
   `claimSpotGridReconcile` devuelve `wasError` desde el documento leido al claimar (`convex/spotGridBots.ts:493-494`). El loop usa `claim.wasError`, no el snapshot de la lista (`convex/spotGridEngine.ts:717-722`).

5. **Anti-carrera bajo lease: GO.**  
   Las nuevas mutations usan `leaseOk` antes de patchear (`convex/spotGridBots.ts:465-466`, `convex/spotGridBots.ts:697`, `convex/spotGridBots.ts:724`, `convex/spotGridBots.ts:743`, `convex/spotGridBots.ts:758`). Recovery y bump de recuperacion revalidan `status:"error" && errorKind:"transient"` bajo lease (`convex/spotGridBots.ts:725`, `convex/spotGridBots.ts:759`). `recoverSpotGridFromError` restaura `recoverToStatus` y terminaliza a fatal si falta (`convex/spotGridBots.ts:760-770`).

6. **Contadores separados + escalada: GO.**  
   `bumpSpotGridTransient` calcula el contador dentro de la mutation y escala con `status:"error"`, `errorKind:"transient"`, `recoverToStatus`, reseteo de contadores y alerta (`convex/spotGridBots.ts:693-713`). `bumpSpotGridErrorRecovery` usa `errorRecoveryAttempts`, backoff largo y mensaje accionable al tope (`convex/spotGridBots.ts:720-731`). Los tests cubren estos casos (`tests/spotGridTransientRecovery.test.ts:30-79`, `tests/spotGridTransientRecovery.test.ts:153-176`).

7. **Limpieza de estado fantasma: GO.**  
   `setSpotGridStatus` asigna `errorKind` explicitamente y normaliza `recoverToStatus`, contadores y `nextRetryAt` (`convex/spotGridBots.ts:656-683`). `pauseSpotGridBot` limpia recovery aunque venga desde `error` (`convex/spotGridBots.ts:262-275`). `setSpotGridBootstrap(error)` marca fatal y limpia recovery (`convex/spotGridBots.ts:516-544`). `markSpotGridReconcileSuccess` solo toca `transientFailCount`, `nextRetryAt` y `updatedAt` (`convex/spotGridBots.ts:739-745`).

8. **Reset en toda ronda OK: GO.**  
   El reset esta en el punto de exito del loop, despues de `reconcileOneBot`, con rama activa vs recuperacion (`convex/spotGridEngine.ts:741-746`). No depende de `setSpotGridFillCursor`. La mutation resetea contador/backoff bajo lease (`convex/spotGridBots.ts:739-745`).

9. **Recuperacion money-path: GO.**  
   Antes de tocar HL, el loop revalida gate live (`convex/spotGridEngine.ts:723-735`). Los envios reales revalidan gate inmediatamente antes de enviar (`convex/spotGridEngine.ts:330-341`, `convex/spotGridEngine.ts:364-381`). El bootstrap IOC es idempotente por CLOID y lee fills antes de reenviar (`convex/spotGridEngine.ts:468-485`). `recoverSpotGridFromError` vuelve a `running` o `paused` segun `recoverToStatus`, no siempre a `running` (`convex/spotGridBots.ts:760-770`). El motor solo repone/coloca cuando `isRunning` es true; en bootstrap se evita colocar si esta pausado (`convex/spotGridEngine.ts:567-569`) y los paths de sells/repost estan gateados por `isRunning` (`convex/spotGridEngine.ts:656-668`, `convex/spotGridEngine.ts:684-687`).

10. **Legacy-safe: GO.**  
    Los cinco campos nuevos son opcionales en schema (`convex/schema.ts:619-633`). Los contadores/backoff usan `?? 0` (`convex/spotGridBots.ts:476`, `convex/spotGridBots.ts:490`, `convex/spotGridBots.ts:698`, `convex/spotGridBots.ts:726`, `convex/spotGridBots.ts:861`). Un `error` sin `recoverToStatus` no entra en query/claim (`convex/spotGridBots.ts:473-477`, `convex/spotGridBots.ts:856-861`) y si se fuerza recovery terminaliza a fatal (`convex/spotGridBots.ts:760-765`). La query filtra en memoria solo sobre `status:"error"` usando `by_status_updated` (`convex/spotGridBots.ts:856-861`).

11. **Aislamiento node/non-node: GO.**  
    `spotGridConstants.ts` es hoja sin `"use node"` ni SDK (`convex/spotGridConstants.ts:1-4`). `classifySpotGridError` importa el SDK y vive en `spotGridEngine.ts`, que es `"use node"` (`convex/spotGridEngine.ts:1`, `convex/spotGridEngine.ts:11`, `convex/spotGridEngine.ts:29-31`). `spotGridBots.ts` importa constantes, no el SDK (`convex/spotGridBots.ts:9-13`).

12. **Huecos nuevos: GO condicionado.**  
    No encontre doble-alerta, recovery infinito, fatal recuperable, HTML visible, ni revive erroneo a `running`. El hueco nuevo relevante es ALTO-1: excepciones de orden consumidas localmente por `placeOrder`, fuera de los contadores/backoff/escalada de JAV-122.

## Comandos revisados

- `git status --short`
- `git diff --stat b0bafcb..c070b49`
- `git diff --name-only c070b49 -- convex/spotGridEngine.ts convex/spotGridBots.ts convex/spotGridActions.ts convex/spotGridConstants.ts convex/schema.ts tests/spotGridTransientRecovery.test.ts`
- `rg -n "classifySpotGridError|TransportError|placeOrder|gatedPlace|bumpSpotGrid|recoverSpotGridFromError|markSpotGridReconcileSuccess" convex/spotGridEngine.ts convex/spotGridBots.ts`
- `rg -n "errorMessage|safeError\\(|classifySpotGridError" convex src tests docs/audit-prompt-jav122-codigo.md`
- lecturas con line refs via `perl -ne` de los spans citados arriba.
