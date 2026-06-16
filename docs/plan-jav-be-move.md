# Plan — Mover el SL a break-even en el motor automático (BE tras `breakevenPct`) — rev.3

**Motor:** JAV-44 (`convex/triggerEngine.ts` `reconcileArm`, fase de posición) · **Issue:** JAV-66
**Tipo:** mejora de seguridad de capital (money-path) — feature configurada pero **sin cablear**
**Estado:** rev.3 tras **NO-GO ronda 2** (5 hallazgos). Para re-auditoría de plan. Sin implementar.

---

## 0. Cambios rev.3 (respuesta a la auditoría ronda 2)

- **H1 (ALTO) — el guard anti-auto-disparo rompía el SL inicial/resize cuando el trigger ya está
  cruzado.** Hoy, si al proteger un short el mark ya superó el trigger, `placeStopLoss` devuelve
  `filled` = protección inmediata (`triggerEngine.ts:743`, `sl_fired_immediately`). Un "skip/retry"
  ahí dejaría la posición sin SL. **Fix rev.3:** el guard H4 **NO** aplica al SL inicial ni al resize
  (se conserva el manejo actual de `filled`/escalado). El guard aplica **solo al BE y en la ACTIVACIÓN**
  (gate previo a cancelar el SL viejo): no se cancela el SL de +1% hasta saber que el trigger de BE es
  colocable (`> markPx + tick`). Tras cancelar, la colocación de BE usa el manejo existente
  (`filled` = salida a break-even = correcto). Así **nunca** hay un camino "sin SL" por el guard.
- **H2 (MEDIO) — rama `slOrder == null` subespecificada.** §3.4 la define explícita: si no hay SL,
  saltar las pruebas del SL previo (no `fillsByCloid`/`openByCloid`/`canceled`), ir directo a
  `prepareSlAttempt(triggerPx)` → renew → place → mark. (Es el mismo camino que hoy ya cubre "no order,
  nunca enviado, o confirmado muerto" en `triggerEngine.ts:728`.)
- **H3 (MEDIO) — `protected` con SL ausente/desactualizado no debe avanzar a TPs.** §3.4 introduce
  `slReady`: el mantenimiento **retorna** en todo camino que no deje un SL vivo confirmado en
  `{size=realSize, trigger=desiredTrigger}`. Los TPs corren **solo** en el fall-through (SL sano).
- **H4 (BAJO) — vocabulario de validación.** BE inválido al armar **no** usa el kind bloqueante
  `[blocked_config]`: no se setea `arm.breakevenPct` (BE off) + warning observable; el armado sigue.
- **H5 (BAJO) — prompt de re-auditoría con texto viejo.** `audit-prompt-jav66-be-move.md` punto 7
  corregido (sin `breakevenPct < stopLossPct`).

## 1. Problema

El bot tiene `breakevenPct` (UI "Breakeven — % ganancia para mover SL a entrada", default 0.5%,
`schema.ts:108`, guardado en `bots.ts:200`) pero **el motor lo ignora** (cero referencias en
`triggerEngine.ts`/`hyperliquid.ts`). El SL se coloca siempre a `entry +stopLossPct%` (+1%) y nunca se
reubica. Objetivo: al alcanzar `breakevenPct` de **ganancia**, reubicar el SL a break-even (entrada).

## 2. Alcance

- ✅ **Motor automático** (`trigger_arms`/`triggerEngine.ts`), fase de posición. **Ambos bordes** (las
  dos patas son SHORT → mismo código cubre entrada superior y re-entrada inferior, incluido el short de
  `entry_lower` tras `armed_lower_only`).
- ❌ **Fuera de alcance:** motor manual/legacy (`hyperliquid.ts:executePerpMarketOrder`).

## 3. Diseño

### 3.1 Schema (`trigger_arms`) — 2 campos nuevos, legacy-safe
```ts
breakevenPct: v.optional(v.number()),   // snapshot del bot (% ganancia que activa el BE)
beMoved: v.optional(v.boolean()),        // latch one-way: el BE ya se ACTIVÓ (cambia el trigger deseado)
```
Requiere `deploy`. Legacy sin estos campos → BE desactivado (comportamiento actual intacto).

### 3.2 Snapshot + persistir triggerPx
- `reserveArm`: copiar `bot.breakevenPct` → `arm.breakevenPct` si válido (§3.6); si no, no setear.
- **`prepareSlAttempt` gana `triggerPx: v.optional(v.number())`** y lo persiste en `sl_upper` (hoy se
  crea/patchea con `triggerPx: 0`, `triggerArms.ts:855/858`). Las **tres** colocaciones (inicial,
  resize, BE) pasan el trigger efectivo → la fila refleja el nivel real del SL vigente.

### 3.3 Trigger deseado del SL (helper único) + guard anti-auto-disparo (acotado)
```ts
const BE_TICK = tickFromSzDecimals(szDecimals);   // 1 tick HL
const beTrigger = roundHlPrice(posEntryPx * (1 - BE_OFFSET_FRACTION), szDecimals, "floor");
const desiredTrigger = arm.beMoved
  ? beTrigger
  : roundHlPrice(posEntryPx * (1 + arm.stopLossPct / 100), szDecimals, "floor");
```
- `BE_OFFSET_FRACTION` (constante): 0 = entrada exacta; pequeño colchón (≈0.0005–0.001) para fees.
  Restricción: `BE_OFFSET_FRACTION < breakevenPct/100`.
- **Guard H4 — acotado al BE, en la activación (§3.4.A):** la activación del BE exige
  `beTrigger > markPx + BE_TICK`. Como al activarse `markPx ≤ entry·(1−breakevenPct/100)` y
  `beTrigger ≈ entry`, normalmente se cumple; si NO (mark ya cerca de entry), **no se activa** este
  ciclo → el SL viejo (+1%) sigue protegiendo, se reintenta. **El SL inicial y el resize NO llevan este
  guard:** conservan el manejo actual (trigger cruzado → `placeStopLoss` devuelve `filled` =
  protección inmediata; escalado por `slAttempts`/`protectDeadline`).

### 3.4 Mantenimiento del SL en la fase de posición (integra resize + BE + recuperación)
Con `status ∈ {filled, protecting, protected}`, **no flat**, **no** emergencia:

**A) Activación del BE (solo flip del latch, no cancela nada):**
```text
si status==="protected" && !beMoved && breakevenPct válido
   && markPx <= posEntryPx*(1 - breakevenPct/100)        // ganancia alcanzada
   && beTrigger > markPx + BE_TICK:                       // guard H4 (SL viejo aún vivo)
   → markArmBeMoved (CAS+token).  Si falla (lease) → return (SL viejo intacto, reintenta).
```
Tras esto `desiredTrigger` ya es el de BE; el SL viejo (+1%) sigue vivo y se rota abajo.

