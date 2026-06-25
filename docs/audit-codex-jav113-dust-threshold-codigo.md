# Auditoria Codex - JAV-113 dust threshold reconcile

Fecha: 2026-06-25

## Alcance auditado

- Rama: `fix/jav113-dust-threshold-reconcile`
- Commit auditado: `4cd37aa fix(jav113): umbral de dust en reconcile — arm no se cuelga con residuo de HL`
- Base local: `master` / `origin/master` en `eb2be11`
- Archivos de codigo:
  - `convex/hyperliquid.ts`
  - `convex/triggerEngine.ts`
  - `convex/spotDefenseEngine.ts`
  - `tests/dustThreshold.test.ts`
- Prompt de auditoria:
  - `docs/audit-prompt-jav113-dust-threshold-codigo.md`

El alcance principal es el money-path de reconcile en los motores IL (`triggerEngine`) y Defensa Spot (`spotDefenseEngine`), donde un remanente de posicion con nocional menor al minimo de orden de Hyperliquid debe tratarse como plano/intradeable.

Referencia externa revisada: documentacion oficial de Hyperliquid, `MinTradeNtl`, error string "Order must have minimum value of $10.":
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses

## Bloqueante

No se encontraron hallazgos bloqueantes.

## Alto

No se encontraron hallazgos altos.

## Medio

### M1 - El cierre manual legacy del portal sigue usando flat estricto

Evidencia:

- `convex/hyperliquid.ts:320` en `closePositionEmergency` todavia intenta cerrar cualquier `Math.abs(szi) > 0`, incluso si es dust menor a 10 USD.
- `convex/hyperliquid.ts:341`, `350` y `370` siguen clasificando flat/residual con `sziAfter === 0`, no con `isFlatOrDust`.
- `convex/hyperliquid.ts:405` en `closeBotPosition` solo cierra ejecuciones/desarma si `closeRes?.sziAfter === 0 && closeRes?.ordersRemaining === 0`.
- `src/components/BotPortal.jsx:345-347` tambien exige `res?.sziAfter === 0 || res?.ordersRemaining !== 0` para considerar exitoso el cierre desde el portal.

Impacto:

- No bloquea el fix auditado de los motores: en `triggerEngine` y `spotDefenseEngine`, el dust entra por la rama `flat` antes del cierre de emergencia y ya no intenta enviar una orden menor al minimo.
- Si el usuario usa la ruta manual `closeBotPosition` para desbloquear un borrado ligado a `execution_requests` legacy/JAV-37, un residuo menor a 10 USD puede seguir devolviendo `residual` y dejar el bot sin borrar desde esa ruta.

Recomendacion:

- Follow-up recomendado: reutilizar `isFlatOrDust(sziAfter, markPx)` en `closePositionEmergency`/`closeBotPosition` y adaptar el payload de respuesta para que el frontend no dependa de `sziAfter === 0` cuando el residuo es intradeable. Mantener el fail-closed de ordenes vivas.

## Bajo

### B1 - El umbral fijo de 10 USD depende de una regla externa

Evidencia:

- `convex/hyperliquid.ts:59` define `DUST_NOTIONAL_USD = 10`.
- La documentacion oficial actual de Hyperliquid lista `MinTradeNtl` con minimo de 10 USD.

Impacto:

- Correcto hoy. Si Hyperliquid cambia el minimo de orden, el umbral local puede quedar desactualizado.

Recomendacion:

- Aceptable para este fix. Como hardening futuro, centralizar el valor con comentario/source o hacerlo configurable si HL expone un limite dinamico fiable.

## Verificaciones especificas del prompt

### 1. Correcto y seguro

Resultado: OK.

Evidencia:

- `convex/hyperliquid.ts:59-63` implementa `isFlatOrDust` como `szi === 0` o nocional `abs(szi) * markPx < 10`.
- `tests/dustThreshold.test.ts:8-34` cubre:
  - `szi` exactamente cero;
  - dust real de Benjamin (`0.0001 ETH @ 1630`);
  - posicion real de cobertura (`2.7739 ETH @ 1630`);
  - borde `$9.99` vs `$10`;
  - `markPx` invalido;
  - signo positivo/negativo.

El valor 10 USD esta alineado con el minimo de orden documentado por Hyperliquid. Una cobertura real de cientos/miles de USD queda fuera del umbral por varios ordenes de magnitud.

### 2. Cierre de emergencia en los motores

Resultado: OK para los motores auditados.

Evidencia:

- IL: `convex/triggerEngine.ts:586` calcula `flat = isFlatOrDust(szi, assetMeta.markPx)` antes de la rama de emergencia de `convex/triggerEngine.ts:680-702`.
- Defensa Spot: `convex/spotDefenseEngine.ts:306` calcula `flat = isFlatOrDust(szi, markPx)` antes del cierre por `wantDisarm` de `convex/spotDefenseEngine.ts:411-432`.
- Defensa Spot post-close: `convex/spotDefenseEngine.ts:427` tambien usa `isFlatOrDust` para confirmar `flatNow`.

Con este orden, un dust menor a 10 USD no llega al envio de market close reduceOnly. Si llega a la rama `!flat`, el nocional es al menos 10 USD segun el mismo predicado.

Limitacion: ver M1 para la ruta manual legacy `closeBotPosition`, que no forma parte del reconcile de estos dos motores.

### 3. `markPx` fiable en cada sitio

Resultado: OK.

Evidencia:

- `convex/hyperliquid.ts:136-142` obtiene `markPx` desde `metaAndAssetCtxs` y lanza error si no es finito o es `<= 0`.
- IL arm: `convex/triggerEngine.ts:169-183`.
- IL reconcile: `convex/triggerEngine.ts:537-538`, `586`, `1041`.
- Defensa Spot arm: `convex/spotDefenseEngine.ts:87-98`.
- Defensa Spot reconcile: `convex/spotDefenseEngine.ts:262-263`, `306`, `427`.

El fallback de `isFlatOrDust` ante `markPx` invalido es conservador, y en los motores normalmente no se alcanza porque `getAssetMeta` aborta antes.

### 4. State machine sin regresiones

Resultado: OK.

Evidencia:

- IL conserva doble lectura/grace y cancelacion por CLOID antes de cerrar: `convex/triggerEngine.ts:613-671`.
- `closeReason` sigue priorizando `emergencyClosing`, luego SL confirmado, luego `manual`: `convex/triggerEngine.ts:655-666`.
- La reduccion de reserva 2x -> 1x ahora se salta si el remanente es dust: `convex/triggerEngine.ts:607-610`, correcto porque ya no debe liberar media reserva por una posicion no operable.
- `armed_lower_only` usa el mismo predicado para no quedar retenido por dust: `convex/triggerEngine.ts:1038-1059`.
- Defensa Spot conserva drift, grace, cancelacion de ordenes propias y cierre con closeReason: `convex/spotDefenseEngine.ts:328-400`.

No vi cambios de transicion distintos al predicado de flat/dust.

### 5. Efecto esperado en prod Benjamin

Resultado: OK.

Con `0.0001 ETH @ 1630`, `abs(szi) * markPx = 0.163`, menor a 10. En el siguiente reconcile, el arm debe entrar en la rama `flat`, pasar por la confirmacion/grace y cerrar con `closeReason = "manual"` si no hay SL confirmado. Ese cierre libera `marginReserved` y no programa rearm porque no fue cierre por SL.

Riesgo de cerrar algo indebido: bajo. Una posicion viva con nocional mayor o igual a 10 USD sigue siendo `!flat`; si `markPx` falla, el helper vuelve al comportamiento estricto.

## Pruebas y comandos revisados

- `git diff --stat master..HEAD`
- `git diff master..HEAD -- convex/hyperliquid.ts convex/triggerEngine.ts convex/spotDefenseEngine.ts tests/dustThreshold.test.ts`
- `rg -n "DUST_NOTIONAL_USD|isFlatOrDust|Math\\.abs\\(.*szi|flat|realSize|armed_lower_only|closeArmAndScheduleRearm|retry_incompatible" convex/triggerEngine.ts convex/spotDefenseEngine.ts convex/hyperliquid.ts tests/dustThreshold.test.ts -S`
- `rg -n "closeBotPosition|closePositionEmergency|sziAfter|ordersRemaining|blockedByExecution|deletePoolBot" tests convex src -S`
- `git diff --check master..HEAD` - OK
- `npx tsc -p convex/tsconfig.json --noEmit` - OK
- `npx vitest run` - OK: 17 test files, 265 tests passed

No se ejecuto `npm run build` porque incluye deploy de Convex.

## Veredicto final

GO.

El cambio de reconcile en los motores IL y Defensa Spot corrige el caso dust sin romper invariantes de cierre, rearm, disarm ni `armed_lower_only`. No encontre bloqueantes ni altos. El unico riesgo medio es residual y acotado a la ruta manual legacy `closeBotPosition`/`closePositionEmergency`, no al reconcile automatico que debe resolver el caso Benjamin al desplegar.
