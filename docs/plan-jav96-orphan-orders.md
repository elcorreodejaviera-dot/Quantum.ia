# Plan JAV-96 — Fix `orphan_orders` falso positivo (observedStatus rancio al cancelar entradas)

> Rev.2 (tras Codex NO-GO r1): helper por **CLOID exacto** (no por rol), enumeración COMPLETA de
> rutas de terminalización y de los puntos `ensureOrdersDead===true`, y tests convex de cierre/disarm/
> armed_lower_only.
> Rev.3 (tras Codex NO-GO r2): marcar SOLO donde el retorno de `ensureOrdersDead` se COMPRUEBA `=== true`;
> excluido el ~614 (best-effort en cierre de emergencia) y N5 ~420 (cancelByCloid best-effort sin prueba
> negativa) — esos los cubre el gate/reconcile que sí verifica muerte.

## Objetivo
Que un arm terminal no deje filas `trigger_orders` con `observedStatus:"open"` rancio cuando la orden
ya fue cancelada/confirmada muerta en HL, para que el check `orphan_orders` del panel "Auditoría de
Pools" deje de dar falso positivo **y** quede como detector fiable de huérfanos REALES.

## Causa raíz
- `orphan_orders` (`src/lib/poolAudit.js:51`) dispara cuando un arm **terminal** (`disarmed|closed|failed`)
  tiene alguna `trigger_order` con `observedStatus === "open"`.
- El audit lee `observedStatus` **de la DB** (`convex/admin.ts:291`), **NO** consulta HL en vivo → el
  texto "vivas en HL" es engañoso.
- Las entradas (`entry_lower`/`entry_upper`) se marcan `observedStatus:"open"` al colocarse
  (`triggerEngine.ts:372`); al **cancelarse** vía `ensureOrdersDead`/`cancelByCloid` **nadie** actualiza
  su fila a `canceled` (SL/TP sí: 648/714/760) → quedan `open` rancio en arms terminales.
