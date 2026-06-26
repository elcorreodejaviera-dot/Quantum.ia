# Auditoria Codex - JAV-117 CodeRabbit quick wins

## Alcance

Reauditoria del diff `102da93..1ac0ded` en PR #127, antes de merge.

Archivos revisados:

- `convex/actions/poolScanner.ts`
- `convex/adminLive.ts`
- `convex/pools.ts`
- `src/components/AdminView.jsx`
- docs de auditorias Codex ya versionadas en el diff

Fuente primaria consultada para el punto transaccional:

- Convex docs, Mutations / Transactions: https://docs.convex.dev/functions/mutation-functions#transactions

## Veredicto

**GO para merge.**

No encontre hallazgos bloqueantes ni regresiones money-path. Los 6 quick wins estan aplicados de forma coherente.

## Validacion por punto

### 1. Seguridad: URL de Alchemy en errores/logs

OK. `rpcGetLogs` ya no incluye `url` en errores HTTP ni timeout:

- `convex/actions/poolScanner.ts:158-164`

Busque rutas de log/error relacionadas con `alchemyUrl`/`rpcGetLogs`. Los errores que todavia interpolan `${url}` estan en `rpcCall`, que usa los RPC publicos de `eth_call`, no la URL de Alchemy. La URL con `ALCHEMY_API_KEY` solo fluye a `rpcGetLogs`, cuyos throws estan sanitizados.

Nota menor no bloqueante: `eth_getLogs error (...)` conserva `json.error.message` del proveedor. No deberia incluir la API key porque no se esta logueando la URL de request; aceptable.

### 2. Integridad: lifetime exige los 4 agregados

OK. `fetchPositionLiquidity` ahora requiere `feesCollectedRaw0`, `feesCollectedRaw1`, `principalDebt0` y `principalDebt1`; con parciales devuelve `feesLifetimeUsd = null` y evita default silencioso a cero.

- `convex/actions/poolScanner.ts:613-630`

### 3. Admin fallback preserva `feesLifetimeStatus`

OK. En el catch por posicion, `adminLive` conserva `t.feesLifetimeStatus ?? null`, asi AdminView no cae a un estado viejo del detalle.

- `convex/adminLive.ts:105-112`

### 4. Raw corrupto aborta recompute

OK. Prefiero abortar antes que persistir un total subcontado.

`computeLifetimeAggregates` lanza si `amount0Raw` o `amount1Raw` no parsean. Ese throw ocurre dentro de `applyPoolFeeEventsWindow`, que borra ventana, inserta eventos, recomputa y patchea el pool dentro de una `internalMutation`.

- `convex/pools.ts:253-259`
- `convex/pools.ts:315-342`

Convex documenta que las mutations son transaccionales: las escrituras se commitean juntas y, si la mutation lanza despues de escribir, nada queda escrito. Por eso el comportamiento deseado es: cache previo intacto, sin tabla a medias, sin agregado incorrecto. El costo es que no se persiste `status:"error"` para ese pool en esa misma corrida; no lo considero bloqueante porque el objetivo principal es no mostrar un numero falso.

### 5. `patchPoolLifetimeMeta` no toca `feesLifetimeCalcAt`

OK. Este camino no recomputa agregados, asi que no debe actualizar el timestamp de calculo. `feesLifetimeCalcAt` queda exclusivo de `applyPoolFeeEventsWindow`.

- `convex/pools.ts:347-365`

### 6. Admin UI `no_key/error` siempre muestra `--`

OK. `AdminView` bloquea `no_key`/`error` antes de `liveLoading`, alineado con portal: no se muestra `...` cuando el estado ya es definitivamente no usable.

- `src/components/AdminView.jsx:170-179`

## Comandos

- `git diff --stat 102da93..1ac0ded`
- `git diff --unified=80 102da93..1ac0ded -- convex/actions/poolScanner.ts convex/pools.ts convex/adminLive.ts src/components/AdminView.jsx`
- `rg -n 'RPC \\\\${url}|timeout .*\\\\${url}|getLogs .*\\\\${url}|alchemyUrl\\\\(|rpcGetLogs\\\\(' convex/actions/poolScanner.ts`
- `npm run typecheck` -> OK
- `npm test` -> OK, 17 archivos / 265 tests
- `npx vite build` -> OK, warnings no bloqueantes ya conocidos de Rollup/chunk

## Cierre

GO para merge. El punto #4 queda aprobado: abortar la mutation ante raw corrupto es el comportamiento correcto para preservar integridad y evitar un lifetime incorrecto.
