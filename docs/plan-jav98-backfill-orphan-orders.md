# Plan JAV-98 — Backfill orphan_orders (limpiar observedStatus rancio preexistente)

## Por qué
JAV-96 (PR #94) corrige `orphan_orders` **hacia adelante**: al cerrar/disarmar un arm marca sus órdenes
confirmadas muertas como `observedStatus:"canceled"`. Pero NO migró las filas YA existentes: un arm que
quedó terminal ANTES del deploy conserva `observedStatus:"open"` rancio → el panel "Auditoría de Pools"
lo sigue marcando (lee el campo de la DB, no HL). Falta un backfill puntual.

## Alcance
`convex/migrations.ts` (NON-node, internalMutation/internalQuery; se corre una vez con `npx convex run`).
NO toca HL, NO envía/cancela órdenes, NO toca el motor: solo normaliza un campo de display en arms YA
terminales.

### 1. `diagnoseOrphanOrders` (internalQuery, read-only)
Barre `trigger_orders`; para cada uno cuyo arm esté en estado terminal (`disarmed|closed|failed`) y con
`observedStatus ∈ {open, pending}`, lo incluye en el resultado: `{ armId, botId, armStatus, role, cloid,
observedStatus }`. Permite INSPECCIONAR antes de tocar nada (`npx convex run migrations:diagnoseOrphanOrders`).

### 2. `backfillCanceledOrphanOrders` (internalMutation)
Mismo barrido; patch `observedStatus → "canceled"` SOLO en órdenes `open/pending` de arms terminales.
- **SOLO arms terminales** (nunca toca un arm vivo / `armed_lower_only` con entry_lower armada → ese NO
  es terminal).
- Idempotente (re-ejecutar no cambia nada; las ya `canceled` se saltan).
- Devuelve `{ scanned, patched, byStatus }`.
- Sin auth: se ejecuta vía `npx convex run` (acceso CLI = acceso deploy; igual que `backfillBotsUserId`).

## Seguridad
- El motor garantiza (anti-huérfano, Codex #2) que un arm `closed` no tenía órdenes vivas en el book →
  lo que queda es dato rancio, seguro de normalizar.
- El diagnóstico read-only se corre PRIMERO para confirmar qué cambiaría (y, si se quiere, contrastar con
  `frontendOpenOrders` de la cuenta del bot ETH/USDC).
- Restringido a estados terminales: imposible cancelar (en DB) una orden de un arm vivo.

## Tests (convex-test)
- arm terminal + orden `open` → backfill la pasa a `canceled`; arm terminal + `pending` → `canceled`.
- arm terminal + `filled`/`triggered`/`canceled` → NO cambia.
- arm VIVO (`armed`/`armed_lower_only`) + `open` → NO se toca.
- idempotencia: segunda corrida `patched: 0`.
- `diagnoseOrphanOrders` lista exactamente los que el backfill tocaría.

## DoD
`npm run typecheck` OK · tests verdes · plan → GO Codex → PR → CodeRabbit → merge → `convex deploy` →
`npx convex run migrations:diagnoseOrphanOrders` (revisar) → `npx convex run
migrations:backfillCanceledOrphanOrders` → verificar que el panel deja de marcar orphan_orders.
