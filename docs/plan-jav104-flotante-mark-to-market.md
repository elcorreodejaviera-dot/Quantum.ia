# Plan JAV-104 — Flotante del Spot Grid marcado a mercado (precio vivo) + flag stale correcto

Rama: `elcorreodejaviera/jav-104-qsg-flotante-del-spot-grid-no-marca-a-mercado-usa-precio-de`.
**Money-path tocado de refilón**: añade una lectura de precio por ronda de reconcile; **no cambia la
colocación de órdenes ni el cálculo de niveles**. Decide GO / NO-GO con hallazgos (ALTO/MEDIO/BAJO).

## Problema (verificado en `master`)

La tarjeta del Spot Grid muestra `Ganancia total = realizado + flotante (a mercado)` (JAV-103), pero el
flotante **no marca a mercado**:

- `convex/spotGridBots.ts:336-339` (query `getSpotGridDetail`):
  ```ts
  const refPrice = bot.currentPrice ?? null;
  const STALE_MS = 5 * 60 * 1000;
  const priceStale = !bot.lastReconciledAt || Date.now() - bot.lastReconciledAt > STALE_MS;
  const floatingPnl = refPrice != null && heldQty > 1e-12 ? (refPrice - heldAvgCost) * heldQty : 0;
  ```
- `bot.currentPrice` es el **precio de CREACIÓN / ancla** (`schema.ts:521`), nunca se actualiza al vivo.
  `reconcileOneBot` (`convex/spotGridEngine.ts`) solo llama a `getSpotPrice` en la colocación inicial
  (línea 552); en estado estable no vuelve a leer el mercado ni lo persiste.
- Como el inventario se compró cerca del ancla, `heldAvgCost ≈ bot.currentPrice` ⇒ `floatingPnl ≈ 0`
  **siempre** (QA real: $0.06 vs +8.58 de BingX a $1000).
- **Bug 2:** `priceStale` se basa en `lastReconciledAt`, que solo sube cuando hay fills nuevos
  (`spotGridEngine.ts:666-668` → `setSpotGridFillCursor`). Un grid sano sin fills en 5 min muestra
  "precio desactualizado" aunque el cron corra cada minuto.

## Contrato invariante (NO romper)

- **`currentPrice` sigue siendo el ancla de creación** (sostiene "prometido == colocado" de JAV-101 y la
  protección del bug #103). NO se toca su semántica ni su uso en `pickInitialPlacementPrice` /
  `calculateGridLevels`.
- El flotante es **aproximación de DISPLAY** (ya documentado en `spotGridBots.ts:307`), no un ledger.
- Guards money-path intactos (lease, gate, simulationMode, exclusividad, kill switch).

## Cambios

### 1. Schema — `convex/schema.ts`
Añadir al doc `spot_grid_bots` (ambos opcionales, legacy-safe):
```ts
lastPrice: v.optional(v.number()),     // último precio spot VIVO observado en reconcile (mark-to-market)
lastPriceAt: v.optional(v.number()),   // ms epoch de esa lectura → base de priceStale
```
No tocar `currentPrice` (ancla).

### 2. Mutación para persistir el precio vivo — `convex/spotGridBots.ts`
Nueva `internalMutation` dedicada (una por ronda, bajo lease):
```ts
export const setSpotGridLastPrice = internalMutation({
  args: { botId: v.id("spot_grid_bots"), token: v.string(), lastPrice: v.number() },
  handler: async (ctx, { botId, token, lastPrice }) => {
    const bot = await ctx.db.get(botId);
    if (!leaseOk(bot, token)) return { ok: false as const };
    if (!Number.isFinite(lastPrice) || !(lastPrice > 0)) return { ok: false as const };   // rechaza NaN/Infinity y ≤ 0
    await ctx.db.patch(botId, { lastPrice, lastPriceAt: Date.now(), updatedAt: Date.now() });
    return { ok: true as const };
  },
});
```

### 3. Motor — `convex/spotGridEngine.ts`, `reconcileOneBot`
Tras resolver el asset (≈ línea 530, ya hay `resolved`) y antes de los pasos de fills, leer el precio vivo
**una vez por ronda** y persistirlo (no aborta el reconcile si falla):
```ts
try {
  const livePrice = await getSpotPrice(clients.info, resolved);
  if (livePrice > 0) {
    await ctx.runMutation(internal.spotGridBots.setSpotGridLastPrice, { botId, token, lastPrice: livePrice });
  }
} catch (e) {
  elog("spotgrid", "live_price_skip", { botId: String(botId), err: safeError(e) });
}
```
Notas:
- Colocarlo **fuera** del branch de bootstrap/colocación inicial para que corra en todas las rondas de un
  grid ya operando.
- **(Decisión Codex GO):** la primera implementación es **lectura por bot/ronda**. PERO si ya se obtuvo un
  `livePrice` en esa misma ronda (p.ej. la colocación inicial, línea 552), **reutilizarlo y persistirlo
  ahí mismo** — prohibido un segundo `getSpotPrice` redundante en la misma ronda.
- Reusa el `getSpotPrice` ya importado (`convex/spotGridEngine.ts:15`). No añade dependencias.

### 4. Query contable — `convex/spotGridBots.ts:336-339`
```ts
const refPrice = bot.lastPrice ?? bot.currentPrice ?? null;        // vivo si existe, ancla como fallback legacy
const STALE_MS = 5 * 60 * 1000;
const priceStale = !bot.lastPriceAt || Date.now() - bot.lastPriceAt > STALE_MS;
const floatingPnl = refPrice != null && heldQty > 1e-12 ? (refPrice - heldAvgCost) * heldQty : 0;
```
`lastPriceAt` es **estrictamente un campo interno de persistencia** usado solo para derivar `priceStale`;
**no se expone** en el response al cliente (la UI solo consume `priceStale`/`floatingPnl`/`heldQty`).

## UI — `src/components/SpotGridView.jsx`
Sin cambios de lógica: ya consume `accounting.floatingPnl` y `accounting.priceStale`. Verificar que el
sub-label "precio desactualizado" / "{heldQty} {baseAsset} en mano" sigue coherente.

## Estado: GO de Codex (typecheck OK, 188 tests OK). Condiciones fijadas: ver §3 (no doble lectura) y test obligatorio (§Comprobaciones).

## Riesgos / preguntas para Codex

1. **Coste/latencia:** +1 `getSpotPrice` por bot por ronda. **Resuelto (GO):** se acepta lectura por
   bot/ronda; compartir por símbolo/cuenta queda como optimización futura, no requisito.
2. **Idempotencia/lease:** `setSpotGridLastPrice` valida lease y `lastPrice > 0`. ¿Algún riesgo de
   carrera con otros patches del mismo doc en la ronda?
3. **Fallback legacy:** bots viejos sin `lastPrice` → `refPrice` cae a `currentPrice` (comportamiento
   actual) hasta el primer reconcile nuevo. ¿OK como transición?
4. **`priceStale` ahora mide frescura real del precio.** ¿5 min sigue siendo razonable frente al cron 1/min?
5. ¿El flotante a precio vivo puede confundir si el grid está pausado (no reconcilia)? → mostraría stale,
   que es correcto.

## Comprobaciones

- `npx tsc -p convex/tsconfig.json --noEmit` limpio.
- `npx vitest run` verde. Añadir test de la query contable: con `lastPrice` distinto de `heldAvgCost`,
  `floatingPnl = (lastPrice - heldAvgCost)·heldQty`; y `priceStale` por `lastPriceAt` viejo/ausente.
