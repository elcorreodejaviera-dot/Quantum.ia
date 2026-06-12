# Plan — Autoleverage (función de seguridad de cobertura)

## Problema

Hoy, cuando un bot tiene `autoLeverage = true`, el backend **fuerza leverage = 1x** en
los dos motores:

- `convex/hyperliquid.ts:404` — `executePerpMarketOrder` (ejecución manual / JAV-37).
- `convex/triggerEngine.ts:121` — `armPoolBotEntry` (motor automático IL / JAV-44).

```js
const effLev = (!bot.autoLeverage && bot.leverage !== undefined) ? bot.leverage : 1;
```

1x es el peor caso: exige el **máximo** margen. Es lo contrario de lo que dice la UI
(`BotPortal.jsx:2192`): *"Permitir auto-ajuste de leverage si el balance es insuficiente"*.
Resultado: activar "Auto" hoy **rompe** la apertura por falta de margen.

## Semántica acordada con el usuario

Autoleverage es una **función de seguridad** para poder **proteger al menos el monto del
pool** aunque el colateral en Hyperliquid sea pequeño.

- Apalancamiento **estándar / base = 10x**.
- Si con 10x el colateral disponible **no** cubre el nocional del pool, el sistema **sube**
  el multiplicador automáticamente, **solo lo justo**, hasta un **tope de 20x**.
- Nunca por encima de **20x** (decisión explícita del usuario) ni por encima del
  `maxLeverage` del activo en HL (lo que sea menor).
- El cálculo respeta el **mismo `MARGIN_SAFETY_BUFFER = 0.10`** que el gate de margen: el
  margen exigido (`notional/lev`) debe caber en `availableCollateral*(1-0.10) − marginCommitted`,
  no en el colateral bruto. Auto-leverage **sí** aplica el buffer (coherencia con el gate;
  evitar dos definiciones de "cabe").
- Ejemplo (idea del usuario, con el buffer ya aplicado): pool $1,000.
  - A 10x el margen es $100; usable = colateral·0.9; con un wallet pequeño no cabe → sube.
  - Para que el pool quepa **a 20x** (margen $50) hace falta `colateral·0.9 ≥ 50` ⇒
    **colateral ≥ $55.56**. Con $55.56 → 20x abre justo; con menos → `[blocked_margin]`.
  - Con colateral intermedio (p.ej. $60 → usable $54): `needed = ceil(1000/54) = 19` ⇒ usa
    **19x** (sube "solo lo justo", sin llegar al tope).

> Nota: la descripción del usuario mencionó "hasta 25x ETH / 40x BTC" como ilustración del
> concepto general de HL, pero el **tope que aplicamos** es **20x** (su selección explícita).
> Si más adelante quiere tope por-activo o configurable por admin, es una extensión aparte.

### Comportamiento en los bordes

- Si `autoLeverage = false` → flujo actual sin cambios (usa `bot.leverage`, valida rango).
- Si con colateral grande el nocional cabe incluso por debajo de 10x → **se usa 10x** (base);
  auto **solo sube**, no baja del estándar. (Clamp: `min(cap, max(10, needed))`.)
- Si `maxLeverage` del activo < 10 → el clamp resuelve a `cap = min(20, maxLeverage)` (usa el
  máximo del activo aunque sea < 10).
- Si **ni a 20x** (ni al `maxLeverage`) cabe el nocional del pool → **NO** se abre una
  posición infradimensionada en silencio: la reserva falla con `[blocked_margin]` y mensaje
  claro ("fondea la wallet"). Proteger el pool a medias sería peor que fallar visible.

## Diseño

La decisión del leverage debe ser **atómica con el gate de margen**, que vive en las
mutations `reserveArm` (`triggerArms.ts:188`) y `reserveExecution` (`executions.ts:200`),
porque solo ahí se conoce `marginCommitted` (margen ya comprometido por otras órdenes de la
misma cuenta, sumando ambos motores). Por eso **la resolución del leverage se mueve a esas
mutations**, no se queda en el action.

Usable real = `availableCollateral * (1 - MARGIN_SAFETY_BUFFER) - marginCommitted`
(idéntico al denominador del gate existente; reutilizamos `MARGIN_SAFETY_BUFFER = 0.10`).

### Helper compartido `resolveAutoLeverage` (única fuente de verdad)

Función **pura** en un módulo compartido (p.ej. `convex/leverage.ts`), usada por ambas
mutations. Decide leverage **y** margen juntos, para que ninguna mutation recalcule el margen
por su cuenta.

Firma e contrato:

```ts
// Devuelve SIEMPRE ambos campos coherentes entre sí, o lanza.
function resolveAutoLeverage(args: {
  autoLeverage: boolean;
  manualLeverage?: number;     // bot.leverage cuando autoLeverage = false
  reservedNotional: number;    // worst-case (2× en OCO)
  availableCollateral: number;
  marginCommitted: number;
  assetMaxLeverage: number;
}): { appliedLeverage: number; marginRequired: number }
```

