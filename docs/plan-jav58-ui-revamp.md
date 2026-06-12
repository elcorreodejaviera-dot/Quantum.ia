# JAV-58 — Revamp visual de la cobertura (plan + auditoría para Codex)

> **Nota:** Codex no tiene acceso a Linear. Este documento es **autocontenido**: tiene el mensaje
> de auditoría (JAV-56 post-hoc + enfoque de este plan) y el plan completo por fases.

---

## Mensaje para Codex — ponete al día y auditá 2 cosas

Sos auditor de código senior. Repo **Quantum.ia** (portal de bots de cobertura en Hyperliquid
**mainnet, capital real**). Hoy se desplegaron varios cambios a master. Ponete al día y audita
**dos cosas pendientes**.

**Contexto (mirá `git log --oneline -8` en master):** se mergearon y desplegaron JAV-48
(autoleverage 10x→20x), JAV-55 (contador "Deteniendo…"), JAV-56 (fix de clasificación de errores)
y JAV-57 (remediación de mocks + balances on-chain). JAV-48/55/57 ya tenían GO de Codex.

### 1) JAV-56 — código YA MERGEADO/DESPLEGADO sin auditoría externa (auditá post-hoc)
Archivo: `convex/triggerRearm.ts`, función `armErrorKind`. Commit: `git log --oneline --all | grep JAV-56` → `git show <hash>`.
Bug: el regex `^\[(kind)\]` no matcheaba porque Convex envuelve el error como `"Uncaught Error: [kind] …"`
(a veces repetido) → todo `[blocked_*]`/`[cancel]` caía al default `transient` y el cron
(`triggerEngine.ts:~699`) reintentaba indefinidamente en vez de marcar `blocked`+alerta o cancelar.
Fix aplicado: `^(?:Uncaught Error:\s*)*\[(transient|blocked_margin|blocked_config|retry_incompatible|cancel)\]`.
Revisá: (a) matchea el string real (`Uncaught Error: Uncaught Error: [blocked_config] …`), doble wrapper
y `[cancel]`; (b) sin falso positivo con un `[kind]` embebido tras texto que no sea el wrapper; (c) sin
prefijo conocido → `transient` (default seguro); (d) routing correcto en `triggerEngine.ts`. GO/NO-GO con hallazgos.

### 2) JAV-58 — auditá el ENFOQUE del PLAN (antes de implementar)
Es un revamp de UI: surfacear estado vivo de la cobertura + saldo HL en la tarjeta del pool. Casi todo
frontend (`src/components/BotPortal.jsx`, `src/styles/bot-portal.css`) + UNA query read-only nueva
(`listMyActiveArms` en `convex/triggerArms.ts`). NO toca order placement, fondos, ni el dimensionado de
margen/leverage; sin cambio de schema. Dame **GO/NO-GO del enfoque** revisando los 5 puntos de la
sección "Reseña para auditoría (Codex)" de abajo. Señalá si alguna fase debería partirse en piezas más chicas.

---

## Refinamientos de Codex (GO del enfoque, 2026-06-12) — INCORPORADOS
Codex aprobó el enfoque con estos cambios (reflejados abajo):
1. **No `listMyActiveArms` por tarjeta.** Una sola query en el **nivel padre del portal** y pasar un map `botId → arm` a cada `PoolCard` (evita N queries duplicadas).
2. **Fase C — definir "Saldo HL" sin mezclar.** El hook separa a propósito `withdrawable` (perp) y `spotUsdcFree`. UI: línea principal **"Saldo HL: $1,000.37"** + subtítulo **"USDC spot libre"**; si hay `withdrawable`, mostrarlo aparte como dato técnico secundario. NO presentar como "disponible para margen" sin etiqueta.
3. **Fase C — agrupar llamadas HL.** `useHLAccountBalance` por tarjeta puede disparar muchas llamadas cada 30s si varios pools comparten cuenta → agrupar por `hlAccountId`/`tradingAccountAddress` en un padre o hook agregador. Si se hace por tarjeta con pocos pools, dejarlo como **deuda consciente**.
4. **Fasing separado (no A+B juntas):** **Fase A SOLA primero** (query + typecheck, GO de código aparte para auditar bien la multi-tenancy) → Fase B → Fase C → Fase D.
5. **Condiciones obligatorias de `listMyActiveArms`:** sin `botId` del cliente · `requireUser` · bots por `by_user` · validar `arm.userId === user._id` (además de venir del bot) · órdenes solo de esos `armId`.

