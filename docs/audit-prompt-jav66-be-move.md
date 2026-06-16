# Prompt de auditoría de PLAN — JAV-66 (mover SL a break-even) — re-auditoría rev.3

> Pega esto a Codex junto con `docs/plan-jav-be-move.md` (**rev.3**) y el código de
> `convex/triggerEngine.ts`, `convex/triggerArms.ts`, `convex/hyperliquid.ts`,
> `convex/schema.ts`, `convex/bots.ts`. **Auditas el PLAN, no hay código nuevo todavía.**

## Re-auditoría: verificar que rev.3 cierra los hallazgos de la ronda 2

Las rondas 1 y 2 dieron **NO-GO**. Confirma que la §0 + §3 de rev.3 resuelven la ronda 2:
- **H1 r2 (ALTO) — el guard anti-auto-disparo rompía el SL inicial/resize cuando el trigger ya está
  cruzado** (hoy `filled` = protección inmediata, `triggerEngine.ts:743`). → rev.3 **acota el guard al
  BE y a la ACTIVACIÓN** (§3.3/§3.4.A): no se cancela el SL viejo (+1%) hasta que `beTrigger > markPx +
  tick`; el SL inicial/resize conservan el manejo actual (`filled`/escalado). ¿Queda algún camino del
  guard que deje la posición sin SL? ¿El SL inicial con trigger cruzado sigue protegiendo?
- **H2 r2 (MEDIO) — rama `slOrder == null` subespecificada** → §3.4.B la define: sin SL, saltar pruebas
  del previo e ir directo a `prepareSlAttempt`/place. ¿Falta algún paso (renew, mark)?
- **H3 r2 (MEDIO) — `protected` con SL ausente/desactualizado no debe ir a TPs** → §3.4.B introduce
  `slReady`; TPs solo en el fall-through con SL `open` confirmado en `{size, trigger}` deseado. ¿Hay
  algún camino que llegue a TPs sin SL sano?
- **H4 r2 (BAJO) — vocabulario** → §3.6 BE inválido no usa `[blocked_config]` (no bloquea armado),
  solo warning + BE off. ¿Correcto?
- **H5 r2 (BAJO)** — este prompt (punto 7) ya no menciona `breakevenPct < stopLossPct`.

También sigue vigente la verificación de la ronda 1 (latch `beMoved` no one-shot; BE fallido se
reintenta/escala). Si algún fix es incompleto o introduce un problema nuevo, NO-GO con el hallazgo. Si
todos cierran y no hay nuevos, evalúa los puntos generales de abajo y emite GO/NO-GO.

---

## Contexto

Quantum.ia es un portal de cobertura de IL en Hyperliquid (mainnet, capital real). El motor
automático (JAV-44) vive en `convex/triggerEngine.ts:reconcileArm` (cron, con lease/fencing por
token). Al llenarse una entrada SHORT coloca un SL stop-market reduceOnly a `entry +stopLossPct%`
(+1%) y TPs parciales sobre un búfer. Hay un campo de bot `breakevenPct` (default 0.5%) que la UI
guarda pero **el motor ignora** (verificado: cero referencias en el backend). Este plan lo cablea:
al alcanzar `breakevenPct` de ganancia, reubicar el SL a break-even (entrada). Debe aplicar a la
entrada superior **y** a la re-entrada inferior (ambas SHORT).

El plan está en `docs/plan-jav-be-move.md`. **No apruebes (GO) si encuentras cualquier camino que
deje la posición sin protección, coloque un 2º SL, libere/duplique margen, rompa el fencing, o
introduzca regresión en el flujo actual.** Devuelve GO / NO-GO con hallazgos numerados por severidad.

## Invariantes del proyecto que el plan NO puede violar (de CLAUDE.md)

- Nunca declarar un arm `closed` si un CLOID de HL puede seguir vivo.
- `protected` no es final; la posición puede seguir abierta con el SL en el book.
- Auto-rearm usa leases/fencing — no quitar los chequeos de token.
- La contabilidad de margen incluye ejecuciones legacy + trigger arms.
- `leverage.ts` es la única fuente de leverage/margen.
- Testnet/mainnet explícito y consistente (cliente desde `arm.network`, no `HL_NETWORK` actual).

## Puntos críticos a verificar (mínimo)

1. **Anti-doble-SL.** El bloque de activación BE reusa el patrón de la redimensión 2.4
   (cancelar SL viejo → confirmar muerte por CLOID el siguiente ciclo → recién entonces colocar el
   nuevo). ¿Hay ALGÚN camino donde se coloque el SL de BE sin haber confirmado muerto el SL previo?
   ¿`fillsByCloid`/`openByCloid`/`orderStatus` se usan igual que en 2.4? ¿La idempotencia por CLOID
   (`prepareSlAttempt` rota cloid) impide un 2º SL si HL aceptó pero se perdió la respuesta?

