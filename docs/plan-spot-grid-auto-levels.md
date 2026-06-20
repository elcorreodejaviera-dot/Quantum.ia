# Plan — Spot Grid: nº de niveles AUTOMÁTICO (default tipo BingX) + 0.5% por defecto

## Objetivo (UX)
Crear un Spot Grid debe ser **fácil**: el usuario pone **inversión + suelo** y el sistema
**calcula solo el nº de niveles**, cubriendo el rango (suelo → precio actual) al profit% elegido,
**topado por el mínimo de Hyperliquid ($10/orden)**. Profit por defecto **0.5%** (ganancias pequeñas
pero constantes). Objetivo: acercarnos al comportamiento del Infinity Grid de BingX **con el mismo
capital** (comparación justa BingX vs nosotros a 1 mes).

## Estado actual (lo que hay que cambiar)
- Front `CreateGridForm`: `gridProfit` default `'1'`; `gridCount` default `'10'`; en modo básico
  `doCreate` **fija `count = 10`** (hardcode) → el grid solo cubre ~`10×profit%` por debajo del
  precio (con 0.5% ≈ 5%), NO baja hasta el suelo. (Caso real: suelo $45k pero solo cubrió a ~$60.8k.)
- Action `createSpotGridBot` (`convex/spotGridActions.ts`) recibe `gridCount` + `orderSize`
  explícitos del front.
- `validateGridInputs` (`convex/spotGridBots.ts`): `gridCount` entero ≥1; `orderSize ≥
  MIN_SPOT_NOTIONAL_USD` (=10); `orderSize×gridCount ≤ investmentAmount`.
- Motor `calculateGridLevels`: stepea desde `currentPrice` hacia abajo `gridCount` niveles a
  `(1+profit%)`. `minPrice` NO se usa como extensión del grid (solo floor de validación).

## Diseño propuesto