Validación de argumentos (fail-closed, **antes** de calcular):
- `reservedNotional`, `availableCollateral`, `marginCommitted` finitos y `>= 0`
  (`reservedNotional > 0`). NaN/Infinity ⇒ `Error("[blocked_config] ...")`.
- `assetMaxLeverage`: **estrictamente** `Number.isInteger(value) && value >= 1`. NO aplicar
  `Math.floor` silencioso: un `20.9` inesperado se **rechaza** con `[blocked_config]` (metadata
  no fiable), no se trunca a 20.

Cálculo:

```text
usableReal = availableCollateral * (1 - MARGIN_SAFETY_BUFFER) - marginCommitted   // 0.10

// modo manual: leverage = round(manualLeverage) acotado al rango actual (igual que hoy)
// modo auto:
hardCap = min(AUTO_LEVERAGE_CAP, assetMaxLeverage)           // ambos enteros; AUTO_LEVERAGE_CAP = 20
if (usableReal <= 0) -> throw "[blocked_margin] sin colateral usable"
needed  = ceil(reservedNotional / usableReal)                 // entero
lev     = min(hardCap, max(STANDARD_AUTO_LEVERAGE, needed))    // STANDARD = 10
if (needed > hardCap) -> throw "[blocked_margin] ni al tope cabe (fondea la wallet)"

marginRequired = reservedNotional / lev
return { appliedLeverage: lev, marginRequired }
```

- `reservedNotional` ya contempla el factor 2× del OCO (dos entradas) en el motor IL: el
  leverage se dimensiona sobre el **peor caso**, igual que el margen reservado. Coherente.
- Errores por **capacidad** insuficiente ⇒ `[blocked_margin]`; por **parámetros/metadata**
  inválidos ⇒ `[blocked_config]`.
- La mutation aplica el `marginRequired` devuelto al gate existente (no recalcula) y **devuelve**
  `appliedLeverage` al action para `exchange.updateLeverage(...)`. Invariante: leverage enviado
  a HL == leverage usado para el margen.
- En el motor IL, la **reducción posterior 2×→1×** (`reduceArmReservation`, `triggerArms.ts:310`)
  divide `marginReserved` por el factor sobre el `appliedLeverage` ya fijado en el arm (no
  reabre la decisión de leverage). Verificar que sigue siendo consistente.

### `maxLeverage` del activo

`getAssetMeta` (`hyperliquid.ts:123`) debe devolver también `maxLeverage`, leído de
`meta.universe[idx].maxLeverage` (campo estándar de la HL Info API). Validar **estrictamente
`Number.isInteger(maxLeverage) && maxLeverage >= 1`**; si no, **fallar cerrado** (no truncar,
no asumir un máximo). El action lo pasa a la mutation (`reserveArm`/`reserveExecution`).

## Cambios por archivo

1. **`convex/hyperliquid.ts`**
   - `AssetMeta` + `getAssetMeta`: añadir `maxLeverage` (validado, fail-closed).
   - `executePerpMarketOrder`: quitar el `: 1` y el cálculo local de leverage. Pasar
     `autoLeverage`, `manualLeverage: bot.leverage`, `assetMaxLeverage` (de `getAssetMeta`) a
     `reserveExecution`; recibir `appliedLeverage` y usarlo en `updateLeverage`. El helper
     resuelve tanto el modo auto como el manual (única fuente).
   - Exportar las constantes `STANDARD_AUTO_LEVERAGE`/`AUTO_LEVERAGE_CAP` o definirlas en un
     único sitio compartido (evitar divergencia, como ya pasa con `MARGIN_SAFETY_BUFFER`
     duplicado en dos archivos — ojo, replicar el patrón existente o centralizar).