**B) Salud del SL y (re)colocación unificada.** `slOrder = getArmOrderByRole(sl_upper)`:
```text
slHealthy = slOrder existe
            && slOrder.observedStatus ∈ {open}           // vivo en book
            && slOrder.size >= realSize*0.99              // cubre el tamaño real (resize)
            && |slOrder.triggerPx - desiredTrigger| <= BE_TICK   // en el nivel deseado (BE vs +1%)
si slHealthy: slReady = true  → caer a §3.5 (TPs).
si NO slHealthy → (re)colocar y RETORNAR (nunca caer a TPs sin SL sano):
  // Caso slOrder != null: confirmar estado del SL previo (patrón actual)
  - fillsByCloid>0 → setArmOrderObserved filled → return (flat lo cierra)
  - openByCloid vivo PERO size/trigger != deseado → renew → cancelByCloid → return "sl_replace_cancel_sent"
    (confirmar muerte el próximo ciclo; nunca 2 SL vivos)
  - no vivo, sin fills, dentro de SL_SUBMIT_GRACE_MS desde slSubmittedAt → return "sl_submit_grace"
  - grace vencido + prueba negativa → setArmOrderObserved canceled  (→ sigue a colocar)
  // Caso slOrder == null (H2): saltar TODO lo anterior, ir directo a colocar
  // Colocar nuevo intento (slOrder==null o confirmado muerto):
  - slAttempts >= SL_MAX_ATTEMPTS → return (escala a emergencia)
  - si status==="filled" → settleArm "protecting"
  - prepareSlAttempt(size=realSize, triggerPx=desiredTrigger) → renew
  - placeStopLoss(..., realSize, posEntryPx, stopLossPct, cloid, triggerPxOverride=desiredTrigger)
      · resting → setArmOrderObserved open + markArmSlSubmitted + settleArm protected → return
      · filled  → setArmOrderObserved filled + markArmSlSubmitted → return ("sl_fired_immediately")
      · pending → markArmSlSubmitted → return
      · catch (rechazo definitivo) → return (slAttempts ya subió; deadline/max → emergencia)
```
Esto **subsume** el bloque resize 2.4 y el SL inicial en una rutina única con una sola fuente de
trigger (`desiredTrigger`) y el escalado existente. `beMoved` solo cambia `desiredTrigger`; el SL de BE
fallido se reintenta como cualquier SL y escala a emergencia (cierra H1 ronda 1).

