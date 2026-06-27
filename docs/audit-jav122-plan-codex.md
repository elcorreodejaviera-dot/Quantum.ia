# Auditoria Codex - JAV-122 plan Spot Grid transient recovery

## Alcance

Auditoria de diseno del plan `docs/plan-jav122-spotgrid-transient-recovery.md` usando como ancla el prompt
`docs/audit-prompt-jav122-plan.md` y el codigo actual del motor Spot Grid.

Archivos revisados:

- `docs/plan-jav122-spotgrid-transient-recovery.md`
- `docs/audit-prompt-jav122-plan.md`
- `convex/spotGridEngine.ts`
- `convex/spotGridBots.ts`
- `convex/schema.ts`
- `convex/crons.ts`
- `convex/log.ts`
- `convex/hyperliquidSpot.ts`
- `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts`
- `node_modules/@nktkas/hyperliquid/src/transport/_base.ts`
- `node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/_base/errors.ts`
- `src/components/SpotGridView.jsx`

## Veredicto

**NO GO para implementar el plan tal como esta.**

El enfoque base es correcto: los errores HTTP/timeout del SDK llegan como `TransportError` cuando no se capturan antes, y no hay evidencia de perdida de `instanceof` por cruzar `runMutation`/`runQuery` en el catch principal. Pero el plan tiene un bloqueante de recuperacion: un bot que escala a `error` por 12 transitorios no entra nunca a la query de recuperacion porque el mismo contador se compara contra un tope de 8. Ademas, el reset propuesto no corre en todas las rondas exitosas y el requisito "nunca HTML" no cubre todos los `errorMessage` persistidos.

## Bloqueante

### 1. NO-GO - La recuperacion desde `error` queda inalcanzable por reutilizar el mismo contador

Evidencia:

- El plan escala a `error` cuando `n >= SPOT_GRID_MAX_TRANSIENT_FAILS`; el valor propuesto es 12.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:42-43`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:70-76`
- La query de recuperacion propone devolver solo bots con `(transientFailCount ?? 0) < SPOT_GRID_MAX_ERROR_RECOVERIES`; el valor propuesto es 8.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:44-45`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:129-132`
- Por construccion, el bot escalado por transitorios persistentes tendria `transientFailCount >= 12`, asi que no cumple `< 8` y el cron nunca lo recupera.

Impacto:

- Invalida la mitad de recuperacion del objetivo JAV-122 para el caso principal "transitorio persistente -> error recuperable".
- El bot queda en `errorKind:"transient"` pero terminal de facto, sin que el plan lo declare como terminal accionable.

Ajuste requerido:

- Separar contadores: `transientFailCount` para fallos consecutivos antes de escalar, y `errorRecoveryCount` para intentos desde `status:"error"`.
- Alternativa minima: al escalar a `error`, setear el contador de recuperacion a 0 y usar otro campo para trazabilidad del total previo.
- La query de recuperacion debe comparar contra el contador de recuperaciones, no contra el contador que ya disparo la escalada.

## Alto

### 1. NO-GO - El reset en `setSpotGridFillCursor` no corre en toda ronda exitosa

Evidencia:

