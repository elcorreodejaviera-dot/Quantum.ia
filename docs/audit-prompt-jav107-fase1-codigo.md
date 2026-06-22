# Auditoría de CÓDIGO — JAV-107 Fase 1: schema + cloid del bot de defensa SPOT

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de la Fase 1 (ya
implementado). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas el
código; señala fallos de corrección, riesgos de schema y huecos. Trabaja sobre la rama
`feat/jav107-spot-defense` (checkout hecho). El plan con GO de Codex está en
`docs/plan-jav107-spot-defense.md` (Fase 1 al principio).

## Alcance de la Fase 1 (NO money-path activo todavía)

Solo schema + helper de cloid + test. No hay motor, ni mutations, ni colocación de órdenes (eso es
Fase 2/3). El objetivo de esta auditoría: que el schema sea **legacy-safe**, coherente con las tablas
que espeja, y que el cloid sea determinista y de namespace disjunto.

## Diff a auditar (commit `7673b40`)

- `convex/schema.ts`: tres tablas nuevas al final —
  - **`spot_defense_bots`** (modelada en `bots` + `spot_grid_bots`): `userId`, `spotPositionId`,
    `hlAccountId`, `asset`, `baseAsset`, `side:"Short"`, `leverage`, `autoLeverage?`, `bufferPct?`,
    `stopLossPct`, `breakevenPct?`, `tps?`, `autoRearm?`, `triggerMode:"manual"|"dca"`, `triggerPrice`,
    `requestedNotionalUsd`, `effectiveNotionalUsd?`, `minCoveragePct?`, `active`,
    `status:running|paused|stopped|error`, `network:mainnet|testnet`, `generation`, `disarmPending?`,
    `disarmRequestedAt?`, campos de rearm (espejo de `bots`), `createdAt`, `updatedAt`. Índices:
    `by_user`, `by_user_position`, `by_user_account`, `by_account`, `by_rearm_status`.
  - **`spot_defense_arms`** (espejo recortado de `trigger_arms`, SIN pool, UNA entrada): enum de
    `status` con `manual_intervention` añadido, `desiredState:"armed"|"disarmed"`, `side:"Short"`,
    `triggerPx`, `size`, `appliedLeverage`, `reservedNotional`, `marginReserved`,
    `requestedNotionalUsd?`/`effectiveNotionalUsd?`, `stopLossPct`, `breakevenPct?`/`beMoved?`, `tps?`,
    SL fields, fill fields, `closeReason?`/`emergencyClosing?`, lease/fencing, timestamps. Índices:
    `by_bot_generation`, `by_bot_status`, `by_status_updated`, `by_updated`, `by_account`,
    `by_filledAt`, `by_user_status`.
  - **`spot_defense_orders`** (espejo de `trigger_orders`): `armId`, `role:"entry"|"sl"|"tp"`,
    `tpIndex?`, `cloid`, `oid?`, `triggerPx`, `size`, `reduceOnly`, `attempt?`, `observedStatus`,
    `submittedAt?`, timestamps. Índices: `by_arm_role`, `by_arm_role_index`, `by_cloid`.
- `convex/cloids.ts`: `SpotDefenseCloidKind = "entry"|"sl"|"tp"` + `spotDefenseCloidInput(botId,
  generation, kind, attempt=0, tpIndex?)` → `spot-defense:<botId>:<gen>:<kind>[:tpIndex]:<attempt>`.
- `tests/spotDefenseCloids.test.ts`: determinismo, distinción por gen/rol/attempt/tpIndex, namespace,
  cloid HL válido (0x+32hex).

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER

1. **Legacy-safe:** ¿añadir estas tablas y sus índices puede borrar/alterar índices o romper el deploy
   de Convex sobre el deployment vivo (`strong-sandpiper-848`)? ¿Algún campo NO-opcional que debería
   serlo para no romper inserts futuros o migraciones?
2. **Coherencia con las tablas espejadas:** ¿falta algún campo/índice que el motor (Fase 3) o el cap
   (Fase 2) vayan a necesitar y cuya ausencia obligue a una migración de schema más adelante? En
   concreto: ¿el cap por `spot-defense:<botId>` podrá leer `effectiveNotionalUsd` de
   `spot_defense_arms` con un índice adecuado (hoy `by_user_status` / `by_account`)? ¿El detector de
   drift necesitará un campo de "tamaño esperado" persistido o se deriva de `size` − Σ TP?
3. **Cloid:** ¿el namespace `spot-defense:` es realmente disjunto de `spotGridCloidInput`
   (`seed:`/`liquidation:`/grid) y del cloid del motor de pool (`armCloid`)? ¿`generation` + `attempt`
   + `tpIndex` bastan para que un re-arm o una recolocación de SL/TP nunca colisione por `by_cloid`?
   ¿`toHlCloid` (SHA-256 → 16 bytes) tiene riesgo de colisión práctico entre inputs distintos?
4. **Unicidad:** `by_user_position` (`userId, spotPositionId`) ¿es la clave correcta para "1 bot por
   posición spot"? ¿Debería ser por `(userId, baseAsset)` en su lugar, dado que la exclusividad de
   cuenta de Fase 2 es por `baseAsset`? ¿Hay riesgo de dos bots sobre el mismo `baseAsset` vía dos
   `spot_positions` distintas (p.ej. dos filas BTC)?
5. **Enum `manual_intervention`:** ¿está bien situado en el enum de `status` de `spot_defense_arms`
   y no rompe ningún exhaustividad-check (no hay consumidores aún, pero confirmar)?

Devuelve: lista de hallazgos (severidad + descripción + fix sugerido) y veredicto **GO / NO-GO**.
Verde actual: `npm run typecheck` EXIT 0, `npm test` 201/201.
