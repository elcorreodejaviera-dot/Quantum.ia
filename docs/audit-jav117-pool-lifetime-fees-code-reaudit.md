# Reauditoria Codex - JAV-117 codigo

## Alcance

Reauditoria del commit `3f23e00` sobre el commit auditado previamente `4928e9d`.

Foco:

- Cierre de ALTO 1: no borrar eventos antes de reconstruir la ventana.
- Cierre de ALTO 2: no marcar `ok` sin backfill historico.
- Cierre de MEDIO 1: degradacion `no_key` / `error` en UI.

Archivos revisados:

- `convex/schema.ts`
- `convex/pools.ts`
- `convex/actions/poolScanner.ts`
- `src/components/BotPortal.jsx`
- `src/components/AdminView.jsx`

## Veredicto

**NO-GO minimo antes de push.**

Los dos ALTO originales estan practicamente cerrados, y el MEDIO de UI esta cerrado. Queda un bypass en el backfill manual: si se llama `backfillPoolLifetime` con `fromBlock > 0` y llega hasta el safe head, el codigo marca `feesLifetimeBackfilledAt` y `status: "ok"` aunque no probo el historico anterior a `fromBlock`.

Es un ajuste chico, pero bloquea el GO limpio porque puede volver a certificar como retroactivo un historico incompleto.

## Hallazgo

### ALTO - `fromBlock` puede marcar backfill completo aunque el rango no empiece en el origen

Evidencia:

- `backfillPoolLifetime` acepta `fromBlock` opcional y calcula `start = Math.max(0, fromBlock ?? 0)`.
  - `convex/actions/poolScanner.ts:1050-1072`
- Si el scan llega al safe head, `reachedHead` queda true.
  - `convex/actions/poolScanner.ts:1099`
- Luego la mutation persiste `status: "ok"` y `backfilledAt: Date.now()` solo por haber llegado al safe head, sin exigir `start === 0` ni que ya existiera un backfill completo anterior.
  - `convex/actions/poolScanner.ts:1101-1110`
- `refreshOnePoolLifetime` usa `feesLifetimeBackfilledAt != null` como condicion para permitir `status: "ok"`.
  - `convex/actions/poolScanner.ts:950-953`

Impacto:

- Un operador puede correr el backfill manual con `fromBlock` alto para acotar/rerunear una ventana y dejar el pool como historicamente completo aunque falten eventos anteriores.
- A partir de ahi el cron incremental ya puede avanzar con `ok`, y la UI mostrara un lifetime confiable que no es retroactivo completo.

Ajuste requerido:

Usar un booleano de completitud real, por ejemplo:

```ts
const alreadyComplete = state.backfilledAt != null;
const completeFromOrigin = reachedHead && (start === 0 || alreadyComplete);

await ctx.runMutation(internal.pools.applyPoolFeeEventsWindow, {
  poolId,
  fromBlock: start,
  toBlock: scannedTo,
  events: staged,
  cursorBlock: scannedTo,
  status: completeFromOrigin ? "ok" : "stale",
  ...(completeFromOrigin ? { backfilledAt: alreadyComplete ? state.backfilledAt : Date.now() } : {}),
  ...(reachedHead && currentKey ? { snapshotKey: currentKey } : {}),
});
```

La regla clave: un backfill nuevo solo setea `feesLifetimeBackfilledAt` si cubre desde `0` hasta `safeHead`. Si ya estaba completo, un rerun parcial puede conservar ese marcador.

## Validaciones positivas

- ALTO 1 anterior cerrado: `refreshOnePoolLifetime` ahora stagea logs y solo aplica una ventana contigua ya leida con exito mediante `applyPoolFeeEventsWindow`.
  - `convex/actions/poolScanner.ts:976-1021`
  - `convex/pools.ts:288-340`
- Si falla el primer chunk, ya no borra tabla ni recomputa agregados; solo marca `error`.
  - `convex/actions/poolScanner.ts:1003-1007`
- ALTO 2 anterior cerrado para el cron incremental: sin `feesLifetimeBackfilledAt`, el camino sin cambios usa `stale`, no `ok`.
  - `convex/actions/poolScanner.ts:950-970`
- MEDIO anterior cerrado: portal y admin degradan `no_key` / `error` a `--` aunque exista cache raw previo.
  - `src/components/BotPortal.jsx:466-472`
  - `src/components/AdminView.jsx:170-176`
- La contabilidad base `principalDebt`, topics/decoding y compatibilidad de `feesUncollectedUsd` no cambiaron respecto de la auditoria anterior y siguen OK.

## Comandos

- `git diff --stat 4928e9d..HEAD`
- `git diff --unified=80 4928e9d..HEAD -- convex/schema.ts convex/pools.ts`
- `git diff --unified=80 4928e9d..HEAD -- convex/actions/poolScanner.ts`
- `git diff --unified=80 4928e9d..HEAD -- src/components/BotPortal.jsx src/components/AdminView.jsx`
- `npm run typecheck` -> OK
- `npm test` -> OK, 17 archivos / 265 tests
- `npx vite build` -> OK, warnings no bloqueantes de Rollup/chunk

## Cierre

No veo regresion money-path ni fallo ABI. Con el guard de `fromBlock` anterior, daria **GO limpio** para push.
