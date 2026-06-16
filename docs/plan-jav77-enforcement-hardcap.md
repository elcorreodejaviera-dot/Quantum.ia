# Plan JAV-77 — Enforcement hard-cap por plan (Planes 4/5) · MONEY-PATH

Parte de la épica **JAV-73**. ⚠️ **MONEY-PATH**: flujo completo Plan → GO Codex → PR → CodeRabbit →
GO → deploy. No mezclar con refactors amplios (CLAUDE.md). Leases/fencing del auto-rearm intactos.

> rev.2 — incorpora los 5 hallazgos de Codex: D1 y D4 CERRADAS; fórmula post-operación por pool;
> `poolId` + fuente fiable de hedge en el path legacy.
> rev.3 — 3 ajustes de plan: (1) SIN fallback estimado → helper LANZA fail-closed ante filas vivas sin
> datos; (2) revalidación in-flight en `markArmSubmitting`/`markSubmitting` + drain pre-deploy (§6);
> (3) helper en `convex/coverageUsage.ts`.
> rev.4 — (1) revalidar la Regla de admisión también en el GATE FINAL `gateArmBeforeOrder`/
> `gateBeforeOrder` (ventana updateLeverage→exchange.order); (2) terminalización EXPLÍCITA del in-flight
> bloqueado (arm/ejecución → `failed`, libera margen/cap, sin reintento ciego del auto-rearm).

## Semántica — MODELO B (decisión del usuario 2026-06-16)

El cap del plan (`coverageCapUsd`) acota la **COBERTURA DE POOLS = Σ liquidez de pool (sin buffer)**
de los pools que el usuario cubre, **NO** el nocional con buffer. Pool $50k + plan $50k → permitido
aunque el nocional de bots llegue a ~$100k (buffer hasta 100% → 2×).

- **Unidad de cobertura** = `hedgeNotionalUsd` = liquidez LP cruda leída on-chain
  (`fetchPositionNotionalStrict` → `liquidityUsd`). NO `totalNotional` (= hedge×(1+buffer/100), que es
  el sizing de la orden) ni `notional`/`requestedAmount` de una ejecución (esos son el TAMAÑO de la
  orden, no la liquidez del pool).
- **Cobertura por pool** = de todos los compromisos vivos sobre un mismo `poolId`, se toma el
  **máximo** `hedgeNotionalUsd` (un pool se cubre una vez; lecturas distintas del mismo LP pueden
  variar levemente → max es fail-closed).

### Regla de admisión (Codex #2 — total POST-operación, no "excluir y sumar cero")
Al reservar un compromiso (arm o ejecución) sobre `poolNuevo` con `hedgeNuevo`:
1. `sub = getSubscriptionForUserInternal(userId)`. `null` → `[blocked_config]` (sin dueño válido).
2. `suspended === true` → `[blocked_config]` "cuenta suspendida".
3. `plan === null` → `[blocked_config]` "sin plan de cobertura".
4. Construir `covByPool: Map<poolId, number>` sobre TODOS los compromisos vivos del usuario
   (arms no terminales + ejecuciones vivas), valor = max `hedgeNotionalUsd` por pool.
5. **Estado POST-operación**: `covPost = clone(covByPool)`;
   `covPost[poolNuevo] = max(covByPool[poolNuevo] ?? 0, hedgeNuevo)`.
6. `total = Σ covPost.values()`. Si `total > sub.coverageCapUsd` → `[blocked_margin]` "supera el tope
   de cobertura del plan".

Esto cubre downgrade de plan y estado legacy ya sobre-cap (no permite añadir más sobre un pool si el
total vivo real ya excede), y el caso `hedgeNuevo > hedgeExistente` (sube la cobertura de ese pool).

**Corrige** el comentario de `convex/subscriptions.ts:9-12` (hoy Modelo A) → Modelo B en este PR. La
UI de JAV-76 ya muestra Modelo B.

## Fuentes de cobertura viva — D1 CERRADA: incluir AMBAS en este PR (fail-closed)

El cap es money-path → debe contar TODO compromiso vivo. Hay dos mutations de reserva que comparten
margen (igual que `committedMarginForAccount`/`dailyNotionalUsed`):
- **`reserveArm`** (`triggerArms.ts`, motor IL JAV-44) — `trigger_arms` NO terminales
  (`ARM_TERMINAL = {disarmed, closed, failed}`).
- **`reserveExecution`** (`executions.ts`, legacy manual JAV-37 vía `executePerpMarketOrder`) —
  `execution_requests` vivas (status NO en `{closed, failed}`; confirmar el set terminal exacto).

Ambas se gatean con la MISMA regla, cada una dentro de su propia mutation OCC.

## Cambios

### 1. Schema (`convex/schema.ts`)
- `trigger_arms.hedgeNotionalUsd: v.optional(v.number())` — liquidez LP (sin buffer) del pool al
  armar. Snapshot inmutable, legacy-safe.