**Estado:** Fase A **implementada** (`convex/triggerArms.ts:listMyActiveArms`, `tsc` EXIT 0), pendiente de code-audit Codex antes de PR/deploy.

## Context
El usuario comparó su portal (Quantum.ia) con el de un amigo (DefiSuite) y pasó capturas. Quantum.ia muestra muy bien el lado **POOL/LP** (range-chart, TVL/Vol/APR, proyección de fees), pero **no surfacea el estado vivo de la cobertura** (triggers, distancias, PNL, leverage, capital, estado) ni el **saldo HL** de forma clara. Hoy esos datos solo se ven —parcialmente— abriendo el modal de configuración.

Hallazgo verificado: el saldo HL **no está roto**. `useHLAccountBalance` (`src/hooks/useHyperliquid.js:379`) refresca cada 30s y el valor es real (spot USDC $1,000.37, confirmado contra la HL API). El problema es **presentación**: se muestra como `"Withdrawable $0 · Spot $1,000"` (técnico, redondeado a $1k → parece estático/falso) y **solo dentro del modal**, no en la vista viva. DefiSuite muestra un único **"Balance: $X"** claro y siempre visible.

**Objetivo:** dentro de la `PoolCard` (sin vista nueva), agregar un bloque **"Cobertura en vivo"** y un **saldo HL prominente**, manteniendo la identidad visual de Quantum y sumando los parámetros que faltan. Decisiones del usuario: (1) embebido en la tarjeta del pool; (2) mantener identidad + sumar datos; (3) incluir query de backend para el estado fino del arm.

## Datos ya disponibles (reusar, no reinventar)
- `PoolCard({ pool, canManage, canTradeLive })` — `src/components/BotPortal.jsx:172`. Ya tiene `pool` y obtiene el bot: `ilBot`/`tradingBot` vía `useQuery(api.bots.listBots)` (`:174,178-179`). `listBots` devuelve los bots del usuario con `active`, `rearmStatus`, `disarmPending`, `leverage`, `capitalPct`, `bufferPct`, `hlAccountId`.
- `useHLAccountBalance(tradingAccountAddress)` — `src/hooks/useHyperliquid.js:379`. Refresca 30s. Devuelve `{ accountValue, withdrawable, spotUsdcFree, openPositions[] }`; cada posición trae `{ coin, size, entryPx, unrealizedPnl, positionValue, roe, leverage, liquidationPx }`. **Cubre saldo + posición + PNL en vivo sin backend nuevo.**
- `useQuery(api.hlCredentials.list)` — devuelve `{ id, label, agentAddress, tradingAccountAddress }` por cuenta del usuario. Mapear `bot.hlAccountId → tradingAccountAddress` para alimentar el hook.
- Precio en vivo: `useHyperliquidAllMids()` (`allPrices['ETH']`) — ya usado en `WalletPanel`. Para distancias % usar `pool.entryPrice`/precio actual ya presente en la card.
- Triggers = bordes del rango: `pool.min` / `pool.max` (ya en la card). El range-chart son divs posicionados (`range-chart-entry-line`, `range-chart-price-line`, `style={{ bottom: \`${pos}%\` }}`) → agregar marcadores de trigger con el mismo patrón.
- CSS: `src/styles/bot-portal.css` (clases `range-chart*`, `pill`, tiles, `wallet-row`). Seguir esas convenciones.

## Fases

