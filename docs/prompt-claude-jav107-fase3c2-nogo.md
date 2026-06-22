# JAV-107 Fase 3c-2 — Auditoria Codex — NO-GO

Claude: repara estos bloqueantes en `feat/jav107-spot-defense`.

Contexto:
- Prompt auditado: `docs/audit-prompt-jav107-fase3c2-codigo.md`
- Commit auditado: `b150494`
- Verificacion: `npm run typecheck` OK; focalizados OK (`61/61`); suite completa OK (`230/230`).
- Los tests verdes no cubren estos casos money-path.

## Bloqueantes

1. ALTO — `wantDisarm` cancela el SL antes de saber si el market close cerro.
- En `convex/spotDefenseEngine.ts`, con posicion abierta y pausa/kill, se llama `ensureSpotDefenseOrdersDead(...)` antes del BUY reduceOnly IOC.
- Si el cancel del SL se acepta y el market close falla, se timeoutea o llena parcial, queda una posicion SHORT abierta sin SL hasta el siguiente ciclo.
- Ademas se ignora el booleano de `ensureSpotDefenseOrdersDead`; aunque una orden propia siga viva o el cancel falle, igual manda el close.
- Fix esperado: no dejar la posicion desnuda. O cerrar reduceOnly primero y cancelar SL solo tras confirmar flat, o si se cancela antes, entonces ante close no confirmado debe reponer/proteger SL o no terminalizar el camino. Confirmar `szi` post-close antes de considerar seguro.

2. ALTO — El cron puede starvear estados criticos por listar por estado, no por antiguedad global.
- `listLiveSpotDefenseArmIdsInternal` recorre `SD_LIVE_STATUSES` en orden fijo y corta al llegar a 200.
- Si hay mas de 200 arms en estados tempranos (`arming`, `submitting`, etc.), arms `filled/protecting/protected` pueden quedar sin reconcile indefinidamente.
- Esto es peor para money-path porque `filled/protecting` son los que necesitan SL/cierre.
- El motor de pool ya evita esto con `by_updated` ASC global (`listReconcilableArmsInternal`).
- Fix esperado: listar por `by_updated` ASC global y filtrar no terminales, con limite; o implementar paginacion/cursor justa que no sesgue por estado.

## Recomendado no bloqueante

- Usar CLOID determinista para el market close (`spot-defense:<arm>:<gen>:close`) mejoraria trazabilidad e idempotencia, aunque `reduceOnly + flat-check` acota el sobre-cierre.
- El arranque de bots activos sin arm queda para la action de Fase 4 segun el prompt; no lo marque bloqueante aqui.

## Checks esperados

- Agregar regression tests para:
  1. Close IOC falla/parcial despues de cancelar SL: no queda posicion sin proteccion silenciosa.
  2. >200 arms vivos con distintos estados: `filled/protecting/protected` reciben turno por antiguedad.
- Reejecutar `npm run typecheck`.
- Reejecutar `npm test -- --run`.
