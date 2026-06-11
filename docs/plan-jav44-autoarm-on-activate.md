# Plan — Auto-armar el motor JAV-44 al activar el bot (modo real) + footer fees

Rama `feat/jav44-autoarm-on-activate` (base master). **ZONA DE CAPITAL REAL.**

## Contexto / hallazgo
El motor de cobertura automática JAV-44 (entrada por trigger + SL + TPs + auto-rearm) está
construido y auditado, pero **`armPoolBotEntry` NO tiene ningún llamador**: ni el front, ni
`getOrCreatePoolBot`, ni cron. El cron `reconcileStaleArms` solo reconcilia arms YA existentes; el
auto-rearm (`processRearms`) solo actúa sobre bots con rearm pendiente (que se marca tras cerrar un
SL de un arm previo). → **Ningún camino crea el PRIMER arm.** Activar el bot lo deja `active=true`
pero nunca coloca el trigger de entrada. Verificado: 0 trigger_arms, 0 ejecuciones.
Switches globales en real: `tradingEnabled=true`, `simulationMode=false`, `HL_NETWORK=mainnet`.

## G0 — Reubicar "Fees sin cobrar" al footer (cosmético, ya implementado)
Movida la métrica de `pool-meta` al `range-chart-footer` (en verde, junto a "Posición LP"), con
`flex-wrap` en el footer. Solo si `feesUncollectedUsd != null`. CSS + JSX, sin lógica.

## (REV. tras NO-GO de Codex) Resumen de la corrección de arquitectura
- **G3 BLOCKER:** el tamaño de la cobertura ya NO lo manda el cliente. `armBotInternal` (backend)
  lo DERIVA de la lectura on-chain autoritativa del LP × (1+bufferPct/100). El cliente solo pide
  activar; nunca fija el nocional.
- **G1 ALTO:** nada de `runAfter(0)` one-shot a secas. Al activar, el bot entra en el estado de
  **rearm durable YA EXISTENTE** (`rearmStatus="pending"`); el cron `processRearms` (1 min) lo arma
  con reintento/backoff y, si un gate falla, lo deja `blocked` con el motivo. El `BotActionButton`
  YA muestra ese estado ("↻ Re-armando cobertura" / "⚠️ bloqueado · motivo") → el usuario nunca ve
  "activo" sin saber que la cobertura aún no está colocada o por qué.

## G1 (REV.) — Activar = encolar el armado durable (no one-shot)
En `getOrCreatePoolBot` (convex/bots.ts), cuando el bot queda activo + real + sin arm vivo + no
pausa: marcar el bot para el motor de rearm durable existente:
`{ rearmStatus: "pending", nextRearmAt: Date.now(), rearmAttempts: 0 }` (mismo patrón que
`triggerArms.ts:23` usa tras un SL). El cron `processRearms` lo recoge (≤1 min), `claimRearm` →
`armBotInternal(rearmToken)` → `recordRearmOutcome`:
- éxito → arm colocado, `rearmStatus` se limpia.
- transitorio (RPC, no-flat, timing) → reintento forzado cada `REARM_RETRY_MS` (indefinido).
- `[blocked_config]`/permiso/sizing → `rearmStatus="blocked"` + `lastRearmError` (motivo visible).
- `[cancel]` (sim/pausa/no activo) → aborta (coherente: no debía armar).
Opcional (responsividad): `ctx.scheduler.runAfter(0, internal.triggerEngine.processRearms, {})`
tras commitear, para no esperar al tick del cron. Idempotente (claimRearm con lease).
**Ventaja:** reutiliza maquinaria YA AUDITADA (lease/fencing, política de errores Codex, alerta de
whipsaw) y el estado es VISIBLE. Sin hueco de "activo sin cobertura".
Etiqueta UI: el texto actual dice "Re-armando"; para el armado inicial conviene un copy neutro
("Armando cobertura"/"Activando cobertura") — ajuste menor en BotActionButton.