- El motor garantiza (anti-huérfano Codex #2, `triggerEngine.ts:510`) no declarar `closed` con orden
  viva (gate `ensureOrdersDead`) → huérfano REAL muy improbable; lo que se ve es rancio.

## Diagnóstico previo (OBLIGATORIO antes de tocar money-path)
1. **Convex query (read-only, admin):** `trigger_orders` con `observedStatus ∈ {open, pending}` cuyo
   `arm.status` sea terminal (`disarmed|closed|failed`). Listar armId/role/cloid/updatedAt.
2. **HL en vivo:** `frontendOpenOrders` de la `tradingAccountAddress` del bot ETH/USDC → confirmar que
   esos cloids **no** están en el book.
- No vivos → falso positivo confirmado (rancio) → Opción A. Alguno vivo → huérfano REAL → cancelar y
  revisar por qué el gate anti-huérfano no lo pilló.

## Enfoque: Opción A (raíz) — marcar `canceled` por CLOID, SOLO tras muerte confirmada

### 1. Nueva internalMutation `markArmOrdersCanceled(armId, token, cloids)`  (`convex/triggerArms.ts`)
- Args: `armId`, `token` (lease), **`cloids: string[]`** (las EXACTAS que `ensureOrdersDead` confirmó
  muertas). **NO por rol** (Codex r1 #3): `tp` tiene múltiples `tpIndex` y `armed_lower_only` jamás
  debe tocar `entry_lower` viva.
- Bajo el MISMO fencing que `setArmOrderObserved`/`settleArm` (token + `reconcileLeaseUntil` vigente).
- Para cada cloid: busca la `trigger_order` por índice `by_cloid`; si su `observedStatus ∈ {open,
  pending}` → patch a `canceled` + `updatedAt`. **NUNCA** toca `filled`/`triggered`/`rejected`/`canceled`.
- Idempotente. `elog("arm","orders_canceled",{ armId, n })` (OBS-3, solo escalares; NO loguear cloids).

### 2. Llamarla SOLO donde el booleano de `ensureOrdersDead(...) === true` se COMPRUEBA (prueba negativa real) y precede una transición terminal/parcial (`convex/triggerEngine.ts`)
Pasar EXACTAMENTE los cloids recién confirmados muertos (Codex r1 #4). **Regla dura (Codex r2 #1): NO
marcar en llamadas a `ensureOrdersDead` cuyo retorno se IGNORA (best-effort).**
- **Cierre flat normal** — gate `if (!(await ensureOrdersDead(allCloids))) return ...` (línea ~575,
  retorno comprobado) → antes de `closeArmAndScheduleRearm` (`triggerArms.ts:700`) →
  `markArmOrdersCanceled(armId, token, allCloids)`.
  - ⛔ **NO** marcar en la línea ~614: ahí `ensureOrdersDead(allCloids)` es **best-effort** (retorno
    IGNORADO) dentro del cierre de EMERGENCIA, que luego hace market close reduceOnly. El arm de
    emergencia alcanza `closed` por el gate (1) (~575) que sí exige `=== true` → el marcado ocurre ahí,
    no en ~614.
- **Transición a `armed_lower_only`** — `ensureOrdersDead(nonLowerCloids)` (~568) y `(deadCloids)`
  (~952), ambos con retorno comprobado → marcar SOLO esos cloids (NUNCA `entry_lower`, sigue armada).
  Cierre por expiración → `closeArmLowerOnlyExpired` (`triggerArms.ts:484`): marcar las cancelables
  confirmadas muertas.
- **Disarm pre-fill** — `if (!(await ensureOrdersDead(entryCloids)))` (~923, comprobado) → antes de
  `settleArm(... "disarmed")` (engine ~927) → `markArmOrdersCanceled(armId, token, entryCloids)`.
- **`failed` por prueba negativa** — `ensureOrdersDead(entryCloids)` (~977, comprobado) → antes de
  `settleArm(... "failed")` (engine ~984) → marcar `entryCloids`.
- ⛔ **N5 defensa pausa (~420): NO marcar aquí** (Codex r2 #2). Ese punto solo hace `cancelByCloid`
  best-effort tras pausa, SIN prueba negativa. El marcado lo hará el reconcile de `wantDisarm`, que sí
  pasa por `ensureOrdersDead(entryCloids) === true` (disarm pre-fill, arriba).

### 3. Rutas de terminalización SIN órdenes "open" (confirmar que NO necesitan cambio)
Terminalizan con entradas en `pending` (nunca enviadas a HL) → no generan `open` rancio y el audit no
las marca: `failArmPreOrder` (`triggerArms.ts:829`, exige entradas pending+oid null),
`recoverAbandonedArming` (`:866`), patches directos a `failed` en gates pre-envío
(`markArmSubmitting :366`, `gateArmBeforeOrder :408`, engine `:409`). DOCUMENTAR como no-afectadas;
opcional normalizar `pending→canceled` por higiene, NO requisito (el audit solo mira `open`).

### 4. `settleArm` — NO normalizar a ciegas (Codex r1 #2)
No marcar `open→canceled` dentro de `settleArm`: enmascararía un huérfano REAL si un cancel falló en
silencio. La señal se preserva confiando en los call sites que pasaron por `ensureOrdersDead`.

### Lo que NO se toca
Lógica SL/TP (ya marca `canceled`); gate anti-huérfano; máquina de estados del arm; reserva/cálculo de
margen; OCO; auto-rearm; conteo whipsaw/consecutiveStops.

## Alternativa descartada (Codex r1 #5 de acuerdo): Opción B
Cruzar `openOrders` HL en `adminLive.ts`: más RPC/fan-out y mezcla diagnóstico read-only con
reconciliación; no corrige la inconsistencia de datos. Posible endurecimiento posterior, no ahora.

## Tests
- **poolAudit (pure, suite existente):** caso "arm terminal con órdenes `canceled` → NO `orphan_orders`"
  + mantener el positivo (orden `open` en arm terminal → sí dispara).
- **convex-test (motor) — congelar "terminal tras muerte confirmada ⇒ open/pending pasan a canceled;
  filled/triggered/rejected NO cambian":**
  - **Cierre flat** de un arm con `entry_lower` en `open` → tras reconcile: `canceled`.
  - **Disarm pre-fill** → entradas `open/pending` → `canceled`.
  - **`armed_lower_only`**: las del short de arriba → `canceled` PERO `entry_lower` viva permanece
    `open` (no se toca).
  - Un SL/TP `filled` NO cambia a `canceled`.
  Reusar infra de tests de máquina de estados de Fase 4 (convex-test).

## DoD
- Diagnóstico confirma rancio (o se trata el real).
- Todo arm que cierra/disarma/expira deja sus órdenes confirmadas muertas en `canceled` (no `open`),
  por CLOID, en TODAS las rutas enumeradas.
- `orphan_orders` solo dispara con una orden realmente viva sobre arm terminal.
- `npm run typecheck` OK, tests verdes, `convex deploy` (toca `convex/`), verificar `HL_NETWORK=mainnet`.
- Flujo: plan → GO Codex → implementar → GO Codex código → PR → CodeRabbit → merge → deploy.
