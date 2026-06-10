# Plan JAV-44 — Etapa 1: trigger nativo de entrada (inferior), TESTNET (rev.8, tras 7ª auditoría Codex)

## (N3) Constante única de terminalidad
`ARM_TERMINAL = { disarmed, closed, failed }`. Se usa SIEMPRE igual para: liberar margen, permitir
nueva generación, permitir borrar pool/credencial, y finalizar la desactivación pendiente. NO
terminales (reservan margen + bloquean nueva generación): `arming, submitting, armed, disarming,
filled, unknown`.

Motor de cobertura automática **por etapas en testnet** (`HL_NETWORK=testnet`). Prerequisito:
JAV-43 (motor IOC con claim/lease/fencing/CLOID) mergeado+desplegado — se REUTILIZA y NO se rompe.
Entrada = **trigger NATIVO de HL** (decisión usuario). El plan incorpora los 14 hallazgos de la 1ª
auditoría (H1..H14), los 6 residuales de la 2ª (R1..R6), los 3 de la 3ª (N1..N3) y N4 de la 4ª.

## Principio rector (por qué Etapa 1 ≠ trivial)
Un trigger nativo lo ejecuta **HL aunque el portal esté apagado o se pulse el kill switch**. Por
tanto la Etapa 1 NO puede aplazar: cancelación CONFIRMADA, fencing, grace de incertidumbre, carrera
fill/cancel, y convergencia del kill switch. "Sin SL/TPs/OCO" sigue siendo el recorte; "sin
reconciliación robusta" NO.

## Alcance Etapa 1
Activar un bot IL coloca **UNA** orden trigger nativa de entrada en el borde inferior (`minRange`):
short que abre al caer. Reconciliación completa, pausa segura y kill-switch que cancela. **Sin** SL,
TPs, segundo trigger, OCO ni auto-rearm. **Solo testnet**; al llenarse, la posición queda sin SL
(por eso testnet estricto). SL = Etapa 3.

---

## (H4, H11, H12) Precondiciones de armado y sizing
- **(H4) Posición neta cero obligatoria:** antes de armar, `clearinghouseState` del activo debe dar
  `szi == 0` y sin órdenes gestionadas incompatibles. `SELL reduceOnly:false` sobre un long lo
  reduce/invierte → prohibido. Tras un fill, **bloquear nuevas generaciones** hasta confirmar flat.
- **(H11 + R6) Rechazar si `mark ≤ triggerPxNormalized`:** un stop-sell exige trigger por DEBAJO del
  mid. **Normalizar PRIMERO** el trigger al tick HL (en la dirección protectora) y aplicar el gate
  sobre ese valor YA persistido/enviado: `triggerPxNormalized = floorHlPrice(minRange, szDecimals)`
  (o el redondeo que se mande a HL); si `mark ≤ triggerPxNormalized`, NO armar (no transformar la
  estrategia en silencio) → error explícito, el usuario decide. Persistir `triggerPxNormalized` en
  el snapshot y usar el MISMO valor en la orden.
- **(H12) Capital de cobertura desde BACKEND, no del frontend.** No existe un campo fiable de
  capital LP. **Decisión (a confirmar Codex/usuario):** añadir `hedgeNotionalUsd` explícito al bot
  (configurado al crear el bot, validado finito>0), y dimensionar con él. `capitalPct`/`bufferPct`
  quedan como metadatos hasta tener un origen de capital LP fiable. Alternativa: `pool.initialLiquidityUsd`
  con chequeo de frescura — descartada en Etapa 1 por staleness. Persistir el nocional/margen del snapshot.
- **(H11 sizing) Precio:** `triggerPx = minRange` (sin buffer de borde en Etapa 1). Orden SELL,
  `isMarket:true`, banda agresiva direccional para venta: `p = aggressiveHlPriceStr(triggerPx*(1−slip), isBuy=false)`
  (redondeo floor, reutiliza helpers JAV-43). Aceptar que un gap > banda puede dejarla sin fill.