- El plan propone limpiar `transientFailCount`/`nextRetryAt` en `setSpotGridFillCursor`.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:104-108`
- En el codigo actual, `setSpotGridFillCursor` solo se llama si `maxTime > (bot.fillCursor ?? 0)`.
  - `convex/spotGridEngine.ts:680-682`
- Hay rondas exitosas que retornan antes o no mueven cursor:
  - bootstrap seeded no terminado retorna despues de `runSeededBootstrap`.
    - `convex/spotGridEngine.ts:552-557`
  - colocacion inicial legacy retorna tras colocar niveles.
    - `convex/spotGridEngine.ts:559-578`
  - rondas sin fills nuevos no cumplen el guard de `maxTime`.
    - `convex/spotGridEngine.ts:604-682`
- El loop considera exitosa la ronda si `reconcileOneBot` retorna sin throw y entonces incrementa `reconciled`.
  - `convex/spotGridEngine.ts:715-717`

Impacto:

- Los fallos transitorios no serian realmente "consecutivos"; se acumularian a lo largo del tiempo aunque haya muchas rondas exitosas sin fills.
- Un bot sano puede escalar a `error` despues de 12 glitches dispersos.

Ajuste requerido:

- Hacer el reset en un punto que siempre corra tras `await reconcileOneBot(...)` exitoso y antes de `releaseSpotGridReconcile`, por ejemplo una mutation `recordSpotGridReconcileSuccess(botId, token, { recoverIfError })` bajo `leaseOk`.
- Si se conserva `setSpotGridFillCursor`, no usarlo como unico punto de reset.

### 2. NO-GO - "Nunca exponer HTML" no esta garantizado en todos los paths persistidos

Evidencia:

- `safeError` solo hace `message.slice(0, 300)`; no elimina HTML.
  - `convex/log.ts:26-28`
- El plan limpia el path central de `TransportError`, pero mantiene `safeError(e)` para fatal.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:51-56`
- Hay capturas locales que persisten `safeError(e)` en `spot_grid_orders.errorMessage` sin pasar por el catch `:718`.
  - retry de `submitting`: `convex/spotGridEngine.ts:595-601`
  - repost tras cerrar SELL: `convex/spotGridEngine.ts:671-676`
  - `markSpotGridOrder` persiste `errorMessage`: `convex/spotGridBots.ts:592-611`
- La UI actual expone `bot.errorMessage`, y la query publica no devuelve `errorMessage` de ordenes abiertas, pero eso no cumple el requisito fuerte de "ningun path" si el HTML queda persistido.
  - `src/components/SpotGridView.jsx:350`
  - `convex/spotGridBots.ts:341-359`
  - `convex/spotGridBots.ts:410-418`

Impacto:

- El incidente original queda resuelto para el catch central si `TransportError` se clasifica bien, pero todavia puede quedar HTML en datos persistidos por capturas locales de errores externos.
- Si un futuro admin/debug/UI muestra esos campos, el problema vuelve.

Ajuste requerido:

- Introducir un helper unico para mensajes persistibles al usuario, por ejemplo `spotGridPublicError(e)`, que nunca devuelva HTML ni cuerpos crudos.
- Usarlo en `setSpotGridStatus`, `setSpotGridBootstrap` y `markSpotGridOrder`.
- Para cualquier `TransportError` capturado localmente, persistir mensaje fijo de transitorio o no persistir mensaje; nunca `safeError(e)`.

## Medio

### 1. GO condicionado - `instanceof TransportError` es viable, pero el plan sobredeclara que todas las ordenes llegan al catch `:718`

Evidencia:

- En el SDK local, `HttpRequestError extends TransportError`.
  - `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts:61-88`
- El transporte HTTP lanza `HttpRequestError` si la respuesta no es JSON/OK y re-lanza errores ya `TransportError`.
  - `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts:155-175`
- `ApiRequestError` no extiende `TransportError`, por lo que rechazos explicitos siguen siendo fatales.
  - `node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/_base/errors.ts:37-50`
- Verificacion local:
  - `HttpRequestError.prototype instanceof TransportError` -> `true`
  - `ApiRequestError.prototype instanceof TransportError` -> `false`
- En el catch principal, los SDK calls que no se capturan antes se ejecutan en el mismo contexto node action:
  - `getUserFees`: `convex/spotGridEngine.ts:715`
  - `reconcileOneBot`: `convex/spotGridEngine.ts:716`
  - lecturas directas dentro de `reconcileOneBot`: `convex/spotGridEngine.ts:529-535`, `convex/spotGridEngine.ts:581-586`
- Las mutations/queries Convex del path Spot Grid son DB/gate y no llaman al SDK, asi que no hay evidencia de que un `TransportError` del SDK cruce un `runMutation`/`runQuery` antes del catch `:718`.
  - `convex/spotGridBots.ts:459-468`
  - `convex/spotGridBots.ts:616-641`
  - `convex/spotGridBots.ts:762-782`
- Pero algunas rutas de orden capturan antes del catch externo:
  - `placeOrder` traga el error, loguea y retorna `{ ok:false }`.
    - `convex/spotGridEngine.ts:392-401`
  - retry de `submitting` captura y persiste en orden.
    - `convex/spotGridEngine.ts:595-601`
  - repost de BUY captura y persiste en orden.
    - `convex/spotGridEngine.ts:671-676`
  - precio vivo opcional captura y sigue.
    - `convex/spotGridEngine.ts:542-550`

