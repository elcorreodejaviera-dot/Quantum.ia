# Re-auditoría de CÓDIGO — JAV-107 Fase 3c-3c r4 (cierre del bloqueante r3)

Eres un auditor senior de código money-path en Hyperliquid. Re-audita el **working tree actual** de la
rama `feat/jav107-spot-defense` (checkout hecho). Emite **GO / NO-GO** por hallazgo con severidad. No
reescribas el código. Base original auditada: commit `ab20e53`; fixes posteriores SIN commitear sobre
`convex/schema.ts`, `convex/spotDefenseBots.ts`, `convex/spotDefenseEngine.ts`, `tests/spotDefenseBackend.test.ts`.

## Historial de veredictos

- NO-GO original (6 hallazgos): drift vs eventual-consistency, `expected==0` apaga drift, falta Σ`closePct`≤100,
  reconciliación de TPs contra HL, recovery/idempotencia del envío, TPs sin SL confirmado. **Todos corregidos.**
- NO-GO r2 (3 hallazgos): grace a cualquier intento enviado, limpiar `submittedAt`/`oid` en pre-record de
  intento nuevo, `slProtected` solo `resting`. **Todos corregidos.**
- NO-GO r3 (1 hallazgo, ÚNICO pendiente): **crash post-RPC / pre-`markSubmitted`** deja un TP `pending` sin
  `submittedAt` → sin grace anti-rotación → riesgo de 2º TP del mismo `tpIndex`.

## Fix del bloqueante r3 a auditar

1. **Nuevo campo `schema.ts:764` `preparedAt: v.optional(v.number())`** en `spot_defense_orders`.
2. **`recordSpotDefenseTpOrder` (`spotDefenseBots.ts:803-816`):** en el upsert/insert ahora fija
   `submittedAt = markSubmitted ? now : undefined` y `preparedAt = markSubmitted ? undefined : now`. Es
   decir: el PREPARE pre-RPC (sin `markSubmitted`) **ancla `preparedAt = now`**; el envío confirmado
   (`markSubmitted`) pone `submittedAt` y **limpia `preparedAt`**. (Sigue limpiando `oid` viejo si el
   nuevo no viene — fix r2 #2.)
3. **Engine (`spotDefenseEngine.ts:564-571`):** el grace anti-rotación de un TP que salió del book usa
   ahora `recoveryAt = existing.submittedAt ?? existing.preparedAt`; si `recoveryAt != null` y
   `Date.now() - recoveryAt <= SL_SUBMIT_GRACE_MS` → `continue` (NO rota el cloid). Cubre el crash entre
   `exchange.order` y el record con `submittedAt`: la fila queda `pending` sin `submittedAt` pero CON
   `preparedAt`, así que el grace cubre la ventana y no se coloca un 2º TP del índice. La rama `triggered`
   (salió del book, `userFills` aún no refleja) sigue haciendo `continue` sin recolocar.

## Test de regresión añadido (ver más abajo la nota de arquitectura)

- `(Codex 3c-3c r3) pre-record PREPARADO marca preparedAt ...`: PREPARE pre-RPC fija `preparedAt` y deja
  `submittedAt` vacío; el envío `markSubmitted` lo supersede y limpia `preparedAt`. Asserts explícitos del
  selector del engine `recoveryAt = submittedAt ?? preparedAt` resolviendo a `preparedAt` (prepared) y a
  `submittedAt` (enviado).
- `(Codex 3c-3c r3) rotación a intento nuevo tras crash re-ancla preparedAt y limpia submittedAt/oid viejos`:
  intento 0 enviado → pre-record del intento 1 (PREPARADO) re-ancla `preparedAt`, no hereda
  `submittedAt`/`oid` del intento 0, `attempt==1`, y `recoveryAt` resuelve al `preparedAt` del intento 1.

### Nota de arquitectura del test (por qué NO hay test de la action)

El harness `tests/convexHarness.ts` carga una **allowlist EXACTA mutation-safe** y **excluye a propósito**
`spotDefenseEngine.ts` (action "use node": scheduler/RPC fuera de alcance, decisión documentada de Fase 4
PR2). Por diseño NINGÚN test ejecuta la action `reconcileSpotDefenseArm`; toda la suite valida los
building blocks a nivel de mutación. Por eso el "test engine-level" pedido en r3 se cubre a nivel de DATOS:
los tests blindan que el ancla del grace (`preparedAt`) queda correctamente poblada/limpiada en cada
transición, que es exactamente el input del que depende `recoveryAt` para NO rotar. Si consideras esto
insuficiente, indica qué cobertura adicional es factible SIN cargar actions en el harness.

## Preguntas que la re-auditoría debe responder

1. **¿Cierra el fix la ventana r3?** Con `recoveryAt = submittedAt ?? preparedAt`, un TP `pending`
   pre-RPC (crash antes de `markSubmitted`) ¿queda SIEMPRE cubierto por el grace antes de rotar el cloid?
   ¿Hay algún camino que llegue al `exchange.order` SIN haber fijado `preparedAt` antes?
2. **Supersesión limpia:** ¿`preparedAt` se limpia SIEMPRE al confirmar envío (`markSubmitted`) para no
   dejar dos anclas? ¿Algún patch parcial que mantenga `preparedAt` stale junto a `submittedAt`?
3. **Grace suficiente:** ¿`SL_SUBMIT_GRACE_MS` es ventana adecuada para que `openByCloid`/`fills`/
   `orderStatus` reflejen el TP enviado en esa ventana antes de declararlo muerto estable?
4. **Sin regresión en los fixes previos** (drift confirm grace, `expected<=dust`, Σ`closePct`, `slProtected`
   resting, TransportError→pending, limpieza `oid`): ¿el fix r3 los respeta?
5. **TS2589 / secretos:** ¿la cascada de tipos sigue intacta y ningún log nuevo filtra payload sensible?

Verde actual: `npm run typecheck` EXIT 0, `npm test` **243/243**.
Devuelve: hallazgos (severidad + fix) y veredicto **GO / NO-GO** para 3c-3c r4.