- **(H12 sizing) Tamaño:** `notionalCapPx = ceilHlPrice(triggerPx, szDecimals)`,
  `size = floorToDecimals(hedgeNotionalUsd / notionalCapPx, szDecimals)`, `size>0`. Leverage entero
  (`appliedLeverage` de JAV-43). `reservedNotional = size*notionalCapPx`, `marginRequired = /appliedLeverage`.

## (H3) Reserva de margen COMPARTIDA con JAV-43 (misma OCC)
El margen de un arm y el de una IOC manual NO pueden reservar el mismo colateral.
- Helper interno compartido `committedMarginForAccount(ctx, hlAccountId)` = Σ margen de
  `execution_requests` en `OPEN_MARGIN_STATES` **+** Σ `marginReserved` de `trigger_arms` no terminales.
- La admisión del arm y `reserveExecution` (executions.ts) usan AMBOS este helper dentro de su
  mutation OCC, y validan contra `availableCollateral*(1−MARGIN_SAFETY_BUFFER)`, `maxNotionalPerOrder`
  y el límite diario (contando ambos motores). → modificar `reserveExecution` para sumar también
  arms (cambio acotado y auditable; NO altera su lógica de claim/lease).

## (H5, H7) Modelos y máquina de estados completa
**(R5) Campo nuevo en `bots`:** `disarmPending: v.optional(v.boolean())` — bloquea nuevos arms
mientras se cancela, manteniendo `active=true` hasta confirmar la cancelación.

`trigger_arms`:
- Identidad: `botId`, `userId`, `hlAccountId`, `poolId`, `asset`, `network:"testnet"`, `generation`.
- `status`: `arming | submitting | armed | disarming | disarmed | filled | closed | failed | unknown`.
  - **(N1) `submitting`:** estado intermedio con lease antes del envío a HL (ver "CAS pre-envío").
  - **(R2) `filled` → `closed`:** `filled` = posición ABIERTA (bloquea margen/credencial/generaciones).
    Solo `reconcileArm`, tras confirmar `clearinghouseState.szi==0` para el activo, transiciona
    `filled → closed` (terminal, libera la reserva de margen y el bloqueo de credencial/generación).
    En Etapa 1 (sin SL) el cierre es manual por el usuario; el cron lo detecta y marca `closed`.
  - Terminalidad: usar `ARM_TERMINAL` (N3) = `disarmed | closed | failed`.
- `desiredState`: `armed | disarmed`.
- snapshot: `side:"Short"`, `triggerPx`, `size`, `appliedLeverage`, `reservedNotional`,
  `marginReserved`, `lowerEdge`.
- fill: `filledSize?`, `entryPrice?`.
- `submittedAt?`, `error?`, `reconcileLeaseUntil?`, `reconcileLeaseToken?`, `createdAt`, `updatedAt`.
- Índices: `by_bot_generation` (unicidad), `by_status_updated`, `by_account` (NO trata `filled`
  como seguro: bloquea revocación).

`trigger_orders`:
- `armId`, `role:"entry_lower"`, `cloid` (determinista `botId|generation|role`), `oid?` (OPCIONAL),
  `triggerPx`, `size`, `reduceOnly:false`, `observedStatus`, `submittedAt?`, `createdAt`, `updatedAt`.
- Índices: `by_arm_role` (unicidad: un `entry_lower` por arm), `by_cloid`.

## (H7) Invariantes de unicidad / generación (OCC)
- Una sola generación NO en `ARM_TERMINAL` por bot (terminal = `disarmed|closed|failed`). Tras un
  `closed` (cierre manual confirmado por szi==0) SÍ se permite una nueva generación.
- `generation = max(existentes)+1`, calculada en backend.
- Un solo `entry_lower` por arm. Conflicto si un CLOID reaparece con parámetros distintos.

