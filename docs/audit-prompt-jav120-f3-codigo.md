# Prompt de auditoría (Codex) — CÓDIGO: JAV-120 Fase 3 (lectura backend `getPoolFees24h`)

**RE-AUDITORÍA (r2).** Audita el **código** del commit `664d9f1` (rama
`elcorreodejaviera/jav-120-fees-24h-real`). Veredicto **GO / NO-GO**. Fase 3 del plan
`docs/plan-fees24h-real.md`. Sobre F0/F1/F2 (todas con tu GO). Es la fase con más lógica financiera; sé
escéptico.

> **Corrige tu NO-GO previo** (`docs/audit-jav120-f3-getPoolFees24h-codex.md`, ALTO: "ventana podía ser
> <24h o 0h"). Fix: el `refSnap` ahora se ancla en `nowSnap.at − 24h` (NO en `serverNow`) → la ventana
> `nowSnap.at − refSnap.at` es SIEMPRE ≥24h entre puntos de datos reales, y `nowSnap !== refSnap` por
> construcción. Además se agregó un **gate de frescura**: si `serverNow − nowSnap.at > 2h` (cron caído) →
> `stale`. El countdown de `warming_up` se ancla en `nowSnap.at`. Verificá que la ventana ya no puede
> reportar `ok` para <24h ni con cron muerto, y que `warming_up`/`stale` cubren bien esos casos.

## Qué cambia
- `convex/pools.ts`: `getFees24hWindowInternal` (internalQuery) — authz owner/admin (`pool.userId === user._id
  || user.role === "admin"`), devuelve `nowSnap` (más reciente), `refSnap` (más nuevo con `at ≤ now−24h`),
  `oldestAt`, `tokenId`, `network`, `serverNow`.
- `convex/actions/poolScanner.ts`: `getPoolFees24h({ poolId, priceUsd })` (action) — computa "Fees 24h"
  REAL desde los snapshots almacenados y lo valúa a spot.

## Diseño a validar
- **Solo snapshots almacenados en ambos extremos** (sin RPC de cobrable en lectura) → consistencia de bloque
  (cada snapshot se leyó en su `safeHead`) y costo bajo. El "ahora" es el último snapshot (≤1h viejo).
- **Neteo (clave)**: con `nowSnap.snapshotKey === refSnap.snapshotKey` NO hubo collect/increase/decrease en
  la ventana ⇒ `feesCollected` y `principalDebt` son CONSTANTES y se CANCELAN en el delta ⇒
  `fees24h = owed_now − owed_ref` (por token), ≥0 por crecimiento pasivo. ¿Es correcto este argumento?
  ¿Hay algún caso con key igual donde collected/debt cambien (y por tanto el atajo subcuente/sobrecuente)?
  Pensá en: ¿`readPositionSnapshotKey` (liquidity|feeGrowthInside0/1|tokensOwed0/1) capta TODOS los eventos
  que mueven collected/debt? Un collect mueve tokensOwed→0 (cambia key). Un decrease mueve liquidity (cambia
  key). ¿Algún flujo que cambie collected/debt SIN cambiar ninguno de esos 5 slots?
- **Estados**: `ok` | `warming_up` (sin ref ≥24h; `hoursUntilReady` por countdown del más viejo) | `stale`
  (refAge > 26h, hueco de cron) | `partial` (snapshotKey cambió → lo cierra F4; o delta raw negativo) |
  `unavailable` (sin snapshot/metadata/red). ¿Cobertura completa y honesta?
- **feeShareStatus NO gatea** (Codex v2 MEDIO#2): correcto que el real NO dependa de in-range actual.
- **Tolerancia 24–26h** (MEDIO#1): `FEE24H_MAX_REF_AGE_MS = 26h`; expone `refAgeMs`/`windowHours`.

## Verifica GO/NO-GO
1. **Aritmética del neteo / atajo de cancelación**: ¿`fees24h = owed_now − owed_ref` con key igual es
   financieramente correcto vs la definición `Δ(collected + max(owed − debt, 0))` del plan? ¿Edge cases
   (owed < debt, posición con decrease previo a la ventana no cobrado)? Recordá: tokensOwed live INCLUYE el
   principal liberado por decrease no cobrado.
2. **Delta negativo con key igual**: se trata como `partial`. ¿Defensa suficiente? ¿Puede pasar legítimamente
   (p.ej. precisión/reorg) y debería ser otro estado?
3. **Selección de snapshots**: las queries `by_pool_at` con `.order("desc").first()` y `.lte("at", now−24h)`
   ¿devuelven exactamente nowSnap y el ref correcto? ¿Riesgo si solo hay 1 snapshot (nowSnap===oldest, sin
   ref)? ¿Si nowSnap.at coincide con ref por bordes?
4. **Authz** (MEDIO#2): ¿la `internalQuery` con `requireUser` + chequeo `pool.userId`/admin es robusta
   llamada vía `runQuery` desde la action (¿propaga identidad?)? ¿Algún modo de leer snapshots ajenos?
5. **Valuación**: usa `tokenInfo` + `valueFeesUsd` con `priceUsd` del front (mismo patrón que
   `fetchPositionLiquidity`). ¿`addrAt(posRaw,2/3)` correcto? ¿Redondeo/precisión del delta pequeño en USD
   aceptable (valueFeesUsd redondea a centavos)?
6. **Money-path / efectos**: confirmar read-only total (1 `eth_call` positions + 2 `tokenInfo`; ninguna
   escritura). ¿Algo toca ejecución/margen?
7. **Coherencia con el plan v3**: ¿la decisión de "ahora = último snapshot almacenado" (en vez de lectura
   live) rompe algo del plan? ¿F4 podrá usar `[refSnap.safeHeadBlock, nowSnap.safeHeadBlock]` como rango
   exacto de getLogs para el caso `partial`?

## Verificación hecha
- `npm run typecheck` → OK.
- **Runtime DIFERIDO**: requiere ≥24h de snapshots del cron F2 (solo tras desplegar). Se valida tras merge,
  comparando contra el cobrable on-chain de tokenId 5562243 (Arbitrum). ¿Aceptable?
