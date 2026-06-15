# Spec: Reentry-from-above — re-armar la cobertura por el borde superior

> Para auditar con Codex antes de implementar. Money-path (mainnet, capital real).
> NO implementar/desplegar sin GO. Doble auditoría: Codex (enfoque + código) + CodeRabbit.

## Contexto / por qué

El bot IL "IL ETH Base" (ETH/USDC, rango **1636–1737**, cuenta HL `0x7bbc…add0`) tiene
`allowReentryFromAbove: true`. El 2026-06-15 pasó esto en HL (reconstruido de fills/órdenes):

- **10:54 UTC** — el precio rompió por **arriba** del rango → abrió SHORT 1.1038 ETH @ **1742.4**.
- El precio **siguió subiendo** → a las **11:26** saltó el **Stop Loss** (trigger 1759.8) y cerró
  @ **1761.1** con **−$20.64**. Los dos Take-Profits (1716/1733) se cancelaron por OCO.
- El bot **re-armó solo la pata de abajo** (stop-sell @ 1636) → quedó **sin cobertura por arriba**.

Causa raíz: `convex/triggerEngine.ts:199-203`. La 2ª entrada (borde superior) solo se coloca si
`markPx < upperEdgeNorm` (precio por debajo del borde). Tras el SL el precio quedó por encima de
1737 → `twoEntries = false` → no se repuso la pata de arriba. **Esto es el bug a corregir.**

## Config confirmada (Convex, tabla `bots`)

`active: true`, `allowReentryFromAbove: true`, `autoLeverage: false`, `leverage: 20`,
`stopLossPct: 1`, `bufferPct: 100`, `tps: [{gainPct:0.5, closePct:40}, {gainPct:1.5, closePct:40}]`,
`direction: short`, `kind: il`. (TPs parciales suman 80%; queda 20% sin cerrar.)

## Comportamiento deseado (validado con el usuario — OPCIÓN B: dos patas armadas a la vez)

Cuando `allowReentryFromAbove` y el precio está **por encima** del rango (tesis del usuario: va a
reentrar). **Las DOS entradas quedan armadas simultáneamente desde el inicio** y se activan según
el precio las toque; NO hay cancelación de la hermana ni "rearmar tras TP-final".

1. **Armado inicial:** quedan vivas a la vez:
   - **entry_upper (reentry):** SELL stop en el **borde superior (1737)** que dispara cuando el
     precio **BAJA y reentra** al rango (semántica `tpsl:"sl"`, triggerPx por debajo del mark).
     *(Hoy la pata de arriba dispara al SUBIR `tpsl:"tp"`, correcto solo con el precio DENTRO del
     rango. La novedad es el caso precio-por-encima.)*
   - **entry_lower (perforación):** SELL stop con triggerPx **estrictamente por debajo** de 1636
     (al menos un tick), dispara al perforar el rango hacia abajo.
2. **Reentra → se abre el short de arriba.** La pata de abajo **NO se cancela, sigue armada.**
3. **Vida del short de arriba:** **SL al 1%** (si en vez de reentrar sigue subiendo) + **TP
   parciales** configurados (0.5%/40%, 1.5%/40%).
4. **TP FINAL en el borde inferior (1636):** al llegar al fondo del rango cierra el **remanente**
   del short de arriba → ganancia plena del recorrido. El arm **NO se cierra** por esto: la pata de
   abajo sigue viva en la misma generación.
   - **El tamaño del TP-final es DINÁMICO**, NO un 20% fijo: `TP-final % = 100 − Σ(closePct de los
     TP parciales configurados)`. Ej.: parciales 40%+40% → final 20%; parciales 20%+20% → final 60%;
     parciales 50%+50% → final 0% (no se coloca). En tamaño absoluto: residual = posición real menos
     lo ya cerrado por los parciales (`reduceOnly`, sobre `szi` real). Si Σ closePct ≥ 100 → sin
     TP-final; Σ > 100 = config inválida a rechazar.
