# Plan JAV-44 — SL post-fill (proteger el short al abrir) + habilitar mainnet

Sobre la **fundación** ya mergeada (PR #19: `trigger_arms`/`trigger_orders`, máquina de estados con
lease/fencing/cuarentena, margen compartido, pausa-segura, kill-switch, reconcile). Esta pieza hace
que, **al llenarse la entrada (short abierto), se arme automáticamente el SL stop-market** que lo
protege — y con eso la cobertura deja de ser una posición desnuda → se puede habilitar **mainnet**.

Reutiliza el `placeStopLoss` ya auditado de JAV-43 (stop-market, banda 1%, reduceOnly, clasificación
de errores por capa, idempotencia por CLOID).

## Objetivo de esta pieza
`armed → (entry fill) → filled → protecting → protected`. Sin TPs, sin 2º trigger, sin OCO, sin
auto-rearm (esas son piezas siguientes). Quitar el hard-gate testnet (ahora seguro porque hay SL).

## Modelo (sobre `trigger_arms`/`trigger_orders`)
- **Nuevo role de `trigger_orders`: `"sl_upper"`** (cierre del short: BUY, reduceOnly, stop-market,
  trigger ARRIBA del entry). cloid determinista `botId|generation|sl`.
- **Nuevos estados del arm:** `protecting` (colocando el SL) y `protected` (SL en reposo). 
  - Terminalidad: `protected` NO es terminal (la posición sigue abierta hasta que el SL/cierre la
    cierre). `ARM_TERMINAL` sigue = `{disarmed, closed, failed}`. `protected` mantiene margen/credencial
    bloqueados (igual que `filled`).
  - Transiciones nuevas (ALLOWED_ARM): `filled → protecting | sl_failed?`; `protecting → protected |
    sl_failed | filled(retry)`; `protected → closed | disarming`. (Definir `sl_failed` del arm como
    NO terminal y reintentar la colocación del SL, igual que JAV-43 reintenta el SL.)
- **Campo `slCloid`/`slAttempt` en `trigger_arms`** (o reutilizar `trigger_orders` role sl con su
  cloid + un contador de reintentos) — a decidir; preferible un `trigger_order` role `sl_upper` por
  paralelismo con la entrada, con su `observedStatus`.

## Cálculo del SL
- Lado: cerrar un SHORT = **BUY**, `reduceOnly:true`, stop-market que dispara al **subir**.
- `slTriggerPx`: el precio al que se corta la pérdida si el mercado se recupera. Opciones (decidir
  con Codex/usuario): (a) **borde superior del rango** `maxRange` (reentrada al rango = SL, como la
  cuenta de referencia), o (b) `entryPrice*(1+stopLossPct/100)` (SL relativo del bot). Propuesta:
  **min(maxRange_normalizado, entryPrice*(1+stopLossPct))** para no arriesgar más que el SL del bot
  ni dejar pasar la reentrada al rango. Normalizar al tick (ceil para un BUY → se llena seguro).
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
   - rechazo definitivo → `sl_failed` (reintentar con nuevo cloid, como JAV-43 `prepareSlRetry`).
3. **CRÍTICO — orden de operaciones:** el camino DEFENSIVO (disarm/kill) y la carrera fill/cancel
   YA existentes deben seguir teniendo prioridad: si se está desarmando, NO colocar un SL nuevo
   (cancelar la entrada/posición según corresponda). El SL solo se coloca si `desiredState=armed`
   y sin kill.
4. **filled→closed** ya existente: ahora se llega normalmente vía el SL (cuando el SL se llena) o
   por cierre manual (szi==0). Mantener el grace + doble lectura.

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