## (H6 + R3) Idempotencia por GENERACIÓN y `unknownOid` con PRUEBA NEGATIVA
- En la reserva (antes de HL) crear `trigger_order(observedStatus:"pending", cloid)` **SIN
  `submittedAt`** (este se fija solo en el CAS `markArmSubmitting`, N5).
- **(N6 — toda terminalización post-`submitting` se subordina a la cuarentena N5).** Para un arm que
  YA alcanzó `submitting` (tiene `submittedAt`), CUALQUIER transición a `ARM_TERMINAL` —incluidas
  `canceled → disarmed`, `*Rejected/*Canceled → failed`, y los errores `ApiRequestError/Validation
  → failed`— SOLO es válida si `now − submittedAt > ARM_SUBMIT_QUARANTINE_MS`. Antes de ese plazo,
  aunque HL responda canceled/rejected, una petición tardía aún podría aparecer → mantener
  `submitting`/`unknown`, margen y generación bloqueados, NO terminalizar.
- **(N7 — recuperación de `arming` abandonado pre-CAS).** Si la action muere ENTRE la reserva y el
  CAS, el arm queda en `arming` SIN `submittedAt`. Como nunca alcanzó el CAS, por construcción NUNCA
  pudo enviar a HL → tras expirar su lease/plazo de action puede terminalizarse a `failed`
  **directamente, sin R3 ni cuarentena** (libera margen/generación). Distinguir SIEMPRE `arming`
  (sin `submittedAt`, jamás envió) de `submitting`+ (pudo enviar, exige cuarentena).
- Terminal (`canceled`/cualquier `*Rejected`/`*Canceled`) con `desiredState=armed` → arm `failed`
  (sujeto a N6), **NO recolocar con el mismo CLOID**. Un nuevo intento exige **nueva generación + nuevo CLOID**.
- **(R3) `unknownOid` tras el grace NO basta para declarar `failed`.** A diferencia de la IOC (que
  tiene `expiresAfter`), un trigger puede seguir VIVO en HL. Antes de liberar el arm exigir
  **prueba negativa independiente por CLOID**: (a) ausente en `frontendOpenOrders`, (b) sin fills en
  `userFills`, y (c) un intento de `cancelByCloid` que confirme `unknownOid`/already-canceled. Solo
  con las tres → `failed`. Sin confirmación → permanecer `unknown`/`disarming`, **bloqueando
  generación y margen** (nunca liberar a ciegas: dejaría una orden viva + permitiría duplicar).
- **(N5 CRÍTICO — carrera CAS→envío) CUARENTENA de `submitting`.** Una action que pasó
  `markArmSubmitting` puede estar SUSPENDIDA justo antes de enviar; si el reconciliador diera prueba
  negativa y liberara, la action podría despertar y colocar el trigger igual (el fencing protege la
  DB, no el efecto externo ya en curso). Especificación exacta de la cuarentena:
  - **`submittedAt` se fija ATÓMICAMENTE dentro de `markArmSubmitting` (el CAS), NO en la reserva.**
    Así marca el instante real a partir del cual una petición puede salir hacia HL.
  - **`ARM_SUBMIT_QUARANTINE_MS` cubre desde ese CAS hasta el momento MÁXIMO en que una petición en
    vuelo puede aceptarse/hacerse visible en HL** = vida máxima de la action Convex **+** margen de
    transporte/asentamiento de HL (holgura generosa, como `ENTRY_GRACE_MS=5min` de JAV-43; nunca
    apurado al timeout). 
  - **La prueba negativa R3 (y cualquier liberación/terminalización) SOLO se ejecuta cuando
    `now − submittedAt > ARM_SUBMIT_QUARANTINE_MS`.** Antes: `submitting`/`unknown`, margen y
    generación bloqueados, NUNCA terminalizar (una orden tardía aún podría aparecer).
  - Además, **la propia action, tras enviar, RE-LEE `desiredState`/`disarmPending`; si es disarmed →
    cancela defensivamente por CLOID (`cancelByCloid`) lo que acaba de colocar** antes de devolver.
  - Test N5: simular aceptación/visibilidad del trigger DESPUÉS del timeout de la action y verificar
    que la cuarentena impidió liberar y no quedó huérfano.