## (OBSOLETO — sustituido por G1 REV.) G1 — Auto-arm al activar el bot en modo real
**Objetivo:** que al dejar el bot ACTIVO en modo REAL (`getOrCreatePoolBot`), el motor coloque su
trigger de entrada automáticamente (sin botón extra), llamando a `armBotInternal`.

**Dónde:** `convex/bots.ts` → `getOrCreatePoolBot`, tras el upsert que deja el bot activo.

**Disparo:** `ctx.scheduler.runAfter(0, internal.triggerEngine.armBotInternal, { botId, userId: user._id })`
SOLO si:
- `willBeActive === true` (el bot queda activo),
- `resultMode === false` (modo REAL; en simulación NO se arma — no hay órdenes reales),
- NO es una pausa (`pausingActive === false`),
- NO existe ya un arm vivo (`hasNonTerminalArmForBot(ctx, botId) === false`) — evita programar
  redundante (de todos modos `reserveArm` rechaza duplicados con `[transient]`).

Aplica tanto al bot NUEVO (insert con `active:true` real) como al EXISTENTE que pasa a activo real.

**Por qué es seguro programarlo:** `armBotInternal` REVALIDA TODOS los gates en el momento de
ejecutarse (no confía en el estado del schedule): permiso `canTradeLive` del dueño, `tradingEnabled`
global, `simulationMode` global = false, bot existe/activo/owned, `kind=il`, `direction=short`,
`!disarmPending`, `!simulationMode`, `hlAccountId`, `poolId`, `baseAsset`, `hedgeNotionalUsd>0`,
`stopLossPct` válido, pool no cerrado, cuenta unified, **posición FLAT** (neto cero del activo), y
`reserveArm` (OCC) rechaza si ya hay un arm vivo. Si CUALQUIER gate falla → throw, NO coloca nada.
→ Programar de más es inocuo: a lo sumo el cron/arm registra un fallo gateado, sin orden colocada.

**Scheduler desde mutation:** estándar en Convex (`ctx.scheduler.runAfter` programa un internalAction
tras commitear la mutation). Si la mutation se revierte (OCC), el schedule no se emite (atómico).

## Robustez (a decidir con Codex)
El schedule es **one-shot**: si `armBotInternal` falla transitoriamente (RPC caído, posición aún no
flat), el bot queda activo SIN arm y no se reintenta solo hasta que el usuario vuelva a guardar.
Opciones:
- **v1 (simple):** solo el schedule al activar. Si falla, el usuario re-guarda para reintentar.
- **Robusto (follow-up):** cron "armar bots activos reales sin arm vivo" (self-healing) que recorre
  bots `active && !simulationMode && !disarmPending && sin arm vivo` y los arma. Más fiable para una
  cobertura que debe protegerse sola, pero coloca órdenes reales de forma autónoma → más superficie.
→ Propuesta: **v1 schedule al activar**; dejar el cron self-healing como follow-up explícito. ¿Codex
de acuerdo, o exige el cron ya por seguridad de la cobertura?

## G2 — Quitar el botón "Probar" (decisión usuario: nada de probar)
El usuario NO quiere paso de prueba: al activar, las órdenes salen. Eliminar:
- El botón "Probar" en `BotActionButton` (`onClick={onTest}` → "Probar", ~línea 2007).
- La prop `onTest` y su cableado en los dos `BotActionButton` (Proteger/Trading).
- El estado `testBot`/`setTestBot`, el render `{testBot && <TestExecModal .../>}` y el componente
  `TestExecModal` (~2422) si no queda ningún uso. (El backend `executePerpMarketOrder` de JAV-37 NO
  se toca; solo se retira la UI de prueba.)

## G3 (REV. — BLOCKER Codex) — El BACKEND deriva el tamaño on-chain; el cliente NO lo fija
Codex BLOCKER: el nocional de capital real NO puede venir del navegador (lectura UI desfasable,
manipulable o mock). → El cliente solo PIDE activar; el tamaño lo decide el backend con una lectura
autoritativa.

