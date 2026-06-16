# Plan JAV-76 — SubscriptionBar real (Planes 3/5)

Parte de la épica **JAV-73**. **Frontend, sin riesgo money-path.** Backend Pieza 1
(`convex/subscriptions.ts`, JAV-74) ya está en `master`: `getMySubscription`, `listPlans`,
catálogo `PLANS`.

## Objetivo

`SubscriptionBar` (`src/components/BotPortal.jsx:675`) hoy usa `const current = SUBSCRIPTIONS[2]`
(Pro $50k **hardcodeado para todos**) y mide la cobertura usada como `Σ pool.liquidity`. Debe leer el
plan **real** del usuario vía `getMySubscription` y mostrar la cobertura usada correcta.

## Semántica de cobertura (aclaración del usuario 2026-06-16) — ⚠️ CONFLICTO A RECONCILIAR

El usuario define el cap del plan como tope de **cobertura de pools** (la liquidez de pools que
protege), **NO** del nocional de los bots. Ejemplo del usuario: pool $50k + suscripción $50k → debe
poder desplegar **hasta $100k en bots**, porque el buffer de capital llega al **100%** (hoy
`BUFFER_OPTIONS = [0,20,40,60,80,100]`), luego `totalNotional = liquidity × (1+buffer/100)` llega a
**2× la liquidez del pool**.

→ Dos métricas distintas:
- **Cobertura de pools (la acotada por el plan):** `Σ pool.liquidity` de pools con ≥1 bot activo
  (cada pool cuenta UNA vez). Se compara contra `coverageCapUsd`.
- **Nocional en bots (informativo, el "doble"):** `Σ` sobre bots activos de
  `pool.liquidity × (1 + (bufferPct ?? 0)/100)`. Puede llegar a ~2× la cobertura de pools.

**🚨 Conflicto con el backend (JAV-74):** `convex/subscriptions.ts:9-12` documenta que el cap limita
`Σ totalNotional` (CON buffer). El modelo del usuario dice que limita la **liquidez de pool** (SIN
buffer) y el nocional puede ser 2×. Son enforcements opuestos:
- Doc backend actual: pool $50k + 100% buffer = $100k notional → **superaría** cap $50k → bloqueado.
- Modelo usuario: pool $50k + suscripción $50k → **permitido** ($100k en bots).

JAV-76 es solo display: implementa el **modelo del usuario** (cap mide cobertura de pools). **La
reconciliación del enforcement y del comentario del backend se trata en JAV-77** (Pieza 4,
money-path) — se deja anotado, NO se toca el backend en este PR.

