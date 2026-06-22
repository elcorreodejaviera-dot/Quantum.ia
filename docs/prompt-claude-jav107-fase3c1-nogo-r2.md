# JAV-107 Fase 3c-1 — Reauditoria Codex r2 — NO-GO

Claude: repara estos bloqueantes restantes en `feat/jav107-spot-defense`.

Contexto:
- Prompt auditado: `docs/audit-prompt-jav107-fase3c1-codigo.md`
- Commit de fixes auditado: `c684481`
- Verificacion: `npm run typecheck` OK; tests focalizados OK (`59/59`); suite completa OK (`228/228`).
- Los tests verdes actuales no cubren los dos casos money-path de abajo.

## Bloqueantes actuales

1. ALTO — Desarme pre-fill puede ocultar un fill ya ocurrido.
- En `convex/spotDefenseEngine.ts`, rama pre-fill (`armed`/`submitting`/`unknown`), el codigo evalua `wantDisarm` antes de consultar `fillsByCloid(entry.cloid)`.
- Si la entrada se lleno en HL y ya no aparece en `frontendOpenOrders`, `ensureSpotDefenseOrdersDead` devuelve `true`; luego `settleSpotDefenseArm(... status:"disarmed")` puede terminalizar el arm tras la cuarentena.
- Resultado: queda una posicion SHORT real sin arm `filled/protecting`, sin SL y sin seguimiento, especialmente con kill-switch/pausa/gate cerrado persistente.
- Fix: en pre-fill confirmar fill ANTES de desarmar. Igual que el motor de pool: `orderStatus/fillsByCloid` primero; si hay fill, pasar a `filled` y entrar a la fase de posicion. Solo declarar `disarmed` con prueba negativa de orden muerta Y sin fill.

2. ALTO — SL local `pending` puede bloquear proteccion aunque no exista SL en HL.
- El fix persiste `recordSpotDefenseSlOrder(... observedStatus:"pending")` antes de `placeStopLoss`.
- Si `renewSpotDefenseReconcile` falla despues del pre-record, o si `placeStopLoss` lanza error determinista antes de enviar/aceptar orden, queda una fila `sl` `pending` aunque no existe SL vivo.
- En el siguiente reconcile, `slAlive` trata `pending` como vivo y no reintenta colocar SL. Resultado: posicion SHORT abierta sin SL, pero el motor cree que ya hay proteccion pendiente.
- Fix: separar "preparado" de "enviado". Opciones validas:
  - no considerar `pending` como vivo si no tiene `submittedAt`/marca de envio;
  - marcar `submittedAt` solo cuando el RPC fue aceptado/ambiguo;
  - si `renew` falla antes del RPC, limpiar/rechazar el intento local;
  - si `placeStopLoss` lanza error determinista, marcar la orden como `rejected`/`canceled` para permitir retry o escalar.

## Checks esperados

- Agregar tests que simulen:
  1. `wantDisarm=true` + entry fill detectable por CLOID + sin open order: debe terminar en `filled`, no `disarmed`.
  2. SL pre-record `pending` pero RPC no enviado/rechazado: siguiente reconcile debe reintentar o no tratarlo como SL vivo.
- Reejecutar `npm run typecheck`.
- Reejecutar `npm test -- --run`.
