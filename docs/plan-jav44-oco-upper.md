# Plan JAV-44 — 2º trigger (borde superior) + OCO entre las dos entradas — rev.2

## (Codex #1) Margen del DOBLE-FILL — ELIMINAR el hueco, no amortiguar
Las dos entradas son triggers nativos independientes → en un spike ambas pueden llenarse antes del
OCO → exposición real 2x el total. Política que lo ELIMINA: **cuando se arman DOS entradas
(`allowReentryFromAbove`), `reserveArm` reserva el PEOR CASO = 2× (`reservedNotional` y
`marginReserved` = 2× el del total pool+búfer).** Así el colateral siempre cubre un doble-fill, NO
solo el buffer de seguridad. Con UNA sola entrada, reserva 1×. Tras confirmar el OCO (entrada
hermana cancelada vía CLOID + verificación de tamaño de posición `|szi| ≤ size*1.5`, ambos en la
fase de posición), `reconcileArm` puede **reducir la reserva a 1×** (mutation que baja
`marginReserved`/`reservedNotional` del arm) liberando colateral. El margen compartido suma el valor
reservado del arm (2× mientras ambas vivan, 1× tras OCO). Esto garantiza margen para el doble-fill en
mainnet (no es una amortiguación).

## (Codex #2) tpsl de `entry_upper` — CERRADO
`entry_upper` = **SELL, `reduceOnly:false`, trigger "price ABOVE maxRange", `tpsl:"tp"`** (un sell que
dispara al SUBIR = dirección take-profit), per el issue JAV-44. `entry_lower` = SELL trigger BELOW
minRange, `tpsl:"sl"`. (Verificar la forma exacta en el SDK 0.32.2 al implementar, pero el plan se
COMPROMETE con `tpsl:"tp"` para el upper.)


Sobre la pieza TPs (PR #21). Hoy el arm coloca UNA entrada (`entry_lower`, SELL trigger BELOW
`minRange`). Esta pieza añade la **2ª entrada en el borde superior** (`entry_upper`) y el **OCO**:
cuando UNA entrada se llena, se cancela la hermana (no abrir dos shorts).

## Modelo (según el issue JAV-44)
- **`entry_lower`** (ya existe): SELL, `reduceOnly:false`, trigger "price BELOW `minRange`", `tpsl:"sl"`.
- **`entry_upper`** (nuevo): SELL, `reduceOnly:false`, trigger "price ABOVE `maxRange`", `tpsl:"tp"`.
  Solo se coloca si `bot.allowReentryFromAbove === true`.
- Ambas abren un SHORT del MISMO tamaño total (pool+búfer). cloid `…|entry_lower` y `…|entry_upper`.
- Snapshot nuevo en el arm: `upperEdge` (maxRange normalizado), `allowReentryFromAbove`.

## OCO (One-Cancels-Other) — el punto delicado
- Al armar: colocar `entry_lower` (siempre) y `entry_upper` (si allowReentryFromAbove). El CAS/gate y
  la cuarentena aplican a AMBAS (cada una con su submittedAt/observed por orden, como los TPs).
- **Cuando se detecta el fill de UNA** entrada (fillsByCloid/orderStatus por su cloid) →
  `settleArm(filled)` con su filledSize/entryPrice → **CANCELAR la hermana** (`cancelByCloid` +
  prueba negativa) ANTES de continuar a la fase de posición (SL/TPs). El SL/TP usan el entryPrice de
  la que llenó.
