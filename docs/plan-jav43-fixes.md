# Plan JAV-43 — 4 correcciones sobre el fix IOC manual (rev. 3, tras 2ª auditoría Codex)

Rama: `feat/exec-market-orders` (base `b65c128`). Objetivo: dejar la cobertura MANUAL
(`executePerpMarketOrder` + `reconcileExecution`) lista para prueba mínima real
($15/orden, $50/día) tras pasar auditoría Codex.

**Decisión del usuario (2026-06-10):** el SL de cierre será **stop-MARKET** (visible en HL
como orden trigger, igual que la plataforma de referencia de JAV-44), con **banda de slippage
fija del 1%** (`SL_MARKET_SLIPPAGE_FRACTION = 0.01`). Se acepta conscientemente el riesgo de
no-fill en un gap > 1% para priorizar el precio de cierre, replicando al amigo. **No queda ningún
10% de slippage del SL** (corrige contradicción del rev.1). OJO: el `MARGIN_SAFETY_BUFFER=0.10`
de `executions.ts` es OTRA cosa (colchón de margen) y **se conserva** — no confundirlo ni borrarlo.

## Evidencia en vivo de la cuenta de referencia (0xb5A7…3701, mainnet, 2026-06-10 12:31)
Posición ETH SHORT 0.8625 @ 1637.2, 20x isolated. Armado real:
- **Entrada:** limit marketable (sell limit 1618.3 ≈ −1.15% del mark) → fill inmediato a 1637.2.
  NO es trigger nativo: el servidor mete la orden al cruzar el rango y DESPUÉS arma los exits.
- **SL = Stop Market**, size TOTAL reduceOnly, trigger en el borde superior del rango (+~0.9%),
  banda ~0-1% (limitPx ≈ triggerPx).
- **TP1/TP2 = Take Profit Market** parciales abajo (−0.5%, −1.5%), banda +1.0%.
Implicación para JAV-44 (no para JAV-43): la entrada NO necesita trigger nativo (reutiliza el
motor IOC ya auditado); solo los EXITS son triggers nativos en HL.

Archivo afectado principal: `convex/hyperliquid.ts`. Otros: `convex/executionLimits.ts`,
`convex/systemConfig.ts`, `src/components/BotPortal.jsx`, `docs/runbook-beta-mainnet.md`.

---

## Fix #1 + #3 — Semántica del SL stop-market y limpieza de `slBufferPct`

**Problema:** `SL_MARKET_SLIPPAGE=0.03` no representa la realidad y el comentario promete
"garantizar el llenado" (falso). `slBufferPct` se lee (`reconcileExecution` L446) y se pasa a
`placeStopLoss` pero ya no controla nada → UI/runbook/panel admin dicen "stop-limit" (mienten).

**Cambios:**
1. Constante única `SL_MARKET_SLIPPAGE_FRACTION = 0.01` (nombre explícito: guarda fracción 0.01,
   NO porcentaje). Eliminar `SL_MARKET_SLIPPAGE`. Es **constante fija**, sin config admin.
2. `placeStopLoss`: quitar el parámetro `bufferPct`. `triggerPx` se calcula solo con `stopLossPct`.
   `marketLimitPx = triggerPx * (1 ± SL_MARKET_SLIPPAGE_FRACTION)` (Short → +, Long → −).
   Mantener `isMarket: true`, `tpsl: "sl"`, `reduceOnly: true`.
3. `slPrices`: simplificar a devolver solo `triggerPx` (eliminar `limitPx`/`bufferPct`), o inlinar
   el trigger en `placeStopLoss`.
