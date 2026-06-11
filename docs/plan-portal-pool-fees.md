# Plan — Fees acumulados (sin cobrar) de la posición LP + fix filtro de cadenas (JAV-UI-2)

Rama `feat/portal-pool-fees` (base master). Dos cambios.

## F0 — Fix del filtro de cadenas (regresión del PR #24, ya implementado)
El scroll horizontal de `.network-segmented` (A del #24) ocultaba cadenas al deslizar y no
gustó. Cambiado a **wrap** (varias filas, todas visibles, sin desplazamiento lateral).
- `src/styles/bot-portal.css`: `.network-segmented { flex-wrap: wrap; }` +
  `.network-segmented button { flex: 1 1 auto; white-space: nowrap; }`. Eliminado el
  `overflow-x:auto`/`nowrap`/ocultar-scrollbar y el override móvil `flex:0 0 auto` (los botones
  vuelven a `flex:1` de la media query → llenan cada fila). Solo CSS.

## F1 — Fees acumulados SIN COBRAR de la posición (en tiempo real)
**Objetivo:** mostrar en la PoolCard las comisiones que la posición LP ha ganado y aún NO ha
cobrado (lo que Uniswap/Revert enseñan como "unclaimed fees"), en USD.

**Decisión:** SOLO sin cobrar en tiempo real (no el total histórico — necesitaría `eth_getLogs`
archival, descartado por coste/fiabilidad en RPC gratis). SIN cambios de schema: se computa en la
action `fetchPositionLiquidity` (igual que `liquidityUsd`) y se devuelve al cliente, que ya mergea
ese objeto en el pool.

### Método PRIMARIO — `collect` simulado vía `eth_call` (Codex 2ª ronda)
Codex confirmó (NonfungiblePositionManager.sol) que `collect()` **recalcula los fees actuales**:
si la posición tiene liquidez, internamente ejecuta `pool.burn(tickLower, tickUpper, 0)` (poke),
relee `feeGrowthInside` y suma el incremento a `tokensOwed` ANTES de cobrar. Por tanto un `eth_call`
de `collect` (simulación sin persistencia) con `from = ownerOf(tokenId)` devuelve el **importe
cobrable AHORA (real-time)**, NO un checkpoint obsoleto. → Esto evita TODA la aritmética manual de
feeGrowth/wraparound (que era la fuente de los 6 hallazgos de la 1ª ronda).

**Llamadas (2, ambas `eth_call`):**
1. `ownerOf(tokenId)` — selector `0x6352211e` (ya se usa en el bloque Revert). Da `owner`.
2. `collect(CollectParams)` — selector `0xfc6f7865`, firma
   `collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max))`.
   Struct de campos estáticos → ABI inline (sin puntero): `tokenId(32) | recipient(32) |
   amount0Max(32) | amount1Max(32)` = 128 bytes. `recipient = owner`,
   `amount0Max = amount1Max = 2^128-1` (uint128 max, 16 bytes FF left-padded a 32).
   **`from = owner`** en el objeto de `eth_call` (collect exige `isAuthorizedForToken`; el static
   call no transfiere pero la EVM evalúa el guard con `msg.sender = from`).
   Return: `(uint256 amount0, uint256 amount1)` = fees cobrables raw (token0, token1).

`eth_call` debe soportar `from` (hoy el helper manda solo `{to, data}`): añadir `from` opcional.
Las 2 llamadas no requieren mismo-bloque entre sí (owner es estable; collect es UNA sola
evaluación atómica → sin el problema de estados mezclados de la 1ª ronda). Usar
`rpcCallWithFallback` (rotación de proveedor por llamada) está bien aquí.

### Orden INDEPENDIENTE del cálculo de fees (Codex 3ª ronda #1)
El bloque de fees es **autocontenido y no depende del flujo de la liquidez**: ni de sus
early-returns (`liqRaw===0n`, `sp<=0`, `liquidityUsd<=0`, fallo del factory/slot0) ni del orden en
que se calcula `liquidityUsd`. Se computa en su PROPIA secuencia (ownerOf → collect → convertir),
con su PROPIO try/catch, leyendo sus propios datos (no reutiliza `sp`/amounts de la rama de
liquidez). Así, aunque la liquidez devuelva 0/temprano, los fees se intentan igual; y un fallo de
fees no afecta a la liquidez. Las dos métricas (liquidityUsd, feesUncollectedUsd) son ortogonales.

### Metadata de tokens SIN defaults silenciosos (Codex 3ª ronda #2)
`decimals`/`symbol` de token0/token1 NO se asumen (nada de "default 18"): si `tokenInfo` no los
devuelve o son inválidos (`decimals` no entero en [0,255], símbolo vacío) → la conversión a USD es
imposible de forma fiable → `feesUncollectedUsd = null`. Un decimals erróneo daría un USD off por
órdenes de magnitud; preferimos "—" a un número falso. (Aplica a la rama de fees; `invert` depende
del símbolo, que también debe estar validado.)

### Conversión a USD
`fees0 = Number(amount0) / 10^t0.decimals`, `fees1 = Number(amount1) / 10^t1.decimals` (decimales
ya leídos para liquidez). Validar que `amount0/amount1` (BigInt) caen en `[0, 2^128)` antes de
`Number()` (cota natural; descarta basura → `feesUncollectedUsd = null`). USD con la MISMA lógica
`invert` (token0 estable vs base) que `liquidityUsd`:
```
feesUsd = invert ? fees0 + fees1*priceUsd : fees0*priceUsd + fees1
```

### Liquidez cero ≠ sin fees
Una posición con liquidez 0 (retirada pero sin cobrar) puede tener fees pendientes. `collect`
simulado los devuelve igualmente (con liq 0 no hace burn, pero devuelve los `tokensOwed`
existentes). → NO cortar el cálculo de fees por la salida temprana `if (liqRaw===0n)` actual
(que es para `liquidityUsd`).

### Fallback (DIFERIDO en v1)
Codex sugiere mantener el cálculo MANUAL feeGrowthInside como fallback si un RPC rechaza la
simulación `collect` (algunos rechazan `eth_call` con `from`/state-touching) o el owner es un
contrato con restricciones raras. **v1: si `collect` falla en TODOS los proveedores →
`feesUncollectedUsd = null`** (UI muestra "—", nunca un número inventado). El manual queda
documentado para una 2ª iteración si se ve que falla a menudo (su complejidad y los 6 hallazgos
de wraparound no justifican meterlo ya). Apéndice con la fórmula manual al final por si se retoma.

### Retorno de la action (null ≠ 0)
Añadir a `fetchPositionLiquidity`: `feesUncollectedUsd` (number ≥0 **o `null`**), y opcionalmente
`fees0`/`fees1`. **`null` = no se pudo leer** (RPC falló / fuera de rango); **0 = leído y no hay
fees**. NO colapsar ambos a 0 (UI: null→"—", 0→"$0"). Las llamadas de fees + cálculo van en su
PROPIO try/catch: si fallan, `feesUncollectedUsd = null` pero `liquidityUsd` se devuelve intacto
(no degradar lo existente). Campos aditivos → no rompen callers actuales.

### UI (`BotPortal.jsx`)
- El memo de pools ya mergea `pd` (resultado de la action) en el pool. Exponer `feesUncollectedUsd`.
- Métrica nueva **"Fees sin cobrar"** en la PoolCard (junto a TVL/Vol/Fees 24h o en
  `range-chart-footer`), con `formatUsdCompact`. Tooltip: "Comisiones ganadas por tu posición
  pendientes de cobrar (en vivo desde Uniswap)".
- `feesUncollectedUsd == null` → "—"; `0` → "$0".
- OJO: no confundir con "Fees 24h" (del POOL entero, DeFiLlama). Etiqueta distinta: esta es de TU
  posición.

## Riesgos / cosas a auditar (código)
1. Encoding del arg de `collect`: struct estático inline (no tuple pointer); `recipient`/`from` =
   owner bien extraído de `ownerOf` (últimos 20 bytes); `amount*Max` = 2^128-1.
2. `from` en `eth_call`: que el helper lo soporte sin romper las llamadas existentes (param opcional).
3. Decodificar el return de `collect` (2 × uint256) correctamente.
4. Cota `[0, 2^128)` antes de `Number()`; `null` si se sale o si cualquier llamada falla.
5. `invert`/decimales idénticos a `liquidityUsd`.
6. +2 RPC por posición (ownerOf ya se hace en algunos casos para Revert; reutilizar si procede).
7. No romper el contrato de `fetchPositionLiquidity`: campos aditivos; si fallan, fees=null y el
   resto sigue igual.

## Flujo (proyecto)
Rama `feat/portal-pool-fees`, push SSH, gh SIN GH_TOKEN. Schema NO cambia, pero SÍ `convex deploy`
para publicar la action nueva. Auditoría: plan + código por Codex (los corre el USUARIO) → PR →
CodeRabbit → merge → deploy.

---
## Apéndice — cálculo MANUAL feeGrowthInside (fallback diferido, NO implementar en v1)
Si en el futuro `collect` simulado resulta poco fiable, este es el método manual (requiere TODAS
las lecturas al MISMO bloque y MISMO proveedor — un helper `pinnedReads` — o el wraparound da fees
gigantes). Datos extra de `positions`: idx 8/9 feeGrowthInside0/1Last, idx 10/11 tokensOwed0/1; del
pool: feeGrowthGlobal0/1X128 (`0xf3058399`/`0x46141319`), `ticks(tick)` (`0xf30dba93`, idx 2/3 =
feeGrowthOutside0/1), tick actual de slot0 idx 1 (int24 con signo). Fórmula (BigInt, `MASK=2^256-1`,
máscara SOLO en restas, producto sin máscara, precedencia con paréntesis):
```
below0  = tickCur >= tickLower ? outLower0 : (global0 - outLower0) & MASK
above0  = tickCur <  tickUpper ? outUpper0 : (global0 - outUpper0) & MASK
inside0 = (global0 - below0 - above0) & MASK
delta0  = (inside0 - inside0Last) & MASK
uncollected0 = tokensOwed0 + ((delta0 * liquidity) >> 128n)
```
