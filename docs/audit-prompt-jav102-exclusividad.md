# Auditoría de PLAN (RONDA 3) — JAV-102: exclusividad de cuenta HL (cobertura por par + Spot Grid dedicado 1:1)

Eres un auditor senior de código money-path en Hyperliquid. Audita el **DISEÑO** de abajo
(todavía NO hay código) y emite **GO / NO-GO** por hallazgo, con severidad (ALTO / MEDIO / BAJO).
No reescribas el código; señala fallos de corrección, huecos y riesgos. Trabaja sobre la rama
`elcorreodejaviera/jav-102-exclusividad-de-cuenta-hl-cobertura-por-par-spot-grid` (checkout hecho).

> **Esta es la ronda 3.** Las rondas previas dieron NO-GO y sus hallazgos YA están incorporados
> al diseño de abajo: r1 (ALTO — `revokeById` debe consultar `spot_grid_bots`, sección 3) y
> r2 (MEDIO — validar contra la cuenta *resultante* en updates sin `hlAccountId`, sección 1; BAJO —
> comentarios "1 cuenta = 1 bot" obsoletos, sección 5b). Tu tarea: **confirmar que esos cierres
> son correctos y suficientes**, buscar cualquier hueco nuevo, responder las 6 preguntas money-path
> del final, y emitir veredicto GO / NO-GO.

> **Hechos verificados en el código actual (2026-06-21), para que no tengas que dig:**
> - `convex/bots.ts`: `getOrCreatePoolBot` mutation; `baseAsset` calculado en :299, guard actual
>   `if (hlAccountId)` en :317 (check total en :327-328), `resultingHlAccountId = hlAccountId ?? existingBot?.hlAccountId` en :334, patch del bot en :351.
> - `convex/spotGridBots.ts`: `assertCreateGuards` :79-102 (perp en :97-98, otro grid `status !== "stopped"` en :100-102).
> - `convex/hlCredentials.ts`: `revokeById` :32-63 (ejecuciones :42-49, arms :51-54, desvincular perp :58, `ctx.db.delete` :63); HOY no toca `spot_grid_bots`.
> - **`spot_grid_bots.status` (schema.ts:522) es un enum cerrado: `running | paused | stopped | error`.**
>   Único estado terminal = `stopped`; vivos = `running | paused | error`. El filtro `status !== "stopped"`
>   los cubre los tres (responde la pregunta 4).

## Contexto del producto

Portal de bots sobre Hyperliquid. Dos tipos de servicio vinculan una credencial HL
(`hl_api_credentials`, 1:1 con `tradingAccountAddress`):

- **Cobertura** (perp): bots `kind: "il" | "trading"` en la tabla `bots`. Cada bot guarda
  `baseAsset` ya normalizado (`convex/helpers.ts:deriveBaseAsset`, WETH→ETH / WBTC→BTC),
  derivado de `pool.pair` en `convex/bots.ts:299`. El quote es siempre USDC.
- **Spot Grid** (spot): tabla `spot_grid_bots`. Mercado spot (UBTC/UETH vía Unit). Estado
  `running | paused | stopped | ...`.

En HL **spot y perp comparten la misma wallet** (`tradingAccountAddress`).

## Regla a implementar (FIJADA por el usuario 2026-06-21)

| Abrir…    | cuenta que ya tiene…          | ¿Permitir? |
|-----------|-------------------------------|------------|
| Cobertura | cobertura del **mismo par**   | ❌ No      |
| Cobertura | cobertura de **otro par**     | ✅ Sí      |
| Cobertura | un **grid** (cualquier estado vivo) | ❌ No |
| Grid      | otro **grid** vivo            | ❌ No      |
| Grid      | una **cobertura / trading**   | ❌ No      |

- **Cuenta de Spot Grid = exclusiva TOTAL** (1 cuenta = 1 grid; nada más).
- **Cuenta de cobertura = compartible SOLO entre pares distintos** (BTC/USDC + ETH/USDC en
  la misma cuenta), nunca el mismo par dos veces, nunca con un grid.

## Estado actual del código (verificado)

