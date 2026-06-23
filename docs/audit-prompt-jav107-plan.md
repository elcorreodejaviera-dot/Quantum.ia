# Auditoría de PLAN (RONDA 3) — JAV-107: Bot de defensa de posiciones SPOT

> **RONDA 3.** La ronda 2 dio NO-GO con 4 bloqueantes, TODOS incorporados al plan (sección "Cambios tras
> Codex r2"): **(1)** reserva de margen REAL atómica en `reserveSpotDefenseArm` (mutation OCC con
> `committedMarginForAccount` `executions.ts:73` + `resolveLeverage` `leverage.ts:36` + `MARGIN_SAFETY_BUFFER`
> + cap), no solo preflight; **(2)** detector de drift en cada reconcile (szi real ≠ esperado → cancelar
> solo lo propio, marcar `manual_intervention`, sin market close ciego); **(3)** cap atómico con clave
> coherente `spot-defense:<botId>` (persistir bot primero) validado en `reserveSpotDefenseArm` +
> `markArmSubmitting` + `gateArmBeforeOrder`; **(4)** cobertura parcial explícita (persistir
> `requestedNotionalUsd`+`effectiveNotionalUsd`, % cubierto, confirmación + bloqueo bajo umbral).
> Confirma que estos 4 cierres son correctos y suficientes, busca huecos nuevos y emite GO / NO-GO.



Eres un auditor senior de código money-path en Hyperliquid. Audita el **DISEÑO** de abajo (todavía
NO hay código). Emite **GO / NO-GO** por hallazgo, con severidad (ALTO / MEDIO / BAJO). No reescribas
el código; señala fallos de corrección, huecos, carreras y riesgos money-path. Trabaja sobre la rama
`plan/jav107-spot-defense` (checkout hecho); el diseño completo (ya con los fixes de r1) está en
`docs/plan-jav107-spot-defense.md`.

> **Esta es la RONDA 2.** La ronda 1 dio NO-GO con 6 hallazgos, TODOS incorporados al diseño (ver la
> sección "Cambios tras Codex r1" del plan):
> 1. (ALTO) Sizing del SHORT acotado: `min(amount×markPx×(1+buffer)`, margen real
>    `withdrawable×levEf×(1−MARGIN_SAFETY_BUFFER)`, cap del plan`)`, `levEf=min(leverage,maxLeverage)`.
> 2. (ALTO) Precondición cuenta **flat + sin órdenes del coin** al crear y revalidada al armar.
> 3. (ALTO) Trigger rechazado si `triggerPrice >= markPx` con lectura HL real al crear y repetido pre-order.
> 4. (ALTO) Cap del plan rediseñado con **claves namespaced** (`pool:<poolId>` / `spot-defense:<botId>`).
> 5. (MEDIO) `desiredState:"armed"|"disarmed"` + CAS `markArmSubmitting`/`gateArmBeforeOrder`.
> 6. (MEDIO) Gate dedicado `mainnetSpotDefenseApproval` en create/arm/reconcile/pre-order.
>
> Tu tarea: **confirmar que esos 6 cierres son correctos y suficientes**, buscar huecos nuevos
> (sobre todo en el sizing acotado, la precondición flat y el rediseño del cap), responder las
> preguntas money-path del final y emitir veredicto GO / NO-GO.

> **Hechos verificados (2026-06-22) para los fixes de r1:** `MARGIN_SAFETY_BUFFER = 0.10`
> (`convex/leverage.ts:23`); fórmula de colateral usable `availableCollateral×(1−MARGIN_SAFETY_BUFFER)−marginCommitted`
> (`leverage.ts:89`, `executions.ts:195`). CAS de envío `markArmSubmitting`/`gateArmBeforeOrder`
> en `convex/triggerArms.ts` (llamados desde `triggerEngine.ts:302/336`). `desiredState` ya existe en
> `trigger_arms` (`schema.ts:414`). `setMainnetSpotGridApproval` (`convex/spotGridBots.ts:147`) = patrón
> del gate a replicar. Lectura `clearinghouseState` por POST en `convex/adminLive.ts:24`; órdenes
> abiertas por `getOpenSpotOrders(info,address)` en `convex/spotGridEngine.ts:489+` (para perp, el SDK
> `info` expone open orders por usuario — usar el equivalente perp). `coverageUsage.ts:134-135` ya tiene
> la variante NO-lanzante de los gates de envío.