5. **Si el precio perfora 1636:** la entry_lower (que seguía armada) **se activa sola** y abre el
   siguiente short. Sin rearmar: ya estaba armada.

### Consecuencia de tamaño/margen

Las dos patas pueden estar vivas a la vez (el usuario lo acepta explícitamente). El motor ya
**reserva 2× worst-case** y coloca el **SL sobre `szi` real** (combinado), así que un doble-fill por
gap rápido es margen-seguro. **NO se debe reducir la reserva 2×→1×** en este flujo (ambas conviven).

## Áreas de código afectadas (a revisar por Codex)

- `convex/triggerEngine.ts`
  - `:199-203` — condición `twoEntries` (quitar/ajustar el gate `markPx < upperEdgeNorm` para el
    caso por-encima; elegir `tpsl` y sentido del disparo según la posición del precio).
  - `:247-279` — colocación de entradas (rol/tpsl/limit por entrada).
  - `:406-411` y `:646-654` — lógica OCO actual: al llenarse una entrada, cancela la hermana
    (`ensureOrdersDead`) y reduce la reserva 2×→1×. Revisar que NO rompa el flujo deseado.
- Colocación de TPs (`placeStopLoss`/equivalente de TP) — añadir el **TP final en el borde
  opuesto (lowerEdge)** que cierra el remanente. Hoy los TP salen del array `tps` (parciales por %
  de ganancia); el TP-final-en-borde es por **nivel de precio absoluto (1636)**, un tipo nuevo.
- `convex/triggerArms.ts` / `triggerRearm.ts` — cierre del arm y rearm: que el TP-final cuente como
  cierre normal (no como SL) y que el rearm reponga el esquema completo.

## Decisiones tomadas tras la auditoría Codex (ronda 1, NO-GO al spec v1)

Codex marcó 3 huecos; resueltos así con el usuario (Opción B):

1. **Doble rol de 1636 → triggerPx distintos.** TP-final dispara **AL llegar a 1636** (triggerPx =
   lowerEdge). entry_lower dispara solo **por debajo** (triggerPx = lowerEdge − ≥1 tick). Nunca el
   mismo precio.
2. **Cierre por TP-final NO requiere rearm.** Como las dos patas están armadas desde el inicio, el
   arm **no se cierra** en el TP-final (la entry_lower sigue viva en la misma generación). Esto
   **elimina el "hueco grande"** de Codex (no hace falta `closeReason:"tp_final"` que rearme).
   ⚠️ Implica: la detección de flat/cierre **no debe cancelar entry_lower** cuando el short de
   arriba se cierra (hoy `ensureOrdersDead(allCloids)` la cancelaría → carve-out necesario).
3. **OCO: NO cancelar la hermana ni reducir 2×→1× en este flujo.** Las dos patas conviven; mantener
   reserva 2× y SL sobre `szi` real. (En el flujo normal in-range sin reentry, el OCO actual se
   mantiene; el cambio es SOLO para `allowReentryFromAbove`.)

## Riesgos que Codex debe re-auditar (ronda 2, sobre Opción B)

1. **Carve-out de cancelación.** Que la lógica de flat/cierre (`triggerEngine.ts:391-446`,
   `ensureOrdersDead`) NO mate entry_lower mientras siga siendo una entrada válida pendiente.
2. **Persistencia de roles/modo.** Hace falta `entry_upper` con su `tpsl` persistido (reentry vs
   breakout) y saber qué entrada llenó (`filledEntryRole`) para colocar el TP-final solo cuando
   abrió la de arriba.
3. **TP-final.** Nuevo role (`tp_final`), `reduceOnly:true`, size = **residual real DINÁMICO** =
   posición real − Σ(parciales ya ejecutados); equivale a `100 − Σ closePct` del bot (varía por
   usuario, NO es 20% fijo). Si Σ closePct ≥ 100 → no colocar TP-final. Persistido en
   `trigger_orders` para que `ensureOrdersDead` lo contemple.