### Fase A — Backend: query read-only del estado vivo del arm (fidelidad total)
- Nueva query en `convex/triggerArms.ts`: `export const listMyActiveArms = query({...})`.
  - `requireUser`; obtener los bots del usuario (`bots` `by_user`); para cada bot, el arm NO terminal más reciente vía índice `by_bot_generation` (reusar `isArmTerminal` / `ARM_TERMINAL` ya definidos en el archivo).
  - Devolver por bot: `{ botId, status, desiredState, side, triggerPx, lowerEdge, upperEdge, appliedLeverage, reservedNotional, generation }` + sus `trigger_orders` (`role, oid, cloid, triggerPx, observedStatus`).
  - Sin tocar money-path (solo lectura). Multi-tenant por `requireUser` + propiedad del bot.
- Sin cambio de schema (usa índices existentes). Si se quiere optimizar, opcional `.index("by_user", ["userId"])` en `trigger_arms` (requiere deploy).
- Exponer en `_generated/api`. Consumir en `PoolCard` con `useQuery(api.triggerArms.listMyActiveArms)`.

### Fase B — Frontend: bloque "Cobertura en vivo" en PoolCard (debajo del range-chart)
- Render condicional cuando `ilBot?.active` (o hay arm vivo). Subcomponente nuevo `CoberturaViva({ bot, arm, account, price, pool })` en `BotPortal.jsx`.
- Mostrar (estilo tiles/pills Quantum):
  - **Estado**: derivar de `arm.status` (Esperando/Armado/Llenado/Protegido) con fallback a `bot.rearmStatus`/`disarmPending` (Armando/Bloqueado/Deteniéndose).
  - **Triggers** abajo/arriba (`pool.min`/`pool.max`) + **distancia %** vs precio actual.
  - **Régimen** Dentro/Fuera del rango.
  - **Capital efectivo + Leverage**: `arm.reservedNotional` + `arm.appliedLeverage` (si hay arm), si no derivar de `bot` config.
  - **Wallet**: label de la cuenta (de `hlCredentials.list`).
  - **OIDs/CLOIDs** (de los `trigger_orders` de la query) — detalle pequeño/colapsable.
- **Marcadores de trigger** sobre el `range-chart` existente: dos divs posicionados por `bottom: %` calculado igual que `range-chart-price-line`. Nuevas clases en `bot-portal.css`.

### Fase C — Saldo HL prominente + posición/PNL en vivo
- En `PoolCard`: resolver `tradingAccountAddress` del bot (vía `hlCredentials.list`) y llamar `useHLAccountBalance(addr)`.
- Mostrar un **"Saldo HL: $1,000.37"** único y legible (sin redondear a $1k — usar `formatUsd` con 2 decimales o un formateador nuevo) siempre que la cuenta esté conectada (no solo en el modal).
- Cuando `account.openPositions` tenga la posición del bot: mostrar **PNL no realizado, entry, leverage, liqPx** (estilo DefiSuite: PNL/ROE).
- Arreglar el `"Disponible después: −$102 en ROJO"` del modal (`BotPortal.jsx:~2194,2250`): el colateral está en spot/unified y alcanza. Cambiar el rojo alarmante por algo claro tipo `"Colateral spot: $1,000 ✓"` cuando `spotUsdcFree` cubre el margen.

### Fase D — Pulido visual (manteniendo identidad Quantum)
- Cabecera compacta de métricas en la card (VALOR LP / ENTRY / PNL / APR / FEES) reusando datos ya presentes + PNL de Fase C.
- Jerarquía y espaciado para acercarse a la legibilidad de DefiSuite, sin rehacer el layout.

## Flujo por fase (protocolo del usuario)
Cada fase: plan corto → GO → implementar → **auditoría (Codex/CodeRabbit cuando haya créditos; si no, test/criterio + waiver explícito del usuario)** → PR → merge → deploy (Convex para Fase A; Railway para B/C/D, frontend). Empezar por **Fase A + B juntas** (la query + el panel) que es lo de mayor valor; C y D después.

