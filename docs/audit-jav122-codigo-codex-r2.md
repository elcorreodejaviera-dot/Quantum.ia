# Auditoria de codigo Codex r2 - JAV-122 cierre ALTO-1

Fecha: 2026-06-27  
Rama auditada: `spot-grid/jav122-transient-recovery`  
Commit de codigo auditado: `895c6d8`  
Prompt auditado: `docs/audit-prompt-jav122-codigo.md`

## Alcance

Re-auditoria focalizada del cierre de **ALTO-1** del informe anterior: los transitorios capturados localmente durante envio de orden no contaban para backoff/escalada del bot.

El commit `895c6d8` modifica solo:

- `convex/spotGridEngine.ts`

Tambien verifique los puntos de integracion con:

- `convex/spotGridBots.ts` para lease, bumps y fill cursor.
- `docs/audit-prompt-jav122-codigo.md` para el alcance solicitado.

No re-ejecute tests; el prompt reporta `typecheck OK` y suite 286/286 verde. El diff de codigo revisado es `027bb5a..895c6d8`; los commits posteriores sobre `895c6d8` son docs.

## Veredicto final

**GO.**

ALTO-1 queda cerrado. No encontre bloqueantes, altos, medios ni bajos nuevos.

La solucion preserva el motivo por el que no convenia re-lanzar desde los catches locales: `setSpotGridFillCursor` corre al final de `reconcileOneBot`, antes de devolver la bandera al loop, evitando doble-conteo de fills mientras aun convierte la ronda en fallo transitorio de bot.

## Hallazgos bloqueantes

Ninguno.

## Hallazgos altos

Ninguno.

## Hallazgos medios

Ninguno.

## Hallazgos bajos

Ninguno.

## Checks solicitados

### 1. Cobertura de todos los catches locales de envio

**GO.**

`placeOrder` ahora recibe `flags?: { transientPlace: boolean }`, clasifica el error local y setea `flags.transientPlace = true` solo para transitorios:

- `convex/spotGridEngine.ts:388-393`
- `convex/spotGridEngine.ts:405-419`

Todos los callers internos de `placeOrder` pasan la bandera:

- Bootstrap seeded SELLs: `convex/spotGridEngine.ts:510-516`
- Bootstrap seeded BUYs: `convex/spotGridEngine.ts:531-536`
- Colocacion inicial legacy: `convex/spotGridEngine.ts:594-600`
- SELL pareada tras fill de BUY: `convex/spotGridEngine.ts:677-684`

Los catches inline tambien setean la bandera:

- Retry de `submitting`: `convex/spotGridEngine.ts:617-626`
- Repost despues de SELL full: `convex/spotGridEngine.ts:696-704`

No quedan otros callers de `placeOrder` sin `flags`:

- `convex/spotGridEngine.ts:512`
- `convex/spotGridEngine.ts:533`
- `convex/spotGridEngine.ts:596`
- `convex/spotGridEngine.ts:680`

### 2. IOC de semilla sigue re-lanzando al catch central

**GO.**

`gatedPlaceIoc` captura el error de `placeSpotLimit`, relee fills por CLOID y solo si no hubo fill vuelve a lanzar:

- `convex/spotGridEngine.ts:364-381`

El IOC de semilla llama `gatedPlaceIoc` sin catch local en `runSeededBootstrap`, por lo que el error no consumido sube al catch central del cron:

- `convex/spotGridEngine.ts:479-486`
- `convex/spotGridEngine.ts:776-786`

Esto preserva la idempotencia: si el timeout fue despues de ejecucion real, `gatedPlaceIoc` devuelve el fill; si no hubo fill, el transitorio llega al path central.

### 3. Desenlace por bandera respeta `wasError`

**GO.**

`reconcileOneBot` acumula `flags.transientPlace` y lo devuelve al loop:

- `convex/spotGridEngine.ts:544-549`
- `convex/spotGridEngine.ts:710-712`

El loop consume la bandera antes de `recoverSpotGridFromError` o `markSpotGridReconcileSuccess`:

- `convex/spotGridEngine.ts:757-774`

Si `wasError` es true, el transient de envio local incrementa recuperacion:

- `convex/spotGridEngine.ts:762-764`
- `convex/spotGridBots.ts:720-731`

Si `wasError` es false, incrementa prevencion/backoff/escalada:

- `convex/spotGridEngine.ts:764-767`
- `convex/spotGridBots.ts:693-713`

Por lo tanto, una ronda de recuperacion con transitorio local ya no cae accidentalmente en `recoverSpotGridFromError`.

### 4. No doble-conteo de fills

**GO.**

El loop de fills agrega por CLOID, aplica fills y solo despues avanza el cursor:

- Agregado por CLOID: `convex/spotGridEngine.ts:630-642`
- Aplicacion de fills: `convex/spotGridEngine.ts:643-662`
- Avance de cursor: `convex/spotGridEngine.ts:709-710`

La bandera se procesa despues del retorno de `reconcileOneBot`, es decir, despues del avance de cursor:

- `convex/spotGridEngine.ts:710-712`
- `convex/spotGridEngine.ts:757-767`

Esto evita el doble-conteo que produciria re-lanzar a mitad del loop de fills.

### 5. No doble-orden / idempotencia

**GO.**

El envio normal sigue usando el contrato DB-intent: registrar `submitting`, enviar con `gatedPlace`, marcar `open` si HL confirma:

- `convex/spotGridEngine.ts:388-410`

`gatedPlace` no reenvia si el CLOID ya esta vivo en HL:

- `convex/spotGridEngine.ts:330-343`

`recordSpotGridOrder` mantiene lookup-before-insert por `by_cloid`:

- `convex/spotGridBots.ts:582-614`

En IOC, la idempotencia por fills antes/despues del envio sigue intacta:

- `convex/spotGridEngine.ts:371-381`

### 6. No HTML nuevo

**GO.**

Los catches locales que persisten `spot_grid_orders.errorMessage` usan `classifySpotGridError(e).message`:

- `convex/spotGridEngine.ts:621-626`
- `convex/spotGridEngine.ts:700-704`

`placeOrder` ya no loguea `safeError(e)` para esos fallos; loguea el mensaje clasificado:

- `convex/spotGridEngine.ts:416-418`

El transitorio local que se transforma en bump activo usa `SPOT_GRID_TRANSIENT_MSG`, no el payload crudo:

- `convex/spotGridEngine.ts:764-766`

### 7. Fencing / orden de mutations

**GO.**

El loop invoca los bumps bajo el token del claim y antes del release del `finally`:

- Claim/token: `convex/spotGridEngine.ts:731-737`
- Bump por bandera: `convex/spotGridEngine.ts:762-767`
- Release: `convex/spotGridEngine.ts:792-793`

Las mutations destino revalidan lease:

- `bumpSpotGridTransient`: `convex/spotGridBots.ts:693-697`
- `bumpSpotGridErrorRecovery`: `convex/spotGridBots.ts:720-725`

## Riesgo residual no bloqueante

El cableado del action (`reconcileOneBot` devuelve `transientPlace` y el loop decide el desenlace) queda validado por revision y typecheck, no por test unitario directo. Las mutations que producen el efecto monetario y de estado (`bumpSpotGridTransient`, `bumpSpotGridErrorRecovery`) si tienen cobertura. No lo considero condicion de GO porque el diff es pequeno, lineal y queda verificado por las line refs anteriores.

## Comandos revisados

- `git status --short`
- `git log --oneline --decorate -8`
- `git show --stat --oneline 895c6d8`
- `git show --name-only --oneline 895c6d8`
- `git diff --stat 027bb5a..895c6d8`
- `git diff --check 027bb5a..895c6d8`
- `rg -n "transientPlace|placeOrder\\(|gatedPlace|gatedPlaceIoc|bumpSpotGridTransient|bumpSpotGridErrorRecovery|setSpotGridFillCursor" convex/spotGridEngine.ts`
- lecturas con line refs via `perl -ne` de los spans citados arriba.
