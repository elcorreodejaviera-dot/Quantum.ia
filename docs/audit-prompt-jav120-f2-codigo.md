# Prompt de auditoría (Codex) — CÓDIGO: JAV-120 Fase 2 (cron horario "snapshot pool fees")

Audita el **código** del commit `ac122fa` (rama `elcorreodejaviera/jav-120-fees-24h-real`). Veredicto
**GO / NO-GO**. Fase 2 del plan `docs/plan-fees24h-real.md`. Construye sobre F1 (writer `snapshotPoolFees`,
commit `302d581`, GO en `docs/audit-jav120-f1-snapshot-writer-r2-codex.md`).

## Qué cambia
- `convex/cronHealth.ts`: `snapshotPoolFeesWithHealth` (internalAction) — `withCronHealth(ctx,
  "snapshot pool fees", () => ctx.runAction(internal.actions.poolScanner.snapshotPoolFees, {}))`. Espejo
  exacto de `refreshPoolLifetimesWithHealth` (`:147-151`).
- `convex/crons.ts`: nuevo `crons.interval("snapshot pool fees", { hours: 1 }, ...)`, separado del cron de
  lifetime y de la poda.

## Verifica GO/NO-GO
1. **Cableado correcto**: ¿el nombre del cron ("snapshot pool fees") es único y consistente entre `crons.ts`
   y `withCronHealth`? ¿`internal.cronHealth.snapshotPoolFeesWithHealth` e
   `internal.actions.poolScanner.snapshotPoolFees` resuelven bien?
2. **Best-effort / aislamiento**: ¿`withCronHealth` captura fallos sin propagar (no rompe otros crons)? ¿Es
   correcto que sea un cron SEPARADO del de lifetime (que está `no_key`/inerte) en vez de encadenarlo?
3. **Cadencia**: 1h coincide con la ventana de referencia (24h ⇒ ~24 snapshots). ¿Algún problema de
   solapamiento si una corrida tarda >1h? (writer es read-only + inserts; ¿idempotencia/duplicados? — la
   tabla es append-only serie temporal; ¿aceptable?)
4. **Money-path**: confirmar que NO toca ejecución/margen/órdenes; solo dispara el writer read-only de F1.
5. **Costo agregado**: +1 cron/h que hace ~4 eth_call/pool (latest + ownerOf + collect + positions).
   ¿Aceptable con `POOL_SCAN_CONCURRENCY`?
6. **Registro de health**: ¿"snapshot pool fees" aparecerá bien en `listCronHealth` sin necesitar registro
   previo? ¿Algún lugar que liste nombres de cron esperados y haya que actualizar?

## Verificación hecha
- `npm run typecheck` → OK.
- **Runtime DIFERIDO**: el cron empieza a correr al desplegar (Railway, al mergear). La acumulación ≥24h y
  la validación de filas reales se hará tras merge. ¿Aceptable, o preferís una corrida controlada antes?