## Contexto del producto

Portal de bots sobre Hyperliquid (Convex backend en `convex/`, React en `src/`). El usuario tiene
**holdings spot suelto** registrados solo como tracking DCA en la tabla `spot_positions`
(`asset`, `amount`, `dca`, `userId`) — hoy SIN ninguna defensa. Quiere un **bot que defienda esos
holdings** abriendo un **SHORT de cobertura en HL** cuando el precio cae a un trigger.

Hoy ya existe en la UI un widget `SpotProtectorBot` (`src/components/BotPortal.jsx:3176`) pero es
**solo simulación local** (localStorage + graba una señal vía `tradesHistory.recordSignal`; no coloca
nada en HL). Se va a reemplazar por la versión real.

## Decisiones del usuario (FIJADAS 2026-06-22)

- **Motor SEPARADO**, no extender el motor de pool. Razón: el motor de triggers actual está
  fuertemente acoplado a pools (`trigger_arms.poolId` **obligatorio** en `schema.ts:403`;
  `armBotInternal` exige `bot.poolId` en `triggerEngine.ts:148`, deriva el trigger de `pool.minRange`
  en `:195` y el nocional de la liquidez LP on-chain en `:236`; dos entradas + OCO + reentrada).
  Tocarlo arriesga el bot IL vivo en producción.
- **Defensa = SHORT** que se arma y dispara **al CAER** el precio al trigger. **Un solo trigger.**
  `side` fijo = `"Short"`.
- **Trigger = precio explícito**, en dos modos: **manual** (precio a mano) o **anclado al DCA**
  (`spot_positions.dca`).
- **TPs opcionales** (ya lo son en el bot de pool, se reutiliza `TakeProfitRows`).
- **Mismas reglas que cobertura:** exclusividad de cuenta HL por `baseAsset` (JAV-102) y el nocional
  del bot **cuenta para el tope del plan** (JAV-77).

## Hechos verificados en el código actual (2026-06-22), para que no tengas que dig

