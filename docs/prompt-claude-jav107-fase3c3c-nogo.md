# JAV-107 Fase 3c-3c - Auditoria Codex - NO-GO

Claude: repara estos hallazgos en `feat/jav107-spot-defense`.

Contexto:
- Prompt auditado: `docs/audit-prompt-jav107-fase3c3c-codigo.md`
- Commit auditado: `ab20e53`
- Verificacion: `npm run typecheck` OK; `npm test` OK (`236/236`).
- Los tests verdes no cubren estos casos money-path.

## Bloqueantes

1. ALTO - Drift vs TP no es consistente ante eventual-consistency.
- En `convex/spotDefenseEngine.ts:270-296` se lee `clearinghouseState` y luego `fillsByCloid` de TPs.
- Si `userFills` ve un TP antes que `clearinghouseState`, o al reves, un TP legitimo puede disparar falso drift y llevar a `manual_intervention`, cancelando ordenes propias.
- Fix esperado: no terminalizar drift con una sola lectura cuando hay TP/fill reciente. Releer con grace o exigir dos snapshots coherentes antes de cancelar y marcar manual.

2. ALTO - `expected == 0` apaga el drift.
- En `convex/spotDefenseEngine.ts:295-296`, `expected = max(0, size - filledTpQty)` y el gate exige `expected > 0`.
- Si los TPs cierran casi/todo el short y queda una posicion no-flat por dust o intervencion manual, el bot no detecta drift ni limpia/cierra correctamente.
- Fix esperado: si `expected <= dust` y `!flat`, tratar el residuo como manual/residual segun umbral; si `flat`, cerrar con confirmacion y limpiar ordenes propias.

3. MEDIO - Falta validar `sum(closePct) <= 100`.
- `convex/spotDefenseBots.ts:144-148` valida cada TP, pero no la suma.
- `reduceOnly` evita invertir la posicion, pero no evita cierres anticipados/rechazos ni un sizing incoherente con la intencion del arm.
- Fix esperado: sumar `closePct` en `validateSpotDefenseConfig` y revalidar el snapshot al reservar/armar.

4. MEDIO - Los TPs `open/triggered/filled` no se reconcilian contra HL.
- En `convex/spotDefenseEngine.ts:491-495`, una fila TP marcada `open`, `triggered`, `filled` o `pending` con `submittedAt` se considera viva sin `openByCloid`, `orderStatus`, fills ni grace.
- Si el usuario cancela el TP, si HL nunca lo materializa, o si hubo fill parcial, no se recoloca ni se distingue estado real.
- Fix esperado: replicar el patron de `triggerEngine`: confirmar fill/open/triggered, respetar grace, marcar canceled si murio y recolocar.

5. MEDIO - Recovery/idempotencia del envio de TP incompleta.
- En `convex/spotDefenseEngine.ts:506` no se chequea `ok` del pre-record antes del RPC.
- En `convex/spotDefenseEngine.ts:519-520`, cualquier catch marca `rejected`, incluso `TransportError` incierto que pudo haber enviado la orden.
- Fix esperado: abortar si el pre-record falla; clasificar `TransportError` como `pending + markSubmitted`; solo marcar `rejected` para rechazo determinista.

6. MEDIO - TPs pueden colocarse con SL aun no confirmado.
- Despues de `convex/spotDefenseEngine.ts:484`, el loop de TPs corre aunque el SL haya quedado `protecting`/`pending`.
- Eso puede dejar TPs vivos sin SL resting confirmado.
- Fix esperado: colocar TPs solo cuando el SL este confirmado vivo/resting; si el arm sigue `protecting`, retornar y esperar al proximo ciclo.

## Checks esperados

- Agregar tests/regresiones para:
  1. TP fill con lag entre `userFills` y `clearinghouseState` no dispara falso drift.
  2. `expected == 0` con posicion residual no queda ignorado.
  3. `sum(closePct) > 100` se rechaza.
  4. TP local `open` cancelado en HL se marca muerto y se recoloca.
  5. `TransportError` en TP queda `pending + submittedAt`, no `rejected`.
  6. No se colocan TPs hasta que el SL este confirmado.
- Reejecutar `npm run typecheck`.
- Reejecutar `npm test`.

Resultado final: **NO-GO**.
