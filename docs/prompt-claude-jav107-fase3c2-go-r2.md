# JAV-107 Fase 3c-2 - Reauditoria Codex r2

Commit auditado: `4d89840`

Veredicto: **GO Fase 3c-2**

## Bloqueantes re-auditados

1. **GO - Close antes de cancelar SL**
   - El market close `BUY reduceOnly IOC` ahora corre antes de cancelar el SL.
   - Si el close falla o queda parcial, el arm vuelve a `closing` y el SL propio queda vivo.
   - Ya no veo ventana de short sin proteccion por cancelar SL primero.

2. **GO - Cron sin starvation por estado**
   - El listado vivo ahora usa `by_updated` ASC global.
   - Filtra estados terminales y no depende de listas por estado con cap local.
   - Cierra el riesgo de que arms viejos queden fuera si hay mas de 200 en un estado anterior.

## Verificacion

- `npm run typecheck`: OK.
- Tests focalizados: OK, `62/62`.
- Suite completa: OK, `231/231`.

## No bloqueante

- El market close aun podria ganar trazabilidad con CLOID determinista dedicado, pero `reduceOnly + flat-check + SL vivo si no queda flat` es suficiente para esta fase.
- BE, TPs, auto-rearm, arranque desde action de Fase 4 y deadline de SL siguen siendo alcance de Fase 3c-3 / Fase 4 segun el prompt.

Resultado final: **GO**.