### 3.5 TPs — solo si `slReady`
Los TPs (lógica actual 2.5) corren **únicamente** en el fall-through de §3.4.B (SL sano confirmado
`open` en `{size, trigger}` deseado). Sin cambios en tamaños/triggers de TPs.

### 3.6 Validación — desacoplada, no bloqueante
- `bots.ts`: `breakevenPct` finito + **`> 0`** + tope sano **`≤ 50`** (extender el loop 220-224). **NO**
  acoplar a `stopLossPct`.
- Al snapshotear en `reserveArm`: si `breakevenPct` inválido o `BE_OFFSET_FRACTION ≥ breakevenPct/100`
  → **no setear `arm.breakevenPct`** (BE off) + `console.warn` observable. **No** usar el kind
  `[blocked_config]` (no bloquea el armado). El motor opera como hoy.

### 3.7 Whipsaw / auto-rearm — decisión explícita
SL-en-BE tocado = `closeReason="sl"` → rearma (igual que hoy, `triggerArms.ts:612`). Aceptado en rev.3;
anotado `closeReason="breakeven_sl"` como mejora futura (no inflar `consecutiveStops`/email).

## 4. Archivos a tocar
- `convex/schema.ts` — 2 campos en `trigger_arms` (+ deploy).
- `convex/triggerArms.ts` — snapshot `breakevenPct`; `prepareSlAttempt(triggerPx)`; `markArmBeMoved`.
- `convex/triggerEngine.ts` — mantenimiento unificado del SL (§3.4) + activación BE + `desiredTrigger`
  + guard H4 acotado; refactor de las 3 colocaciones a la rutina única; TPs gateados por `slReady`.
- `convex/hyperliquid.ts` — `placeStopLoss` gana `triggerPxOverride?: number` (sin override = idéntico).
- `convex/bots.ts` — validación `breakevenPct > 0 && ≤ 50` (sin acoplar a stopLossPct).

## 5. Verificación
- `npm run typecheck` + `deploy` (toca schema).
- Prueba real mainnet (sin mocks): al tocar +`breakevenPct` el SL salta de entry+1% a BE; **repetir
  perforando el borde inferior** (simetría). Validar recuperación: forzar fallo de colocación BE → el
  SL se recoloca o escala a emergencia, nunca queda `beMoved=true` sin SL. Validar que un trigger
  cruzado en SL inicial sigue protegiendo (`filled`) — no regresión por el guard.
- Comparar con el portal del amigo (`0xb5A7…3701`): confirmar que su SL hace lo mismo tras su 0.5%.

## 6. Decisiones para el usuario (antes de implementar)
1. **`BE_OFFSET_FRACTION`:** 0 (BE exacto) vs ≈0.0005–0.001 (colchón fees → BE neto). Recomendado: colchón.
2. **Tope `breakevenPct`:** ¿`≤ 50` ok?
3. **UI:** ¿issue aparte (tipo JAV-62) para mostrar "SL en break-even" cuando `beMoved`?

## 7. Riesgos
- Ventana ≤1 ciclo de cron sin SL al rotar (cancelar→confirmar→recolocar) — **mismo riesgo aceptado**
  por el resize actual; emergencia por `protectDeadline`/`SL_MAX_ATTEMPTS` como red. Con BE además el
  SL viejo (+1%) NO se cancela hasta que el trigger de BE es colocable (guard A) → la ventana solo
  existe tras confirmar que hay a dónde rotar.
- Refactor de las 3 colocaciones a una rutina única: la re-auditoría de **código** debe verificar
  paridad con el comportamiento actual (sin override = idéntico; `filled`/`pending`/escalado iguales).