Impacto:

- El clasificador `e instanceof TransportError` es correcto para el catch principal.
- No todos los 502/timeouts de orden incrementaran `transientFailCount`; algunos quedan en la politica existente de retry/idempotencia por orden. Puede ser aceptable, pero el plan debe decirlo explicitamente y testearlo.

Ajuste requerido:

- Documentar que el contador del bot aplica al catch externo, no a todos los fallos locales de orden.
- Si el objetivo es contar cualquier 502 de HL por bot, mover la clasificacion a esos catches locales tambien.

### 2. GO condicionado - Fencing/lease esta bien encaminado, pero el incremento debe calcularse dentro de la mutation

Evidencia:

- El patron actual de fencing existe y es fuerte: `leaseOk` exige token y lease vigente.
  - `convex/spotGridBots.ts:454-455`
- `releaseSpotGridReconcile` tambien usa `leaseOk`, por lo que un token viejo no limpia el lease de otro worker.
  - `convex/spotGridBots.ts:536-542`
- El plan propone llamar `bumpSpotGridTransient` antes del `finally` que libera el lease.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:67-94`
- El snippet calcula `n` en la action a partir del `bot` listado antes del claim.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:70-83`

Impacto:

- Bajo cron solapado o snapshots viejos, pasar el contador ya calculado desde la action es mas fragil que leer el valor actual dentro de la transaccion.
- El fencing evita escrituras con token viejo, pero no convierte un valor calculado afuera en CAS sobre el contador actual.

Ajuste requerido:

- `bumpSpotGridTransient(botId, token, kind/backoffMs)` debe leer el bot actual bajo `leaseOk`, calcular `(bot.transientFailCount ?? 0) + 1` en la mutation y retornar el nuevo contador.
- `recoverSpotGridFromError` y el reset de exito tambien deben ser mutations bajo `leaseOk` y ejecutarse antes de liberar el lease.

## Bajo

### 1. GO con correccion documental - El plan habla de cron cada 5 min, pero el codigo actual corre cada 1 min

Evidencia:

