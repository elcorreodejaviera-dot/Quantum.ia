# Auditoria Codex - JAV-119 back-fill lifetime gratis

## Alcance

Revision de plan y codigo del commit `2663860` en la rama `elcorreodejaviera/jav-119-backfill-lifetime-gratis`, antes de push.

Archivos revisados:

- `docs/plan-jav119-backfill-gratis.md`
- `convex/actions/poolScanner.ts`

## Veredicto

**NO-GO antes de push.**

El range-halving y la politica de no mutar ante cobertura parcial estan bien encaminados. El bloqueo esta en la semantica de cobertura historica: el backfill automatico marca `backfilledAt` y `status: "ok"` aunque el inicio se derive de `initialLiquidityAt - 45d`, que es solo primera observacion del sistema, no el mint on-chain.

Eso puede volver a presentar un lifetime incompleto como confiable.

## Hallazgos

### ALTO - `autoStart` certifica historico completo desde una heuristica

Evidencia:

- El plan reconoce que `initialLiquidityAt` no es el mint real y que una posicion observada mas de 45 dias despues podria perder eventos tempranos.
  - `docs/plan-jav119-backfill-gratis.md:11`
  - `docs/plan-jav119-backfill-gratis.md:20-21`
- `initialLiquidityAt` se setea con `Date.now()` al registrar/observar la posicion, no desde chain.
  - `src/components/BotPortal.jsx:2122-2130`
  - `convex/pools.ts:107-119`
- En codigo, si no se pasa `fromBlock`, `autoStart` queda true, `start` se calcula desde `initialLiquidityAt - 45d`, y luego `coversHistory = autoStart || start === 0 || state.backfilledAt != null`.
  - `convex/actions/poolScanner.ts:1211-1240`
- Si el scan desde ese `start` hasta `safeHead` completa, se persiste `status: "ok"` y `backfilledAt`, aunque no se haya probado que no existieron `Collect` / `DecreaseLiquidity` antes de `start`.
  - `convex/actions/poolScanner.ts:1242-1252`

Impacto:

- Un usuario puede importar/registrar una posicion Uniswap V3 antigua. Si tuvo fees/cobros antes de `initialLiquidityAt - 45d`, esos eventos quedan fuera, pero el pool queda marcado como historicamente completo.
- Rompe el invariante de JAV-117/JAV-119: `backfilledAt`/`ok` debe significar lifetime retroactivo confiable.

Ajuste requerido:

Opcion A, preferida:

- Derivar el bloque real de origen desde on-chain antes de usar la heuristica:
  - buscar evento ERC-721 `Transfer(address indexed from,address indexed to,uint256 indexed tokenId)` del `NonfungiblePositionManager`, filtrando `topic3 = tokenId` y `topic1 = 0x0`, con el mismo `getLogsAdaptive`;
  - usar ese `mintBlock` como `start`;
  - solo entonces permitir `coversHistory = true`.

Opcion B, minima:

- Permitir el auto-start heuristico para ahorrar RPC, pero no certificarlo:
  - `const coversHistory = start === 0 || state.backfilledAt != null;`
  - si `autoStart` y `start > 0` sin backfill previo, aplicar la ventana completa pero dejar `status: "stale"` y no setear `backfilledAt`.

Opcion C, operacional:

- Hacer que `backfillAllPoolLifetimes` llame `backfillPoolLifetime({ fromBlock: 0 })` por defecto. Con 2 pools y adaptive halving, es mas caro pero conserva semantica exacta.

## Validaciones positivas

### Range-halving + multi-proveedor

La estructura no deja huecos persistidos: `getLogsAdaptive` procesa una pila de subrangos; si agota presupuesto devuelve `complete:false`, y `backfillPoolLifetime` retorna sin llamar `applyPoolFeeEventsWindow`.

- `convex/actions/poolScanner.ts:269-287`
- `convex/actions/poolScanner.ts:1224-1236`

Esto contesta el punto (1): el algoritmo puede leer rangos en orden no cronologico, pero eso no importa porque los eventos se recomputan ordenados por `blockNumber/logIndex` en `pools.ts`. Mientras `complete` sea true, cubre todos los subrangos de `[start,safeHead]`.

### No mutar ante cobertura parcial

Correcto. Si transporte falla o se agota presupuesto, no se borra ni reinserta nada; cache previo intacto.

- `convex/actions/poolScanner.ts:1227-1236`

Esto contesta el punto (2): es la decision correcta. Evita persistir ventanas no contiguas.

### Clasificar timeout/400/413 como range-too-large

Aceptable con matiz. Clasificar timeout/400/413 como `GetLogsRangeTooLargeError` puede partir de mas y consumir presupuesto, pero no corrompe datos: si no logra completar todos los subrangos, no muta. Si un proveedor rechaza hasta un solo bloque, el codigo aborta.

- `convex/actions/poolScanner.ts:231-243`
- `convex/actions/poolScanner.ts:281-283`

Esto contesta el punto (4): no es un bloqueo. Refinamiento opcional: tratar HTTP 400 como range-too-large solo si el body/mensaje contiene una razon de rango; hoy es conservador en integridad, menos eficiente en diagnostico.

## Observacion menor

`BACKFILL_CALL_BUDGET` cuenta subrangos procesados, no requests HTTP reales. Con dos proveedores, cada subrango puede hacer hasta dos requests. No es bloqueante para 2 pools, pero el comentario "tope de getLogs por pool" es optimista.

- `convex/actions/poolScanner.ts:252-263`
- `convex/actions/poolScanner.ts:274-280`

## Comandos

- `git show --stat --oneline --decorate 2663860`
- `git diff --unified=80 4f26ac0..2663860 -- convex/actions/poolScanner.ts docs/plan-jav119-backfill-gratis.md`
- `rg -n "initialLiquidityAt|backfillPoolLifetime|getLogsAdaptive|LOGS_RPC|BACKFILL_CALL_BUDGET" convex src docs`
- `npm run typecheck` -> OK
- `npm test` -> OK, 17 archivos / 265 tests
- `npx vite build` -> OK, warnings no bloqueantes conocidos de Rollup/chunk

## Cierre

No daria push hasta corregir la certificacion de historico completo. Con mint-block on-chain o con `autoStart` degradado a `stale`, el resto del diseno queda listo para GO.
