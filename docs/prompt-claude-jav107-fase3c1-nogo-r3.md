# JAV-107 Fase 3c-1 — Reauditoria Codex r3 — NO-GO

Claude: repara el bloqueante restante en `feat/jav107-spot-defense`.

Contexto:
- Commit de fixes auditado: `b81bd06`
- Los 2 bloqueantes de `docs/prompt-claude-jav107-fase3c1-nogo-r2.md` quedaron cerrados:
  - pre-fill ahora confirma `fillsByCloid(entry.cloid)` antes de `disarmed`, y reconfirma despues de cancelar;
  - `sl pending` sin `submittedAt` ya no cuenta como SL vivo, y `markSubmitted` solo se fija tras RPC aceptado/ambiguo.
- Verificacion: `npm run typecheck` OK; focalizados OK (`60/60`); suite completa OK (`229/229`).

## Bloqueante restante

1. ALTO — `slAlive` confia solo en estado local y puede dejar una posicion SHORT sin SL real.
- En `convex/spotDefenseEngine.ts`, fase de posicion, `slAlive` se calcula solo desde la fila local:
  `observedStatus === "open" || "triggered" || ("pending" && submittedAt != null)`.
- No consulta HL (`frontendOpenOrders`, `orderStatus`, `fillsByCloid`) para confirmar que ese CLOID sigue vivo o se lleno.
- Caso peligroso: el SL fue cancelado/rechazado manualmente en HL, pero la DB quedo `open`. El reconcile cree que hay SL vivo, no recoloca, no marca `manual_intervention`, y devuelve `position_reconciled`. Resultado: SHORT abierto sin proteccion.
- Tambien aplica al `pending` enviado/ambiguo: puede quedarse como vivo indefinidamente aunque nunca exista en HL.

Fix esperado:
- Antes de tratar un SL local como vivo, confirmar en HL por CLOID:
  - si `orderStatus/openByCloid` dice `open` o `triggered`, mantenerlo vivo y actualizar oid/status;
  - si `fillsByCloid(sl.cloid)` > 0, marcar `filled` y dejar que la rama flat cierre;
  - si no esta vivo ni lleno, marcar `canceled/rejected/unknown` y recolocar SL o mantener `protecting` para retry;
  - para `pending + submittedAt`, usar grace/confirmacion por CLOID, no asumir vivo para siempre.
- Agregar tests de regression:
  1. arm `protected` con SL local `open`, pero HL sin open order y sin fill: debe recolocar o marcar no protegido, no quedarse `protected`;
  2. SL `pending + submittedAt` sin open/fill tras grace: debe permitir retry.

## Checks esperados

- `npm run typecheck`
- `npm test -- --run`