- **Carrera doble-fill (crítico, Codex original #1):** las dos son triggers nativos que HL dispara
  independientemente; en un spike ambas podrían llenarse antes de cancelarse → DOBLE short. Mitigación:
  - El **SL full-size y el cierre de emergencia usan el tamaño REAL de la posición (`szi` de
    clearinghouseState), no solo `arm.filledSize`** → cubren el tamaño real aunque sea 2x. (Cambio
    acotado sobre la pieza SL: hoy el SL usa `arm.filledSize`; pasar a `Math.abs(szi)` para el size del
    SL y del cierre de emergencia.)
  - `entryPrice` para el SL: si ambas llenaron, usar el **precio medio ponderado** de los fills de
    ambos cloids (o `clearinghouseState.entryPx` de la posición agregada — preferible: HL ya da el
    entryPx medio de la posición).
  - Registrar/alertar el doble-fill (no debería pasar; es defensa).
- **Disarm/kill pre-fill:** cancelar AMBAS entradas (ya: `ensureOrdersDead` sobre todos los roles).

## Flujo en `reconcileArm` (extender la FASE PRE-FILL)
Hoy la fase pre-fill mira solo `entry_lower`. Cambios:
1. **Colocación:** tras el CAS/gate, colocar `entry_lower` y (si allowReentryFromAbove) `entry_upper`.
   Cada una con su confirmar-antes-de-rotar (submittedAt por orden). Una colocación por ciclo (acota lease).
2. **Detección de fill:** comprobar fills de AMBOS cloids. Si alguno llenó → `filled` con su
   entryPrice/filledSize → cancelar la hermana (OCO) con prueba negativa → fase de posición.
3. **Estados de orden:** `armed` del arm cuando AMBAS (o la única) están `open`/resting. El mapeo
   open/triggered/filled/terminal/unknownOid + cuarentena se aplica POR orden.

## Cambios concretos
- `schema`: `trigger_orders.role` += `entry_upper`. `trigger_arms` snapshot += `upperEdge`,
  `allowReentryFromAbove`. (entry_lower/entry_upper sin tpIndex.)
- `armPoolBotEntry`: calcular `upperEdge = roundHlPrice(maxRange, "ceil")` (SELL trigger arriba);
  validar `mark < upperEdge` para el entry_upper (debe dispararse por encima); persistir en snapshot.
- `triggerArms`: helpers genéricos por role (ya hay `getArmOrderByRole`/`setArmOrderObserved` con
  role; extender el union de role a entry_upper). prepareEntryAttempt por role (o reusar reserveArm
  para crear las dos órdenes a la vez al reservar).
- `reconcileArm` (pre-fill): iterar las entradas (lower + upper si aplica); colocar/confirmar cada
  una; detectar fill de cualquiera → OCO (cancelar hermana) → filled. SL/TPs sin cambios salvo el
  size desde `szi` (doble-fill safety).
- `placeStopLoss`/cierre de emergencia: usar `Math.abs(szi)` como size (cubre el tamaño real).

## Invariantes a preservar
- Nunca un short desnudo (SL full-size sobre el tamaño REAL `szi`). Nunca trigger huérfano
  (ensureOrdersDead sobre todos los roles, incl. entry_upper). Sin doble-SL/doble-TP.
- **Margen (Codex #1): con dos entradas, reservar 2× (peor caso doble-fill); reducir a 1× tras OCO.**
  El margen compartido suma el `marginReserved` actual del arm (2× → 1×). Garantiza cobertura, no
  amortigua.

## Verificación (mainnet real)
1. Bot IL con `allowReentryFromAbove=true` → al armar, 2 órdenes SELL en HL (abajo en minRange,
   arriba en maxRange).
2. El precio sale por abajo → llena `entry_lower` → se cancela `entry_upper` (OCO) → SL+TPs.
3. (otra vez) El precio sale por arriba → llena `entry_upper` → se cancela `entry_lower` → SL+TPs.

## Decisiones (CERRADAS)
- Doble-fill SL/emergencia: con `szi` REAL (cubre el tamaño real aunque sea 2x). ✓
- Margen: reservar 2× con dos entradas (peor caso), reducir a 1× tras OCO. ✓ (Codex #1)
- `tpsl` de `entry_upper`: SELL trigger ABOVE maxRange, `tpsl:"tp"`. ✓ (Codex #2)