## (H9) Catálogo de estados de orderStatus (SDK 0.32.2) — clasificación
- **No terminal:** `open` (→ armed), `triggered` (disparado, esperando fill; seguir reconciliando).
- **Fill:** `filled` (→ arm `filled`, posición abierta).
- **Terminal SIN fill:** `canceled`, `marginCanceled`, `openInterestCapCanceled`,
  `liquidatedCanceled`, `selfTradeCanceled`, `*Rejected` (`badTriggerPxRejected`,
  `marketOrderNoLiquidityRejected`, `tickRejected`, …). Antes de concluir "no abrió posición",
  **confirmar fills por CLOID** (`userFills`).
- `unknownOid` → grace (¿lag o nunca colocó?), reconciliar por CLOID.

## (H1, H2, H8, H14) Pausa segura, kill switch y carrera cancel/fill
**(H1 + R4 + R5) TODA ruta que desactiva un bot / borra su contexto pasa por desarmado confirmado.**
Centralizar en `requestDisarmAndDeactivate(botId)`: **(N2 caso base) si NO hay ningún arm fuera de
`ARM_TERMINAL` para el bot → desactivar YA** (`active=false`, sin `disarmPending`) en la misma
mutation, sin esperar al cron (no hay nada que cancelar). Si hay un arm vivo: set
`arm.desiredState=disarmed` + **(R5) `bot.disarmPending=true`** (campo nuevo persistente: bloquea
NUEVOS arms de inmediato pero mantiene `active=true`) → `reconcileArm` cancela en HL y CONFIRMA
(R3 + carrera H8) → recién entonces `active=false` + `disarmPending=false`. Mientras `disarmPending`,
`armPoolBotEntry` rechaza. Rutas:
- `getOrCreatePoolBot(active=false)`, `poolScanner.checkAllPoolClosures` (cierre de pool), cambio de
  cuenta HL, activar `simulationMode`.
- **(R4) `pools.deletePool`** (pools.ts:128): hoy hace `active=false`+`poolId=undefined`+`delete`.
  Debe RECHAZAR si hay un arm NO en `ARM_TERMINAL` para algún bot del pool (no borrar el pool → se
  perdería el snapshot necesario para cancelar/cerrar).
- **(R4) `hlCredentials.revokeById`** (hlCredentials.ts:29): ya bloquea con `execution_requests`
  abiertas vía `by_account`; **añadir el MISMO guard para `trigger_arms` NO en `ARM_TERMINAL`**
  (incluido `filled`): no borrar la credencial (perderíamos la clave para cancelar/cerrar). 
Nunca `active=false` (ni borrar pool/credencial) con trigger vivo o arm no terminal.

**(N2) Finalización de la pausa.** Cuando un arm con `bot.disarmPending` alcanza CUALQUIER estado
de `ARM_TERMINAL` (`disarmed` por cancelación confirmada, `closed` por szi==0, o `failed` por prueba
negativa), `reconcileArm` (o el cron) DEBE completar atómicamente la desactivación pendiente:
`active=false` + `disarmPending=false`. Caso crítico cubierto: si durante `disarmPending` el trigger
se LLENA (`filled`), la pausa NO se completa hasta que el usuario cierre la posición y el cron
confirme `szi==0 → closed`; mientras tanto el bot queda `active=true, disarmPending=true` (sin nuevos
arms) y con alerta operativa de "posición abierta pendiente de cierre". Así nunca queda bloqueado
para siempre ni se pausa con posición viva.

**(H2) Kill switches CANCELAN triggers ya puestos.** Un cron `reconcilePoolArms` (~1 min) barre los
arms no terminales y fuerza `desiredState=disarmed`+cancelación si: `tradingEnabled=false` ∨
`simulationMode=true` ∨ `canTradeLive` revocado ∨ pool cerrado ∨ red≠testnet ∨ snapshot de cuenta
cambiado. Las mutations de kill switch (setTradingEnabled/setSimulationMode) además marcan los arms
para convergencia inmediata (o dejan alerta operativa).

