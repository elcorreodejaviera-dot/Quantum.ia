# JAV-107 Fase 3c-3c - Reauditoria Codex - NO-GO r3

Claude: repara el hallazgo restante sobre el working tree actual en `feat/jav107-spot-defense`.

Contexto:
- Base auditada original: `ab20e53`
- Reauditoria r3: fixes no commiteados sobre `convex/schema.ts`, `convex/spotDefenseBots.ts`, `convex/spotDefenseEngine.ts`, `tests/spotDefenseBackend.test.ts`
- Verificacion local: `npm run typecheck` OK; `npm test` OK (`241/241`).
- Los hallazgos de r2 quedaron encaminados/corregidos, pero queda una ventana money-path de recovery.

## Bloqueante

1. MEDIO - Crash despues de enviar TP pero antes de `markSubmitted` puede causar recolocacion prematura.
- Flujo actual:
  - `convex/spotDefenseEngine.ts:584-587`: pre-record TP `pending` SIN `submittedAt`.
  - `convex/spotDefenseEngine.ts:590-599`: se envia `exchange.order` y solo despues se guarda `markSubmitted`.
  - `convex/spotDefenseEngine.ts:564-568`: el grace anti-recolocacion aplica solo si `existing.submittedAt != null`.
- Si el proceso cae despues de que HL recibe/acepta el TP pero antes de ejecutar el record con `markSubmitted`, la fila queda `pending` sin `submittedAt`.
- En el siguiente ciclo se consulta `orderStatus/openByCloid/fills`, pero si HL aun no refleja el cloid por lag, no hay grace porque `submittedAt` es null; el motor puede marcar muerto el intento y recolocar con un cloid nuevo.
- Riesgo: dos TPs para el mismo `tpIndex` si el intento original aparece o llena despues.
- Fix esperado: introducir un marcador/grace de intento preparado antes del RPC (por ejemplo `preparedAt` o reutilizar `submittedAt` con un estado distinto), o guardar un `sendAttemptStartedAt` antes de `exchange.order` para que un `pending` pre-RPC tenga una ventana de recovery antes de rotar. Alternativa: para `pending` sin `submittedAt`, no recolocar hasta pasado un grace estable y dos lecturas negativas por cloid.

## Checks esperados

- Agregar regression test para:
  1. TP queda `pending` sin `submittedAt` con cloid del intento 0, simulando crash post-RPC/pre-record.
  2. `orderStatus`, `openByCloid` y `fillsByCloid` todavia no lo reflejan en el primer ciclo.
  3. El motor NO rota a attempt 1 hasta pasar el grace/prueba negativa estable.
- Reejecutar `npm run typecheck`.
- Reejecutar `npm test`.

Resultado final: **NO-GO**.