4. **Gap rápido 1737→1636.** Doble-fill antes de reconciliar: confirmar que margen 2× + SL sobre
   `szi` real lo cubren, y que el TP-final no queda huérfano.
5. **Lifecycle del arm.** Con dos patas + posibles dos shorts secuenciales en la MISMA generación:
   cuándo se considera el arm `closed` (solo cuando flat Y sin entradas vivas), y cómo interactúa
   con el rearm durable y `consecutiveStops`/whipsaw (un TP-final no debe contar como SL/stop).

## Modelo y lifecycle de implementación (requerido por Codex ronda 2)

Codex ronda 2: **objetivo correcto, pero NO implementar como parche sobre `twoEntries`** — requiere
cambios de modelo explícitos. Definidos así:

1. **Modo de arm PERSISTIDO** (no inferir de `allowReentryFromAbove`): nuevo campo en `trigger_arms`,
   p.ej. `armMode: "oco" | "reentry_coexist"`. El flujo in-range normal sigue en **`oco`** (cancela
   hermana, reduce 2×→1×, intacto). El flujo reentry-from-above usa **`reentry_coexist`** (NO cancela,
   NO reduce). OCO/reduceReservation se desactivan **solo** en este modo.
2. **Persistir modo/tpsl de entry_upper:** `entryUpperMode: "breakout_up"` (`tpsl:"tp"`, dispara al
   subir) | `"reentry_down"` (`tpsl:"sl"`, dispara al bajar). Define el trigger correcto y su
   semántica al reconciliar.
3. **Persistir `filledEntryRole`** en `trigger_arms`: qué entrada llenó. El TP-final se coloca
   **solo si `filledEntryRole === "entry_upper"`**.
4. **Nuevo role `tp_final`** en `trigger_orders` (hoy `schema.ts:365`: entry_lower|entry_upper|
   sl_upper|tp). `reduceOnly:true`, size residual dinámico (ver fórmula arriba), persistido por
   CLOID, contemplado por `ensureOrdersDead`.
