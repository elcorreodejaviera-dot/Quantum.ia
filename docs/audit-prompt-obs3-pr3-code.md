# Prompt de auditoría Codex — CÓDIGO de OBS-3 PR3 (logging de hyperliquid.ts — MÓDULO MÁS SENSIBLE)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de OBS-3 PR3 para Quantum.ia (portal de bots sobre
Hyperliquid, capital real). El plan maestro ya tiene tu GO. PR1 (helper) y PR2 (coverage/ejecuciones/
arms) ya están mergeados. Este PR3 instrumenta `convex/hyperliquid.ts` — **el módulo que descifra y
maneja la clave privada y la dirección de trading**. Aquí el riesgo de loguear un secreto es REAL, así
que la auditoría es REFORZADA campo por campo. SOLO observación: sin cambiar ninguna decisión.

Revisa el diff (rama basada en `master`):

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/obs3-engine-logging-pr3 -- convex/hyperliquid.ts
```

Verificación ya hecha: `npm run typecheck` EXIT 0.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO).

## SECRETOS EN ESTE ARCHIVO (lo que NUNCA debe aparecer en un log)
- `decryptPrivateKey(credential)` / la `privKey` / el `wallet`.
- `credential.tradingAccountAddress` (`tradingAccount`), cualquier dirección `0x…` de cuenta.
- Las respuestas crudas del SDK: `resp`, `entryResp`, `closeResult`, `st`, `entry.reason`,
  `entry.detail`, y los mensajes de error (`(e as Error).message`).

## Invariantes (los DOS críticos primero)

1. **NINGÚN secreto ni payload del SDK en los `elog` (CRÍTICO — revisión campo por campo).** Recorre
   los 16 call-sites. Los ÚNICOS campos permitidos y presentes deben ser:
   - `cloid` (= `String(slCloidVal)` / `String(entryCloid)`) — id de orden de cliente, NO secreto.
   - `oid` (= `String(st.resting.oid)` / `String(entryOid)`) — id de orden de HL, NO secreto.
   - `coin` (`asset`/`a`) — símbolo del activo.
   - `side` (Long/Short), `leverage`/`appliedLeverage` (número, NO secreto), `requestId` (id).
   - `result`/`kind`/`ok`/`flat` — clasificación (literales/boolean).
   - `filledSize`/`sziBefore`/`sziAfter` — números (tamaño de posición, operacional).
   Confirma que NINGÚN `elog` recibe: `credential`, `tradingAccount`, `privKey`, `wallet`, `resp`,
   `entryResp`, `closeResult`, `st`, `e`, ni un `(e as Error).message`. En particular: las ramas de
   error loguean SOLO `kind: "transport"|"deterministic"|"transport_uncertain"|"ambiguous"|"rejected"`,
   nunca el string del error (que SÍ se sigue guardando en DB vía `settleExecution`, sin cambios — eso
   no es un log y queda fuera de alcance).

2. **CERO cambio de control de flujo (CRÍTICO).** Las 5 líneas eliminadas en `placeStopLoss` eran
   `if (...) return/throw` de una sola línea, convertidas a bloque `{ elog(...); return/throw }`:
   verifica que la condición, el valor de retorno y el `throw new Error(String(st.error))` son
   IDÉNTICOS. En `executePerpMarketOrder`, los `elog` se añaden junto a los returns/`settleExecution`
   existentes sin alterar el `try/catch`, el orden de `await`, los gates, ni el dimensionado de la
   orden. El `exchange.order`/`updateLeverage`/`cancel` y sus argumentos NO cambian.

3. **`elog` best-effort no rompe el money-path.** El helper ya envuelve en try/catch. Confirma que
   los `elog` están fuera de la ruta de firma/envío (antes/después de los `await exchange.*`, nunca
   entre la firma y el dispatch de forma que un coste añadido afecte el `expiresAfter`/`abortAfter`).

4. **Volumen / altitud.** Una línea por operación, no por iteración. `order_send`+`order_result` =
   una entrada por intento; `update_leverage` una por intento; `sl_placed` una por colocación de SL;
   `emergency_close` una por cierre. ¿Alguno quedó en un bucle de reconciliación por-tick?

## Mapa de call-sites (para tu verificación)
- `placeStopLoss`: `sl_placed` con `result` ∈ {pending_transport, error_deterministic, rejected,
  resting, filled, pending, ambiguous} (+`oid` en resting/filled).
- `closePositionEmergency`: `emergency_close` {coin, sziBefore, sziAfter, flat}.
- `executePerpMarketOrder`:
  - `update_leverage` {requestId, coin, leverage?, ok, kind?} (ok / transport / deterministic).
  - `order_send` {requestId, cloid, coin, side, leverage} ANTES del `exchange.order`.
  - `order_result` {requestId, cloid, kind, filledSize?, oid?} (transport_uncertain / rejected /
    ambiguous / filled).

NOTA: con PR3 el motor money-path queda instrumentado de extremo a extremo (coverage → reserva →
submit → gate → envío HL → updateLeverage → fill → SL → settle → rearm), todo con escalares no
sensibles. La tabla opcional `engine_events` sigue FUERA de alcance.
