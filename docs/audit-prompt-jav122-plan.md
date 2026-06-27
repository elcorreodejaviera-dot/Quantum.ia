# Auditoría de PLAN (Codex) — JAV-122: Spot Grid no debe morir por error transitorio de HL (502)

Eres un auditor senior de código money-path sobre Hyperliquid. Audita el **DISEÑO** de abajo (todavía
NO hay código). Emite veredicto **GO / NO-GO** por hallazgo, con severidad (ALTO / MEDIO / BAJO). No
reescribas el código; señala fallos de corrección, huecos, carreras (race), riesgos money-path y de
idempotencia/fencing. El plan completo está en `docs/plan-jav122-spotgrid-transient-recovery.md`.

> **RONDA 2.** La ronda 1 dio NO-GO con 3 hallazgos, TODOS incorporados al plan (ver "Rev.2 (tras Codex
> NO-GO r1)" arriba del plan):
> 1. **(BLOQUEANTE) Contador único impedía la recuperación.** Antes `transientFailCount` escalaba (≥12) Y
>    filtraba la recuperación (<8) → un bot escalado tenía count≥12 y la query nunca lo tomaba. Fix: DOS
>    campos — `transientFailCount` (prevención, se resetea a 0 al escalar) y `errorRecoveryAttempts`
>    (recuperación, arranca en 0 en la escalada y es el único filtrado por el tope de la Parte 2).
> 2. **(ALTO) Reset no corría en toda ronda exitosa.** Antes vivía en `setSpotGridFillCursor` (solo con
>    fills nuevos) → fallos no consecutivos se acumulaban. Fix: mutation `markSpotGridReconcileSuccess`
>    llamada en el punto de éxito del loop (`spotGridEngine.ts:717`), corre con o sin fills, running o paused.
> 3. **(ALTO) "Nunca HTML" incompleto.** Quedaban `markSpotGridOrder({errorMessage: safeError(e)})` en los
>    catches de colocación (`:600`, `:675`) que persisten en `spot_grid_orders.errorMessage`. Fix: pasan
>    por `classifySpotGridError(e)` → mensaje limpio (fijo para transitorio).
>
> Tu tarea: **confirmar que estos 3 cierres son correctos y suficientes**, buscar huecos NUEVOS que
> introduzcan (sobre todo: ¿el reset y `recoverSpotGridFromError` en `:717` operan bajo lease y antes del
> `release`? ¿`errorRecoveryAttempts` se incrementa exactamente una vez por intento? ¿algún otro
> `errorMessage` persistido sigue pudiendo traer HTML?), y emitir veredicto GO / NO-GO.

