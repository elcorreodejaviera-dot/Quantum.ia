# Auditoría de CÓDIGO — fixes CodeRabbit JAV-103 (siembra de inventario) — PR #106

Eres un auditor de seguridad money-path. Revisa SOLO el diff de estos fixes sobre `feat/jav103-seeding`
(no el PR entero, ya auditado en r1/r2). Verifica cada hallazgo contra el código actual; reporta GO/NO-GO con
severidad (ALTO bloquea, MEDIO según criterio, BAJO no bloquea). Contexto: HL spot, cuenta DEDICADA por bot,
contratos ya vigentes (DB-intent, idempotencia por cloid, gate revalidado, fencing por lease/token).

## Qué se cambió (4 hallazgos Major de CodeRabbit)

### #1 — Presupuesto de slippage del seed (`convex/spotGridEngine.ts`, `deriveSeededGrid`)
- Antes: `deriveSeededGrid` repartía el 100% de `investmentAmount`. El seed se compra con LIMIT IOC agresivo;
  si llena por encima del ancla podía hacer que `M·orderSize` (BUYs reservadas) + `seedNotional·(1+slip)`
  superase `investmentAmount`.
- Ahora: nueva constante `SEED_SLIPPAGE_BUDGET_MAX = 0.02` (= techo del clamp de `getSeedMaxSlippageInternal`).
  La derivación calcula `budgetForOrders = investmentAmount / (1 + SEED_SLIPPAGE_BUDGET_MAX)` y lo usa en
  `nCapital` y en `floorQuoteForBudget`. `seedPercent` se sigue reportando contra el `investmentAmount`
  original (informativo).
- Invariante a verificar: `M·orderSize + seedNotional·(1+slip) ≤ investmentAmount` para **cualquier**
  `slip ≤ SEED_SLIPPAGE_BUDGET_MAX`. Cubierto por test nuevo en `tests/spotGridEngine.test.ts`.
- **Determinismo creación↔bootstrap**: se usa una CONSTANTE (no el valor live del config) → el reparto es
  idéntico en `spotGridActions.createSpotGridBot` y en `runSeededBootstrap` (prometido==colocado). CONFIRMAR
  que no introduce desajuste de gridCount/orderSize/seedQtyTarget entre ambos.

### #2 — Contabilidad de display descuenta liquidaciones (`convex/spotGridBots.ts`, `getSpotGridDetail`)
- Las órdenes `kind:"liquidation"` (SELL del stop) NO se vuelven ciclo → sin restarlas el inventario contable
  quedaba inflado tras Stop+liquidar.
- Ahora se acumulan `liquidatedQty`/`liquidatedCost` (filled/partial sells con `kind==="liquidation"`) y se
  suman a `soldQty`/`soldCost`. Coste por unidad liquidada = `o.costBasis ?? bot.seedAvgPx ?? o.avgFillPx ?? o.price`.
- Es DISPLAY (aproximación), no ledger. CONFIRMAR que no hay doble-conteo ni `heldQty` negativo (hay `Math.max(0,…)`).

### #3 — `getHeldInventoryInternal` fail-closed (`convex/spotGridBots.ts` + `convex/spotGridEngine.ts`)
- Esta query decide cuánto liquida el stop: `min(free, heldQty)`. Antes: `take(cap+1)` sin validar
  truncamiento y sin restar liquidaciones → `heldQty` podía quedar inflado.
- Ahora: resta `liquidatedQty` (mismo criterio que #2) y devuelve `{ heldQty, truncated }`. El engine
  (`stopSpotGridBot`) aborta fail-closed con error reintentable si `truncated===true`, ANTES de colocar la
  liquidación. CONFIRMAR: (a) no se sobre-vende (sigue acotado por `free`); (b) el post-check tras la venta
  ya descuenta la liquidación recién hecha (`heldAfter`); (c) el error deja el bot reintentable, no perdido.

### #4 — UI marca KPIs parciales (`src/components/SpotGridView.jsx`)
- KPI "Ganancia total" muestra `sub='parcial (tope de lectura contable)'` cuando `accounting.accountingTruncated`.
  Frontend, no money-path.

## Foco del auditor (busca FALLOS, no estilo)
1. ¿El recorte de presupuesto del #1 puede dejar `M<2` o `K<2` y hacer fallar creación de grids antes válidos
   de forma sorpresiva? ¿Rompe algún invariante de `calculateGridLevels`/`calculateSellLadder`?
2. ¿`getHeldInventoryInternal` y `getSpotGridDetail` cuentan la MISMA base dos veces, o restan de menos/más?
   ¿Qué pasa con liquidaciones `partially_filled` reintentadas (varios cloids)? ¿se suman sin doble-conteo?
3. ¿El fail-closed por `truncated` puede dejar un bot atascado sin salida (ni stop sin liquidar)? ¿Hay ruta
   "detener sin liquidar"?
4. Carreras: el stop corre bajo lease/token; ¿la lectura `truncated` y la venta son coherentes si llegan
   fills nuevos en medio?
5. ¿Algún secreto/clave en logs nuevos? (no debería haber logs nuevos).

Responde: GO / NO-GO con lista de hallazgos (severidad + archivo:línea + fix sugerido).