4. Eliminar el helper `slBufferPct(ctx)` y su uso en `reconcileExecution` (L446) + el paso del
   `buffer` a `placeStopLoss` (L450). Eliminar `slBufferPct` de **todos** estos sitios (Codex #7):
   - `convex/executionLimits.ts`: `LIMIT_DEFAULTS.slBufferPct`, `getExecutionLimits`,
     `setExecutionLimitInternal`, validadores.
   - `convex/systemConfig.ts`: `setSlBufferPct` (y cualquier validador de la clave).
   - `src/components/BotPortal.jsx` (~L2959): campo de UI + llamadas frontend.
   - La clave antigua `slBufferPct` en `system_config` puede quedar **inerte** (no migrar/borrar
     datos). 
   - ⚠️ **NO tocar el `bufferPct` del BOT** (`bots.bufferPct`): es otro concepto — el búfer de
     capital de la estrategia (toma de ganancias para recuperar SL encadenados). Solo se elimina
     el `slBufferPct` de límites de ejecución.
5. **UI / runbook / panel admin (Codex #8):** retirar toda mención a "stop-limit" y al buffer
   configurable del SL. Texto correcto: *"orden trigger market con precio máximo/mínimo aceptable
   (banda 1%); puede NO ejecutarse si el mercado atraviesa la banda"*. Sin "cierre garantizado".
   Archivos: modal Protección/IL en `src/`, `AdminPanel` (campo buffer), `runbook-beta-mainnet.md`.

---

## Fix #2 (Crítico, reescrito) — Nocional reservado ≥ fill real (Long y Short)

**Problema (Codex #1):** la entrada IOC se llena a un precio entre el mark y el límite. Para un
**Short** (venta), `entryLimitPx = mark*(1−2%)` es el precio MÍNIMO y el fill real es MAYOR →
dimensionar con él **sobredimensiona** y el nocional puede superar `tradeAmount`. La cota para
reservar debe ser el **techo** de precio de fill, no el límite de la orden.

**Asimetría Long/Short (Codex rev.2 #1):** para un **Long** (compra IOC) el `orderLimitPx`
(`mark*(1+slip)`) es un **techo duro** de precio → `size*orderLimitPx` acota el nocional
con garantía matemática. Para un **Short** (venta IOC) el `orderLimitPx` (`mark*(1−slip)`) es un
**suelo**, no acota por arriba: el fill ocurre contra el mejor bid (≈mark). Por tanto en Short
`mark*(1+slip)` es una **estimación conservadora, NO una garantía**; un spike alcista entre el
snapshot de `markPx` y el fill podría superarla. Se asume el residuo porque (a) la prueba es a
$15 (muy por debajo de límites reales), (b) el bid ≈ mark salvo spike sub-segundo, y (c) el
`MARGIN_SAFETY_BUFFER=0.10` (en `executions.ts`, **se conserva**) da colchón en el margen. El plan
NO afirma garantía para Short.

**Cambios (en `executePerpMarketOrder`), separando dos precios:**
1. `orderLimitPx` (precio enviado a HL): Long `markPx*(1+ENTRY_IOC_SLIPPAGE)`,
   Short `markPx*(1−ENTRY_IOC_SLIPPAGE)`.
2. `notionalCapPx` = `markPx*(1+ENTRY_IOC_SLIPPAGE)` para AMBOS lados (techo p/ dimensionar/reservar).
3. **Redondeo dirigido (Codex rev.2 #2):** `formatHlPrice` redondea al más cercano y puede bajar
   el cap → subreserva. Implementar un redondeo **hacia ARRIBA al tick** para `notionalCapPx`
   (helper `ceilHlPrice`/sumar 1 tick tras formatear) y volver a `Number` ANTES de dimensionar.
   `orderLimitPx` se formatea normal (debe seguir cruzando).
4. `size = floorToDecimals(args.tradeAmount / notionalCapPxCeil, szDecimals)`.
5. `reservedNotional = size * notionalCapPxCeil`. `marginRequired = reservedNotional / appliedLeverage`.
6. La reserva y los límites por orden/día se evalúan contra `reservedNotional`.
7. La orden de entrada usa `orderLimitPx` formateado (Long arriba, Short abajo) — NO el cap.
8. Actualizar el comentario "Precio server-side / nocional efectivo": ahora es techo worst-case
   (garantía dura solo en Long; estimación conservadora en Short).

**Pruebas (Codex #2, #9):** Long y Short, precios pequeños, varios `szDecimals`; casos donde
`formatHlPrice` redondearía hacia abajo → verificar que `ceilHlPrice` mantiene la cota.

---

## Fix #4 (reescrito) — `waitingForTrigger` sin inventar OID ni recursión

**Problema (Codex #3,#4,#5):** `placeStopLoss` solo acepta `resting`/`filled`. Si HL devuelve la
aceptación del trigger, hoy cae en "ambigua" → `sl_failed` falso. Pero (a) en
`@nktkas/hyperliquid` 0.32.2 es el **literal string `"waitingForTrigger"`**, NO un objeto con
`oid`; (b) NO se puede llamar a `reconcileExecution` recursivamente (el lease ya está tomado →
deadlock); (c) `triggered` ≠ protegido (disparada y esperando ejecución; con banda 1% puede no
llenar).

**Cambios:**
1. `placeStopLoss`: resultado discriminado. `resting`(oid) → SL colocado pendiente de trigger;
   `filled`(oid) → cerrado; `status === "waitingForTrigger"` (literal, SIN oid) →
   `pending_confirmation`; `error` → throw. NO inventar oid, NO marcar `protected`.
2. **SIN sondeo local (Codex rev.2 #10):** el sondeo dentro de la action podría exceder el lease
   (envío hasta 30s + lease 60s) y dejar que otro reconciliador tome el claim. En su lugar: ante
   `pending_confirmation`, **marcar `slSubmittedAt`** y dejar el estado en `entry_filled`; la
   confirmación la hace el **cron→reconcileExecution** por CLOID (re-claim limpio, idempotente).
3. **Marcador anti-doble-SL (nuevo campo `slSubmittedAt` en `execution_requests`):** cuando
   `placeStopLoss` devuelve `resting`/`waitingForTrigger`, persistir `slSubmittedAt`. En
   `reconcileExecution`, si `orderStatus(slCloid)` devuelve `unknownOid` PERO `slSubmittedAt` está
   puesto y dentro de un grace (reutilizar patrón `submittedAt`/grace de la entrada), tratarlo como
   **pendiente** (lag), NO recolocar — evita un SEGUNDO SL en la ventana de lag. Solo recolocar
   (rotar CLOID) si `unknownOid` sin `slSubmittedAt`, o en estado terminal explícito.
4. `reconcileExecution` — mapeo de `orderStatus.order.status` (Codex rev.2 #11: `waitingForTrigger`
   NO aparece aquí, solo en la respuesta de `exchange.order`; los estados de `orderStatus` son
   `open`/`triggered`/`filled`/terminales/`unknownOid`):
   - `open` → `protected` (único estado de trigger resting).
   - `filled` → `closed`.
   - `triggered` → **NO** `protected`: salida pendiente (disparado, sin llenar aún); mantener
     reconciliable con observabilidad explícita.
   - `canceled`/`rejected`/terminal sin fill → rotar CLOID (`prepareSlRetry`) **solo** en terminal.
   - `unknownOid` → ver punto 3 (grace si `slSubmittedAt`, si no recolocar).
5. Verificar la forma exacta del status en la doc del SDK 0.32.2 antes de codificar.

---

## Pruebas obligatorias antes de capital real (Codex #9)

Tests con SDK simulado (mock de `exchange.order`/`info.orderStatus`):
- `waitingForTrigger → open → protected` (sin doble SL).
- timeout tras aceptación → queda `entry_filled`, el cron reconcilia sin colocar 2º SL.
- `triggered → filled` (closed) y `triggered → canceled/rejected` (rota CLOID).
- rotación de CLOID **solo** tras estado terminal.
- pérdida de lease antes del envío (no envía).
- nocional Long/Short tras redondear precios → `size*fillPx ≤ tradeAmount`.

## Verificación en vivo (prueba mínima real, tras los tests)
Límites admin **$15/orden, $50/día**. Por API (`orderStatus`/`frontendOpenOrders`/`userFills`):
1. Entrada IOC se llena (`entry_filled`), `filledSize*avgPx ≤ $15`.
2. SL stop-market aparece en HL como orden trigger reduceOnly (`open` → `protected`).
3. Estado final `protected` + SL activo visible en HL.
→ Desbloquea JAV-44.

## Riesgos / notas
- HL solo acepta leverage entero (ya manejado, `appliedLeverage`).
- Banda 1% = slippage MÁXIMO aceptado; en un gap > 1% el SL puede NO llenar (riesgo aceptado).
- No tocar la lógica de claim/lease/fencing/CLOID de `reconcileExecution` (auditada y segura).
