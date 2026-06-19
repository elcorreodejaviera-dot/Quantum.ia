# Fase 4 — PR2: state machines + reservation (con `convex-test`)

## En una frase

PR1 cubrió los helpers PUROS. PR2 cubre los invariantes que viven DENTRO de mutations (necesitan
`ctx.db`): las transiciones de estado (terminal no resucita, `protected` no degrada, inválidas
rechazadas) y la suma de margen comprometido por ambos motores. Se usa `convex-test` (DB simulada),
ejecutando las mutations REALES — sin exportar los mapas privados `ALLOWED`/`ALLOWED_ARM` (Codex #3).

## Tooling nuevo

- Añadir `convex-test` como devDependency. Vitest ya existe; `convex-test` corre las funciones Convex
  (queries/mutations, NO actions `"use node"`) contra una implementación en memoria del backend.
- **(Codex MEDIO#1, re-cerrado) ALLOWLIST POSITIVA, no glob global con deletes.** Un
  `import.meta.glob("../convex/**/*.ts")` + deletes aún podría registrar módulos no deseados
  (p.ej. `cronHealth.ts`, que define `internalAction`). Vite acepta un ARRAY de rutas literales en
  `import.meta.glob` → se enumera explícitamente SOLO el cierre mutation-safe:
  ```ts
  const modules = import.meta.glob([
    "../convex/executions.ts",
    "../convex/triggerArms.ts",
    "../convex/triggerRearm.ts",
    "../convex/coverageUsage.ts",
    "../convex/leverage.ts",
    "../convex/log.ts",
    "../convex/engineEvents.ts",
    "../convex/helpers.ts",
    "../convex/plans.ts",
    "../convex/hlNetwork.ts",
  ]);
  // Guard anti-drift: fallar si el set cargado difiere del allowlist esperado.
  const EXPECTED = new Set([/* las 10 rutas de arriba */]);
  for (const k of Object.keys(modules)) if (!EXPECTED.has(k)) throw new Error(`módulo inesperado: ${k}`);
  const t = convexTest(schema, modules);   // schema se pasa aparte
  ```
  NUNCA se incluye un módulo `"use node"` (hyperliquid/hlCredentialActions) ni actions/crons
  (triggerEngine, adminLive, crons, *Cron, cronHealth). Si una mutation bajo test referenciara un
  `internal.*` ausente en runtime, se AÑADE esa ruta a la allowlist (siempre que no sea `"use node"`).
- Posible ajuste de `vitest.config.ts` (entorno `edge-runtime` si node no basta para convex-test; se
  decide al implementar). Los tests de PR1 (helpers puros, env node) NO deben romperse → si hay
  conflicto de entorno, usar `// @vitest-environment edge-runtime` por archivo.

## Qué se testea (mutations reales, sin tocar lógica)

### 1. Transiciones de ejecución (`settleExecution` → `applyTransition`, `convex/executions.ts`)
Sembrando una `execution_requests` y llamando `settleExecution`, afirmar contra la DB:
- **terminal no resucita:** desde `closed`/`failed`, cualquier `settleExecution(...)` → NO cambia el
  estado (no-op por `FINAL_STATES`).
- **`protected` no degrada:** `protected → sl_failed` → NO aplica (ALLOWED no lo permite); `protected →
  closed` → SÍ aplica.
- **transición inválida rechazada:** p.ej. `entry_filled → submitting` → no-op.
- **válida aplica:** `pending → entry_filled` → aplica.
- **(Codex BAJO#4) `trades_history` EXACTAMENTE una vez:** contar filas antes/después →
  - transición a terminal (`closed`/`failed`) inserta UNA fila y marca `historyRecorded=true`;
  - repetir `settleExecution` sobre el ya-terminal NO duplica (no-op por FINAL_STATES);
  - transiciones NO terminales (`entry_filled`/`protected`) NO insertan en `trades_history`.

### 2. Transiciones de arm (`settleArm`, `convex/triggerArms.ts`)
- **ARM_TERMINAL no resucita:** desde `disarmed`/`closed`/`failed` → no-op.
- **válidas vs inválidas** según `ALLOWED_ARM` (p.ej. `filled → protecting` sí; `protected → armed`
  no). OJO con la **cuarentena N6**: una terminalización con `submittedAt` reciente devuelve
  `{quarantined:true}` → sembrar `submittedAt` antiguo (o null) para probar la transición en sí.
- **(Codex MEDIO#2) `closeReason` obligatorio al cerrar:** `settleArm` rechaza `status:"closed"` SIN
  `closeReason`. Por eso:
  - las transiciones VÁLIDAS a `closed` se siembran/llaman SIEMPRE con `closeReason` (si no, el no-op se
    atribuiría por error a ALLOWED/terminal/cuarentena);
  - test NEGATIVO explícito: `protected → closed` SIN `closeReason` → no-op (y afirmar que la razón es
    esa, no otra).
- **fencing:** con `token` provisto y lease vencido/ajeno → no-op (probar el guard).

### 3. Margen comprometido (`committedMarginForAccount`, exportada)
**(Codex MEDIO#3) Vía de invocación test-only, sin wrapper productivo:** el helper toma `ctx` (usa solo
`ctx.db.query`). Se invoca dentro de `t.run(async (ctx) => committedMarginForAccount(ctx, accId))` que
`convex-test` provee con un ctx de DB — NO se añade ninguna función Convex desplegable solo para el test.
Sembrar `execution_requests` + `trigger_arms` y afirmar:
- suma SOLO los estados con margen vivo (`OPEN_MARGIN_STATES` / `ARM_OPEN_MARGIN_STATES`), ignora
  terminales.
- usa `marginReserved ?? notional` (exec) y `marginReserved ?? reservedNotional` (arm).
- **invariante JAV-85 #1:** `armed_lower_only` SÍ cuenta como margen comprometido.
- suma de AMBOS motores en la misma cuenta (no doble gasto del colateral).
- **(Codex extra) aislamiento por cuenta:** filas de OTRA `hlAccountId` NO entran en la suma de la
  cuenta consultada.

## Fixtures (Codex BAJO#5): helpers mínimos, NO objetos ad-hoc por test

Las tablas tienen campos requeridos; sembrar a mano en cada test arriesga que un fallo venga del
schema y no del invariante. Un módulo `tests/fixtures.ts` con helpers de defaults válidos + overrides
pequeños, sembrados dentro de `t.run`:
- `seedUser(ctx, over?)`, `seedCredential(ctx, {userId}, over?)`, `seedBot(ctx, {userId, hlAccountId}, over?)`.
- `seedExecutionRequest(ctx, {userId, botId, hlAccountId}, over?)` (status/marginReserved/notional…).
- `seedTriggerArm(ctx, {userId, botId, hlAccountId}, over?)` (status/marginReserved/reservedNotional/
  submittedAt/reconcileLeaseToken…).
Cada helper devuelve el id insertado. Los overrides solo tocan lo relevante al invariante bajo test.

## Decisiones cerradas (post-auditoría Codex)
- **convex-test es el camino** (confirmado): exportar `ALLOWED`/`ALLOWED_ARM` probaría datos privados,
  no el comportamiento real con fencing/cuarentena/`historyRecorded`/patches/DB. **No se exportan.**
- **Alcance correcto:** transiciones + margen en PR2; sin actions ni reconciliadores completos.
- **Registro de módulos explícito** (MEDIO#1), **`closeReason` en cierres de arm** (MEDIO#2),
  **invocación test-only de `committedMarginForAccount` vía `t.run`** (MEDIO#3), **conteo exacto de
  `trades_history`** (BAJO#4) y **aislamiento por cuenta** — todos incorporados arriba.

## Entregables
- `convex-test` en devDependencies.
- `tests/fixtures.ts` (helpers de sembrado).
- `tests/stateMachine.test.ts` (exec + arm), `tests/reservation.test.ts` (margen).
- (Si hace falta) ajuste de `vitest.config.ts`.

## Verificación
- `npm test` (PR1 + PR2 verdes) + `npm run typecheck`. Sin red ni HL real.

## Flujo
plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → merge. Riesgo BAJO-MEDIO (tests,
pero introduce convex-test → posible fricción de entorno; cero cambio de lógica de producción).
