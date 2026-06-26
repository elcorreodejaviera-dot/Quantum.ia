# Reauditoria Codex - JAV-119 back-fill lifetime gratis

> **ACTUALIZACIÓN (post-PR #128):** el ajuste documental que abajo impedía el "GO limpio" YA se aplicó
> (el plan `docs/plan-jav119-backfill-gratis.md` fue alineado: sin `BACKFILL_INITIAL_SPAN`/600, sin
> `autoStart`, sin caveat de 45 días). **Veredicto efectivo: GO de código + plan.** El resto del informe
> refleja el estado intermedio previo a esa corrección.

## Alcance

Reauditoria del diff `2663860..f9290bf` en la rama `elcorreodejaviera/jav-119-backfill-lifetime-gratis`.

Foco:

- Confirmar eliminacion de la heuristica `initialLiquidityAt - 45d`.
- Confirmar que `backfilledAt` / `ok` solo se certifican desde el origen real.
- Revalidar que el backfill gratis no persiste huecos si queda parcial.
- Revisar coherencia del plan `docs/plan-jav119-backfill-gratis.md` contra el codigo final.

## Veredicto

**GO tecnico de codigo. Ajuste documental minimo antes de push.**

El bloqueo de la auditoria anterior esta cerrado en runtime: el backfill arranca en bloque `0` por defecto, `fromBlock > 0` queda `stale`, y ya no existe la ruta `initialLiquidityAt - 45d` ni los helpers `blockTimestamp` / `blockAtOrBeforeTimestamp`.

No doy "GO limpio" solo porque el plan quedo parcialmente desfasado: aun menciona `BACKFILL_INITIAL_SPAN`/600, `autoStart` y el caveat de 45 dias. Es doc-only, pero el pedido era plan + codigo.

## Validacion de codigo

### Bloqueo anterior cerrado

- Se eliminaron `blockTimestamp` y `blockAtOrBeforeTimestamp`.
  - `convex/actions/poolScanner.ts:190-287`
- `backfillPoolLifetime` usa `start = Math.max(0, fromBlock ?? 0)`.
  - `convex/actions/poolScanner.ts:1172-1176`
- Si `start > safeHead`, retorna sin mutar.
  - `convex/actions/poolScanner.ts:1177`
- `coversHistory = start === 0 || state.backfilledAt != null`.
  - `convex/actions/poolScanner.ts:1195-1198`
- `status: "ok"` y `backfilledAt` dependen de `coversHistory`.
  - `convex/actions/poolScanner.ts:1200-1208`

Conclusion: un backfill por defecto certifica historico solo porque cubre `[0, safeHead]`; un `fromBlock > 0` sin backfill previo no certifica y queda `stale`.

### Range-halving / no huecos

`getLogsAdaptive` sigue cubriendo una pila de subrangos y solo devuelve `complete:true` cuando vacio toda la pila. Si agota presupuesto, `backfillPoolLifetime` retorna sin llamar `applyPoolFeeEventsWindow`.

- `convex/actions/poolScanner.ts:269-287`
- `convex/actions/poolScanner.ts:1183-1193`

Conclusion: no persiste ventanas parciales ni huecos; cache previo intacto ante fallo o presupuesto agotado.

### FromBlock explicito

Con `fromBlock > 0`, el codigo puede aplicar una ventana parcial y recomputar desde la tabla completa, pero conserva `status:"stale"` salvo que `state.backfilledAt` ya exista.

- `convex/actions/poolScanner.ts:1195-1208`

Conclusion: correcto; sirve para reruns o ventanas manuales sin mentir sobre cobertura historica.

## Ajuste documental pendiente

Actualizar `docs/plan-jav119-backfill-gratis.md`:

- Linea 10: ya no existe `BACKFILL_INITIAL_SPAN` 1M ni `BACKFILL_CALL_BUDGET` 600; codigo usa un trozo inicial `[start,safeHead]` y budget 2000.
- Linea 17: quitar `autoStart cubre desde ≈creacion`; ya no hay `autoStart`.
- Linea 20-21: eliminar el caveat de `initialLiquidityAt` / margen 45 dias; ya no aplica.

No es riesgo runtime, pero si queda asi el plan contradice el codigo final.

## Observaciones menores no bloqueantes

- `BACKFILL_CALL_BUDGET` cuenta subrangos intentados por `getLogsAdaptive`, no requests HTTP reales. Con varios proveedores puede haber mas requests que el numero del budget. Es aceptable como guard anti-runaway, pero el nombre/comentario podria aclararlo.
- Escanear desde bloque 0 puede agotar presupuesto en redes/proveedores con limites estrictos. Si ocurre, no muta y retorna `ok:false`; integridad preservada.

## Comandos

- `git log --oneline --decorate -8`
- `git diff --stat 2663860..f9290bf`
- `git diff --unified=100 2663860..f9290bf -- convex/actions/poolScanner.ts docs/plan-jav119-backfill-gratis.md`
- `rg -n "initialLiquidityAt|45|autoStart|blockTimestamp|blockAtOrBeforeTimestamp|BACKFILL_INITIAL_SPAN|BACKFILL_START_MARGIN|coversHistory" convex/actions/poolScanner.ts docs/plan-jav119-backfill-gratis.md`
- `npm run typecheck` -> OK
- `npm test` -> OK, 17 archivos / 265 tests
- `npx vite build` -> OK, warnings no bloqueantes conocidos de Rollup/chunk

## Cierre

Codigo: **GO**.

Plan/docs: ajustar las lineas obsoletas indicadas y queda **GO limpio para push**.