- El prompt/plan describen el cron como cada 5 min.
  - `docs/audit-prompt-jav122-plan.md:11`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:39-41`
- El codigo actual lo programa cada 1 minuto.
  - `convex/crons.ts:49-52`

Impacto:

- Con cron de 1 min, `SPOT_GRID_TRANSIENT_BACKOFF_MS = 60_000` no es inerte: normalmente salta una ronda hasta el proximo tick.
- Si produccion estuviera realmente a 5 min, entonces el backoff de 60s seria "proximo tick" y casi no modularia frecuencia.

Ajuste requerido:

- Sincronizar el plan con el cron real antes de implementarlo.

### 2. GO condicionado - Los nuevos campos son legacy-safe si se mantienen opcionales, pero las constantes deben vivir donde las queries puedan usarlas

Evidencia:

- El plan define `errorKind`, `transientFailCount` y `nextRetryAt` como opcionales.
  - `docs/plan-jav122-spotgrid-transient-recovery.md:30-37`
- El schema actual ya usa campos opcionales para el estado Spot Grid legacy.
  - `convex/schema.ts:617-629`
- La query nueva propuesta viviria en `spotGridBots.ts`, pero las constantes se proponen "en `spotGridEngine.ts`".
  - `docs/plan-jav122-spotgrid-transient-recovery.md:39-45`
  - `docs/plan-jav122-spotgrid-transient-recovery.md:129-132`

Impacto:

- `spotGridBots.ts` no deberia depender de `spotGridEngine.ts` (`"use node"` action) para constantes de query/mutation.

Ajuste requerido:

- Poner los limites/backoffs compartidos en un helper hoja no-node, o definir los limites que usa la query en `spotGridBots.ts`.

## Checklist GO/NO-GO pedido

1. **`instanceof TransportError` cruzando limites Convex: GO condicionado.** Las excepciones SDK que llegan al catch `convex/spotGridEngine.ts:718` llegan vivas; no vi SDK cruzando `runMutation`/`runQuery`. Condicion: el plan debe aclarar los catches locales que no llegan al catch externo.
2. **Nunca exponer HTML: NO-GO.** El catch central puede quedar limpio, pero siguen existiendo paths con `safeError(e)` persistido en ordenes y `safeError` no sanitiza HTML.
3. **Fencing/lease en mutations nuevas: GO condicionado.** El patron local (`leaseOk`) es correcto. Condicion: todas las mutations nuevas deben operar bajo `leaseOk`, antes de liberar lease, y calcular contadores en la mutation.
4. **Reset + backoff: NO-GO por reset.** `setSpotGridFillCursor` no corre siempre en ronda exitosa. El backoff de 60s si tiene efecto con el cron actual de 1 min; el plan debe corregir la referencia a 5 min.
5. **Recuperacion money-path: GO condicionado.** La idempotencia existente por cloid/fase/ciclo reduce el riesgo de duplicar ordenes, pero la recuperacion debe volver a `running` solo tras una ronda exitosa bajo lease y no debe re-seedear antes de reconciliar estado HL.
6. **Tope/estado terminal accionable: NO-GO.** El tope de recuperacion queda roto por el contador compartido. Positivo: `stopSpotGridBot` puede claimar bots en `error`.
   - `convex/spotGridBots.ts:475-481`
7. **Legacy-safe de los 3 campos nuevos: GO condicionado.** Opcionales y defaults ausente=0/0 funcionan si se implementan asi; falta resolver ubicacion de constantes y la query acotada por `status:"error"`.

## Hechos verificados

- Catch generico actual: `convex/spotGridEngine.ts:718-723`.
- `safeError` solo trunca: `convex/log.ts:26-28`.
- `setSpotGridStatus` persiste `errorMessage` bajo lease: `convex/spotGridBots.ts:616-630`.
- `setSpotGridFillCursor` actual solo corre si avanza cursor: `convex/spotGridEngine.ts:680-682`.
- `claimSpotGridReconcile` actual solo admite `running`/`paused`: `convex/spotGridBots.ts:459-468`.
- `claimSpotGridReconcileForStop` admite `error`: `convex/spotGridBots.ts:475-481`.
- Cron real Spot Grid: 1 min: `convex/crons.ts:49-52`.
- UI muestra `bot.errorMessage` cuando `status === "error"`: `src/components/SpotGridView.jsx:350`.
- Query de detalle no devuelve `errorMessage` de ordenes abiertas: `convex/spotGridBots.ts:341-359`.
- `HttpRequestError extends TransportError`: `node_modules/@nktkas/hyperliquid/src/transport/http/mod.ts:61-88`.
- `ApiRequestError` no extiende `TransportError`: `node_modules/@nktkas/hyperliquid/src/api/exchange/_methods/_base/errors.ts:37-50`.

## Comandos revisados

- `sed -n '1,240p' AGENTS.md`
- `git status --short`
- `rg -n "TransportError|instanceof|bumpSpotGridTransient|recover|reset|lease|fenc|html|HTML|errorCount|backoff|cron" convex src server.js docs tests`
- `nl -ba docs/audit-prompt-jav122-plan.md`
- `nl -ba docs/plan-jav122-spotgrid-transient-recovery.md`
- `nl -ba convex/spotGridEngine.ts` en los bloques relevantes
- `nl -ba convex/spotGridBots.ts` en los bloques relevantes
- `nl -ba convex/schema.ts`
- `nl -ba convex/crons.ts`
- `nl -ba convex/log.ts`
- `rg -n "safeError\\(|errorMessage"`
- `node -e` para validar herencia local de `HttpRequestError`, `TransportError` y `ApiRequestError`

No ejecute `npm run typecheck` ni tests porque esta fue auditoria estatica de plan; no hubo cambios de codigo.

## Cierre

No daria GO limpio al plan. Corregir primero: contador separado para recuperacion, reset en un punto de exito garantizado, sanitizacion global de mensajes persistibles y definicion explicita de que catches locales de orden entran o no en la politica de transitorios del bot. Con esos ajustes, el enfoque puede pasar a una segunda auditoria corta de plan antes de implementacion.