5. **State machine — nuevo estado de transición.** Hoy `protected → {closed, disarming}`
   (`triggerArms.ts:57`). Tras el TP-final, con entry_lower aún viva, el arm NO debe quedar
   `protected`-flat ni cerrarse. Añadir **`armed_lower_only`** (o `waiting_lower_after_upper`):
   - `protected → armed_lower_only` (szi==0 por TP-final/parciales **Y** entry_lower sigue viva).
   - `armed_lower_only → filled` (perfora y llena entry_lower) `→ protecting → protected` (SL del
     nuevo short).
   - `armed_lower_only → {closed, disarming}` (cancela / pausa).
   - **Recomendación: estado dedicado, NO reusar `armed`** (evita que la rama pre-fill "confirmar
     entradas" de `triggerEngine.ts:631` malinterprete el upper ya consumido).
6. **Cerrar el arm solo cuando flat Y sin entradas vivas.** En `reentry_coexist`, la detección de
   flat (`triggerEngine.ts:391-446` / `ensureOrdersDead`) debe **excluir entry_lower viva** del set a
   cancelar y, en vez de cerrar, transicionar a `armed_lower_only`.
7. **TP-final NO cuenta como SL/stop:** no incrementa `consecutiveStops`, no dispara whipsaw, no
   programa rearm. Es un cierre parcial/normal dentro de la misma generación.

## Resolución auditoría de CÓDIGO (Codex NO-GO ronda 1 → aplicado)

| # | Sev | Hallazgo | Fix aplicado |
|---|-----|----------|--------------|
| 1 | P0 | Doble-fill deja parte de la posición sin SL actualizado | En `reentry_coexist`, si `realSize > sl_upper.size·1.02` se cancela el SL y se recoloca full-size (con `realSize`+`posEntryPx` actuales). `triggerEngine.ts` rama "SL open". |
| 2 | P0 | El carve-out flat trataba un SL como TP-final (sin whipsaw/rearm) | `slConfirmed` se evalúa ANTES del carve-out; este solo aplica si `!slConfirmed`. Un cierre por SL cae al cierre normal (cuenta stop + rearma esquema completo). |
| 3 | P0/P1 | `filledEntryRole` no se seteaba en fills inmediatos del armado | Se registra `filledRole` en la rama `anyFilled` de `armBotInternal` (prefiere `entry_upper`) y se llama `setArmFilledEntryRole`. |
| 4 | P1 | TP-final bloqueado si no hay TP parciales / bufferPct≤0 | Ya no se retorna antes; el loop de parciales corre solo si `bufferSize>0` y el flujo sigue al TP-final. |
| 5 | P1 | Regla Σ closePct ≥ 100 no implementada | Se calcula `sumClose`; si `≥ 100` no se coloca tp_final. |
| 6 | P1 | `armed_lower_only` sin entry viva quedaba no-terminal (margen bloqueado) | Confirmar flat + grace → `closeArmLowerOnlyExpired` (cierre limpio "manual" + `rescheduleRearmIfEligible`). |
| 7 | P1 | Offset de perforación quedaba OPEN | Política fijada 0.1%; `reserveArm` exige `entryLowerTriggerPx < lowerEdge` (fail-closed). |

## Resolución auditoría de CÓDIGO (Codex NO-GO ronda 2 → aplicado)

| # | Sev | Hallazgo | Fix aplicado |
|---|-----|----------|--------------|
| 1 | P0 | TP-final podía cerrar el short inferior tras doble-fill | Si `entry_lower` llenó (`observed=filled` o `realSize > arm.size·1.5`) → NO se coloca tp_final y se cancela uno resting. Además `tpfSize = arm.size` (un short), no `realSize`. |
| 2 | P0 | El resize del SL rotaba sin prueba negativa (anti-doble-SL) | Bloque resize 2.4: si el SL viejo sigue vivo → cancelar y CONFIRMAR muerte el próximo ciclo; solo se rota tras prueba negativa (`openByCloid`/`fills`). |
| 3 | P0/P1 | Ventana sin SL tras resize | Una vez confirmado muerto el SL viejo, se recoloca full-size en el MISMO claim/ciclo. |
| 4 | P1 | `armed_lower_only` cerraba aunque `ensureOrdersDead` fallara | Se chequea el booleano: si no confirma muerte de entry_lower → `skipped` y reintenta (no cierra huérfano). |
| 5 | P1 | `closeArmLowerOnlyExpired` no finalizaba pausa | Si `bot.disarmPending` → desactivar + limpiar pausa y NO rearmar (igual que el resto del state machine). |

## Resolución auditoría de CÓDIGO (Codex NO-GO ronda 3 → aplicado)

| # | Sev | Hallazgo | Fix aplicado |
|---|-----|----------|--------------|
| 1 | P0 | Resize SL en bucle: el SL se enviaba con `realSize` pero `trigger_order.size` quedaba en `arm.size` → el guard re-disparaba indefinidamente (churn de SL, consumo de intentos, bloqueo de TPs) | `prepareSlAttempt` acepta `size` y lo PERSISTE (insert y patch); ambos call sites pasan `realSize`. Invariante: tras (re)colocar, `sl_upper.size === realSize` → el resize no vuelve a entrar con el SL abierto. |

## Proceso

Codex ronda 2 = **GO al objetivo, condicionado** a los 7 cambios de modelo de arriba. Falta:
**GO del usuario al modelo** → implementación → `audit-jav61-reentry.diff` → Codex GO de código →
PR → CodeRabbit → GO usuario → merge + `deploy` a mainnet. Mientras tanto el bot está cubierto a la
baja (1636) pero **sin la reentry de arriba**.
