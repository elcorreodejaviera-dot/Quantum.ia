# Prompt de auditoría (Codex) — CÓDIGO: JAV-113 umbral de "dust" en el reconcile (motores IL + Defensa Spot)

Rama `fix/jav113-dust-threshold-reconcile`. **Toca el money-path** (motores de cobertura). Veredicto **GO / NO-GO**.

## Bug (caso real benjamin)

El reconcile detecta el cierre de la posición con un gate **estricto**: `const flat = Math.abs(szi) === 0`.
Hyperliquid deja un **remanente de redondeo** al cerrar (en prod: short de 2.7739 ETH cerrado, quedó
**0.0001 ETH ≈ $0.16**). Con `=== 0` estricto, `flat` nunca es `true` →
- el arm queda en `protected` para siempre (nunca llega a `closed`),
- no libera el `marginReserved` ($232.84 fantasma en DB),
- `closeArmAndScheduleRearm` nunca corre → **no reprograma el rearm** (no abre cobertura nueva),
- la **precondición flat del armado** (`[retry_incompatible]`) queda bloqueada por el dust,
- el cierre de emergencia/disarm intenta cerrar 0.0001 ETH a mercado, pero está por **debajo del mínimo de
  orden de HL (~$10)** → HL lo rechaza → se cuelga igual.

El **mismo patrón** existía en los DOS motores: `convex/triggerEngine.ts` (IL) y `convex/spotDefenseEngine.ts`.

## Fix

Helper compartido en `convex/hyperliquid.ts`:
```ts
export const DUST_NOTIONAL_USD = 10;
export function isFlatOrDust(szi: number, markPx: number): boolean {
  return Math.abs(szi) === 0 ||
    (Number.isFinite(markPx) && markPx > 0 && Math.abs(szi) * markPx < DUST_NOTIONAL_USD);
}
```
Semántica: un residuo cuyo nocional cae por debajo del **mínimo de orden de HL (~$10)** es **intradeable** →
tratarlo como **plano** (cerrado). `markPx` inválido → solo `szi===0` cuenta como flat (estricto previo;
no falsea posiciones reales).

Aplicado en los gates de szi de ambos motores:
- `triggerEngine.ts`: precondición de armado (~193), detección de cierre `flat` (~596), `realSize` (~598,
  ahora `!flat`), reducción de reserva 2×→1× (~619, ahora `!flat`), `armed_lower_only` (~1051).
- `spotDefenseEngine.ts`: precondición de armado (~98), `flat` (~305), `realSize` (~307, `!flat`),
  `flatNow` del disarm (~426).

`tests/dustThreshold.test.ts`: 6 casos (0, dust de benjamin, cobertura real, borde $9.99/$10, markPx
inválido, signo del szi).

## Verifica GO/NO-GO

1. **Correcto y seguro**: ¿`isFlatOrDust` clasifica bien? Una cobertura real (cientos/miles de $) nunca cae
   por debajo de $10 → no hay riesgo de marcar como cerrada una posición viva. ¿De acuerdo con el valor
   `DUST_NOTIONAL_USD = 10` (vinculado al mínimo de orden de HL)? ¿Convendría otro valor?
2. **Cierra el hueco de emergencia**: con el umbral en $10, ¿toda posición que llega al cierre de
   emergencia (`!flat`) tiene nocional ≥ $10 y por tanto es cerrable por HL (sobre el mínimo de orden)?
3. **markPx fiable en cada sitio**: ¿`markPx`/`assetMeta.markPx` está siempre en scope y fresco en los 9
   puntos de uso? ¿El fallback (markPx inválido → solo `szi===0`) es seguro (no falsea ni flat ni live)?
4. **Sin regresiones de la state machine**: el camino `flat` (cierre + grace + `closeArmAndScheduleRearm`)
   y `armed_lower_only` no cambian salvo el predicado. ¿Algún invariante roto? (265 tests verdes).
5. **Efecto en prod (benjamin)**: al desplegar, el dust pasa a `flat` → el arm cierra (closeReason
   "manual", sin rearm porque no fue SL) y libera el margen. ¿Correcto? ¿Algún riesgo de que cierre/rearme
   algo que no debía en otros arms vivos?

Checks: `npx tsc -p convex/tsconfig.json --noEmit` (OK) + `npx vitest run` (265 OK). NO `npm run build`.

## Addendum (post-GO): medio residual resuelto

Codex GO dejó 1 medio: la ruta manual legacy `closePositionEmergency` / `closeBotPosition`
(`convex/hyperliquid.ts`) seguía usando `sziAfter === 0`, así que podía colgarse con dust al desbloquear
ejecuciones legacy/JAV-37. Resuelto: `closePositionEmergency` ahora computa `const flat =
isFlatOrDust(sziAfter, markPx)`, lo usa en el gate de cancelación de órdenes, el log y el `reason`, y lo
**devuelve**; `closeBotPosition` chequea `closeRes.flat` en vez de `sziAfter === 0`. Además el aplanado
inicial (`if (!isFlatOrDust(szi, markPx))`) ya no intenta cerrar dust (HL lo rechazaría). Mismo patrón ya
auditado; `tsc` + 265 tests siguen verdes.