**Cliente:** ELIMINAR cualquier envío de `hedgeNotionalUsd` (no añadirlo a handleSave ni a
serializePoolBotConfig). El modal sigue mostrando "Posición efectiva" como ESTIMACIÓN informativa,
pero ese número NO viaja al backend ni fija nada.

**Backend (`armBotInternal`):** en el momento de armar, DERIVAR el nocional con un helper DEDICADO
y ESTRICTO (NO reutilizar `fetchPositionLiquidity` tal cual — Codex MEDIO: su `tokenInfo` admite
defaults silenciosos de symbol/decimals y solo lee de `rpcs[0]` sin fallback; un decimals errado
daría un nocional 10^N veces mal en CAPITAL REAL).

Nuevo `fetchPositionNotionalStrict({ tokenId, network, priceUsd, poolAddress })` (internalAction en
poolScanner) que **falla cerrado**:
1. `positions(tokenId)` → amounts token0/token1 (reusa la misma matemática V3 ya existente).
2. **Metadata ESTRICTA con fallback real entre RPCs:** helper `tokenMetaStrict(rpcs, addr)` que lee
   symbol(0x95d89b41) y decimals(0x313ce567) vía `rpcCallWithFallback` (rota proveedores) y devuelve
   `null` si NO se obtienen AMBOS de forma fiable (no defaults 18/"???"). Si t0 o t1 → null ⇒ aborta.
3. **invert ESTRICTO:** exactamente UN token es stable (igual que el helper de fees); si ambiguo → null.
4. `liquidityUsd` con esos decimals validados y el `priceUsd` = `markPx` de HL que armBotInternal ya
   obtiene. Devuelve `{ liquidityUsd }` o **`null`** (cualquier fallo de lectura/metadata/precio).
Luego en armBotInternal:
5. `hedgeNotionalUsd = liquidityUsd` (capital del LP EN CRUDO, SIN buffer); validar finito y `> 0`.
   ⚠️ NO multiplicar por (1+buffer) aquí: la línea existente
   `totalNotional = hedgeNotionalUsd * (1 + bufferPct/100)` YA aplica el buffer una vez. Derivar con
   buffer lo DOBLARÍA (capital real mal dimensionado).
6. Si el helper devuelve `null` o `<=0` → NO armar: `[retry_incompatible]`/transitorio (el cron
   reintenta) o `[blocked_config]` si falta `pool.tokenId`. NUNCA armar con un tamaño dudoso.
7. Sustituir `bot.hedgeNotionalUsd` (línea ~177) por ESTE `liquidityUsd` derivado; el resto del
   sizing (totalNotional, size, reserva) queda igual → buffer aplicado UNA sola vez.

**Cambios derivados:**
- `armBotInternal`: quitar el gate "Bot sin hedgeNotionalUsd válido" como REQUISITO de campo
  almacenado; pasar a DERIVARLO on-chain (arriba). `bufferPct` sí lo aporta el bot (ya almacenado;
  validar 0–N razonable en backend).
- `getOrCreatePoolBot`: ya NO necesita recibir/almacenar `hedgeNotionalUsd` del cliente. (Mantener
  el campo en schema es opcional; si se conserva, que lo escriba el backend tras derivarlo, solo
  para observabilidad — nunca como fuente de verdad del cliente.)
- Reutilizar la lectura on-chain ya existente (poolScanner) evita duplicar la decodificación ABI.

## G4 — Botón "Cerrar posición" (cierre seguro de ejecuciones JAV-37 abiertas)
**Motivo:** hoy una ejecución JAV-37 abierta (`protected`/`entry_filled`) deja una posición + SL
vivos en HL que bloquean el borrado del bot, y NO hay forma de cerrarla desde el portal (solo
quedaba el botón "Probar" que abría, no cerraba). El usuario debe poder cerrar desde la app.

**Backend — action `closeBotPosition({ botId })`** (auth `canTradeLive`/admin + ownership del bot):
1. Buscar las ejecuciones del bot en estados ABIERTOS (`entry_filled`/`protected`/`sl_failed`/
   `unknown`) — índice `by_bot` ya creado.
