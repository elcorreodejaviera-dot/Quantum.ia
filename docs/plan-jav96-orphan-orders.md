# Plan JAV-96 — Fix `orphan_orders` falso positivo (observedStatus rancio al cancelar entradas)

## Objetivo
Que un arm terminal no deje filas `trigger_orders` con `observedStatus:"open"` rancio cuando la orden
ya fue cancelada en HL, para que el check `orphan_orders` del panel "Auditoría de Pools" deje de dar
falso positivo **y** quede como detector fiable de huérfanos REALES.

## Contexto / causa raíz
- El check `orphan_orders` (`src/lib/poolAudit.js:51`) dispara cuando un arm **terminal**
  (`disarmed|closed|failed`) tiene alguna `trigger_order` con `observedStatus === "open"`.
- El audit lee `observedStatus` **de la DB** (`convex/admin.ts:291`), **NO consulta HL en vivo** → el
  texto "vivas en HL" es engañoso.
- Las órdenes de **entrada** (`entry_lower`/`entry_upper`) se marcan `observedStatus:"open"` al colocarse
  (`triggerEngine.ts:372`), pero cuando se **cancelan** en el cierre/disarm vía `ensureOrdersDead` /
  `cancelByCloid` (`triggerEngine.ts:70-79`, `~420`, `~575`, `~614`) **nadie actualiza su fila a
  `canceled`**. (Las de SL/TP sí: líneas 648/714/760.)
- → un arm que cierra deja sus filas de entrada con `observedStatus:"open"` rancio aunque la orden esté
  MUERTA en HL → el audit grita huérfano para siempre. Misma clase de bug que JAV-95 (dato rancio).
- El motor **garantiza** (anti-huérfano Codex #2, `triggerEngine.ts:510`) no declarar `closed` con una
  orden viva en el book (`ensureOrdersDead` gatea el cierre) → un huérfano REAL es muy improbable.

## Diagnóstico previo (OBLIGATORIO antes de tocar money-path)
Confirmar que es rancio y no un huérfano real, con datos reales:
1. **Convex query (read-only, admin):** contar `trigger_orders` con `observedStatus ∈ {open, pending}`
   cuyo `arm.status` sea terminal (`disarmed|closed|failed`). Listar armId/role/cloid/updatedAt.
2. **HL en vivo:** `frontendOpenOrders` de la `tradingAccountAddress` del bot ETH/USDC → confirmar que
   esos cloids **no** están en el book.
- Si no están vivos → confirmado falso positivo (rancio) → proceder con Opción A.
- Si alguno está vivo → huérfano REAL → cancelarlo y revisar por qué el gate anti-huérfano no lo pilló.

## Enfoque elegido: Opción A (raíz) — marcar `canceled` al confirmar muertas
Reusar el patrón ya existente para SL/TP (`setArmOrderObserved(..., "canceled")`).

### Cambios
1. **`convex/triggerArms.ts` — nueva internalMutation `markArmOrdersCanceled`:**
   - Args: `armId`, `token` (lease), `roles?` (opcional; si se omite → todas las del arm).
   - Bajo fencing (mismo patrón que `setArmOrderObserved`/`settleArm`): para cada `trigger_order` del arm
     con `observedStatus ∈ {open, pending}` (NUNCA tocar `filled`/`triggered`/`rejected`/`canceled`) →
     patch a `canceled` + `updatedAt`.
   - Idempotente (re-llamarla no cambia nada).
   - `elog("arm","orders_canceled",{ armId, n })` (OBS-3, solo escalares).

2. **`convex/triggerEngine.ts` — llamarla SOLO donde `ensureOrdersDead` YA confirmó muerte:**
   - Tras `ensureOrdersDead(...allCloids...) === true` en los gates de cierre (líneas ~575 y ~614) →
     `markArmOrdersCanceled(armId, token)` **antes** del `settleArm(closed)`. Sabemos que todas están
     muertas.
   - En `armed_lower_only` (línea ~568, cancela `nonLowerCloids`) →
     `markArmOrdersCanceled(armId, token, roles: <no-lower>)` solo para esas (NO tocar `entry_lower`,
     que sigue armada).
   - En la defensa N5 (línea ~420, cancela ambas entradas tras pausa) → marcar esas entradas `canceled`
     (o dejar que el reconcile de disarm lo haga; decidir con Codex para no duplicar).
   - **Disarm/pausa:** localizar el punto del reconcile donde se cancela por `desiredState:"disarmed"` y
     se llega a terminal → tras confirmar muertas (`ensureOrdersDead`), misma llamada.

3. **`convex/triggerArms.ts:settleArm` — red de seguridad (decisión a validar con Codex):**
   - Recomendación: **NO** normalizar a ciegas `open→canceled` en settleArm, porque enmascararía un
     huérfano REAL si un cancel falló en silencio. Confiar en los call sites que ya verificaron muerte
     con `ensureOrdersDead`. Que el audit siga pudiendo señalar el caso real residual.

### Lo que NO se toca
- La lógica de SL/TP (ya marca `canceled`).
- El gate anti-huérfano (`ensureOrdersDead` que bloquea `closed` con orden viva).
- La máquina de estados del arm ni el cálculo/reserva de margen.

## Alternativa descartada (registrada): Opción B — audit robusto contra HL live
Ampliar `adminLive.ts` para traer `openOrders` por cuenta y marcar huérfana solo si el cloid sigue vivo
en el book. Elimina la dependencia del `observedStatus` persistido, pero añade RPC por cuenta (coste) y
no corrige la inconsistencia de datos subyacente. Considerar como endurecimiento posterior, no ahora.

## Tests
- **poolAudit (pure, ya existe la suite):** añadir caso "arm terminal con todas las órdenes `canceled`
  → NO `orphan_orders`" y mantener el caso positivo (orden `open` en arm terminal → sí dispara).
- **convex-test (motor):** simular cierre de un arm con `entry_lower` en `open` → tras el reconcile de
  cierre su `observedStatus` queda `canceled` y el audit no marca huérfano. Reusar la infra de tests de
  máquina de estados de Fase 4.

## DoD
- Diagnóstico confirma rancio (o se trata el huérfano real si lo hubiera).
- Un arm que cierra/disarma deja sus entradas en `canceled` (no `open`).
- `orphan_orders` solo dispara con una orden realmente viva sobre arm terminal.
- `npm run typecheck` OK, tests verdes, `convex deploy` (toca `convex/`), verificar `HL_NETWORK=mainnet`.
- Flujo: este plan → GO Codex → implementar → GO Codex código → PR → CodeRabbit → merge → deploy.