2. **`convex/executions.ts`**
   - `reserveExecution`: aceptar `autoLeverage`, `manualLeverage`, `assetMaxLeverage`. Resolver
     `{appliedLeverage, marginRequired}` con el helper compartido usando
     `committedMarginForAccount` + `availableCollateral`, **antes** del gate `:200`. Persistir
     `appliedLeverage` (campo nuevo del schema, ver §Schema) y `marginReserved = marginRequired`.
     Devolver `appliedLeverage`.
   - **Ruta de idempotencia (explícita, Codex #3):** `reserveExecution` puede devolver una
     reserva ya creada por una carrera (`executions.ts:177`). Reglas:
     - **Reserva NUEVA:** resuelve, persiste y devuelve `appliedLeverage` + `marginRequired`.
     - **Reserva EXISTENTE (carrera/dedupe):** **nunca** recalcula ni sobrescribe
       `appliedLeverage`/`marginReserved`; devuelve los **persistidos** tal cual (el campo
       persistido es `marginReserved`, no `marginRequired` — ese nombre solo es interno del helper).
     - **Registro LEGACY sin `appliedLeverage`** (filas previas a este cambio): solo se
       **reconcilia**; **no** se vuelve a llamar `updateLeverage` (el leverage en HL ya quedó
       fijado en su envío original). El action, ante una respuesta `deduped`/existente, **no**
       ejecuta `updateLeverage` — igual que hoy retorna temprano en las ramas dedupe
       (`hyperliquid.ts:450-495`); confirmar que ninguna rama dedupe cae al `updateLeverage`.

3. **`convex/triggerArms.ts`**
   - `reserveArm`: aceptar `autoLeverage`, `manualLeverage`, `assetMaxLeverage`. Resolver
     `{appliedLeverage, marginRequired}` con el helper compartido (usando
     `committedMarginForAccount` + `availableCollateral` que ya calcula). Sustituir el
     `appliedLeverage` que hoy llega del action por el resuelto, y usar `marginReserved =
     marginRequired` antes del gate `:188`. Persistir en el arm (`schema.ts:317`). Devolver
     `appliedLeverage` en `reservation`.

4. **`convex/triggerEngine.ts`**
   - `armPoolBotEntry`: quitar el `: 1` y el cálculo local de `appliedLeverage`/`orderMargin`
     basado en él. Pasar `autoLeverage`, `manualLeverage: bot.leverage`, `assetMaxLeverage` a
     `reserveArm`; recibir `appliedLeverage` de la reserva y usarlo en `updateLeverage` (`:236`)
     y para el `orderMargin` de la reducción OCO. El gate atómico `gateArmBeforeOrder` no cambia.
   - Reordenar si hace falta: hoy `effLev` se calcula en `:121` antes de `getAssetMeta`
     (`:127`); con el nuevo diseño la decisión ocurre dentro de `reserveArm`, así que solo
     necesitamos `assetMaxLeverage` (de `getAssetMeta`) disponible antes de llamar a la
     reserva — ya lo está.

5. **`src/components/BotPortal.jsx`** (UI, opcional pero recomendable)
   - La etiqueta "Leverage: Auto" (`:701`, `:842`) puede mostrar el leverage efectivo si el
     backend lo expone, pero **no** es necesario para el fix. El texto del checkbox ya es
     correcto. No tocar lógica de capital en el cliente (el backend es la autoridad).

## Invariantes que se preservan (no romper)

- Leverage entero (HL solo acepta enteros): el algoritmo usa `ceil`/clamp a entero.
- `appliedLeverage` enviado a HL == el usado para `marginReserved`/`marginRequired`.
- Gate de margen atómico con `MARGIN_SAFETY_BUFFER` y `committedMarginForAccount` (ambos
  motores) **sin cambios** — solo cambia el leverage de entrada.
- `reservedNotional` con factor 2× del OCO sigue gobernando el dimensionado del leverage.
- Fail-closed: sin `maxLeverage` fiable, o si no cabe ni al tope → `[blocked_margin]`/error,
  nunca posición infradimensionada silenciosa ni leverage > activo/20x.
- `autoLeverage = false` ⇒ comportamiento idéntico al actual.

## Cambios de schema

- `trigger_arms.appliedLeverage` **ya existe** (`schema.ts:317`).
- `execution_requests` **NO** lo tiene (solo `marginReserved`, `schema.ts:262`). **Añadir
  `appliedLeverage: v.optional(v.number())`** para no invalidar las filas existentes (legacy
  sin el campo). Es el único cambio de schema.
- `maxLeverage` viaja en memoria (action→mutation), no se persiste.
- Requiere `node node_modules/convex/bin/main.js deploy` (type-check real + validación de
  schema), no solo `codegen`.

## Pruebas (en mainnet beta real, sin mocks — política del proyecto)

1. autoLeverage OFF → leverage manual igual que hoy (regresión).
2. autoLeverage ON, colateral holgado → usa 10x (base, no baja).
3. autoLeverage ON, colateral justo (pool $1000, colateral $55.56 → usable $50) → sube a 20x,
   abre, margen $50 cabe. Con $60 → 19x (sube solo lo justo).
4. autoLeverage ON, colateral insuficiente incluso a 20x (p.ej. $40) → `[blocked_margin]`
   claro, no abre.
5. Activo con `maxLeverage` < 20 → respeta el máximo del activo (hardCap = maxLeverage).
6. **Concurrencia:** colateral suficiente aislado pero insuficiente tras `marginCommitted`
   de otra orden viva → el leverage sube o falla según el usable real, nunca subreserva.
7. **OCO (2 entradas):** `reservedNotional = 2 × orderNotional` → el leverage se calcula
   sobre 2×; tras el OCO, `reduceArmReservation` divide el margen reservado 2×→1× sin
   reabrir la decisión de leverage (el `appliedLeverage` del arm queda fijo).

## Flujo

Plan → **Codex audita el plan** → implementar → **Codex audita el código** → commit (sin
push) → PR → **CodeRabbit** → aplicar → merge → `node node_modules/convex/bin/main.js deploy`
(type-check real; ojo: szDecimals/undefined no lo caza codegen) → verificar `HL_NETWORK` →
prueba real.