**(H8/H14) Carrera cancelar-vs-disparar (resultado explícito).** Tras `cancelByCloid` (o al
detectar disarm), consultar `orderStatus`+fills por CLOID:
- `canceled` confirmado → `disarmed`, luego `active=false` — **sujeto a la cuarentena N6** si el arm
  alcanzó `submitting` (no terminalizar antes de `now−submittedAt > ARM_SUBMIT_QUARANTINE_MS`).
- `filled` → arm `filled`, posición abierta; **NO** declarar disarmed (queda posición sin SL → alerta).
- `triggered` → seguir reconciliando (no terminal).
- timeout/TransportError → permanecer `disarming`, **nunca** pausar aún.

## (H10 + residual R1) Gates con DOS políticas: colocación vs cancelación defensiva
**CRÍTICO (R1):** los gates de colocación NO pueden aplicar a la cancelación/reconciliación
defensiva — precisamente cuando fallan (`tradingEnabled=false`, permiso revocado, bot pausándose,
pool cerrado) es cuando HAY que cancelar el trigger vivo. Dos políticas separadas:
- **Política de COLOCACIÓN** (`armPoolBotEntry`, o recolocar): TODOS los gates — `canTradeLive`
  (o admin), `tradingEnabled===true`, `simulationMode===false`, bot `active`+`kind:"il"`+
  `direction:"short"`, ownership bot↔pool↔cuenta, snapshot de cuenta sin cambios, precondición
  flat(H4), `mark>triggerPxNormalized`(R6), y **hard gate** `hlNetwork()==="testnet"`.
- **Política de CANCELACIÓN/RECONCILIACIÓN DEFENSIVA** (`reconcileArm` cuando `desiredState=disarmed`,
  o cancelación por kill switch/pausa): se ejecuta AUNQUE fallen trading/permiso/estado del bot.
  **(N4 CRÍTICO) La red la fija el campo INMUTABLE del arm (`arm.network`, siempre "testnet"), NO
  `hlNetwork()` actual.** El cliente se construye desde `arm.network` incondicionalmente, de modo que
  si `HL_NETWORK` cambia a mainnet/ inválido con un trigger testnet vivo, el cron PUEDE cancelarlo
  igual (si no, quedaría huérfano y bloquearía el arm para siempre). El hard-gate `hlNetwork()==="testnet"`
  aplica SOLO a la colocación, no a la cancelación. Si la credencial ya no existe (revocada), NO puede
  cancelar → mantener `unknown/disarming` + **alerta operativa** (por eso R4 prohíbe borrar la
  credencial antes de `ARM_TERMINAL`).
- NO tocar el motor IOC auditado (salvo el cambio acotado de margen compartido, H3).

## Acciones / mutations
1. `armPoolBotEntry` (action, testnet): gates de COLOCACIÓN(R1) → precondición flat(H4)+
   `mark>triggerPxNormalized`(R6) → reserva OCC compartida(H3)+arm(`arming`)/trigger_order(H5/H6) →
   **(N1) CAS pre-envío:** `markArmSubmitting` (CAS `arming→submitting` validando
   `desiredState=armed` ∧ `!bot.disarmPending` ∧ gates, bajo lease) JUSTO antes del envío; si el CAS
   falla (otro proceso desarmó/pausó) → abortar SIN enviar. Igual patrón que
   `markSubmitting`+`gateBeforeOrder` de JAV-43, para que una action retrasada NUNCA coloque un
   trigger que el reconciliador ya dio por ausente (evita trigger huérfano). → coloca trigger →
   registra oid/observedStatus (`submitting→armed`). Errores: TransportError→`unknown`(grace+prueba
   negativa R3); `ApiRequestError/Validation→failed` **sujeto a la cuarentena N6** (ya estamos en
   `submitting`: una petición que el SDK reportó como rechazada pero que salió por red podría aún
   aparecer → no terminalizar antes de vencer la cuarentena). Tras enviar, re-leer
   `desiredState`/`disarmPending` y cancelar defensivamente por CLOID si disarmed (N5).