> **RONDA 3.** La ronda 2 dio NO-GO con 1 bloqueante + 4 condicionados, TODOS incorporados (ver "Rev.3
> (tras Codex NO-GO r2)" arriba del plan):
> 1. **(BLOQUEANTE) El catch ramifica por ORIGEN.** Captura `wasError = bot.status === "error"` por bot:
>    transitorio+activo → `bumpSpotGridTransient`; transitorio+recuperación → `bumpSpotGridErrorRecovery`
>    (incrementa `errorRecoveryAttempts`, no `transientFailCount`); éxito+activo →
>    `markSpotGridReconcileSuccess`; éxito+recuperación → `recoverSpotGridFromError`. Sin esto, un
>    transitorio durante recuperación dejaba el tope inerte (reintentos infinitos).
> 2. **(COND) Contadores se calculan DENTRO de las mutations bajo `leaseOk`** (el catch solo elige rama;
>    el incremento+escalada vive en `bumpSpotGridTransient`/`bumpSpotGridErrorRecovery`).
> 3. **(COND) Actions user-facing `createSpotGridBot`/`stopSpotGridBot` saneadas:** re-lanzan
>    `new Error(classifySpotGridError(e).message)` → nunca HTML al portal; validaciones deterministas intactas.
> 4. **(COND) Cron Spot Grid = 1 min** (`crons.ts:49-52`), corregido en todo el plan.
> 5. **(COND) `errorRecoveryAttempts` en legacy-safe y DoD.**
>
> Tu tarea en r3: **confirmar que el bloqueante del origen y los 4 condicionados están bien cerrados**,
> en particular: ¿`wasError` tomado de la lista es el origen correcto (vs el `status` que el gate pudo
> mutar a `paused`/`error` durante la ronda)? ¿la ramificación cubre TODOS los caminos (incl. fatal
> durante recuperación → flip a `errorKind:fatal`)? ¿el saneo de las actions no rompe ningún mensaje de
> validación legítimo? Emite GO / NO-GO.

> **RONDA 4.** La ronda 3 dio NO-GO con 1 bloqueante de CARRERA, incorporado (ver "Rev.4 (tras Codex
> NO-GO r3)" arriba del plan): `wasError` se tomaba del snapshot de la lista y `recoverSpotGridFromError`
> no revalidaba bajo el lease → una pausa/stop concurrente entre el listado y el success podía revivir a
> `running` un bot ya cambiado. Cierres:
> 1. **`claimSpotGridReconcile` devuelve `wasError` leído de DB al tomar el lease** (no de la lista). El
>    loop usa `claim.wasError` como origen autoritativo.
> 2. **`recoverSpotGridFromError` y `bumpSpotGridErrorRecovery` revalidan `status:"error"` +
>    `errorKind:"transient"` bajo `leaseOk`** → si una transición concurrente cambió el bot, son no-op
>    (`recover` NO lo vuelve a `running`).
> 3. **Test de carrera nuevo** (listado=error → pausa antes del success → recovery no revive a running).
>
> Tu tarea en r4: **confirmar que el cierre de la carrera es correcto y suficiente**: ¿la revalidación
> bajo lease en `recoverSpotGridFromError`/`bumpSpotGridErrorRecovery` cubre TODAS las transiciones
> concurrentes posibles (pausa, stop, flip a fatal)? ¿queda algún otro punto donde un snapshot rancio
> (lista o `claim.wasError`) gobierne una escritura money-path? ¿hay simetría faltante en el path activo
> (`markSpotGridReconcileSuccess` necesita la misma revalidación)? Emite GO / NO-GO.

> **RONDA 5.** La ronda 4 dio NO-GO con 1 bloqueante money-path + 2 medios, incorporados (ver "Rev.5 (tras
> Codex NO-GO r4)" arriba del plan):
> 1. **(BLOQUEANTE) Recuperación preserva `running` vs `paused`.** Rev.4 recuperaba SIEMPRE a `running` →
>    un bot que el usuario dejó `paused` y que escaló a `error` por transitorios se reactivaba (siguiente
>    tick colocaba órdenes, `isRunning = status === "running"`). Fix: nuevo campo opcional
>    `recoverToStatus: "running"|"paused"`; `bumpSpotGridTransient` al escalar guarda
>    `bot.status === "paused" ? "paused" : "running"`; `recoverSpotGridFromError` restaura ESE estado (no
>    siempre `running`); ausente → no-op conservador.
> 2. **(MEDIO) Terminalidad accionable:** al agotar `MAX_ERROR_RECOVERIES`, `bumpSpotGridErrorRecovery`
>    setea `errorMessage` a texto accionable (la UI muestra `errorMessage`, `SpotGridView.jsx:350`).
> 3. **(MEDIO) Constantes a módulo hoja non-node** (`spotGridConstants.ts`) importable por `spotGridBots.ts`
>    (non-node) y el engine; `classifySpotGridError` (usa `TransportError` del SDK) queda en tierra node.
>
> Tu tarea en r5: **confirmar que la preservación de `paused` cierra el bloqueante money-path** (¿hay
> algún otro punto que escriba `status:"running"` sin consultar `recoverToStatus`? ¿el no-op conservador
> ante `recoverToStatus` ausente es correcto, o debería preferir `paused`? ¿`recoverToStatus` se limpia
> al recuperar y al ir a fatal para no dejar estado fantasma?) y que los 2 medios no abren huecos. Emite
> GO / NO-GO.

> **RONDA 6.** La ronda 5 dio NO-GO con 1 alto (convergencia) + 1 medio (estado fantasma), incorporados
> (ver "Rev.6 (tras Codex NO-GO r5)" arriba del plan):
> 1. **(ALTO) `recoverToStatus` ausente ya no queda en recovery infinito.** (a) La query
>    `listRecoverableErrorSpotGridBotsInternal` exige `recoverToStatus ∈ {running, paused}` → un
>    error-transient sin estado de retorno NO se reclama; (b) defensa: si `recoverSpotGridFromError` se
>    invoca igual sin `recoverToStatus`, **terminaliza** (`errorKind:"fatal"` + `errorMessage` accionable),
>    no no-op silencioso.
> 2. **(MEDIO) Limpieza de campos de recovery al salir del estado transitorio.** `setSpotGridStatus`
>    NORMALIZA (borra `recoverToStatus`/contadores/backoff) en TODA transición que no sea la escalada
>    error-transient. El gate-loop (`spotGridEngine.ts:702-708`) pasa `errorKind:"fatal"` en
>    `policy:"error"` y `errorKind:undefined` en `policy:"paused"`; el catch fatal hereda la limpieza.
>
> Tu tarea en r6: **confirmar que la convergencia y la limpieza de estado están bien cerradas** — ¿queda
> algún camino donde un `error`-transient sin `recoverToStatus` se siga reclamando, o donde un bot
> conserve `errorKind:"transient"`/`recoverToStatus` fantasma tras un outcome no recuperable? Verificado:
> los callers de `setSpotGridStatus` (gate-loop `:706`, fatal `:719`, stop `:771-831`) son TODOS
> transiciones no-error-transient → la normalización incondicional es segura; `pauseSpotGridBot`
> (`:257-264`) NO comparte la mutation (no tiene lease) y hace su propio patch → la limpieza se añade
> explícita ahí (admite pausar un bot en `error`); no hay resume en la UI (solo pause/stop/delete/create).
> ¿Coincidís con ese mapeo o ves un caller/transición que quede sin normalizar? Emite GO / NO-GO.

> **Ronda 6 → GO CONDICIONADO.** Codex dio GO sin bloqueante money-path, con 3 condiciones de precisión +
> 1 bajo, TODAS incorporadas (ver "Rev.7 (tras Codex GO-condicionado r6)" arriba del plan):
> 1. **(COND-1)** El claim espeja el predicate COMPLETO de la query (`recoverToStatus` válido +
>    `errorRecoveryAttempts < MAX` + `nextRetryAt`), vía helper compartido `isRecoverableError(bot)`.
> 2. **(COND-2)** `setSpotGridStatus` borra/setea `errorKind` explícitamente (incondicional):
>    `error` → `errorKind ?? "fatal"`; no-error → `errorKind: undefined`.
> 3. **(COND-3)** Eliminado el texto viejo "no-op conservador" para `recoverToStatus` ausente.
> 4. **(BAJO)** `setSpotGridBootstrap` limpia campos de recovery al setear `error` fatal.
>
> **Estado: el DISEÑO tiene GO.** El plan queda listo para implementar. El próximo veredicto de Codex será
> sobre el CÓDIGO, no sobre el plan.

## Contexto del producto
Portal de bots sobre Hyperliquid (backend Convex en `convex/`, React en `src/`). Producto **solo-real**
(custodial). El **Quantum Spot Grid** (JAV-9x/JAV-103) es un grid bot spot. Un cron
(`reconcileAllSpotGrids`, `convex/spotGridEngine.ts:686`) corre cada **1 min** (`crons.ts:49-52`), agrupa bots por cuenta HL,
toma un **lease con token** por bot (`claimSpotGridReconcile`, `convex/spotGridBots.ts:459`), revalida un
gate live, y reconcilia (`reconcileOneBot` `:525`, que puede entrar al bootstrap seeded
`runSeededBootstrap` `:408`). Todas las llamadas a HL son funciones JS planas en el MISMO contexto del
catch del loop.

## Problema (causa raíz confirmada — NO re-investigar)
Un **502 Bad Gateway / timeout / red** de HL lanza una excepción que el catch genérico del loop
(`spotGridEngine.ts:718-719`) convierte en `setSpotGridStatus({status:"error", errorMessage: safeError(e)})`.
Consecuencias: (a) el bot queda en `error` PERMANENTE; (b) `safeError(e)` (`convex/log.ts:26`) mete el
**cuerpo HTML crudo del 502** en `errorMessage`, visible en el portal; (c) el cron luego ignora los
`error` (`listActiveSpotGridBotsInternal:702` y `claimSpotGridReconcile:464` solo toman running/paused)
→ **no se recupera solo**. (El bot del incidente ya se reinició a mano; el código sigue con el bug.)

## Diseño propuesto (resumen — el detalle está en el plan)
**Reuso:** clasificar transitorio con `e instanceof TransportError` del SDK `@nktkas/hyperliquid` (ya es
el criterio canónico del repo: `convex/hyperliquid.ts:248` y `:597`); `HttpRequestError extends
TransportError` ⇒ el 502 es transitorio, sin parsear HTML. Máquina estado-con-lease + backoff + tope a
espejo de `convex/triggerRearm.ts` (auto-rearm JAV-44).

- **Schema** (`spot_grid_bots`, todo opcional/legacy-safe): `errorKind: "transient"|"fatal"`,
  `transientFailCount: number` (prevención), `errorRecoveryAttempts: number` (recuperación, contador
  SEPARADO), `nextRetryAt: number`, `recoverToStatus: "running"|"paused"` (estado a restaurar en recovery).
- **Parte 1 (Prevención):** `claimSpotGridReconcile` devuelve `wasError` (leído de DB bajo el lease); el
  loop usa `claim.wasError` (NO el snapshot de la lista). En el catch
  `:718`, `classifySpotGridError(e)`. Transitorio+activo → `bumpSpotGridTransient` (lee+incrementa
  `transientFailCount` bajo `leaseOk`, NO toca status; al alcanzar `MAX_TRANSIENT_FAILS`=12 escala a
  `error`+`errorKind:transient` con alerta y resetea contadores). Fatal → `error`+`errorKind:fatal` +
  mensaje corto. Reset del contador en `markSpotGridReconcileSuccess` llamada en el punto de éxito del
  loop (`:717`), que corre con o sin fills. Gate de `nextRetryAt` añadido al claim. El bootstrap mantiene
  sus `error` deterministas como `fatal`; un 502 dentro del bootstrap sube al catch `:718`. Catches de
  colocación (`:600`/`:675`) y actions user-facing (`createSpotGridBot`/`stopSpotGridBot`) saneados vía
  `classifySpotGridError` (nunca HTML).
- **Parte 2 (Recuperación):** nueva query `listRecoverableErrorSpotGridBotsInternal` (status=error ∧
  errorKind=transient ∧ nextRetryAt≤now ∧ **`errorRecoveryAttempts`**<`MAX_ERROR_RECOVERIES`); el cron
  también los itera; `claimSpotGridReconcile` admite `error` recuperable (espejo de
  `claimSpotGridReconcileForStop:475`). Transitorio+recuperación → `bumpSpotGridErrorRecovery` (incrementa
  `errorRecoveryAttempts` bajo `leaseOk`, backoff largo). Éxito+recuperación → `recoverSpotGridFromError`
  (restaura `recoverToStatus` = `running`/`paused`, NO siempre running; limpia
  errorMessage/errorKind/contadores/recoverToStatus). **Ambas revalidan `error`+`errorKind:transient` bajo
  el lease (Codex r3): no-op si una pausa/stop concurrente cambió el bot.** Supera tope → `error` terminal
  con `errorMessage` accionable. Fatal nunca se recupera.

## Verifica GO/NO-GO (responde cada punto)
1. **Clasificación correcta y completa.** ¿`e instanceof TransportError` captura efectivamente el 502
   (cuerpo HTML) y los timeouts/red, y NO captura rechazos deterministas (`ApiRequestError`, validación,
   firma) que SÍ deben ser fatales? ¿Hay rutas donde la excepción cruza un límite de Convex
   (`runMutation`/`runQuery`) y pierde el `instanceof` (se serializa a `Error` genérico)? El catch `:718`
   envuelve `getUserFees`/`getSpotPrice`/órdenes y mutations: ¿qué excepciones son del SDK (instanceof
   vivo) vs de un `runMutation` interno (re-lanzada/serializada) y podrían misclasificarse?
2. **No exponer HTML nunca.** ¿El diseño garantiza que NINGÚN path setea `errorMessage` con el cuerpo del
   502? (Transitorio no setea; escalada usa mensaje fijo; fatal usa `safeError`, que ya recorta a 300 —
   ¿basta para un determinista, o algún determinista también trae HTML?)
3. **Fencing / lease.** `bumpSpotGridTransient`, `bumpSpotGridErrorRecovery`,
   `markSpotGridReconcileSuccess` y `recoverSpotGridFromError` ¿operan todos bajo `leaseOk(token)`
   (`spotGridBots.ts:454`) y hacen el patch ANTES del `release` del `finally`? ¿Cada bump incrementa su
   contador EXACTAMENTE una vez por intento? ¿Riesgo de que dos workers (lease vencido) pisen contadores?
4. **Convergencia / no-flapping + origen.** Con `nextRetryAt` gateando el claim y el cron cada 1 min:
   ¿`markSpotGridReconcileSuccess` en el punto de éxito del loop (`:717`) SIEMPRE corre en una ronda
   exitosa (con o sin fills, running o paused) reseteando `transientFailCount`? ¿`wasError` (tomado de la
   lista, antes del gate) es el origen correcto para elegir entre `bumpSpotGridTransient` y
   `bumpSpotGridErrorRecovery`, y no se contamina si el gate muta el status a `paused`/`error` a mitad de
   ronda? ¿Algún camino donde un transitorio durante recuperación toque `transientFailCount` y deje inerte
   el tope `errorRecoveryAttempts`?
5. **Recuperación segura (money-path).** Al recuperar un bot desde `error`→`recoverToStatus`, el gate live
   (`assertSpotGridLiveAdmissible:704`) y el bootstrap idempotente ¿garantizan que no se duplican órdenes
   ni se re-siembra inventario? ¿Un bot que escaló a error por 12 transitorios pero cuyo estado HL cambió
   mientras tanto (órdenes vivas, fills) se reconcilia correctamente al volver, o puede actuar sobre
   estado rancio? **¿La recuperación restaura `running` vs `paused` correctamente (un `paused` que pasó
   por `error` transitorio vuelve a `paused`, NO a `running`)? ¿Algún otro punto del plan escribe
   `status:"running"` sin consultar `recoverToStatus`?**
6. **Tope y estado terminal.** ¿`MAX_TRANSIENT_FAILS`=12 y `MAX_ERROR_RECOVERIES`=8 son sensatos? ¿Un
   bot que supera el tope de recuperación queda en un estado distinguible/accionable (alerta ya emitida,
   `errorKind` preservado) o se vuelve invisible? ¿El usuario puede siempre `stopSpotGridBot`+liquidar
   desde cualquier `error` (el claim de stop admite error)?
7. **Legacy-safe.** Bots existentes sin los 5 campos nuevos
   (`errorKind/transientFailCount/errorRecoveryAttempts/nextRetryAt/recoverToStatus`) ¿se comportan como
   0/ausente en TODO el flujo (claim, query de recuperación, ambos bumps, reset, recover)? ¿El no-op
   conservador de `recoverSpotGridFromError` ante `recoverToStatus` ausente es seguro? ¿La query de
   recuperación con filtro en memoria sobre `by_status_updated` es correcta y acotada (bots en error pocos)?
8. **Huecos nuevos.** Cualquier carrera, doble-alerta, doble-orden, o camino donde un transitorio igual
   termine en `error` con HTML, o donde un fatal se trate como transitorio y reintente para siempre.

## Hechos verificados para anclar la auditoría
- Catch genérico: `convex/spotGridEngine.ts:718-723`. `safeError`: `convex/log.ts:26` (`slice(0,300)`).
- `TransportError` importado y usado como clasificador: `convex/hyperliquid.ts:6,248,597`.
- Claim del cron: `convex/spotGridBots.ts:459` (solo running/paused). Claim de stop que YA admite error:
  `:475`. `leaseOk`: `:454`. `setSpotGridStatus`: `:616` (emite `emitSpotGridErrorAlert` en transición).
  `setSpotGridFillCursor`: `:634`. `listActiveSpotGridBotsInternal`: `:702` (running+paused).
- Patrón a espejar: `convex/triggerRearm.ts` (`armErrorKind:35`, `claimRearm:42`, backoff/tope/lease).
- Bootstrap con `error` deterministas: `convex/spotGridEngine.ts:419,430,447,472,486`.

Checks que pasarán en implementación (no en esta fase de plan): `npx convex codegen` + `npm run
typecheck`. Money-path: toca el motor del grid → requiere tu GO antes de escribir código y un 2º GO sobre
el código.