2. **Ventana sin SL.** Entre cancelar el SL viejo y colocar el de BE hay ~1 ciclo de cron (≤1 min)
   sin SL en el book. ¿Es aceptable dado que (a) es el mismo riesgo ya aceptado por 2.4, (b) el
   cierre de emergencia por `protectDeadline`/`SL_MAX_ATTEMPTS` sigue como red, y (c) la posición
   está en ganancia ≥ breakevenPct cuando esto ocurre? ¿Propondrías un orden que reduzca la ventana?

3. **Latch one-way `beMoved`.** ¿`markArmBeMoved` (CAS + token) se fija ANTES de colocar el SL de BE
   (como `markEmergencyClosing`), y se aborta si la mutación falla? ¿Puede quedar `beMoved=true` con
   el SL de BE NO colocado (posición protegida solo por el viejo ya cancelado)? ¿Puede oscilar
   (volver a +1%)? ¿Qué pasa si se pierde el lease entre fijar el latch y colocar?

4. **Coherencia con la redimensión 2.4 y el SL inicial.** El plan dice que, si `beMoved` ya es true
   y luego crece el `szi` (2ª pata en reentry_coexist), la redimensión recoloca el SL full-size **en
   BE** (no en +1%) vía `slOverride`. Verifica: ¿el `slOverride` se recalcula sobre el `posEntryPx`
   VIGENTE (nuevo entry medio si hubo doble-fill)? ¿Las 3 colocaciones de SL (inicial ~565, resize,
   bloque BE) usan la MISMA fuente de trigger? ¿Hay riesgo de que tras un resize el SL quede en +1%
   y nunca vuelva a BE (latch sin re-aplicar)?

5. **Simetría arriba/abajo.** El plan ubica la lógica en la fase de posición, que opera sobre la
   posición real (`szi`, `posEntryPx`). ¿Es correcto que esto cubre AMBOS bordes sin ramas separadas
   porque las dos patas son SHORT? ¿Funciona también para el short que abre `entry_lower` tras
   `armed_lower_only` (¿ese short pasa por la misma fase de posición con su propio `posEntryPx`?)?
   ¿Hay algún estado (`armed_lower_only`, doble-fill) donde el gate `status==="protected"` no se
   cumpla y el BE no se active cuando debería, o se active sobre la posición equivocada?

6. **Condición de activación.** `assetMeta.markPx <= posEntryPx*(1 - breakevenPct/100)` para Short.
   ¿`assetMeta.markPx` es fresco cada ciclo (`getAssetMeta` línea 388)? ¿Debería usarse mark, o el
   `entryPx`/`unrealizedPnl` de la posición, para evitar que un mark momentáneo dispare el BE
   demasiado pronto? ¿Conviene exigir doble lectura (como el cierre) antes de mover, o el latch +
   confirmar-antes-de-rotar ya lo hace robusto?

7. **Restricciones numéricas.** `BE_OFFSET_FRACTION < breakevenPct/100` (si no, el trigger de BE
   quedaría ≤ mark al activarse y dispararía al instante). `breakevenPct > 0 && ≤ 50` (tope sano,
   **desacoplado de `stopLossPct`** — son ejes distintos: umbral de ganancia vs distancia del SL).
   ¿El plan valida en `bots.ts` (no bloqueante) Y desactiva BE al snapshotear si inválido? ¿Qué pasa
   con arms/bots legacy sin `breakevenPct` (BE desactivado, comportamiento actual intacto)? ¿El
   redondeo al tick (`roundHlPrice`) del trigger de BE puede empujarlo por debajo del mark y
   auto-dispararlo (cubierto por el guard `> markPx + tick` de §3.3)?

8. **No romper el flujo actual.** `placeStopLoss` gana `triggerPxOverride?` opcional; sin override
   debe ser byte-idéntico al comportamiento actual. ¿El plan garantiza cero cambio cuando
   `breakevenPct` está ausente? ¿El SL de BE sigue siendo reduceOnly full-size (no cierra de más)?

9. **Interacción con auto-rearm / whipsaw.** Si tras mover a BE el precio retrocede y toca el
   SL-en-BE, es un cierre `closeReason="sl"` → cuenta como stop y rearma. ¿Es correcto que un
   stop-a-break-even (~$0 de pérdida) cuente igual que un stop con pérdida para el contador de
   whipsaw / `consecutiveStops` / email? ¿O debería distinguirse? (señalar, no bloqueante).

10. **Snapshot y deploy.** Los 2 campos nuevos en `trigger_arms` son opcionales (legacy-safe) y
    requieren `deploy` (type-check real, no solo codegen). ¿Algún índice afectado? ¿`reserveArm`
    es el sitio correcto para snapshotear `breakevenPct` (mismo punto que `stopLossPct`)?

## Entregable

GO / NO-GO + hallazgos numerados (severidad ALTO/MEDIO/BAJO), con archivo:línea cuando aplique y la
corrección concreta sugerida para el plan. Si el diseño converge pero quedan residuales, lístalos
para una rev.2 del plan.