- `execution_requests.hedgeNotionalUsd: v.optional(v.number())` — ídem para el path legacy.
- `execution_requests.poolId: v.optional(v.id("pools"))` (Codex #3) — snapshot inmutable del pool;
  hoy NO existe (solo `botId`). Necesario para el dedupe por pool sin releer el bot.
- Índices para listar compromisos vivos por usuario sin full-scan: confirmar/añadir
  `trigger_arms.by_user` y `execution_requests.by_user` (si no existen ya).

### 2. Persistir la unidad de cobertura
- **Arm** (`triggerEngine.ts` `armBotInternal`): pasar `hedgeNotionalUsd` (= `notionalRead.liquidityUsd`,
  ya calculado antes de `reserveArm`) → `reserveArm` lo recibe (`v.number()`, validar `>0`/finito) y
  lo persiste en el `insert`.
- **Legacy** (`hyperliquid.ts` `executePerpMarketOrder`, que es ACTION → puede leer on-chain):
  ANTES de `reserveExecution`, leer la liquidez del LP del pool del bot con la MISMA
  `fetchPositionNotionalStrict` (Codex #4 — NO usar `actualNotional`/`tradeAmount`, que son el tamaño
  de la orden, no la cobertura del pool). Pasar `poolId = bot.poolId` y `hedgeNotionalUsd = liquidityUsd`
  a `reserveExecution`, que los valida y persiste. Si no se puede obtener `poolId` + `hedgeNotionalUsd`
  fiables (RPC/empty/par no soportado) → **bloquear** la ejecución (fail-closed), no reservar sin cap.

### 3. Helper de cobertura (fuente única, fail-closed) — NUEVO archivo (Codex rev.2 #3)
`convex/coverageUsage.ts` con `consumedCoverageByPool(ctx, userId): Map<poolId, number>`, importado
por `triggerArms.ts` (`reserveArm`) y `executions.ts` (`reserveExecution`) — fuente única, sin ciclos
de import (no vive en subscriptions/executions para no acoplar).
- recorre `trigger_arms` del usuario NO terminales (índice `by_user`) y `execution_requests` vivas;
- **SIN fallback estimado (Codex rev.2 #1):** si un compromiso vivo NO tiene `hedgeNotionalUsd` fiable
  (`> 0`, finito) o le falta `poolId`, el helper **LANZA** `[blocked_config] "cobertura no
  cuantificable: hay compromisos vivos sin datos de cobertura (requiere backfill/drain)"`. NO se
  estima con `reservedNotional`/`notional` (un estimado en money-path es inaceptable). El throw
  **bloquea TODA nueva reserva de ese usuario** hasta que sus filas vivas se backfilleen o drenen
  (ver §6). Fail-closed total.
- `map[poolId] = max(map[poolId] ?? 0, h)`.
La regla de admisión (arriba) usa este map para el total POST-operación.

### 4. Gate en `reserveArm` y `reserveExecution` (puntos canónicos, OCC)
Dentro de cada mutation, junto a los gates de margen existentes, contra `args.userId`:
- aplica la **Regla de admisión** (sección Semántica). Leer los compromisos vivos DENTRO de la
  mutation (las lecturas quedan registradas → la OCC de Convex aborta un segundo armado concurrente
  que intentara colarse sobre el mismo presupuesto; Codex #1/#2 de carreras).
- **Auto-rearm:** `reserveArm` ya corre por `userId` en el cron. Al re-armar el MISMO bot su arm
  previo es terminal (unicidad), no se cuenta a sí mismo; su pool re-entra como `poolNuevo`. Suspender/
  perder plan **bloquea el re-armado**; el error con prefijo `[blocked_config]`/`[blocked_margin]`
  mapea a la política de `triggerRearm.ts` (no reintentar para siempre, trabajo durable intacto).
- **Reservas in-flight pre-deploy (Codex rev.2 #2):** un compromiso RESERVADO antes del deploy (arm en
  `arming`/`reserved`, ejecución `pending`) podría llegar al ENVÍO después de activarse el cap,
  saltándoselo. Defensa-en-profundidad: revalidar la **Regla de admisión** (fail-closed) en TODOS los
  gates hasta el envío, no solo en la reserva.
- **Gate FINAL antes de `exchange.order` (Codex rev.3 #1) — CRÍTICO:** existe otra ventana real entre
  `mark*Submitting` y el envío: la action hace `updateLeverage` y luego llama al gate final
  (`triggerArms.gateArmBeforeOrder` / `executions.gateBeforeOrder`) justo antes de `exchange.order`.
  Hoy ese gate final solo revalida admisión live, NO suscripción/cap. → **Añadir la misma Regla de
  admisión (plan ≠ null, no suspendido, total post-operación ≤ cap) en `gateArmBeforeOrder` y
  `gateBeforeOrder`**, con el mismo fail-closed del §3 para filas sin `hedgeNotionalUsd`/`poolId`
  fiables. Puntos de revalidación money-path EN ORDEN: `reserveArm`/`reserveExecution` →
  `markArmSubmitting`/`markSubmitting` → `gateArmBeforeOrder`/`gateBeforeOrder` (último antes de enviar).
- **Terminalización del in-flight bloqueado (Codex rev.3 #2) — explícita, no "rutas existentes":**
  - **Ejecución legacy:** si `markSubmitting` o `gateBeforeOrder` bloquean por cap/suspensión/sin plan
    → el caller pasa la `execution_request` a **`failed`** con `error="[blocked_config|blocked_margin] …"`,
    SIN envío (extiende lo que ya hace el caller de `markSubmitting→blocked` al gate final). Al ser
    terminal, libera el margen/cap reservados (no cuenta como vivo).
  - **Arm IL:** si `markArmSubmitting` o `gateArmBeforeOrder` bloquean por cap/suspensión/sin plan →
    NO dejar el arm en `arming` reteniendo margen/cap. **Terminalizar a `failed`** (terminal) con razón
    explícita `[blocked_config|blocked_margin]`, sin orden viva (en estos gates aún no se envió nada).
    Libera margen/cap. El auto-rearm NO re-arma un `failed` por cap/suspensión hasta que cambie la
    condición (plan/suspensión); el `[kind]` mapea a la política de `triggerRearm.ts` (sin reintento
    ciego). Sin margen/cap retenidos ni comportamiento implícito.
  - Combinado con el drain pre-deploy de §6 (no quedan in-flight viejos al desplegar).

### 5. Eliminar límites beta `$500/$2.000` — D4 CERRADA: BORRAR (no dejar claves inertes)
Quitar el control de tamaño por orden/diario; el cap por plan (cobertura de pool) es el único control.
**NO tocar** `tradingEnabled` ni el gate de margen por colateral. Referencias a retirar (verificadas):
- `convex/executionLimits.ts` — borrar el archivo (helper `getLimit` + `LIMIT_DEFAULTS`).
- `convex/executions.ts:5,187-188` — imports y uso de `maxNotionalPerOrder`/`maxNotionalPerUserDaily`.
- `convex/triggerArms.ts:7,216-224` — import y el bloque de límites por orden/diario.
- `convex/systemConfig.ts:4,7-13,115-118,125-141` — `getExecutionLimits`, `setMaxNotionalPerOrder`,
  `setMaxNotionalPerUserDaily` y la validación sibling.
- `src/components/BotPortal.jsx:3294-3303,3544` — `ExecutionLimitsPanel` y su render en el AdminPanel.
- `convex/_generated/*` se regenera con `codegen`/deploy.
- `dailyNotionalUsed` (`executions.ts`): si tras quitar el límite diario queda sin uso, borrarlo
  también; si lo usa algo más, conservar. Verificar antes.

### 6. Migración / despliegue (pre-deploy) — drain o backfill (Codex rev.2 #1/#2)
Las filas vivas existentes no tienen `hedgeNotionalUsd`/`poolId`. Como el helper §3 LANZA ante una fila
viva sin esos datos (bloquearía a esos usuarios), hay que resolverlas ANTES de activar el cap. Dos
opciones (elegir; recomendado **A** por simpleza en beta con pocos compromisos vivos):
- **A — DRAIN (recomendado):** antes del deploy, confirmar 0 compromisos vivos sin los campos: pausar
  nuevos armados y dejar que los arms/ejecuciones vivos lleguen a terminal (o desarmarlos por las rutas
  existentes). Verificable con un query de conteo. Deploy solo cuando el conteo = 0.
- **B — BACKFILL:** action one-shot que, por cada fila viva, lee la liquidez LP del pool
  (`fetchPositionNotionalStrict`) y setea `hedgeNotionalUsd` + `poolId`; si alguna no se puede
  cuantificar fiable → drenar esa fila. Más trabajo; útil si no se quiere pausar.
Runbook: documentar el paso elegido en `docs/runbook-beta-mainnet.md`. El orden de deploy importa:
schema (campos opcionales) primero; el gate del cap se activa con el código; el drain/backfill ocurre
en la ventana entre ambos.

## Open decisions restantes
- **D3** (dedupe por pool): resuelto con `max` por pool + total post-operación; confirmar con Codex que
  el sizing (`totalNotional`) NO se ve afectado (sigue derivándose del hedge del propio bot).

## Qué NO se toca
- Sizing/`totalNotional`, leverage (`leverage.ts` fuente única), reconciliación/leases/fencing,
  `tradingEnabled`, gate de margen por colateral.

## Verificación
- `npm run typecheck` (type-check real backend) EXIT 0 (toca schema: deploy revalida).
- Testnet/sim: bot que cabe por cobertura de pool ARMA; el que excede el cap se BLOQUEA
  (`[blocked_margin]`) en armado MANUAL, auto-rearm y ejecución legacy; usuario sin plan/suspendido
  BLOQUEADO en los tres; segundo armado concurrente sobre el mismo presupuesto → uno aborta (OCC);
  quitar $500/$2k no rompe `executions.ts`/`triggerArms.ts`/`systemConfig.ts`/AdminPanel.
- Pruebas reales las corre el usuario (sin mocks).