## Archivos críticos
- `convex/triggerArms.ts` — nueva query `listMyActiveArms` (Fase A).
- `src/components/BotPortal.jsx` — `PoolCard` (`:172`) + nuevo subcomponente `CoberturaViva`; ajustes al modal de margen (`:~2190-2250`) en Fase C.
- `src/styles/bot-portal.css` — nuevas clases para el bloque vivo y los marcadores de trigger.
- `src/hooks/useHyperliquid.js` — sin cambios (reusar `useHLAccountBalance`, `useHyperliquidAllMids`).

## Reseña para auditoría (Codex) — leer antes de aprobar el plan
Resumen autocontenido para un auditor sin el contexto del chat.

**Qué se construye y por qué.** Quantum.ia (portal de bots de cobertura en Hyperliquid **mainnet, capital real**) hoy no muestra el estado vivo de la cobertura ni el saldo HL de forma clara; el usuario quiere paridad visual con un portal competidor. Es un **revamp de UI**: surfacear datos que en su mayoría YA existen, más una única query read-only nueva.

**Naturaleza del cambio / superficie de riesgo.**
- **Mayormente frontend** (`BotPortal.jsx`, `bot-portal.css`): render de datos ya disponibles vía hooks existentes (`useHLAccountBalance`, `useHyperliquidAllMids`) y de `pool`/`bot` ya en la card.
- **Un solo cambio de backend**: `listMyActiveArms`, una query **read-only** en `convex/triggerArms.ts`. NO coloca órdenes, NO mueve fondos, NO toca el motor de ejecución/rearm ni el dimensionado de margen/leverage. Sin cambio de schema (usa índices existentes).
- **Sin tocar** `executions.ts`, `triggerEngine.ts`, `hyperliquid.ts`, `leverage.ts`, `reserveArm`, ni ninguna mutation money-path.

**Puntos críticos a auditar (cuando se revise el código de cada fase).**
1. **Multi-tenancy de `listMyActiveArms`**: debe `requireUser` y devolver SOLO arms/órdenes de bots del usuario (mismo cuidado que el fix JAV-57: el portal no debe exponer datos ajenos). Verificar propiedad por `bot.userId`/`arm.userId`, no confiar en argumentos del cliente.
2. **Sin fuga vía `useHLAccountBalance`**: la dirección HL debe salir de `hlCredentials.list` (ya multi-tenant, `by_user`), nunca de un input arbitrario.
3. **Coherencia de cálculos de display**: distancias %, capital efectivo y PNL mostrados deben coincidir con HL (la fuente de verdad sigue siendo el backend/HL; el front solo presenta). No introducir un segundo cálculo de margen/leverage que diverja del backend.
4. **Arreglo del “−$102 en rojo”**: es solo presentación; confirmar que NO cambia ninguna validación real de margen (el backend sigue siendo autoridad al operar).
5. **Estados del arm**: el mapeo `arm.status → etiqueta` no debe inventar estados ni ocultar `failed`/`blocked` (no maquillar errores como “ok”).

**Veredicto esperado del auditor**: GO/NO-GO sobre el ENFOQUE del plan (no sobre código aún), señalando si alguna fase debería partir en piezas más chicas o si falta cubrir algún riesgo multi-tenant/money-path.

## Verificación (end-to-end)
1. `npm run typecheck` (Fase A) y `node node_modules/vite/bin/vite.js build --outDir dist-check` (frontend) en verde.
2. Con un bot IL activo (caso real ya existente, cuenta `0x7bbc…add0`): abrir la tarjeta del pool y confirmar que el bloque "Cobertura en vivo" muestra estado, triggers 1636/1737.2 con distancias %, capital $2,040/20x, wallet, y el **saldo HL real ($1,000.37)** sin redondear.
3. Cruzar contra la HL API (`clearinghouseState`/`spotClearinghouseState` de la cuenta) que los números del panel coinciden con HL.
4. Pausar el bot → el estado pasa a "Deteniéndose" y luego desaparece el panel (sin órdenes huérfanas).
5. Cuando una entrada se llene (precio fuera de rango): el panel debe mostrar la **posición abierta con PNL/entry/leverage** desde `useHLAccountBalance.openPositions`.