- **Primitivas de bajo nivel reutilizables** (`convex/hyperliquid.ts`): `makeClients(decryptPrivateKey(cred), isTestnet)` (export ~:9), `getAssetMeta(info, asset)` → `{assetId,szDecimals,markPx,maxLeverage}`, `roundHlPrice`/`ceilHlPrice` (:85/:105), `aggressiveHlPriceStr`, `placeStopLoss` (:189). `hlNetwork()`/`hlIsTestnet()` en `convex/hlNetwork.ts:6`. `decryptPrivateKey` en `convex/hlCredentialActions.ts`.
- **Cloids** (`convex/cloids.ts`): `toHlCloid` (:12), patrón `spotGridCloidInput` con `SpotGridCloidKind` (:26/:38) — se replica un namespace `spot_defense`.
- **Exclusividad de cuenta JAV-102** (`convex/bots.ts:319-352`, `getOrCreatePoolBot`): hoy escanea `bots.by_user_account` (mismo `baseAsset` → rechazo) y `spot_grid_bots.by_account` (grid vivo → rechazo). El grid (`convex/spotGridBots.ts:assertCreateGuards`) y la revocación de credencial (`convex/hlCredentials.ts:revokeById`) escanean ambas tablas. `deriveBaseAsset` (`convex/helpers.ts`) normaliza WETH→ETH/WBTC→BTC.
- **Tope de plan JAV-77** (`convex/coverageUsage.ts`): `consumedCoverageByPool(ctx,userId)` (:54) agrega por pool los `trigger_arms` + `execution_requests` vivos; `assertWithinPlanCoverage(ctx,userId,poolId,hedge)` (:102) compara contra el tope del plan. **Está deduplicado y keyed POR POOL.** Las posiciones spot NO tienen pool.
- **Ciclo de vida de cobertura** a replicar (recortado a 1 entrada) en `convex/triggerEngine.ts`: arm (DB-intent antes de colocar), colocación de trigger SELL, fill→SL (`placeStopLoss`), BE con guard anti-auto-disparo `beTrigger > markPx + tick` (:51, :682), TPs parciales reduceOnly, reconcile con lease/fencing, auto-rearm durable (estado en `bots`/cron `by_rearm_status`). `stopSpotGridBot`/`stopBot` patrones de cierre a mercado reduceOnly + cancel by cloid.
- **Spot Grid** como referencia del patrón "engine separado + cron lease/reconcile + idempotencia por cloid": `convex/spotGridEngine.ts` (`"use node"`), `convex/spotGridBots.ts` (mutations/queries NON-node), cron "reconcile spot grid" 1/min en `convex/crons.ts`.
- **UI**: `ProtectionBotModal` (`BotPortal.jsx:2421`) y `serializePoolBotConfig` (:2224) = modal real del bot de pool; `CoberturaViva` (:174) = tarjeta en vivo (clases `cv-*`); `TakeProfitRows` (:2578), `HLAccountSelect`, `BUFFER_OPTIONS`. La tarjeta del pool se renderiza con dos `cv-tile` "Trigger abajo/arriba" (:241-250).

## DISEÑO PROPUESTO

(Resumen — el detalle está en `docs/plan-jav107-spot-defense.md`, 4 fases.)

- **Fase 1 — Schema + cloid:** tablas nuevas `spot_defense_bots`, `spot_defense_arms`,
  `spot_defense_orders` (modeladas en `bots`/`trigger_arms`/`trigger_orders`, **sin pool**, **una sola
  entrada**, enum de estado recortado **sin** `armed_lower_only`, roles `entry|sl|tp`). Namespace de
  cloid `spot_defense` determinista `botId|generation|role[:tpIndex]:attempt`.
