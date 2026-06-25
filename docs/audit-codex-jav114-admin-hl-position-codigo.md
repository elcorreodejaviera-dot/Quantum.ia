# Auditoria Codex - JAV-114 posicion real HL en panel admin

Fecha: 2026-06-25

## Alcance auditado

- Rama: `feat/jav114-admin-hl-position`
- Commit auditado: `f5ab213 feat(jav114): ver la posición real de HL por usuario en el panel admin`
- Base local: `master` / `origin/master` en `3e7de06`
- Archivos de codigo:
  - `convex/adminLive.ts`
  - `src/components/AdminView.jsx`
- Prompt de auditoria:
  - `docs/audit-prompt-jav114-admin-hl-position-codigo.md`

Cambio auditado: display admin/read-only para mostrar la posicion real de Hyperliquid por cuenta+coin (`szi`, entry, liquidacion, leverage, notional) y compararla contra la exposicion LP.

## Bloqueante

No se encontraron hallazgos bloqueantes.

## Alto

No se encontraron hallazgos altos.

## Medio

### M1 - La UI puede mostrar "Sin posicion HL abierta" cuando la lectura HL fallo parcialmente

Evidencia:

- `convex/adminLive.ts:101-106`: si `fetchClearinghouse` falla para una cuenta, se marca `hlPartial = true` y se agrega `hlAccounts.push({ ..., collateralUsd: null })`, pero se hace `continue`.
- Por ese `continue`, no se crean entradas vacias explicitas en `pnlByAccountCoin`, `coverageByAccountCoin` ni `positionByAccountCoin` para esa cuenta.
- `src/components/AdminView.jsx:265-267`: si no existe `live.positionByAccountCoin[pos.hlAccountId]`, `hlPosition` queda `null`.
- `src/components/AdminView.jsx:182-183`: con `live && !liveLoading`, `hlPosition === null` renderiza `Sin posición HL abierta para ...`.

Impacto:

- Es read-only y no toca money-path, pero puede inducir al admin a creer que no hay posicion HL cuando en realidad la lectura de HL fallo para esa cuenta.
- El snapshot ya trae `partial.hl`, pero la tarjeta no lo usa para distinguir "sin posicion" de "dato HL no disponible".

Recomendacion:

- Antes de merge/deploy, distinguir estos casos:
  - si la cuenta se leyo correctamente y `positionByAccountCoin[acctId]` existe pero no trae `coin` -> `Sin posicion HL abierta`;
  - si la cuenta no se pudo leer o `live.partial?.hl === true` y no hay entrada para `acctId` -> mostrar `Posicion HL: —` / `HL no disponible`, no "sin posicion".

## Bajo

### B1 - El umbral visual del ratio duplica el `HEDGE_BAND` en vez de importar la constante

Evidencia:

- `src/lib/poolAudit.js:14` define `HEDGE_BAND = 0.25`.
- `src/components/AdminView.jsx:146` usa literal `0.25` para colorear el ratio.

Impacto:

- No rompe el comportamiento actual: el valor coincide con el audit `hedge_vs_exposure`.
- Riesgo menor de drift futuro si cambia `HEDGE_BAND` y no se actualiza el literal de la UI.

Recomendacion:

- Importar `HEDGE_BAND` desde `src/lib/poolAudit.js` o dejar un comentario fuerte si se decide mantener literal.

### B2 - La posicion HL agregada por cuenta+coin se repite si existieran bots ambiguos del mismo coin

Evidencia:

- `convex/adminLive.ts:127-140` guarda una posicion neta por `acctId + coin`, coherente con HL.
- `src/components/AdminView.jsx:265-268` muestra esa misma posicion por cada bot que apunte al mismo `acctId + coin`.
- `src/lib/poolAudit.js:62-66` ya reconoce ese caso como ambiguo para `hedge_vs_exposure`.

Impacto:

- Bajo: el modelo actual de cuenta/coin y las reglas de exclusividad reducen el caso esperado, y el panel de auditoria lo marca como `unknown` si aparece.
- Si existiera data legacy ambigua, la fila puede parecer atribuida a cada bot individual cuando en realidad es posicion neta compartida.

Recomendacion:

- Aceptable para este cambio. Como mejora futura, reutilizar la misma deteccion de ambiguedad visualmente en la tarjeta.

## Verificaciones especificas del prompt

### 1. Read-only / sin efectos

Resultado: OK.

Evidencia:

- `convex/adminLive.ts:40-44` mantiene el gate admin con `internal.users.getCurrentAdminInternal`.
- El backend usa `fetchClearinghouse` contra Info API (`convex/adminLive.ts:17-34`), que ya existia para leer estado HL.
- No se agregan mutations, escrituras DB, exchange client, firma ni cambios en motores.
- El diff de codigo se limita a `convex/adminLive.ts` y `src/components/AdminView.jsx`.

### 2. Guards numericos

Resultado: OK, salvo M1 por semantica de dato faltante.

Evidencia:

- `convex/adminLive.ts:123-126` calcula cobertura con `Math.abs(Number(positionValue))` y solo la agrega si es finita y positiva.
- `convex/adminLive.ts:128-140` solo crea `hlPosition` con `szi` finito y distinto de cero; `entryPx`, `liqPx`, `leverage` y `upnl` caen a `null` si no son finitos.
- `src/components/AdminView.jsx:143-146` calcula `covRatio` solo con `hedgeNotional != null`, `lpExposure != null` y `lpExposure > 0`.
- `src/components/AdminView.jsx:175-177` renderiza entry/liq/leverage solo si no son `null`.

No vi ruta de `NaN`/`Infinity` al render.

### 3. Correctitud de la comparacion

Resultado: OK.

Evidencia:

- `coverageByAccountCoin` usa `abs(positionValue)` en `convex/adminLive.ts:123-126`.
- `positionByAccountCoin.notional` reutiliza el mismo `posValue` en `convex/adminLive.ts:133-136`.
- `src/components/AdminView.jsx:143-146` usa `hlPosition?.notional ?? coverageLive` contra `live?.liquidityUsd`.
- `src/lib/poolAudit.js:69-71` usa la misma base `coverageUsd / liquidityUsd` y banda `0.25`.

La comparacion visual es consistente con `hedge_vs_exposure`.

### 4. Coherencia de mapeo

Resultado: OK.

Evidencia:

- `src/components/AdminView.jsx:5` importa `hlCoin` desde `src/lib/poolAudit.js`.
- `src/components/AdminView.jsx:255-267` usa la misma `coin` para PnL, cobertura y posicion HL.
- `src/lib/poolAudit.js:6-8` normaliza `WETH -> ETH` y `WBTC -> BTC`.
- `convex/adminLive.ts:117-145` indexa PnL, cobertura y posicion con el `coin` de Hyperliquid.

### 5. Reutilizacion/UI y compatibilidad con snapshots viejos

Resultado: OK con M1.

Evidencia:

- `src/components/AdminView.jsx:174-179` reutiliza `fmtPrice`, `usd`, `av-pos-foot`, `av-tag`, `av-pos-pnl`, `av-amber`.
- No se agrega CSS nuevo.
- La nueva prop `hlPosition` es opcional (`PositionCard` sigue renderizando sin ella), por lo que un snapshot viejo sin `positionByAccountCoin` no rompe.

Limitacion: snapshot parcial de HL y snapshot viejo se ven igual que "sin posicion" en la tarjeta. Ver M1.

## Pruebas y comandos revisados

- `git diff --stat master..HEAD`
- `git diff master..HEAD -- convex/adminLive.ts src/components/AdminView.jsx src/lib/poolAudit.js`
- `rg -n "positionByAccountCoin|coverageByAccountCoin|pnlByAccountCoin|hlPosition|PositionCard|hedge_vs_exposure|covRatio|hlCoin|liqPx|leverage|entryPx|szi" convex/adminLive.ts src/components/AdminView.jsx src/lib/poolAudit.js -S`
- `git diff --check master..HEAD` - OK
- `npx tsc -p convex/tsconfig.json --noEmit` - OK
- `npx vite build --outDir /tmp/quantum-jav114-audit-build --emptyOutDir` - OK
  - Warnings no bloqueantes: anotaciones PURE de dependencias `ox` y chunk JS > 500 kB.
- `npx vitest run tests/poolAudit.test.ts` - OK: 19 tests
- `npx vitest run` - OK: 17 archivos, 265 tests

No se ejecuto `npm run build` porque incluye deploy de Convex.

## Veredicto final

GO condicionado.

El cambio es read-only/admin y la ruta principal de datos es coherente con el audit `hedge_vs_exposure`. No encontre bloqueantes ni altos. Antes de merge/deploy recomiendo corregir M1 para que una lectura HL parcial no se muestre como "Sin posicion HL abierta"; debe mostrarse como dato no disponible.