- **Cobertura** — `convex/bots.ts:316-328` (`getOrCreatePoolBot`): exclusividad **TOTAL** hoy:
  consulta `bots.by_user_account (userId, hlAccountId)` y rechaza si **cualquier** otro bot usa
  la cuenta ("Esa cuenta ya está asignada a otro bot"). NO mira el par. NO consulta
  `spot_grid_bots` (asimetría).
- **Grid** — `convex/spotGridBots.ts:96-102` (`assertCreateGuards`): ya rechaza si la cuenta la
  usa cualquier bot perp (`bots.by_user_account`) **o** cualquier grid no-`stopped`
  (`spot_grid_bots.by_account`). Lógica correcta → mantener, solo mejorar textos.
- Índices disponibles: `bots.by_user_account` (`schema.ts:164`), `spot_grid_bots.by_account`
  (`schema.ts:539`). `baseAsset` se persiste en cada bot (`bots.ts:382`).

## DISEÑO PROPUESTO

### 1. Cobertura — `convex/bots.ts`, reemplazar el bloque ~316-328

`baseAsset` (línea 299) ya está calculado y normalizado antes del check.

**⚠️ El guard debe correr contra la CUENTA RESULTANTE, no solo cuando `hlAccountId` viene explícito
(MEDIO, NO-GO Codex r2).** La mutation conserva la cuenta existente en un update parcial
(`resultingHlAccountId = hlAccountId ?? existingBot?.hlAccountId`, línea 334). Si el guard solo mira
`if (hlAccountId)`, un update que omite el arg se salta la validación. Solución: computar
`const accountToValidate = hlAccountId ?? existingBot?.hlAccountId;` y validar contra esa, excluyendo
`existingBot` al comparar. (Mover el cómputo de `resultingHlAccountId` ANTES del guard o reusarlo.)

Cuando `accountToValidate` existe:

1. Resolver `cred = ctx.db.get(accountToValidate)`; si no existe o `cred.userId !== user._id` → error
   "La cuenta Hyperliquid no existe o no te pertenece." (solo cuando el arg `hlAccountId` viene
   explícito; una cuenta ya persistida en `existingBot` no se re-valida de pertenencia).
2. **Mismo par:** `bots.by_user_account(user._id, accountToValidate).collect()`; rechazar si algún
   `b._id !== existingBot?._id` tiene `b.baseAsset === baseAsset` →
   > "Esta cuenta de Hyperliquid ya tiene una cobertura para [BASEASSET]/USDC. Para cubrir este
   > par usá otra cuenta; para esta cuenta podés cubrir un par distinto."
   (Otro `baseAsset` en la misma cuenta → permitido.)
3. **Grid en la cuenta:** `spot_grid_bots.by_account(accountToValidate).collect()`, filtrar
   `status !== "stopped"`; si hay alguno → rechazar:
   > "Esta cuenta está vinculada a un Spot Grid. Para una cobertura, usá una cuenta distinta."

El check aplica a ambos `kind` (`il` y `trading`): mismo `baseAsset` en la cuenta colisiona sea
cual sea el kind.

### 2. Grid — `convex/spotGridBots.ts:96-102`

Mantener la lógica. Cambiar solo los textos:
- Perp en la cuenta → "Esta cuenta ya la usa un bot de cobertura/trading. El Spot Grid necesita
  una cuenta dedicada."
- Otro grid vivo en la cuenta → "Esta cuenta ya está vinculada a un Spot Grid. Para abrir otro
  grid, vinculá otra cuenta."

### 3. Revocación de credencial — `convex/hlCredentials.ts:revokeById` (ALTO, NO-GO r1 de Codex)

`revokeById` (líneas ~32-65) hoy bloquea revocar si hay `execution_requests` abiertas o un
`trigger_arm` no terminal, y desvincula los bots perp (`bots.by_user_account`), pero **NO consulta
`spot_grid_bots`** → se puede borrar la credencial con un Spot Grid vivo y perder la clave privada
para cancelar/reconciliar sus órdenes (fondos atascados en HL). Cerrar la asimetría:

- Antes de `ctx.db.delete(id)`: `spot_grid_bots.by_account(id).collect()`, filtrar `status !== "stopped"`;
  si hay alguno → rechazar:
  > "La cuenta tiene un Spot Grid activo; deténlo antes de revocar."
- Mantener el orden actual de guards (ejecuciones → arms → grid → desvincular bots → delete).

### 4. Revalidación en persistencia (no solo preflight) — MEDIO

El check de unicidad por par debe vivir en la mutation que realmente persiste/upsert el bot
(`getOrCreatePoolBot`), no solo en un preflight, para que dos creaciones concurrentes no lo burlen
(OCC de Convex revalida en la mutation). Confirmar que el bloque nuevo corre dentro de la misma
mutation que inserta/patcha el bot.

### 5. Nota de producto (riesgo operativo, documentar)

Cobertura por par sobre la misma wallet HL: distinto `baseAsset` = distinta `coin` = distinto order
book (sin fills ambiguos ni cancelaciones cruzadas), PERO comparten **collateral/margen cross a nivel
cuenta** → una pérdida fuerte en un par puede reducir la capacidad de margen del otro. Aceptable por
decisión de producto, pero debe quedar explícito (comentario en código + mención al usuario).

### 5b. Comentarios/invariantes viejas (BAJO, NO-GO Codex r2)

Actualizar los comentarios "1 cuenta = 1 bot" que quedan obsoletos con JAV-102:
`convex/schema.ts:163` (índice `by_user_account`) y `convex/hyperliquid.ts:383`. Texto nuevo:
grid = cuenta dedicada total; perp = una cuenta puede compartir **pares distintos**, pero solo un
bot por `baseAsset`.

### 6. Tests

- Cobertura: misma cuenta + `baseAsset` distinto → OK; mismo `baseAsset` → rechazo.
- Cobertura: cuenta con grid vivo → rechazo; cuenta con grid `stopped` → permitido.
- Grid: cuenta con cobertura/trading o con otro grid vivo → rechazo (textos nuevos).
- `existingBot` (upsert del mismo bot/pool) NO se rechaza a sí mismo.
- Revocar: credencial con grid vivo → rechazo; con grid `stopped` (o sin grid) → permitido.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **CLAVE (riesgo del usuario):** ¿Aislar la cobertura **por par** sobre una wallet HL
   compartida (spot+perp) introduce algún conflicto de **balance/margen/cross-margin**, fills
   ambiguos o cancelaciones cruzadas cuando varios pares perp distintos viven en la misma
   cuenta? (Distinto `baseAsset` = distinta `coin` HL = distinto order book — ¿basta para que no
   se interfieran?) ¿La cobertura comparte margen cross entre pares de forma que un par pueda
   liquidar al otro? Si es así, ¿debe avisarse o sigue siendo aceptable por decisión de producto?
2. ¿Es `baseAsset` la **clave de par** correcta y suficiente, o hay que considerar el quote
   (siempre USDC hoy) o el `network` (mainnet/testnet) en la unicidad? ¿Dos pools con el mismo
   `baseAsset` pero distinta red deberían colisionar o no?
3. ¿Hay **carreras** (dos creaciones concurrentes sobre la misma cuenta) que burlen el check al
   no ser atómico? ¿El patrón actual (collect + comprobación en la mutation) es suficiente en
   Convex, o hace falta algo más?
4. ¿El filtro `status !== "stopped"` cubre TODOS los estados vivos de `spot_grid_bots`? Enumerar
   los estados reales del schema y confirmar que ninguno vivo se escapa (p.ej. `paused`,
   `submitting`, transitorios).
5. ¿Coherencia bidireccional? Tras el cambio: crear cobertura mira grids, y crear grid mira
   cobertura → confirmar que las dos direcciones quedan simétricas y sin huecos (p.ej. trading
   perp creado por otra ruta que no pase por `getOrCreatePoolBot`).
6. ¿Algún call-site de `getOrCreatePoolBot` que pase `hlAccountId` y se rompa con el nuevo
   rechazo por par (regresión en flujos existentes de un solo par)?

Devuelve: lista de hallazgos (severidad + descripción + fix sugerido) y veredicto **GO / NO-GO**.
