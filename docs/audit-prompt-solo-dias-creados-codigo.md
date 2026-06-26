# Prompt de auditoría (Codex) — CÓDIGO: mostrar solo "Tiempo de vida" del pool, quitar "Total generado"

**Cambio solo-UI / display.** Commit `ea8ea1e` en rama `chore/solo-dias-creados` (sacada de `master`
al día). Elimina el tile **"Total generado"** (fees lifetime) del portal (`PoolCard` en
`src/components/BotPortal.jsx`) y del panel admin (`PositionCard` en `src/components/AdminView.jsx`),
dejando **únicamente el tile "Tiempo de vida"** (días de vida del pool). NO toca motor, persistencia,
scanner, schema, crons ni money-path. Veredicto **GO / NO-GO**.

## Contexto / motivación

JAV-117 introdujo dos métricas por pool: **"Tiempo de vida"** (edad de la posición, calculada en
cliente desde `initialLiquidityAt ?? _creationTime`, sin proveedor externo) y **"Total generado"**
(fees acumulados en toda la vida, que requería un back-fill on-chain de eventos). JAV-119 intentó
poblar "Total generado" gratis (Alchemy Free, RPC públicos, Blockscout); todas las vías resultaron
inviables/no confiables (caps de getLogs, indexación incompleta). Decisión del usuario: **quitar
"Total generado"** y conservar solo los días. Este cambio hace exactamente eso a nivel de UI.

## Qué cambia

### `src/components/BotPortal.jsx` (PoolCard)
- En el bloque de cálculo (antes ~460-480): se **eliminan** las variables que alimentaban el tile de
  fees: `lifetimeUsd`, `lifetimeStatus`, `lifetimeUsable`, `lifetimeValueNode`, `lifetimeTip`.
- Se **conservan**: `lifeSinceAt`, `lifetimeStr`, `lifeDateStr`, `showLifetime`
  (`showLifetime = !!pool.tokenId && lifetimeStr != null`).
- En el render del bloque `{showLifetime && (...)}`: se **elimina** el segundo
  `<Metric label="Total generado" ... />`; queda solo `<Metric label="Tiempo de vida" ... />`.

### `src/components/AdminView.jsx` (PositionCard)
- Se **eliminan** las variables `lifetimeUsd`, `lifetimeStatus`, `lifetimeBlocked`, `lifetimeVal`.
- Se **conservan**: `lifeSinceAt = p?.lifeSinceAt ?? null`, `lifetimeStr`, `lifeDateStr`.
- Se **elimina** el `<div className="av-cell">` de "Total generado"; queda el `av-cell` de
  "Tiempo de vida".

### Backend (a propósito SIN tocar)
El cron `refresh pool lifetimes` (`convex/crons.ts`), `convex/actions/poolScanner.ts`, los campos
`feesLifetime*` del schema y `feesLifetimeUsd/feesLifetimeStatus` en `convex/adminLive.ts` quedan
**inertes**: ya nadie los consume en UI, pero no se borran para evitar una migración de schema. La
limpieza de ese código muerto queda como follow-up aparte.

## Verifica GO/NO-GO

1. **Sin referencias colgantes**: ¿queda alguna lectura de `lifetimeUsd` / `lifetimeStatus` /
   `lifetimeVal` / `lifetimeBlocked` / `lifetimeUsable` / `lifetimeValueNode` / `lifetimeTip` en
   ambos archivos? (grep esperado: vacío.) ¿`formatUsd2`/`usd` siguen usándose en otro lado de cada
   archivo (no quedaron imports/helpers sin uso que rompan lint)?
2. **"Tiempo de vida" intacto**: el tile de días sigue funcionando igual. ¿`showLifetime` sigue
   gateado por `pool.tokenId` + `lifetimeStr != null` (BotPortal)? ¿En AdminView el `av-cell` muestra
   `lifetimeStr` con el `· fecha` cuando hay `lifeDateStr`, y `—` cuando no? Confirmar que ninguna de
   las variables conservadas dependía de las eliminadas.
3. **Sin efectos fuera de UI**: ¿el cambio es puramente de render? Confirmar que NO se tocó motor,
   persistencia, scanner, schema, crons ni adminLive, y que los campos `feesLifetime*` que el backend
   sigue produciendo simplemente dejan de leerse (no se rompe ninguna query/mutation por su ausencia,
   porque siguen existiendo).
4. **Coherencia de layout**: al pasar de 2 tiles a 1, ¿el contenedor (`pool-metrics-header` en
   BotPortal, la grilla de `av-cell` en AdminView) se ve correcto con un solo elemento (sin hueco roto
   ni alineación rara)?
5. **Código muerto residual**: ¿quedó algún comentario que prometa "total generado" / "fees lifetime"
   y ya no aplique? (Los comentarios JAV-117 se actualizaron para describir solo la vida del pool —
   verificar que no haya quedado texto engañoso.)

Checks: `npx vite build` (compila — verificado OK, `✓ built in 2.63s`). NO `npm run build` (incluye
`convex deploy` a prod). Revisión visual: tarjeta de pool en el portal y fila de posición en el panel
admin muestran solo "Tiempo de vida".
