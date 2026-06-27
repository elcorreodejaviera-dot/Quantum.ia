# Plan — "Fees 24h (tu parte)" REAL (no estimado)

> **v2 (2026-06-26) — corrige el NO-GO de Codex** (`docs/audit-fees24h-real-plan-codex.md`). Cambios vs v1:
> (ALTO#1) acumulador NETO `collected + max(tokensOwed − principalDebt, 0)` — no contar principal como fee;
> (ALTO#2) `snapshotKey` + regla de status: un delta positivo también puede subcontar → nunca `ok` con
> cambios no capturados; (MEDIO#1) tolerancia de antigüedad 24-26h; (MEDIO#2) authz owner/admin en la
> lectura; (MEDIO#3) `estimatedFees24hUsd = fees1d*feeShareRatio` (USD, no la APR); (BAJO) +2 eth_call/pool/h,
> `npm run typecheck`.
>
> **v3 (2026-06-26) — GO condicionado de Codex** (`docs/audit-fees24h-real-plan-v2-codex.md`). Resueltas las
> 2 condiciones: (MEDIO#1) guardar `safeHeadBlock` en cada snapshot → rango exacto de `getLogs` en F4 (sin
> timestamp→block); (MEDIO#2) `feeShareStatus` NO invalida el valor real por snapshots, solo gatea el
> fallback estimado. + (BAJO#1) `snapshotKey` = `readPositionSnapshotKey` exacto (null → no certificable).
> **Plan APTO para implementar.**

**Objetivo (pedido del usuario):** el tile "Fees 24h (tu parte)" del portal hoy muestra una **estimación
pool-wide** que da mal (~$3 cuando el cobrable real acumulado de la posición de prueba es **$15.46**).
Hay que mostrar **fees REALES** generadas por la posición, derivadas de lecturas on-chain. Todo el cambio
es **read-only / display** (no toca ejecución, márgenes, órdenes ni cobertura). Auditar por fases con GO de
Codex antes de pushear ([[flujo-codex-antes-de-push]]).

---

## 0. Diagnóstico confirmado (citas)

**El bug** (`src/components/BotPortal.jsx`):
- `:67-72` (Summary) y `:423-431` (PoolCard): `fee1d = pool.fees1d` (pool ENTERO, DeFiLlama) × `share =
  pool.liquidity / tvl`. **Prorrateo pool-wide que ignora la concentración del rango** → subestima.
- `:653-659`: los 4 tiles de proyección (Diario/Semanal/Mensual/Anual) usan ese mismo `userFees1d` + `feeApr`
  pool-wide. No es fees reales: es un run-rate teórico mal concentrado.

**Lo que YA existe y sirve (verificado):**
- `convex/actions/poolScanner.ts:689-712` `fetchUncollectedFeesRaw`: `collect()` simulado con `MAX_U128`
  vía `rpcCallWithFallback` a **RPC público** (`:703-704`). **No usa Alchemy** → el cobrable real on-chain
  SÍ se lee siempre. Base del "real".
- `:883-884` `fetchPositionLiquidity` ya calcula y retorna `feesUncollectedUsd` (uncollected live a spot,
  `:1067`).
- `:888-903` `feesLifetimeUsd = collected (agregados cacheados) + uncollected − principalDebt` (null si
  faltan los 4 raw).
- `:949-983` / `:1071-1072` retorna `feeShareRatio` (L_pos / L_activa-en-rango) + `feeShareStatus`
  (`ok|out_of_range|inconsistent|unavailable`), desde el MISMO slot0 on-chain (autoritativo).
- Tabla `pool_fee_events` (`schema.ts:106-117`) + mutation `applyPoolFeeEventsWindow` (`pools.ts:296-348`):
  recomputa agregados raw desde la tabla (fuente de verdad, idempotente, anti-reorg).
- Cron "refresh pool lifetimes" cada 1h: `crons.ts:72-76` → `cronHealth.ts:147-152` →
  `poolScanner.ts:1303 refreshAllPoolLifetimes`.

**Lo que está inerte (verificado):**
- `refreshOnePoolLifetime` (`:1207-1300`) usa `alchemyUrl(pool.network)` (`:1211`); sin `ALCHEMY_API_KEY`
  (no está en prod) marca `no_key` y retorna sin hacer nada → el incremental de "collected" está inerte.
  Pero `feesCollectedRaw0/1` quedan en lo que dejó el último back-fill.
- Back-fill histórico (`backfillPoolLifetime :1334`, Blockscout/`rpcUrl`): descartado por flaky.

**Flujo de datos al front (verificado):**
- `BotPortal.jsx:3764` `useAction(api.actions.poolScanner.fetchPositionLiquidity)`; `:3769-3790` se dispara
  por pool con TTL 30s (`POSITION_TTL_MS`) → `positionData[p._id]`.
- `:3820-3858` arma `pool` = query Convex `poolsFromDb` + spread del snapshot LIVE `pd` (`liquidity`,
  `liquidityReal`, `feesUncollectedUsd`, `feesLifetimeUsd`, `valueAtEntryUsd`, `feeShareRatio`,
  `feeShareStatus`). `pool.tvl`/`pool.fees1d` ← `poolsFromDb` (DeFiLlama cacheado). `prices[asset]` ← hook.

**Supuestos NO verificables solo leyendo código (marcar a Codex):**
- El $15.46 on-chain (tokenId 5562243, Arbitrum) se valida en QA con un `eth_call` read-only, no estáticamente.
- Que `prices` tenga el asset antes del primer snapshot (afecta solo el bootstrap visual).

---

## 1. Definición de "Fees 24h real" — acumulador NETO (corrige Codex ALTO#1)

> **CRÍTICO (Codex ALTO#1):** `collect()` simulado (`tokensOwed` live) **incluye principal liberado por
> `DecreaseLiquidity` aún no cobrado** → NO es todo fee. El código de lifetime ya lo netea con `principalDebt`
> (`poolScanner.ts:886-903`; recompute en `pools.ts:244-271`). El delta de 24h **debe usar el mismo neteo**,
> si no contaría principal como fee.

Acumulador NETO de fees por token (raw), idéntico a lifetime:
```text
feesAccumRaw(t)  = feesCollectedRaw(t) + max(tokensOwedRaw(t) − principalDebtRaw(t), 0)   // por token0 y token1
fees_24h         = feesAccumRaw(now) − feesAccumRaw(now − 24h)                            // por token, luego a USD
```
El **delta raw** se valúa a spot al mostrar (patrón existente: cantidad exacta, USD aproximado —
`schema.ts:74`, "el USD NO se cachea").

**Regla de status (Codex ALTO#1 + ALTO#2 + F4-r2):** `status = ok` SOLO si la deuda base del ref está
**probada hasta su `safeHeadBlock` exacto** (`aggregatesSafeThroughBlock ≥ safeHeadBlock`; no basta que los
4 raw existan: el cache lifetime vale a `cursorBlock ≥ safeHead`, así que F4 recomputa la deuda a `safeHead`
desde `pool_fee_events`) **y** se puede certificar que no hubo cambios de posición no capturados (ver §2
`snapshotKey`). Si falta la prueba o hay cambio no certificado → `partial`/`unavailable`, **nunca `ok`**.

Casos:
- **Sin cambios de posición en la ventana** (la `snapshotKey` no cambió): `feesCollected`/`principalDebt`
  constantes → `fees_24h = max(tokensOwed_now − debt,0) − max(tokensOwed_ref − debt,0)`. **No necesita
  Alchemy** (solo `fetchUncollectedFeesRaw`, RPC público). Garantizado correcto → `ok`.
- **Con collect/increase/decrease en la ventana** (la `snapshotKey` cambió): un `collect()` baja
  `tokensOwed` sin ser pérdida; un delta **positivo también puede subcontar** (ej: ref=5, cobra, genera 10,
  `collected` no avanza → delta bruto +5 cuando lo real es +10). **No basta clampar negativos.** Si la key
  cambió y NO se capturaron los eventos completos de la ventana (sin Alchemy) → `partial`/`unavailable`,
  nunca `ok`. La captura de eventos (Fase 4, `getLogs` estrecho) es **obligatoria para `ok`** cuando hubo
  cambios; si el RPC público falla → `partial`.

---

## 2. Snapshots (tabla nueva, poblada por el cron de 1h)

```ts
pool_fee_snapshots: defineTable({
  poolId: v.id("pools"),
  at: v.number(),
  tokensOwed0Raw: v.string(), tokensOwed1Raw: v.string(),   // collect() simulado (RPC público) — BRUTO, a safeHeadBlock
  collected0Raw:  v.string(), collected1Raw:  v.string(),   // feesCollectedRaw0/1 a safeHeadBlock exacto (o "" si ausente)
  principalDebt0Raw: v.string(), principalDebt1Raw: v.string(), // principalDebt0/1 a safeHeadBlock exacto (o "")
  snapshotKey: v.string(),    // = readPositionSnapshotKey() EXACTO (ver abajo). Cambia con increase/decrease/collect
  safeHeadBlock: v.number(),  // (Codex v2 MEDIO#1) bloque seguro/finalizado al insertar → rango exacto para getLogs en F4
  aggregatesComplete: v.boolean(), // true SOLO si aggregatesSafeThroughBlock está presente (no basta que los raw existan)
  aggregatesSafeThroughBlock: v.optional(v.number()), // bloque hasta el que la deuda base está PROBADA; certifica F4 solo si ≥ safeHeadBlock
}).index("by_pool_at", ["poolId", "at"])
```
- **Guarda los componentes, neteo al leer** (Codex ALTO#1): se guardan `tokensOwed` BRUTO + `collected` +
  `principalDebt` para poder netear `feesAccum = collected + max(tokensOwed − debt, 0)` en la lectura. NO se
  guarda `tokensOwed` como si fuera fee.
- **`snapshotKey`** (Codex ALTO#2 + v2 BAJO#1): **reutilizar EXACTAMENTE `readPositionSnapshotKey`**
  (`poolScanner.ts:464-480`, usa `liquidity | feeGrowthInside0/1Last | tokensOwed0/1` de `positions()`) —
  factorizarlo si hace falta, NO reinventar la huella. Si `readPositionSnapshotKey` devuelve `null` → el
  snapshot queda `unavailable` y **no se inserta como certificable**. Si difiere entre ref y now → hubo
  cambio (collect/increase/decrease) → certificación extra (F4) requerida para `ok`.
- **`safeHeadBlock`** (Codex v2 MEDIO#1): bloque seguro/finalizado leído al insertar. F4 lo necesita para un
  rango EXACTO de `getLogs` sin reintroducir la frágil conversión timestamp→block (ruta ya vetada en
  auditorías previas).
- **Raw, no USD**: consistencia con `schema.ts:74`; el delta se valúa a spot al mostrar (la volatilidad del
  precio no contamina "fees ganadas").
- **Snapshot de referencia + tolerancia de antigüedad** (Codex MEDIO#1): el más reciente con
  `at ≤ now − 24h`. **Aceptar solo si `refAge ∈ [24h, 26h]`**; si es más viejo (huecos del cron) →
  `partial`/`stale` con el intervalo real, NO etiquetar "24h". Exponer `windowHours`/`refAgeMs` al front para
  tooltip. Sin interpolación en v1 (mejora v2).
- **Retención**: ~7-10 días/pool; podar inline en el writer (`at < now − RETENTION_MS`) o cron de poda
  (patrón `pruneEngineEventsWithHealth`). Barato (1 fila/h/pool).
- **Bootstrap** (sin ref válida ≥24h): estado `warming_up` → "Acumulando… (faltan Xh)". NO inventar.

**Writer**: `internalAction` `snapshotPoolFees` (nueva, o extensión de `refreshAllPoolLifetimes`):
1. Por pool con `tokenId`: `fetchUncollectedFeesRaw` (RPC público, sin key) → `tokensOwed0/1Raw`.
2. Leer `feesCollectedRaw0/1` + `principalDebt0/1` cacheados; `aggregatesComplete` = los 4 presentes.
3. Calcular `snapshotKey` con `readPositionSnapshotKey` (si `null` → `unavailable`, NO insertar como certificable).
4. Leer `safeHeadBlock` (bloque finalizado) del mismo RPC.
5. Insertar fila + podar, vía nueva mutation `insertPoolFeeSnapshot`.
- **Independiente del gate `no_key`**: el snapshot de `tokensOwed` NO depende de Alchemy → corre SIEMPRE
  (con `aggregatesComplete=false` si faltan agregados, lo que impide `ok`).

---

## 3. Exposición al front (computar el delta en backend)

**Recomendado**: una action que reúna snapshot-ref + lectura live y devuelva `fees24hUsd` + `status` +
`windowHours`/`refAgeMs` ya listos (front "tonto", sin lógica financiera). Trade-off: una RPC más;
preferible por auditabilidad.
- Estados del valor REAL: `ok` (neteado, agregados completos, sin cambio no certificado, refAge∈[24,26]h) |
  `warming_up` (sin ref ≥24h) | `partial` (cambio no capturado / agregados incompletos / refAge>26h /
  delta clamped) | `unavailable` (sin snapshot ref válido o `snapshotKey` null).
- **`feeShareStatus` NO gatea el valor real** (Codex v2 MEDIO#2): el real por snapshots se deriva de
  `tokensOwed`/eventos y NO depende de que la posición esté in-range AHORA — una posición hoy fuera de rango
  pudo generar fees en las últimas 24h antes de salir. `feeShareStatus` (`out_of_range`/`inconsistent`) solo
  gatea el **fallback estimado concentrado** (§4), nunca `fees24hUsd` real.
- **Neteo en la lectura** (Codex ALTO#1): `feesAccum = collected + max(tokensOwed − principalDebt, 0)` en
  ambos extremos; `fees_24h = feesAccum_now − feesAccum_ref`.
- **Autorización** (Codex MEDIO#2): la action **NO** confía en que el front solo mande pools propios. Debe
  `ctx.auth.getUserIdentity()` + llamar una `internalQuery` que valide `pool.userId === usuario actual` o rol
  admin antes de leer `pool_fee_snapshots` (espejo de `pools.ts:132-157`). Sin eso, un usuario autenticado
  podría leer el historial de otro.
- Reusar el `now` del action live existente (`fetchPositionLiquidity`) para no duplicar el `eth_call`.

---

## 4. Fallback (durante `warming_up`) — run-rate CONCENTRADO, nunca pool-wide

- NUNCA volver al estimado pool-wide (es el bug).
- Durante `warming_up`: mostrar el run-rate **concentrado en USD/día**, **etiquetado "Estimado
  (concentrado)"**. **OJO unidades (Codex MEDIO#3):** el tile es USD diario, así que es
  `estimatedFees24hUsd = fees1d * feeShareRatio` (NO dividir por valor — eso da una TASA). `concentratedFeeApr`
  (`:441-444`) ya divide por `mValorLP` y ×365×100 → es APR, va en su propio tile. Definir dos variables:
  - `estimatedFees24hUsd = fees1d * feeShareRatio`   (USD/día, para el tile de Fees 24h en warming_up)
  - `estimatedFeeApr = estimatedFees24hUsd / mValorLP * 365 * 100`   (%, para el tile de Fee APR)
- En cuanto haya snapshot ref válido (`ok`): conmutar a **valor REAL** etiquetado "Real on-chain (24h)".
- `feeShareStatus` `out_of_range`/`inconsistent` → `—` (no inflar).

---

## 5. Cambios UI (`BotPortal.jsx`)

- `:67-72` + `:81` (Summary): valor = Σ `fees24hUsd` reales (`status==='ok'`); `sub` honesto
  ("Real on-chain (24h)" vs "Estimado · acumulando"). Quitar la fórmula pool-wide.
- `:653-659` (tiles): separar "Fees 24h REAL" (medido) de "Proyección" (run-rate concentrado etiquetado).
  El tile diario muestra el real cuando exista.
- Estados: `warming_up` → "Acumulando… (faltan Xh)"; `partial` → "Aproximado (cobro reciente)";
  `unavailable` → `—`.
- Consistencia con tile "Fees" (`:609-610`, uncollected = **stock** pendiente de cobrar): el nuevo es
  **flujo** (generadas en 24h). Tooltips deben distinguir stock vs flujo.

---

## 6. Reutilización vs limpieza (JAV-117)

**Conservar (base del real):** `fetchUncollectedFeesRaw` + `valueFeesUsd` (RPC público); `pool_fee_events`
+ `applyPoolFeeEventsWindow`; el cron de 1h (se reutiliza para snapshots); `feeShareRatio`/`feeShareStatus`.
**Dejar inerte (no borrar, no bloquea):** camino Alchemy `refreshOnePoolLifetime` (`no_key` → no-op);
back-fill Blockscout como herramienta manual.
→ **JAV-117 NO se borra: se reutiliza.** El snapshot writer es un añadido pequeño que cuelga del cron y de
`fetchUncollectedFeesRaw`. (Esto reemplaza la idea previa de "limpiar el backend inerte".)

---

## 7. Fases (cada una con GO de Codex). Money-path: TODO read-only/display.

- **F0 — Schema**: `pool_fee_snapshots` (con `tokensOwed*Raw`, `collected*Raw`, `principalDebt*Raw`,
  `snapshotKey`, `aggregatesComplete`) + índice `by_pool_at` (`convex/schema.ts`). Verif:
  `npx convex codegen` + `npm run typecheck` (= `tsc -p convex/tsconfig.json --noEmit`).
- **F1 — Writer + mutation**: `insertPoolFeeSnapshot` + poda (`convex/pools.ts`); `snapshotPoolFees`
  internalAction (`poolScanner.ts`) leyendo `tokensOwed` raw + `collected`/`principalDebt` cacheados +
  `snapshotKey`. Sin tocar UI/cron. Verif: `npm run typecheck` + ejecutar la action a mano y leer la tabla.
- **F2 — Cron**: `refreshPoolLifetimesWithHealth` también llama `snapshotPoolFees` (o cron separado 1h)
  (`cronHealth.ts`/`crons.ts`); registrar contadores success/partial/unavailable en cronHealth. Dejar correr
  ≥24h para tener historia.
- **F3 — Lectura backend**: action **con authz owner/admin** que netea (`collected + max(owed−debt,0)`),
  aplica la regla de status (ALTO#1/#2), tolerancia de antigüedad (MEDIO#1) y devuelve `fees24hUsd` +
  `status` + `windowHours`/`refAgeMs`. Verif: comparar contra el cobrable on-chain (tokenId 5562243).
- **F4 — getLogs estrecho**: **obligatorio para certificar `ok` cuando `snapshotKey` cambió** (no opcional);
  rango EXACTO `[ref.safeHeadBlock + 1 − confirmationsMargin, currentSafeHead]` (anti-reorg; mismo patrón de
  bloques que `poolScanner.ts:141-162`/`:1258-1299`), sin timestamp→block. Si el rango cubierto no coincide
  con la ventana real, exponerlo (→ `partial`). Si el RPC falla → `partial`.
- **F5 — UI**: cablear `fees24hUsd`/`status`/`refAgeMs`, labels honestos, fallback `estimatedFees24hUsd`
  (USD, NO la APR) (`BotPortal.jsx` :67-72, :81, :423-431, :653-659). Verif: **`npx vite build`** (NUNCA
  `npm run build`).

**Riesgos:** **+2 `eth_call`/pool/hora** base (`ownerOf` + `collect()` simulado, `:689-704`) más reintentos
por fallback de RPC (respetar `POOL_SCAN_CONCURRENCY=5`, `:1090`); usar el mismo precio spot que el resto de
la card; comunicar claramente el bootstrap de 24h.

**Validación on-chain:** tokenId 5562243 (Arbitrum), acumulado real $15.46. El "Fees 24h" debe ser un
subconjunto coherente (≤ acumulado) y `feesLifetimeUsd`/uncollected converger a ~$15.46. Confirmar con un
`collect()` simulado (read-only) en QA.

---

## Archivos a tocar
- `convex/schema.ts` — tabla `pool_fee_snapshots`
- `convex/actions/poolScanner.ts` — `snapshotPoolFees`, lectura del delta
- `convex/pools.ts` — `insertPoolFeeSnapshot` + poda + (opc.) query de exposición
- `convex/crons.ts` + `convex/cronHealth.ts` — enganchar el writer al cron de 1h
- `src/components/BotPortal.jsx` — tiles `:67-72`, `:81`, `:423-431`, `:653-659`
