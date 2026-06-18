# Plan — Panel Admin: paridad con el mockup (`docs/mockups/admin-tab.html`)

## Contexto
El `AdminView` actual (JAV-80) es una versión **simplificada** del mockup. Además hay un **bug de dato**:
el KPI "TVL en pools" y la celda "Liquidez/TVL" usan `pool.tvl` (TVL de TODO el pool de Uniswap,
≈$100M → se ve "$100175k"), cuando lo que la plataforma realmente monitorea es la **liquidez de la
posición LP del usuario** (≈ miles de $). El mockup lo llama **"Liquidez LP"** / **"TVL en pools (LP)"**.

Objetivo: llevar el panel a **paridad total** con el mockup, con datos correctos.

## Diagnóstico de datos (qué hay y de dónde sale)
- ✅ **Persistido (barato, query):** plan, suspended, rol, bots (active), pool (pair, network, **feeTier**,
  minRange, maxRange, tokenId, **initialLiquidityUsd**, entryPrice), arm status, márgenes/reservas
  (execution_requests/trigger_arms), trades (volumen 24h). Mutations de control: `setSubscriptionPlan`,
  `setUserSuspended`, `grant/revokeTradeLive`, `grant/revokeManageBots`.
- 🌐 **EN VIVO (acción, NO query — hace red):**
  - **Liquidez LP actual + in/out range + Fees s/cobrar** → `convex/actions/poolScanner.ts`
    (`scanPosition`/`fetchPositionNotional`: `liquidityUsd`, `inRange`, `feesUncollectedUsd`, `currentPrice`).
  - **PnL hedge + colateral HL + dirección cuenta HL** → HL Info API `clearinghouseState` (read-only,
    igual patrón que `useHyperliquid`/`hyperliquid.ts`, SIN firmar ni ordenar).
- ⚠️ **No disponible aún:** **apalancamiento en Revert** ("⚡ Apalancado en Revert ·N×"). No hay integración
  Revert on-chain. → en esta entrega se muestra **"Sin apalancar (LP spot)"** / "Revert: integración
  pendiente" (igual que hoy). Tarea futura aparte.
- 🐞 **Bug de dato a verificar:** el bot real `IL ETH Base` tiene `hedgeNotionalUsd = null` y hay que
  confirmar si `pool.initialLiquidityUsd` está poblado. Si están null, "Cobertura"/"Liquidez LP" saldrán
  "—". Subtarea: asegurar que el alta del bot/poolScanner persiste estos valores (o derivarlos en vivo).

## Principio de arquitectura (money-path)
- Las **queries** admin (`admin.ts`) NO hacen red (Convex lo prohíbe) → siguen siendo solo lectura/cache.
- Los datos en vivo van en **acciones admin nuevas, read-only** (HL Info API + RPC), bajo `requireAdmin`,
  acotadas y con manejo de fallo → "—" (nunca rompen la vista, nunca inventan números). NO tocan el
  money-path (no firman, no colocan/cancelan órdenes). Reutilizan helpers existentes de lectura.
- Controles reutilizan las mutations YA auditadas (no se crea lógica de permisos/planes nueva).

## Distinción semántica (clave, hallazgo Codex #1)
- **"$ monitoreado" / "Liquidez LP"** = valor de la **posición LP en Uniswap** del usuario. Fuente:
  - **Cacheada/inicial** = `pool.initialLiquidityUsd` (barata, en queries). Se etiqueta SIEMPRE como
    "LP inicial (cacheada)" en la UI, NO como liquidez actual.
  - **En vivo** = `poolScanner` (acción) → es la cifra "actual" para paridad real con el mockup.
- **"Cobertura (cap)"** = `bot.hedgeNotionalUsd` (cobertura/cap en HL). **NUNCA** se usa como "monitoreado".
  Son magnitudes distintas y se muestran en celdas distintas.

## Fases

