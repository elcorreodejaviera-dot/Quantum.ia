# Plan JAV-44 — SL post-fill (proteger el short al abrir) + habilitar mainnet (rev.2, tras Codex)

## (Codex #1) Margen compartido — incluir protecting/protected
`ARM_OPEN_MARGIN_STATES` en `convex/executions.ts` HOY suma `{arming, submitting, armed, disarming,
filled, unknown}` y **NO** `protecting`/`protected`. Como esos estados mantienen la posición abierta
(margen comprometido), hay que **AÑADIRLOS** a `ARM_OPEN_MARGIN_STATES` y a `dailyNotionalUsed`
(filtro de no-terminales) en la MISMA edición, o se sobre-reservaría el colateral (rompe "no doble
reserva"). Igual para cualquier sitio que liste estados no-terminales del arm.


Sobre la **fundación** ya mergeada (PR #19: `trigger_arms`/`trigger_orders`, máquina de estados con
lease/fencing/cuarentena, margen compartido, pausa-segura, kill-switch, reconcile). Esta pieza hace
que, **al llenarse la entrada (short abierto), se arme automáticamente el SL stop-market** que lo
protege — y con eso la cobertura deja de ser una posición desnuda → se puede habilitar **mainnet**.

Reutiliza el `placeStopLoss` ya auditado de JAV-43 (stop-market, banda 1%, reduceOnly, clasificación
de errores por capa, idempotencia por CLOID).

## Objetivo de esta pieza
`armed → (entry fill) → filled → protecting → protected`. Sin TPs, sin 2º trigger, sin OCO, sin
auto-rearm (esas son piezas siguientes). Quitar el hard-gate testnet (ahora seguro porque hay SL).

## (Codex #2) Observabilidad/cancelación del SL por ROL — generalizar la API
La fundación expone `getArmOrderInternal` hardcodeado a `entry_lower`. Para el `sl_upper` hace falta:
- **Generalizar a `getArmOrderByRole(armId, role)`** (con wrapper `entry_lower` por compat).
- `setArmOrderObserved` debe aceptar el `role` (hoy hardcodea `entry_lower`).
- **Cancelación independiente:** el camino defensivo/kill-switch en `reconcileArm` cancela por CLOID
  **TODOS** los `trigger_orders` no terminales del arm (entry_lower si aún resting, y sl_upper si ya
  colocado): iterar y `cancelByCloid` cada uno; prueba negativa por CLOID de cada uno antes de
  declarar `disarmed`.
- **Idempotencia del SL:** cloid `botId|generation|sl|attempt`; un reintento (sl_failed) usa nuevo
  attempt (como `prepareSlRetry` de JAV-43). El cron confirma el sl_upper por su CLOID (orderStatus
  + frontendOpenOrders + fills), igual que la entrada.

## Modelo (sobre `trigger_arms`/`trigger_orders`)
- **Nuevo role de `trigger_orders`: `"sl_upper"`** (cierre del short: BUY, reduceOnly, stop-market,
  trigger ARRIBA del entry). cloid determinista `botId|generation|sl|attempt`.
- **Nuevos estados del arm:** `protecting` (colocando el SL) y `protected` (SL en reposo). 
  - Terminalidad: `protected` NO es terminal (la posición sigue abierta hasta que el SL/cierre la
    cierre). `ARM_TERMINAL` sigue = `{disarmed, closed, failed}`. `protected` mantiene margen/credencial
    bloqueados (igual que `filled`).
  - Transiciones nuevas (ALLOWED_ARM): `filled → protecting`; `protecting → protected | protecting
    (retry) | closed (cierre de emergencia, Codex #3) | disarming`; `protected → closed | disarming`.
    El arm NO tiene un estado `sl_failed` permanente: el fallo del SL se reintenta dentro de
    `protecting` hasta el deadline y, si no, se ESCALA a cierre de emergencia (`protecting → closed`).
    Nunca un arm no-terminal con short desnudo más allá del deadline.
- **Campos nuevos en `trigger_arms`:** `slAttempts` (nº de intentos de SL) y `protectDeadline`
  (`filledAt + SL_PROTECT_DEADLINE_MS`). El SL es un `trigger_order` role `sl_upper` con su
  `observedStatus` y su cloid `…|sl|attempt`.

## Cálculo del SL
- Lado: cerrar un SHORT = **BUY**, `reduceOnly:true`, stop-market que dispara al **subir**.
- `slTriggerPx` (IMPLEMENTADO): `entryPrice*(1+stopLossPct/100)` — SL relativo del bot, vía la
  REUTILIZACIÓN directa de `placeStopLoss` de JAV-43 (que ya hace exactamente esto para un Short:
  trigger = entry*(1+stopLossPct), BUY reduceOnly stop-market, banda 1%). **NO** se aplica el cap por
  `maxRange`: se descartó para reutilizar `placeStopLoss` sin modificarlo (auditado). El cap por
  `maxRange` (cortar antes si reentra al rango) queda como REFINAMIENTO futuro (requeriría un
  `placeStopLoss` parametrizado por triggerPx).
- Banda 1% (reutiliza `SL_MARKET_SLIPPAGE_FRACTION` de JAV-43): `p = aggressiveHlPriceStr(triggerPx*(1+1%), isBuy=true)` (ceil).
- Tamaño: el **total** del fill (`arm.filledSize`), reduceOnly (cierra toda la posición). En esta
  pieza el SL cubre el 100% (los TPs parciales son la pieza siguiente).

## Flujo en `reconcileArm` (extender, NO romper lo auditado)
Cuando `arm.status === "filled"` (ya con `filledSize>0` confirmado y pasado el manejo actual):
1. Antes del closed-check actual: si el bot NO está en disarm/kill y NO hay SL colocado aún →
   transición `filled → protecting` (CAS bajo lease) y **colocar el SL** (placeStopLoss adaptado:
   BUY reduceOnly stop-market). Reutilizar la clasificación de errores y la confirmación por CLOID.
2. Resultado de colocar el SL (igual patrón que JAV-43):
   - resting/open con oid → `protected` (+ persistir slOid en el trigger_order role sl_upper).
   - filled → el SL ya cerró → `closed` (tras confirmar szi==0 con el grace+doble-lectura existentes).
   - pending/waitingForTrigger/timeout (TransportError) → quedarse en `protecting` con grace
     (reusar la lógica de slSubmittedAt/cuarentena ya existente para el SL); reconciliar por CLOID.
   - rechazo definitivo → reintentar con nuevo `…|sl|attempt` (`slAttempts++`), SIGUE en `protecting`.
   - **Si `slAttempts ≥ SL_MAX_ATTEMPTS` o `now > protectDeadline` sin `protected`** → CIERRE DE
     EMERGENCIA (Codex #3): cerrar la posición reduceOnly market ya; al szi==0 → `closed`.
3. **CRÍTICO — orden de operaciones:** el camino DEFENSIVO (disarm/kill) y la carrera fill/cancel
   YA existentes deben seguir teniendo prioridad: si se está desarmando, NO colocar un SL nuevo
   (cancelar la entrada/posición según corresponda). El SL solo se coloca si `desiredState=armed`
   y sin kill.
4. **filled→closed** ya existente: ahora se llega normalmente vía el SL (cuando el SL se llena) o
   por cierre manual (szi==0). Mantener el grace + doble lectura.

## (Codex #3) POLÍTICA DE FALLO DEL SL (imprescindible para mainnet) — short nunca desnudo indefinido
Si el short ya está abierto (`filled`/`protecting`) y el SL no logra quedar `protected` —`sl_failed`
repetido, `pending`/timeout prolongado—, NO se puede dejar la posición desnuda sin tope. Política:
- **Reintento acotado:** colocar el SL se reintenta con nuevo attempt en cada ciclo del cron, hasta
  `SL_MAX_ATTEMPTS` (p.ej. 3) o `SL_PROTECT_DEADLINE_MS` (p.ej. 3–5 min) desde `filledAt`.
- **Escalada → CIERRE DE EMERGENCIA:** superado el límite sin `protected`, ejecutar un **cierre
  reduceOnly MARKET inmediato** de la posición (IOC agresivo, reduceOnly, banda amplia) para no
  dejar el short sin protección. Reutiliza el motor IOC de JAV-43 (o `placeStopLoss` con trigger ya
  cruzado) en modo "cerrar ya". Al confirmarse szi==0 → `closed`; registrar el evento.
- **Estado/alerta:** mientras se intenta proteger o cerrar, el arm está en `protecting` (no terminal,
  margen bloqueado) con un campo de observabilidad (`slAttempts`, `protectDeadline`) y una **alerta
  operativa** (admin_logs/alerts) "posición abierta sin SL — protegiendo/cerrando".
- **Interacción con disarm/kill:** si llega un kill mientras el short está abierto sin SL, el camino
  defensivo también va al **cierre de emergencia** (cancelar entrada si resting; si ya hay posición,
  cerrar reduceOnly market) — nunca dejar la posición abierta al pausar.
- Este cierre de emergencia es lo que hace SEGURO quitar el gate testnet: la garantía no es "el SL
  siempre se coloca", sino "la posición NUNCA queda desnuda más allá del deadline" (se protege o se
  cierra). Aceptar el residuo de slippage del cierre de emergencia (igual que el SL, sin cota dura).

## Habilitar mainnet (quitar el gate testnet)
- `reserveArm`: quitar `if (network !== "testnet") throw`. Aceptar `network = hlNetwork()`.
- `armPoolBotEntry`: quitar el hard-gate `hlNetwork()==="testnet"`; usar `assertExpectedNetwork`
  (como JAV-43) + el resto de gates. La cancelación defensiva sigue usando `arm.network` inmutable.
- `reconcileArm` kill-check: cambiar `hlNetwork() !== "testnet"` por `hlNetwork() !== arm.network`
  (si el deploy cambió de red bajo un arm, desarmar — la red del arm es la autoridad).
- El `trigger_arms.network` se fija a `hlNetwork()` al reservar (mainnet o testnet, lo que toque).
- **Gate de seguridad:** la cobertura solo opera real con el master switch (`tradingEnabled`),
  `canTradeLive` y `!simulationMode` (ya revalidados en el CAS + gate). Mantener.

## Seguridad / invariantes a preservar (de la fundación, auditados)
- Margen compartido OCC, cuarentena CAS→envío, prueba negativa por CLOID, pausa-segura en todas las
  rutas, kill-switch que cancela, no doble reserva, no trigger huérfano, no closed prematuro.
- El SL NO debe poder colocarse dos veces (idempotencia por su cloid `…|sl|attempt`).
- Un `protected` con SL vivo bloquea revocación de credencial / borrado de pool (ya cubierto: arm
  no terminal).

## Verificación (mainnet beta, real)
1. Activar bot IL → orden trigger SELL de entrada en HL (`armed`).
2. Precio cae bajo `minRange` → entra el short (`filled`) → el cron arma el SL stop-market BUY
   reduceOnly arriba → `protected`; verificar ambas órdenes/posición por API.
3. Si el precio se recupera al borde superior → el SL cierra → `closed`.
4. Pausar/kill switch en cualquier punto → cancela lo que esté vivo (entrada o SL) antes de pausar.

## Riesgos
- Banda 1% del SL: en un gap > 1% puede no llenarse (riesgo aceptado, igual que JAV-43).
- Reutilizar `placeStopLoss` de JAV-43 requiere adaptarlo al contexto del arm (no romper su uso en
  executePerpMarketOrder). Preferible un helper compartido parametrizado.