**Dependencia explícita (Codex #5):** NO lanzar el enforcement de planes (JAV-77) hasta reconciliar,
en una sola pasada, los tres puntos: (a) el comentario de `convex/subscriptions.ts:9-12`, (b) la
fórmula autoritativa de cobertura consumida, y (c) lo que muestra esta UI. Mientras tanto, esta barra
es **informativa** y no bloquea nada.

## Decisión de implementación (display): cliente, no backend

Cómputo **en el cliente** desde `botsFromDb` + `pools` (datos que la página ya tiene). Razones:
JAV-76 es frontend puro y sin money-path; la fórmula **autoritativa** (la que de verdad bloquea
dinero) la define JAV-77 en backend como fuente única. Duplicar aquí una fórmula de *display* es
aceptable y se documenta como tal; cuando JAV-77 exponga la cobertura consumida autoritativa, el bar
puede migrar a leerla. (Alternativa descartada para este PR: añadir ya un `getMyUsedCoverage`
backend — pertenece a JAV-77 para evitar dos definiciones de la cobertura que mueve dinero.)

## Cambios (todo en `src/components/BotPortal.jsx`)

1. **`SubscriptionBar`** pasa a recibir `pools`, `bots` y `loading` (los bots del usuario ya
   disponibles en el padre como `bots`/`botsFromDb`). **`sub` NO es prop**: el componente consulta
   `getMySubscription` internamente con `useQuery` (un solo dueño del dato, sin contrato ambiguo).
   Callsite (`~línea 3954`):
   `<SubscriptionBar pools={pools} bots={bots} loading={botsFromDb === undefined || poolsFromDb === undefined} />`.
   El componente consulta `getMySubscription` internamente (ver punto 2). El padre debe pasar
   `loading` derivado de los **raw** `botsFromDb`/`poolsFromDb` porque dentro del componente `pools`/
   `bots` ya llegan normalizados a `[]` y no distinguen "cargando" de "vacío".
2. Dentro del componente:
   - `const sub = useQuery(api.subscriptions.getMySubscription);`
   - **Estado de carga (Codex #1):** la cobertura usada depende de `sub`, `botsFromDb` Y
     `poolsFromDb`; en el código actual `pools`/`bots` se normalizan a `[]` antes de cargar, así que
     `[]` NO se puede distinguir de "cero cobertura". → El padre pasa flags de carga explícitos:
     `<SubscriptionBar pools={pools} bots={bots} loading={botsFromDb === undefined || poolsFromDb === undefined} />`
     (`sub` se obtiene dentro con `useQuery`). Mientras `loading || sub === undefined` → **placeholder neutro** (sin
     números, sin %); NUNCA renderizar uso 0 antes de tener los tres datos.
   - Estados de `sub` (una vez cargado):
     - `sub === null` → no autenticado (no debería verse el portal; render mínimo o nada).
     - `sub.suspended === true` → **suspendido (Codex #2):** badge "Suspendido" (NO "Online"); copy
       explícito "Cuenta suspendida — sin cobertura disponible"; las barras muestran **disponibilidad
       0** (no sugerir que puede operar; JAV-77 lo bloqueará). El `cap` puede mostrarse como
       informativo tachado/atenuado, pero nada que comunique operatividad.
     - `sub.plan === null` → **sin plan**: badge "Sin plan", `cap = 0`, barras al 0%, sin %
       engañoso. Tooltip: "Pídele al admin que te asigne un plan".
     - con plan y no suspendido → `cap = sub.coverageCapUsd`, `label = sub.label`.
   - **Cobertura de pools usada** = suma de `p.liquidity` de los pools que tienen ≥1 bot activo
     (set de `poolId` de bots con `active === true`, sumar `liquidity` una vez por pool).
   - **Nocional en bots** = `Σ` bots activos `poolLiquidity(b.poolId) × (1 + buffer/100)` donde
     **`buffer` se normaliza robustamente (Codex #3):**
     `const n = Number(b.bufferPct); const buffer = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;`
     (cubre NaN/Infinity/strings del estado local de la UI; un solo NaN contaminaría el total).
   - `pct` (la barra acotada) = `cap > 0 ? min(100, poolCoverage/cap*100) : 0`. Con `cap = 0` → 0%
     (fail-closed, nunca "ilimitado").
3. **UI (Codex #4 — copy cerrado):**
   - **Barra** "Cobertura de pools: {poolCoverage} / {cap}" + relleno `pct` (la métrica del plan).
   - **Métrica textual** "Nocional en bots: {botNotional}" — **texto informativo, SIN barra y SIN
     denominador de cap** (una barra contra `2×cap` reintroduciría la idea de cap-sobre-nocional, que
     es justo el conflicto que difiere a JAV-77).
   - Badge: `{label} Online` (con plan, no suspendido) / `Suspendido` / `Sin plan`.
4. Botón **"Upgrade"** queda **inerte** (sin handler) hasta Stripe (JAV-78). Mantener visible.
5. **Eliminar** la constante `SUBSCRIPTIONS` (`~línea 21`) — queda muerta (solo la usaba la línea 676).
   Confirmar con `grep` que no hay otros usos.

## Qué NO se toca

- `convex/` — cero cambios backend en este PR (la reconciliación de semántica del cap es JAV-77).
- Lógica de armado/ejecución de bots, márgenes, leverage.

## Verificación

- `npx vite build` (frontend) — EXIT 0.
- `grep -n "SUBSCRIPTIONS" src/components/BotPortal.jsx` → sin resultados tras borrar la constante.
- Visual: con plan asignado por el admin (JAV-75) la barra muestra ese plan y `coverageCapUsd`; sin
  plan, "Sin plan" y 0%; **suspendido → "Suspendido", disponibilidad 0, nunca "Online"**;
  **mientras cargan sub/bots/pools → placeholder neutro, sin uso 0 engañoso**; la cobertura de pools
  usa `Σ liquidity` de pools con bot activo; el nocional en bots refleja el buffer (hasta ~2×) y es
  texto informativo sin barra.

## Riesgos / notas

- Si un bot activo apunta a un pool no presente en `pools` (cerrado/no cargado), su liquidez no se
  cuenta: documentar como aproximación de display (consistente con que el dato autoritativo vive en
  JAV-77).
- No introducir el `%` cuando `cap = 0` (evitar división y porcentajes sin sentido).
