# Plan JAV-44 — 2º trigger (borde superior) + OCO entre las dos entradas

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
- Nunca un short desnudo (SL full-size sobre el tamaño REAL). Nunca trigger huérfano (ensureOrdersDead
  sobre todos los roles, incl. entry_upper). Sin doble-SL/doble-TP. Margen: la reserva ya cubre el
  total (pool+búfer); las DOS entradas reservan el MISMO total (no duplicar la reserva — una sola
  reserva por arm; las dos entradas son alternativas, no aditivas). OJO: si doble-fill, el margen real
  sería 2x el reservado → el `MARGIN_SAFETY_BUFFER` + el cierre de emergencia lo amortiguan; documentar.

## Verificación (mainnet real)
1. Bot IL con `allowReentryFromAbove=true` → al armar, 2 órdenes SELL en HL (abajo en minRange,
   arriba en maxRange).
2. El precio sale por abajo → llena `entry_lower` → se cancela `entry_upper` (OCO) → SL+TPs.
3. (otra vez) El precio sale por arriba → llena `entry_upper` → se cancela `entry_lower` → SL+TPs.

## Decisiones para Codex/usuario
- Doble-fill: ¿SL/emergencia con `szi` real (propuesta) o rechazar/cerrar el exceso? (propuesta: szi real).
- ¿La reserva de margen debe contemplar el peor caso doble-fill (2x)? (propuesta: no duplicar la
  reserva; cubrir con buffer + emergencia; o reservar 2x conscientemente — decidir).
- `tpsl` exacto de `entry_upper` (SELL trigger arriba) en el SDK 0.32.2 — confirmar.