2. Con la cuenta cifrada (`makeClients`/`decryptPrivateKey`): por cada una, **cancelar el SL vivo**
   (`cancelByCloid`/oid del `slCloid`/`slOrderId`) y luego **cerrar la posición a mercado** reduceOnly
   del activo (mismo patrón que el CIERRE DE EMERGENCIA de `reconcileArm`: leer `szi` real y mandar
   un market reduceOnly del tamaño neto). Reutilizar helpers de `hyperliquid.ts`.
3. Confirmar `szi==0` (doble lectura/grace como el cron) → marcar la ejecución `closed`
   (`settleExecution`). Idempotente: si ya está flat/closed, no-op.
4. Errores: clasificar transport vs validación; dejar la ejecución reconciliable por el cron si el
   cierre no se confirma (no marcar closed sin szi==0).

**UI (decisión usuario): cierre INTEGRADO en el flujo de BORRADO** (no un botón suelto). Al pulsar
"Eliminar", si `deletePoolBot` devuelve `blockedByExecution`, se ofrece (`window.confirm`, capital
real) **cerrar la posición desde el portal** (`closeBotPosition`) y, si HL confirma `sziAfter==0`,
se REINTENTA el borrado automáticamente. Así el usuario nunca queda atascado sin poder quitar el
bot. `closeBotPosition` = action pública (auth `canTradeLive` + ownership) → `closePositionEmergency`
(reduceOnly flatten + cancel) → si flat: `closeOpenExecutionsForBotInternal` + `requestDisarmAndDeactivate`.

**A auditar (Codex):** no dejar posición sin SL a medias (cancelar SL solo junto con el cierre y
confirmar flat); reduceOnly siempre (nunca abrir/invertir); idempotencia; no marcar closed sin
szi==0 confirmado; fencing/lease para no competir con el cron de reconciliación.

## Prerequisitos que el bot DEBE cumplir para que arme de verdad (verificar)
Aunque cablee el auto-arm, NO armará si falta algo. CRÍTICO confirmar que el modal de configuración
del bot envía/deriva:
- `hedgeNotionalUsd > 0` (tamaño de la cobertura). **Si la UI no lo manda, armBotInternal lanza
  `[blocked_config] sin hedgeNotionalUsd válido` y el bot nunca arma.** ← revisar el modal IL.
- `stopLossPct` en (0,100), `direction='short'`, `kind='il'`, `hlAccountId` (cuenta unified),
  `canTradeLive` concedido al usuario.
- Posición HL FLAT del activo (sin posición previa abierta en ETH, etc.).

## Riesgos / a auditar (Codex)
1. ¿El schedule se emite EXACTAMENTE en los casos correctos (activo + real + no-pausa + sin arm
   vivo), y NUNCA en simulación ni en pausa?
2. Reconfiguración de un bot ya activo: el código actual BLOQUEA reconfig con arm vivo. Si está
   activo y SIN arm (el bug actual), ¿re-guardar debe armar? (sí; `reserveArm` evita duplicados).
3. Idempotencia ante doble guardado rápido: dos schedules → el 2º `reserveArm` da `[transient]`
   (no coloca 2 entradas). ¿Suficiente, o filtrar antes con `hasNonTerminalArmForBot`?
4. ¿Importar `internal` en bots.ts crea ciclo? (bots.ts ya importa de triggerArms/executions).
5. El one-shot vs cron self-healing (arriba): ¿aceptable para capital real en beta?
6. ¿`userId` correcto al programar (el dueño del bot = `user._id` del que guarda; admin que edita
   bot ajeno? — getOrCreatePoolBot ya valida ownership/admin; el arm usa el `userId` del DUEÑO real
   del bot, no del admin que edita)? Revisar que se pasa el dueño correcto, no el editor.

## Flujo
Rama `feat/jav44-autoarm-on-activate`, push SSH, gh sin GH_TOKEN. `convex deploy` tras merge.
Auditoría: plan + código por Codex (USUARIO) → PR → CodeRabbit → merge → deploy → **prueba real**
(el usuario, capital real, observando que aparece el trigger en HL y el arm en Convex).