### Fase 1 — Fix de dato + KPIs/columnas correctas (sin red nueva)  [prioridad alta]
1. `usd()` en `AdminView.jsx`: soportar millones/mil-millones → `$100.2M`, `$41.0k`, `$320`.
2. `admin.ts getSystemStats`:
   - KPI "TVL en pools (LP, inicial)" = **Σ `pool.initialLiquidityUsd`** de pools de bots activos (no
     `pool.tvl`). Etiqueta explícita "LP inicial (cacheada)".
   - **(Codex #2) Nulls nunca se suman como 0 en silencio:** contar `unknownLiquidityCount` (pools sin
     `initialLiquidityUsd`) y devolverlo; la UI muestra "$X (+N incompletos)" o "— incompleto" si todos null.
   - Mantener `capitalInHL`, `marginCommitted`, `volume24h`, `activeBots`. Añadir `volume24hPrevDelta`.
   - **(Codex #6)** Añadir `network = hlNetwork()` (backend, fuente de verdad) → pill de red. No asumir en front.
3. `admin.ts listUsersOverview`: añadir `monitoredInitialUsd` por usuario (Σ `initialLiquidityUsd`, etiqueta
   "LP inicial") + `unknownLiquidityCount` por usuario (para "—/incompleto"). NO usar hedgeNotionalUsd aquí.
4. `admin.ts getUserDetail` → `positions[].pool`: añadir `feeTier`, `initialLiquidityUsd`. UI:
   "Liquidez LP (inicial)" = initialLiquidityUsd; "Cobertura (cap)" = hedgeNotionalUsd; subtítulo
   "Uniswap v3 · {feeTier}% · {network}"; enlace "↗ ver" (explorer/Uniswap por tokenId+network).
5. `AdminView.jsx`: columnas de tabla y celdas de la position card alineadas al mockup, con las etiquetas
   "inicial/cacheada" hasta que entre el dato vivo (Fase 2).

### Fase 2 — Datos en vivo (UNA acción admin agregada, read-only)  [prioridad media]
6. `convex/adminLive.ts` (NUEVO) — **una sola acción admin-only agregada** (Codex #3, #5):
   `getUserAdminLiveSnapshot({ userId })`. **(Codex r2 #1) Validación admin en ACCIÓN:** `requireAdmin`
   (`helpers.ts:30`) solo acepta `QueryCtx|MutationCtx`; una action NO puede llamarlo directo → la acción
   valida admin vía `ctx.runQuery(internal.users.getCurrentAdminInternal)` (ya existe, `users.ts:8`) al
   inicio, y aborta si no es admin. Luego, con **topes duros**:
   - **(Codex #3)** Por cada pool con bot activo: 1º `scanPoolByTokenId` (da `currentPrice`/`status`/`range`),
     2º `fetchPositionLiquidity({ tokenId, network, priceUsd: currentPrice })` (da `liquidityUsd`,
     `feesUncollectedUsd`); se computa `inRange` desde currentPrice vs range. (Ambas acciones son
     necesarias: una da precio sin liquidez, la otra exige priceUsd y no da precio.) Si falta el dato →
     campo `null` con flag, nunca inventar.
   - **(Codex #6)** Estado HL: `clearinghouseState` vía `hlInfoUrl()` (read-only, Info API). Dirección
     enmascarada `0x12..ab`, colateral (marginSummary), PnL no realizado por activo. **PROHIBIDO** construir
     clientes con `exchange`/clave privada: solo lectura Info. `network` efectiva desde `hlNetwork()`.
   - **(Codex #5) Topes:** `MAX_POSITIONS_PER_USER` (p.ej. 8), ejecución **secuencial o con cap de
     concurrencia** (no fan-out ilimitado), y un único snapshot por usuario (no N llamadas por celda).
7. `AdminView.jsx`: al expandir un usuario, tras `getUserDetail` (cache, instantáneo) se dispara
   `useAction(getUserAdminLiveSnapshot)` UNA vez (Codex #5):
   - **(Codex #8) Anti-pantalla-en-blanco:** la llamada va en `try/catch` con estado por sección
     (`live`/`error`/`loading`); cualquier fallo → "—" en esa celda, nunca propaga excepción a React.
   - **(Codex #5) Caché cliente con TTL** (p.ej. 30 s) + debounce: re-expandir no re-dispara dentro del TTL.

### Fase 3 — Controles por usuario + utilidades  [prioridad media]
8. Sección "CONTROLES POR USUARIO" (mockup): por fila NO-admin → toggles **Manage**/**Live**
   (`grant/revokeManageBots`, `grant/revokeTradeLive`), `<select>` de **plan** (`setSubscriptionPlan`),
   **suspender/reactivar** (`setUserSuspended`).
   - **(Codex #4)** `setSubscriptionPlan`/`setUserSuspended` ya bloquean admin en backend, pero
     `grant/revoke TradeLive/ManageBots` NO. Para evitar filas confusas: en filas de **rol admin** se
     **ocultan/deshabilitan** los toggles y el select (admin = ∞, bypass en `hasPermission`). Opcional:
     añadir guard backend no-op para admin en los grant/revoke (defensa en profundidad).
9. **Buscar usuario** + **filtro** (todos/activos/sin plan/suspendidos) — cliente sobre la página.
10. Enriquecer "FLUJO DE ACTIVIDAD" con los tipos del mockup (SL ejecutado, fill, TP parcial, out of range,
    plan→X, kill switch) — derivado de fuentes ya indexadas (sin tabla nueva).

### Fase 4 (futura, fuera de alcance) — Apalancamiento en Revert.finance
**(Codex r2 #2, corrección):** SÍ existe lectura parcial de **Revert Finance Lend** en
`fetchPositionLiquidity` (`poolScanner.ts:15` `REVERT_VAULT`; `:576` loanInfo; retorna `borrowHealth`,
`leverageRevert`, `healthFactor`, `amountToRepay` en `:622-625`). (No confundir con `RpcRevertError`,
l.~42-80, que es un revert de `eth_call`, otra cosa.) Como `getUserAdminLiveSnapshot` ya llama a
`fetchPositionLiquidity`, esos campos vendrían "gratis". **Decisión: se DIFIERE exponerlos en Admin** hasta
validar los valores en cuentas reales y normalizar la UX (umbral de "apalancado", redondeo, estados de
fallo). Mientras: la card muestra **"Revert: no expuesto aún"** (no afirmamos que no exista). Exponer
`leverageRevert`/`healthFactor` en la card = tarea de seguimiento corta (el dato ya llega).

## Archivos
- `src/components/AdminView.jsx` (todas las fases)
- `convex/admin.ts` (Fase 1: stats/overview/detail)
- `convex/adminLive.ts` NUEVO (Fase 2: acciones read-only)
- Posible subtarea de dato: alta de bot/`poolScanner` para poblar `hedgeNotionalUsd`/`initialLiquidityUsd`.

## Verificación
- `npm run typecheck` + `npx vite build`.
- Con el usuario real (admin): KPIs muestran LP real (no $100M), formato `$x.xM`/`$x.xk`; al expandir,
  Liquidez LP/Fees/in-range/PnL/colateral cargan o caen a "—" sin romper; controles cambian plan/permiso/
  suspensión y se reflejan; búsqueda/filtro OK.
- Money-path intacto: ninguna acción nueva firma ni ordena (solo Info API/RPC de lectura).

## Respuesta a auditoría Codex (ronda 1 → NO-GO, 8 hallazgos)
1. **monitoreado = initialLiquidityUsd solo cacheado, no hedgeNotionalUsd** → sección "Distinción semántica"
   + Fase 1.2/1.3 etiquetan "LP inicial (cacheada)"; lo vivo en Fase 2. hedgeNotionalUsd solo en "Cobertura (cap)".
2. **Nulls no se subcuentan** → `unknownLiquidityCount` global y por usuario; UI "—/incompleto" (Fase 1.2/1.3).
3. **adminLive subespecificado** → Fase 2.6 detalla la ruta `scanPoolByTokenId` (precio) + `fetchPositionLiquidity`
   (priceUsd) combinadas en una acción agregada.
4. **Permisos admin** → Fase 3.8 oculta/deshabilita toggles+select para filas admin; opción de guard backend no-op.
5. **Fan-out** → Fase 2.6/2.7: UNA acción agregada por usuario, topes (MAX_POSITIONS_PER_USER, concurrencia),
   caché cliente TTL + debounce, dispara solo al expandir.
6. **Frontera testnet/mainnet** → `hlNetwork()` backend para pill y red efectiva; `clearinghouseState` por
   `hlInfoUrl()`; nunca clientes con exchange/clave.
7. **Revert** → Fase 4: aclarado que poolScanner NO integra Revert (es `RpcRevertError` de eth_call); se
   muestra "Revert: no detectado", integración real diferida.
8. **Pantalla en blanco** → Fase 2.7: `try/catch` alrededor de `useAction`, estado por sección, fallo → "—".

### Respuesta a auditoría Codex (ronda 2 → NO-GO, 2 hallazgos)
r2-1. **`requireAdmin` no vale dentro de una action** → Fase 2.6: la acción valida admin con
   `ctx.runQuery(internal.users.getCurrentAdminInternal)` (existe), no `requireAdmin` directo.
r2-2. **Revert SÍ existe (parcial)** → Fase 4 corregida: hay lectura `leverageRevert`/`healthFactor`/
   `borrowHealth` en `fetchPositionLiquidity`; se DIFIERE exponerla en Admin hasta validar/normalizar (no
   se afirma que no exista).

## Flujo de trabajo
Plan → **Codex audita el plan** (lo corre el usuario) → GO → implementar por fases → **Codex audita el
código** → GO → PR → CodeRabbit → deploy Convex + Railway → verificación. Sin tests simulados.
