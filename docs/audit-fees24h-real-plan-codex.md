# Auditoria Codex - plan "Fees 24h real"

## Alcance auditado

- Prompt: `docs/audit-prompt-fees24h-real-plan.md`
- Plan: `docs/plan-fees24h-real.md`
- Codigo contrastado:
  - `convex/actions/poolScanner.ts`
  - `convex/pools.ts`
  - `convex/schema.ts`
  - `convex/crons.ts`
  - `convex/cronHealth.ts`
  - `src/components/BotPortal.jsx`

Objetivo revisado: reemplazar el tile "Fees 24h (tu parte)" estimado pool-wide por una metrica real por posicion basada en snapshots raw y lecturas on-chain read-only.

## Bloqueante

No hay hallazgos bloqueantes de money-path. El plan se mantiene read-only/display si se implementa como describe.

## Alto

### 1. El delta propuesto no descuenta `principalDebt`, por lo que puede contar principal liberado como fee

Evidencia:

- El plan define `fees_acumuladas(t) = collected_hasta(t) + uncollected(t)` en `docs/plan-fees24h-real.md:55-59`.
- La tabla propuesta guarda `uncollected0Raw/1Raw` tal cual como `collect() simulado` y `collected0Raw/1Raw` en `docs/plan-fees24h-real.md:80-85`.
- El writer propuesto solo lee `fetchUncollectedFeesRaw` y `feesCollectedRaw0/1` en `docs/plan-fees24h-real.md:95-99`.
- El codigo existente ya documenta que `tokensOwed live` incluye principal liberado por `Decrease` y lo descuenta con `principalDebt` antes de calcular lifetime: `convex/actions/poolScanner.ts:886-903`.
- La contabilidad de `principalDebt` se recomputa en `convex/pools.ts:244-271`.

Impacto:

Si una posicion hizo `DecreaseLiquidity` y ese principal quedo como cobrable, `collect()` simulado devuelve principal + fees. El snapshot delta puede inflar "Fees 24h real" con principal, justo la clase de error que JAV-117 ya habia corregido para lifetime.

Correccion sugerida:

- No guardar ni comparar `tokensOwed` bruto como fee.
- Guardar o derivar un acumulador raw neto por token: `feesAccumRaw = feesCollectedRaw + max(tokensOwedRaw - principalDebtRaw, 0)`.
- La snapshot debe incluir los cuatro agregados necesarios (`feesCollectedRaw0/1`, `principalDebt0/1`) o directamente guardar `feesAccum0Raw/1Raw` ya neteado.
- Si faltan agregados o son parciales, el status no puede ser `ok`; debe ser `unavailable`/`partial`.

### 2. El manejo de collects sin Alchemy es insuficiente: un delta positivo tambien puede subcontar y quedar marcado como `ok`

Evidencia:

- El plan reconoce que sin Alchemy el incremental de collected esta inerte: `docs/plan-fees24h-real.md:67-70`.
- La mitigacion propuesta solo detecta el caso en que el delta queda negativo y lo clampa a `partial`: `docs/plan-fees24h-real.md:70-73` y `docs/plan-fees24h-real.md:156-159`.
- El camino `refreshOnePoolLifetime` depende de `alchemyUrl` y con falta de key retorna `no_key` sin capturar eventos: `convex/actions/poolScanner.ts:1211-1217`.

Impacto:

Un collect dentro de la ventana no siempre produce delta negativo. Ejemplo: al inicio hay 5 unidades uncollected, el usuario cobra, luego la posicion genera 10 unidades nuevas. Si `collected` no avanza, el delta bruto puede ser positivo `+5`, pero el real es `+10`. El plan podria mostrar un numero positivo como "Real on-chain (24h)" aunque sea incompleto.

Correccion sugerida:

- `getLogs` estrecho o una prueba estructural equivalente no puede ser opcional para status `ok` cuando hubo cambios de posicion.
- Guardar en cada snapshot una `positionSnapshotKey`/`lifetimeSnapshotKey` o equivalente; en la lectura live, si la key cambio desde el snapshot de referencia y no se capturaron eventos completos de la ventana, devolver `partial`/`unavailable`, no `ok`.
- Si se implementa `getLogs` estrecho, hacerlo obligatorio para certificar `ok` en ventanas con cambio; si el RPC publico falla, el resultado debe quedar `partial`.

## Medio

### 1. El snapshot de referencia puede representar mas de 24h si el cron tiene huecos

Evidencia:

- El plan elige el snapshot "mas reciente con `at <= now - 24h`" y no interpola en v1: `docs/plan-fees24h-real.md:89-90`.
- El cron propuesto corre cada 1h: `docs/plan-fees24h-real.md:154-155`; el cron actual de lifetime tambien es horario en `convex/crons.ts:72-76`.

Impacto:

Si el cron falla varias horas, la referencia puede ser de 30h, 40h o mas y el valor se seguiria etiquetando como "24h". Sin tolerancia de antiguedad, el numero deja de ser una metrica real de 24h.

Correccion sugerida:

- Definir tolerancia maxima: por ejemplo aceptar referencia entre 24h y 26h, o mostrar `partial/stale` con el intervalo real.
- Exponer `windowHours`/`refAgeMs` al front para tooltips y estados.

### 2. La action nueva de lectura no especifica autorizacion owner/admin

Evidencia:

- El plan propone una action backend que lee snapshots y devuelve `fees24hUsd`: `docs/plan-fees24h-real.md:103-109`.
- `listPools` filtra por usuario en `convex/pools.ts:6-17`.
- Mutations de pool existentes validan owner/admin en `convex/pools.ts:132-157`.
- Las actions publicas actuales en `poolScanner.ts` solo hacen `requireAuth` para cuota/RPC (`convex/actions/poolScanner.ts:851`), pero no leen datos privados de la DB.

Impacto:

Si la nueva action acepta `poolId` y consulta `pool_fee_snapshots`, un usuario autenticado podria intentar leer snapshots de otro usuario salvo que se valide propiedad/admin. Aunque parte de la informacion sea on-chain, la asociacion pool-usuario y su historial dentro de la app no debe quedar abierto.

Correccion sugerida:

- En la action, obtener identidad con `ctx.auth.getUserIdentity()`.
- Llamar a una internalQuery que valide `pool.userId` contra el usuario actual o rol admin antes de leer snapshots.
- No confiar en que el front solo envie pools de `listPools`.

### 3. El fallback concentrado mezcla unidades de USD diario y APR

Evidencia:

- El plan dice mostrar run-rate concentrado `fees1d * feeShareRatio / valor` en `docs/plan-fees24h-real.md:113-118`.
- El codigo actual calcula `concentratedFeeApr` como `(fees1d * feeShareRatio / mValorLP) * 365 * 100` en `src/components/BotPortal.jsx:441-444`.

Impacto:

Para el tile en USD diario, el estimado concentrado deberia ser `fees1d * feeShareRatio`. Dividir por valor produce una tasa, no dolares. Si se reutiliza `concentratedFeeApr`, hay que convertir explicitamente segun el tile.

Correccion sugerida:

- Definir dos variables distintas:
  - `estimatedFees24hUsd = fees1d * feeShareRatio`
  - `estimatedFeeApr = estimatedFees24hUsd / mValorLP * 365 * 100`
- Usar cada una en su tile/tooltip correspondiente.

## Bajo

### 1. El costo RPC esta subestimado

Evidencia:

- El plan lista `+1 eth_call/pool/hora` en `docs/plan-fees24h-real.md:163-164`.
- `fetchUncollectedFeesRaw` hace al menos `ownerOf` y luego `collect()` simulado: `convex/actions/poolScanner.ts:689-704`.

Impacto:

El coste base real es al menos +2 `eth_call` por pool/hora, mas reintentos por fallback de RPC. Sigue siendo razonable, pero debe medirse con el numero real.

Correccion sugerida:

- Actualizar el plan a +2 `eth_call`/pool/hora base.
- Mantener concurrencia limitada y registrar contadores de success/unavailable en cronHealth.

### 2. El comando de verificacion de schema esta impreciso

Evidencia:

- El plan dice `npx convex` typecheck en `docs/plan-fees24h-real.md:150`.
- El proyecto tiene `npm run typecheck` definido como `tsc -p convex/tsconfig.json --noEmit` en `package.json`.

Impacto:

Bajo. Puede causar friccion o una verificacion incompleta.

Correccion sugerida:

- Usar `npx convex codegen` si se requiere regenerar tipos, y `npm run typecheck` para validar TypeScript.

## Checks realizados

- `git status --short --branch`
- `sed -n '1,260p' docs/audit-prompt-fees24h-real-plan.md`
- `sed -n '1,320p' docs/plan-fees24h-real.md`
- `nl -ba docs/plan-fees24h-real.md`
- `nl -ba convex/actions/poolScanner.ts` en rangos relevantes:
  - `fetchUncollectedFeesRaw`
  - `fetchPositionLiquidity`
  - `refreshAllPoolLifetimes`
  - `backfillPoolLifetime`
- `nl -ba convex/pools.ts` en rangos relevantes:
  - `listPools`
  - `computeLifetimeAggregates`
  - `applyPoolFeeEventsWindow`
  - mutations con owner/admin
- `nl -ba convex/schema.ts`
- `nl -ba convex/crons.ts`
- `nl -ba convex/cronHealth.ts`
- `nl -ba src/components/BotPortal.jsx` en `Summary`, `PoolCard` y proyeccion de fees.
- No ejecute build/tests porque esta auditoria es de plan y no hay implementacion de codigo que validar.

## Veredicto final

NO GO.

La direccion general es buena y el enfoque de snapshots raw + valuacion spot es recuperable, pero el plan no puede implementarse tal como esta: debe netear `principalDebt` y debe cambiar la regla de status para no marcar `ok` cuando hubo collects/decreases no capturados. Corregidos esos dos puntos altos, el plan podria volver a auditoria para GO condicionado/GO.