- **Fase 2 — Backend creación/config:** `convex/spotDefenseBots.ts` (NON-node) +
  `precheckSpotDefenseCreate` (action `"use node"` para lo que necesita HL real). Permisos
  `canManageBots`+`canTradeLive`, `baseAsset` derivado, **exclusividad JAV-102** escaneando las TRES
  tablas. **Fixes r1:** precondición **cuenta flat + sin órdenes del coin** (#2); gate trigger
  `triggerPrice < markPx` con lectura HL real, rechazo si DCA≥precio (#3); **sizing acotado**
  `min(amount×markPx×(1+buffer)`, margen real, cap plan`)` (#1); CAS `markArmSubmitting`/
  `gateArmBeforeOrder` (#5). `coverageUsage.ts` rediseñado a **claves namespaced**
  `pool:<poolId>` / `spot-defense:<botId>` (#4), fail-closed legacy.
- **Fase 3 — Motor live (`convex/spotDefenseEngine.ts`, `"use node"`):** `armSpotDefenseInternal`
  **revalida gate mainnet (#6), flat (#2), `markPx>triggerPx` (#3) y recalcula el sizing acotado (#1)**;
  triggerPx = `roundHlPrice(triggerPrice, szDecimals, "floor")`, `size=notionalEfectivo/triggerPx`,
  reserva margen, CAS pre-envío (#5), 1 orden trigger SELL `tpsl:"sl"`. `reconcileSpotDefenseArm`
  (fill→SL→BE→TPs→cierre→auto-rearm, idempotencia por cloid+lookup+lease/fencing, revalida gate
  mainnet + `hlNetwork()===network`). `stopSpotDefenseBot` (cancel propio + cierre a mercado reduceOnly).
  Cron "reconcile spot defense" 1/min + gate dedicado `mainnetSpotDefenseApproval` (#6, espejo de
  `setMainnetSpotGridApproval`).
- **Fase 4 — UI:** reemplazar `SpotProtectorBot` por modal real clonado de `ProtectionBotModal` (con
  bloque Trigger Manual/DCA, sin rango/reentry, TPs opcionales) + tarjeta `DefensaSpotViva` clonada de
  `CoberturaViva` con un solo `cv-tile` de trigger y misma paleta. Borrar la ruta de simulación.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **CLAVE — sizing y semántica del SHORT:** el nocional sale de `spot_positions.amount × precio ×
   (1+buffer)`, pero `amount` es **dato auto-declarado por el usuario** (tracking DCA), no verificable
   on-chain. ¿Es seguro dimensionar un short real con un dato no verificado? ¿Debe acotarse (p. ej.
   contra el saldo/margen real de la cuenta HL, como hace el bot de pool con `MARGIN_SAFETY_BUFFER`)?
   ¿Qué pasa si `amount` está inflado → short sobredimensionado → liquidación?
2. **Trigger por precio:** ¿el gate `markPx > triggerPx` + `roundHlPrice(..,"floor")` es suficiente
   para un SELL trigger que dispara al bajar (`tpsl:"sl"`)? ¿Modo DCA: si el DCA (p. ej. BTC $82.350)
   está MUY por encima del precio actual (~$64k) el trigger quedaría ya disparado → el diseño debe
   rechazar/avisar (no armar un trigger que dispara solo)? ¿Cómo se maneja DCA < precio vs DCA > precio?
3. **Exclusividad JAV-102 en TRES tablas:** ¿escanear `bots`+`spot_defense_bots`+`spot_grid_bots` por
   `tradingAccountAddress` cierra todos los huecos? ¿Un spot-defense BTC y una cobertura de pool BTC en
   la misma cuenta interfieren (misma `coin` HL, mismo order book, cloids distintos)? ¿Comparten margen
   cross? ¿La unicidad debe ser por `baseAsset` o por `(baseAsset, network)`?
4. **Tope de plan (JAV-77):** `consumedCoverageByPool`/`assertWithinPlanCoverage` están keyed POR POOL.
   Meter una clave sintética `spot:<baseAsset>` ¿es correcto y no rompe la dedupe por pool existente
   ni el fail-closed de filas legacy? ¿Hay doble-conteo si el mismo baseAsset se cubre por pool Y por
   spot en cuentas distintas?
5. **Carreras / idempotencia:** ¿el patrón "engine separado con lease/fencing + cloid determinista +
   DB-intent antes de colocar" replica correctamente las garantías del motor de pool (nunca `open` sin
   confirmar HL, sin doble-SL, partial fills con costBasis)? ¿Hay alguna garantía del motor de pool que
   se pierda al recortar a una sola entrada?
6. **Auto-rearm y cierre:** ¿`stopSpotDefenseBot` cancela SOLO lo propio (por cloid namespaced) sin
   tocar órdenes de otra cobertura/grid en la misma cuenta? ¿El auto-rearm reabre el short tras un SL
   sin condición de pool-cerrado (que aquí no aplica) y con cooldown como el de pool?
7. **Gate de seguridad:** ¿basta reusar `tradingEnabled`, o conviene un gate de aprobación explícito
   tipo `mainnetSpotGridApproval` antes de permitir crear/operar el bot de defensa en mainnet?
8. **Regresión:** ¿extender `coverageUsage.ts` y `cloids.ts` y añadir un cron puede afectar al motor de
   pool o al grid vivos? ¿Algún call-site compartido en riesgo?

Devuelve: lista de hallazgos (severidad + descripción + fix sugerido) y veredicto **GO / NO-GO**.
