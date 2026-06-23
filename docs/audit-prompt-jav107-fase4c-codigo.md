# Auditoría de CÓDIGO — JAV-107 Fase 4c (cablear defensa + tarjeta viva + borrar simulación)

Eres un auditor senior de UI money-path en Hyperliquid. Audita el **CÓDIGO** de la sub-fase 4c (commit
`d326dd1`). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas el código.
Rama `feat/jav107-spot-defense` (checkout hecho). Plan con GO: `docs/plan-jav107-spot-defense.md` (Fase 4).
Fases 1, 2, 3*, 3c-3c (r4), 4a y 4b ya tuvieron GO de Codex.

## Contexto

4c cierra la UI de la defensa spot: la posición spot deja de usar el **protector simulado**
(localStorage + señal informativa) y pasa al **bot de defensa real** (modal 4b + armado 4a). Todo el
cambio vive en `src/components/BotPortal.jsx`.

## Diff a auditar — commit `d326dd1`, `src/components/BotPortal.jsx`

1. **`DefensaSpotViva({ botId, bot, accountById, balancesByAddress, currentPrice })`** — tarjeta en vivo
   clonada de `CoberturaViva` (misma paleta `cv-*`) pero con UN solo `cv-tile` de Trigger:
   - `useQuery(getSpotDefenseDetail, { botId })` → `{ bot, arm, orders }`; cae al `bot` de la lista
     mientras carga.
   - Estado/tono desde `arm.status` (SD_ARM_LABEL) o, sin arm, desde `disarmPending`/`rearmStatus`/`active`.
   - `needsArm = active && !arm && !disarmPending && rearmStatus∉{pending,running}` → muestra "Sin armar"
     + botón **"Reintentar armado"** (`useAction(armSpotDefenseBot)` con confirm + HL_NETWORK). (Cubre el
     hallazgo 4b #1: bot creado pero sin armar.)
   - Botón **"Pausar defensa"** (`useMutation(pauseSpotDefenseBot)`) si `active && !disarmPending`.
   - Tiles: Trigger (arm.triggerPx ?? bot.triggerPrice, distancia a currentPrice), Cobertura
     (arm.effectiveNotionalUsd ?? bot.effectiveNotionalUsd + leverage), Wallet. Fila SL (orden role='sl'
     open/pending + BE si arm.beMoved). Saldo HL + posición viva (de balancesByAddress). Órdenes en detalle.
2. **`SpotPositions`** (cableado): recibe `canTradeLive`; fetchea `listMySpotDefenseBots` + `hlCredentials.list`
   + saldos de las cuentas de defensa (dedup, `useHLAccountsBalances`). `defenseByPositionId` mapea
   spotPositionId→bot. En cada posición abierta (`isOpen`): si hay bot, render de `DefensaSpotViva`; botón
   "Configurar/Reconfigurar defensa" (abre `SpotDefenseBotModal`) si `canTradeLive`, si no, aviso. Pill de
   estado: "Defensa activa/pausada/Sin defensa". El modal se renderiza con `bot={defBot}` (reconfig) o null.
3. **Borrado del camino de simulación**: `DEFAULT_PROTECTOR`, `protectorKey`/`loadProtector`/`saveProtector`,
   `recordSpotSignal` + el effect de auto-evaluación por tick, `updateProtector`, `position.protector`, y el
   componente `SpotProtectorBot` completo. (Se reinsertó intacto `ExecutionsObservabilityPanel`, que vivía
   contiguo y AdminView importa.)

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER

1. **Reintento de armado (money-path):** "Reintentar armado" llama `armSpotDefenseBot` (confirm + red).
   ¿Es seguro re-armar desde la tarjeta (el internal revalida flat/sin órdenes/mark>trigger/OCC/CAS)? ¿Hay
   doble-armado posible con doble click (el botón se deshabilita con `busy`, y el backend rechaza por arm
   no-terminal/no-flat)?
2. **Pausa con arm vivo:** `pauseSpotDefenseBot` con arm vivo setea `disarmPending` (el cron cancela/cierra
   reduceOnly). ¿La tarjeta refleja el "Deteniéndose" y no deja reintentar/duplicar acciones mientras tanto?
3. **Coherencia de datos vivos:** la tarjeta mezcla `bot` de la lista (rápido) con `detail` (fresco) y
   saldos de `useHLAccountsBalances`. ¿Algún caso donde muestre datos incoherentes/obsoletos peligrosos
   (p.ej. cobertura/SL de un arm ya terminal)? `getSpotDefenseDetail` solo devuelve arm NO terminal.
4. **Borrado de simulación sin regresiones:** ¿quedó alguna referencia a `protector`/`SpotProtectorBot`/
   `loadProtector`/`recordSpotSignal`? ¿Se preservó `ExecutionsObservabilityPanel` (export usado por
   AdminView) y `EVM_RE_PROTECTOR` (usado por otro componente)? El build pasa, pero confirmen semántica.
5. **Permisos/gating en la tarjeta:** "Reintentar armado" y "Pausar" no chequean `canTradeLive` en cliente
   (sí lo hace el backend: arm exige canTradeLive+canManageBots; pause exige requireBotManager). ¿Es
   aceptable, o conviene ocultar/deshabilitar en cliente sin permiso? (la tarjeta solo se ve si el bot
   existe, que requirió canTradeLive al crearlo).
6. **Hooks/estado:** `DefensaSpotViva` hace su propio `useQuery`/`useAction`/`useMutation`; se renderiza
   dentro del `.map` de posiciones. ¿Cumple las reglas de hooks (es un componente, no un map de hooks)?
   ¿`defenseModalFor` (un solo modal a la vez por id de posición) es correcto?
7. **Secretos:** ¿la tarjeta expone algo sensible? (oids/cloids/px/size son escalares; wallet parcial vía
   patrón existente).

## Nota de verificación

No hay test de UI ni lint; `npm run build` despliega prod (prohibido en local). Verificado con `npx vite
build` aislado: **OK** (compila, sin imports rotos tras el borrado). `typecheck` (convex) EXIT 0; `npm
test` **243/243** (4c no toca backend).

Devuelve: hallazgos (severidad + fix) y veredicto **GO / NO-GO** para 4c (y, si procede, para cerrar la
épica JAV-107 completa de cara al PR).