### 1) Helper PURO nuevo y testeable: `deriveAutoGrid`
Entradas: `currentPrice, minPrice, gridProfitPercent, investmentAmount, szDecimals, feeRate,
minNotional=10`.
**(Codex r4 MEDIO#1) Recibe `feeRate` — EXACTAMENTE el que se persistirá — porque el oráculo
`calculateGridLevels` lo usa en `solveSellPrice`; si difiere, el oráculo aceptaría niveles que el
motor luego rechaza (o al revés). Validar `feeRate` finito ≥ 0.**
**(Codex ALTO#2) Recibe `szDecimals`. (Codex MEDIO) El recuento de niveles NO se fija por la fórmula
cerrada sola, sino SIMULANDO con la misma lógica pura del motor (`calculateGridLevels`), para que lo
prometido == lo realmente colocado.**
```
step       = 1 + gridProfitPercent/100
sizeTick   = 10^(-szDecimals)
minNotEff  = minNotional + currentPrice * sizeTick     // colchón por truncado de tamaño (worst case = precio más alto)
nFull      = floor( ln(currentPrice / minPrice) / ln(step) )   // candidato (geométrico)
nCapital   = floor( investmentAmount / minNotEff )             // tope por capital con colchón
// (Codex ALTO#1) NO clamp hacia arriba. Rango/capital insuficientes → ERROR claro:
if nFull    < 2 -> throw "Rango demasiado estrecho para ≥2 niveles con este profit% (sube el % o baja el suelo)."
if nCapital < 2 -> throw "Capital insuficiente para ≥2 órdenes respetando el mínimo de HL (sube la inversión)."
nCand      = min( nFull, nCapital, ABS_MAX )

// (Codex r5 MEDIO#3) orderSize se calcula en CENTAVOS ENTEROS y el budget-check se hace en CENTAVOS,
// no en float. Razón: floor(x*100)/100 NO basta — 36.85*3 = 110.55000000000001 en JS, y
// validateGridInputs rechaza `>` (convex/spotGridBots.ts:38). Solución money-path:
//   invCents   = floor(investmentAmount*100 + 1e-6)
//   orderCents = floor(invCents / n)             // ⇒ orderCents * n ≤ invCents (entero, exacto)
//   orderSize  = orderCents / 100
floorQuoteForBudget(investmentAmount, n) -> { orderSize, orderCents, invCents }  // como arriba
// ⚠️ CAMBIO REQUERIDO en validateGridInputs (convex/spotGridBots.ts:38): el budget-check en CENTAVOS,
// con redondeo CONSERVADOR (ceil) para NO falso-aceptar orderSize manual con >2 decimales:
//   invCents   = floor(investmentAmount*100 + 1e-6)
//   orderCents = ceil(orderSize*100 - 1e-6)      // (Codex r6 MEDIO) ceil, no round
//   reject if  orderCents * gridCount > invCents
// Por qué ceil y no round: con orderSize=10.004, gridCount=3, investment=30.00, round(10.004*100)=1000
// (1000*3=3000 ≤ 3000) falso-ACEPTA aunque el coste real 30.012 > 30. Con ceil → orderCents=1001,
// 1001*3=3003 > 3000 ⇒ rechaza correctamente. Para AUTO (orderSize ya en cents exactos) ceil(3685-eps)
// =3685, sin penalización. Aplica a auto Y manual.
// (Higiene adicional, money-path) En modo MANUAL, canonicalizar/rechazar orderSize con >2 decimales
// ANTES de persistir (mensaje claro "orderSize: máximo 2 decimales") para no operar con centavos
// fantasma. El ceil es la red dura; la canonicalización evita sorpresas de UX.
// Se usa ESTE MISMO orderSize en el oráculo Y en persist → consistencia total.

// (Codex MEDIO) ORÁCULO: bajar n desde nCand hasta que calculateGridLevels acepte EXACTAMENTE n
// niveles. Aplica roundSpotPrice(raw, szDecimals, "floor") y rechaza niveles con buyPrice < minPrice
// o notional truncado < minNotional. orderSize (truncado) depende de n → se recomputa por iteración.
// Aceptación MONÓTONA al bajar n (menos profundidad, mayor orderSize) → el 1er n que cumple es el mayor.
for n in nCand down to 2:
    orderSize = floorQuoteForBudget(investmentAmount, n).orderSize   // centavos enteros ⇒ budget ≤ inv exacto
    if orderSize < minNotional: continue           // por el truncado quedó bajo el mínimo → prueba n menor
    { levels } = calculateGridLevels({ currentPrice, minPrice, gridProfitPercent, orderSize,
                                       gridCount: n, szDecimals, feeRate })
    if levels.length === n: break        // los n niveles son aceptados por el motor → usar este n
// si ningún n∈[2,nCand] cumple -> throw "No se pueden colocar ni 2 niveles válidos (ajusta suelo/%/capital)."
gridCount    = n
orderSize    = floorQuoteForBudget(investmentAmount, n).orderSize   // EXACTO el que va a persist (cents)
capped       = nFull > min(nCapital, ABS_MAX) || n < nCand   // no se cubre todo el rango
coveredFloor = precio del ÚLTIMO nivel aceptado por calculateGridLevels (NO la fórmula cerrada)
```
Salida: `{ gridCount, orderSize, capped, coveredFloor, nFull, nCapital, minNotEff }` (con `orderSize`
ya truncado a 2 decimales — EXACTO el que va a persist).
Guards previos: `currentPrice, minPrice, investmentAmount, gridProfitPercent, feeRate` finitos;
los 4 primeros > 0 y `feeRate ≥ 0`; `gridProfitPercent ∈ [0.5, 10]`; `minPrice < currentPrice`
(si `≥` → error "el suelo debe estar por debajo del precio actual").
**Clave (Codex MEDIO):** `gridCount` y `coveredFloor` salen de lo que `calculateGridLevels` ACEPTA
realmente (incluido el redondeo `roundSpotPrice(...,"floor")` del último nivel), no de la fórmula
geométrica → imposible prometer más niveles/cobertura de los que el motor coloca.
Nota perf: el bucle reusa la función pura del motor sin RPC; en la práctica acierta en 1ª/2ª
iteración (solo recorta si el último nivel cae bajo el suelo por el tick).

### 2) Comportamiento "capital corto" (DECISIÓN USUARIO)
Mantener el **0.5% del usuario** (NO ensancharlo a sus espaldas). Si el capital no cubre hasta el
suelo (`capped`), **cubrir lo que alcance** (los `nMax` niveles desde el precio hacia abajo) y
**AVISAR** en la UI: "Con $X cubre de $cur a $coveredFloor; para llegar a tu suelo $floor harían
falta ~$Z". **(Codex BAJO)** `Z = nFull × minNotEff` (NO `nFull×$10`): el capital requerido usa el
mínimo efectivo con colchón de truncado, si no se subestima. (Idealmente, derivar `Z` con el mismo
helper para que sea exacto.)

### 3) Backend `createSpotGridBot` — flujo redISEÑADO (Codex MEDIO#2)
Hoy `preflightCreateSpotGridBot` EXIGE y valida `gridCount`/`orderSize` ANTES de tocar HL; si los
hacemos opcionales sin más, el preflight se rompe. Rediseño en 3 fases:
1. **Preflight común (sin count):** validar lo que NO necesita el nº de niveles — permisos
   (canManageBots+canTradeLive), switches live-only, gate mainnet, ownership, exclusividad de cuenta,
   y los inputs base (`investmentAmount>0`, `minPrice>0`, `gridProfitPercent∈[0.5,10]`, **(Codex r5
   MEDIO#2) `feeRate` finito ≥0**). NO toca HL. (feeRate ya es input del helper y del motor → validarlo
   aquí, antes de tocar HL, igual que el resto.)
2. **Derivar (auto) tras HL-meta:** tras `resolveSpotAsset` (da `szDecimals`) + `getSpotPrice`
   (precio spot real), si `auto` → `deriveAutoGrid(currentPrice, minPrice, gridProfitPercent,
   investmentAmount, szDecimals, **a.feeRate**)` → fija `gridCount`/`orderSize`. **(Codex r5 MEDIO#1)
   el `feeRate` que entra al helper/oráculo es EXACTAMENTE `a.feeRate` ya validado, y es el MISMO que
   se persiste** (nunca un default distinto). Si `auto:false` → usa los `gridCount`/`orderSize` explícitos.
3. **Persistir con revalidación COMPLETA:** `persistSpotGridBot` vuelve a correr `validateGridInputs`
   (con el budget-check en CENTAVOS, ver §1 helper) sobre los valores finales (auto o manuales) →
   `orderSize≥$10`, `orderSize×gridCount≤investment` (en cents), `gridCount` entero ≥1, `feeRate≥0`.
   Red de seguridad: si el auto produjera algo inválido, falla aquí (no inserta).
- Args: `gridCount`/`orderSize` **opcionales** + `auto: boolean`. Devolver `{capped, coveredFloor,
  gridCount, orderSize}` para que la UI muestre el resultado real.
- Mantener TODOS los demás guards intactos.

### 4) Frontend `CreateGridForm`
- `gridProfit` default **'0.5'**.
- Modo básico = **AUTO**: no enviar `gridCount`/`orderSize` fijos; `auto:true`. Mostrar estimación
  en vivo del nº de niveles usando `refPrice` (allMids) y, si `capped`, la nota de cobertura.
  (La estimación del front es orientativa; el backend con el precio spot real es la fuente de verdad.)
- "Opciones avanzadas" sigue permitiendo fijar nº de niveles / orderSize manualmente (`auto:false`).

## Riesgos / edge cases a auditar
- **`ABS_MAX = 50` (Codex MEDIO#1)**: alineado con el cap de lectura de `getSpotGridDetail` (~50) para
  NO crear más órdenes reales de las que la UI puede mostrar. La colocación es serial (1 RPC + lease
  por orden) → 50 es un techo razonable por ronda. Subirlo por encima de 50 EXIGIRÍA, en otra issue:
  (a) elevar/paginar el cap de `getSpotGridDetail`, y (b) colocar por lotes entre reconciles (no todo
  en una ronda). Por ahora ABS_MAX=50 y, si `nFull>50`, `capped=true` + aviso.
- Redondeos: `orderSize` debe seguir ≥ $10 tras dividir y tras `floorSpotSize`/szDecimals.
  `n=floor(inv/10)` lo garantiza salvo el redondeo de tamaño → revisar que no caiga bajo notional.
- `currentPrice` backend (spot real, getSpotPrice ya corregido por `coin`) vs `refPrice` front (perp)
  difieren ~0.1% → estimación del front aproximada; el grid lo fija el backend.
- `minPrice ≥ currentPrice`, capital < $20, `gridProfitPercent` fuera de rango (0.5–10).
- Consistencia: el auto debe pasar `validateGridInputs` (que sigue corriendo como red de seguridad).
- Comparación justa BingX: **mismo capital**; aun así nuestro nº de órdenes será menor que BingX
  porque HL exige $10/orden y BingX permite ~$4 (limitación de plataforma, no de estrategia). El
  motor sigue siendo "compra-primero" (sin sembrar inventario) — fuera del alcance de este plan.

## Money-path
SÍ (afecta nº y tamaño de órdenes reales). Flujo: este plan → **Codex GO (plan)** → implementar →
**Codex GO (código)** → PR → CodeRabbit → merge → `convex deploy` + verificar `HL_NETWORK=mainnet`.

## Tests sugeridos (no-mock; lógica pura) — ampliados (Codex BAJO)
- `deriveAutoGrid`: rango amplio (cubre, no capped); capital corto (capped, `coveredFloor` correcto);
  capital justo; `minPrice ≥ currentPrice` (throw); `nFull < 2` rango estrecho (throw, NO clamp a 2);
  `nMax < 2` capital insuficiente (throw); `nFull > ABS_MAX` (capped a 50); 0.5% vs 1%.
- **Notional post-`floorSpotSize`**: con `szDecimals` de BTC, verificar que el `orderSize` derivado
  produce niveles cuyo notional truncado **sigue ≥ $10** (que `calculateGridLevels` NO los rechace) —
  incluido el nivel de precio más alto (peor caso del colchón `minNotEff`).
- **Invariantes de salida**: `orderSize ≥ minNotional`, `orderSize×gridCount ≤ investment`,
  `gridCount` entero, `2 ≤ gridCount ≤ ABS_MAX`.
- **(Codex r5 MEDIO#3) budget en centavos**: casos "feos" donde el float falla — `investment=110.55,
  n=3` (floorQuote daría 36.85 y `36.85*3=110.55000000000001 > 110.55`), `100.01/5`, etc. Con
  `floorQuoteForBudget` (cents enteros) + budget-check en cents con **ceil**: `ceil(orderSize*100-eps)×
  gridCount ≤ invCents`. AUTO no se rechaza por coma flotante; y MANUAL con >2 decimales que se pasa
  del presupuesto SÍ se rechaza: test `orderSize=10.004, gridCount=3, investment=30.00` → debe
  **rechazar** (real 30.012 > 30; `round` lo aceptaría por error, `ceil` no). Test directo a
  `validateGridInputs` para ambos sentidos (auto válido pasa, manual fantasma rechaza).
- **(Codex r4 MEDIO#1) feeRate**: el `feeRate` pasado al oráculo == el persistido; variar feeRate
  (0, 0.0004, alto) y confirmar que la aceptación de niveles (vía `solveSellPrice`) es consistente
  entre `deriveAutoGrid` y lo que el motor coloca después.
- **Coherencia prometido vs real (Codex MEDIO)**: `gridCount` devuelto == nº de niveles que
  `calculateGridLevels` acepta; `coveredFloor` == precio del último nivel aceptado.
- **Borde de redondeo de precio (Codex BAJO)**: último nivel con `raw` pegado a `minPrice` que tras
  `roundSpotPrice(raw, szDecimals, "floor")` cae **debajo del suelo** → `deriveAutoGrid` debe reducir
  `n` (el oráculo lo detecta) y NO prometer ese nivel. Verificar con precios/tick reales (BTC/ETH).
- Valores **no finitos / negativos / 0** y `gridProfitPercent` fuera de [0.5,10] → throws claros.