2. `reconcileArm` (internalAction, claim/lease/fencing como `reconcileExecution`): converge a
   `desiredState`, mapea estados(H9), resuelve carrera cancel/fill(H8). Usa la **política defensiva**
   (R1) cuando `desiredState=disarmed`: cancela aunque trading/permiso/bot fallen. `unknownOid` con
   **prueba negativa** (R3). `filled → closed` solo tras confirmar `szi==0` (R2). Cliente SIEMPRE testnet.
3. `requestDisarmAndDeactivate` (mutation interna, usada por TODAS las rutas de pausa — H1).
4. Cron `reconcilePoolArms` (~1 min) — convergencia + kill switch(H2) + pausa(H1).

## (H13) Aislamiento testnet estricto (esquema + runtime + deploy)
- Rechazo en runtime si `hlNetwork()!=="testnet"` SOLO al **armar/colocar** (no al cancelar — N4: la
  cancelación usa `arm.network` inmutable para no dejar triggers huérfanos si cambia `HL_NETWORK`).
- `trigger_arms.network` fijo "testnet" e INMUTABLE; el cliente de cancelación se construye desde él.
- Un arm `filled` representa posición ABIERTA sin SL → bloquea revocación de credenciales (`by_account`)
  y nuevas generaciones hasta cierre manual confirmado (flat por `clearinghouseState`).

## Verificación (testnet, por API)
1. Activar bot IL → 1 orden trigger SELL en `frontendOpenOrders` testnet, triggerPx=minRange, arm=armed.
2. Precio cae bajo minRange → trigger dispara → short abierto (`clearinghouseState`), arm=filled.
3. Pausar antes de disparo → cancelación CONFIRMADA antes de `active=false`.
4. Kill switch (tradingEnabled=false) → el cron cancela el trigger vivo.

## Pruebas con SDK simulado (requisito de Etapa 1, no aplazable — H14)
- arm idempotente (reintento mismo CLOID no duplica; terminal→failed sin recolocar; nuevo intento→nueva generación).
- reconcile: open→armed, triggered→pendiente, filled→filled, cada terminal-sin-fill→failed (con confirmación de fills).
- crash tras envío (unknownOid+grace); carrera cancel/fill concurrente; kill switch cancela; dos activaciones concurrentes (una sola generación); conflicto de margen con una IOC JAV-43 (misma OCC).
- pausa por cada ruta (getOrCreatePoolBot, cierre de pool, deletePool, revokeById, cambio de cuenta, simulationMode) cancela antes de desactivar.
- **(N2) pausa SIN arm vivo → desactiva inmediatamente** (no queda colgado esperando al cron).
- **(N3) re-arm tras `closed`:** una nueva generación se permite tras un cierre manual confirmado (szi==0).
- **(N4) cambio de red con arm vivo:** `HL_NETWORK→mainnet` con trigger testnet vivo → el cron lo
  cancela igual usando `arm.network` y no deja huérfano.
- **(N5) carrera CAS→envío:** pausa tras el CAS, cancelación inicial `unknownOid`, la action
  coloca tarde → la cuarentena impide liberar antes de tiempo y la action cancela defensivamente al
  ver `desiredState=disarmed`; verificar que NUNCA queda trigger huérfano ni margen liberado con orden viva.

## Riesgos
- Etapa 1 deja la posición SIN SL al llenarse → **solo testnet, nunca mainnet** (triple bloqueo).
- Confirmar en SDK 0.32.2: forma exacta del trigger de ENTRADA (no reduceOnly, tpsl), `cancelByCloid`,
  y el conjunto completo de estados terminales.
- Modificar `reserveExecution` (auditado) para el margen compartido: cambio acotado, re-auditar.
