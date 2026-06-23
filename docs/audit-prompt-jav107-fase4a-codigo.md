# Auditoría de CÓDIGO — JAV-107 Fase 4a (armSpotDefenseBot: action pública de armado manual)

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** de la sub-fase 4a
(commit `c6c9bf0`). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas
el código. Rama `feat/jav107-spot-defense` (checkout hecho). Plan con GO: `docs/plan-jav107-spot-defense.md`.
Fases 1, 2, 3a+3b, 3c-1, 3c-2, 3c-3a+3c-3b y 3c-3c ya tuvieron GO de Codex (3c-3c en r4).

## Contexto

Bot que defiende un holding spot con UN SHORT (trigger SELL que dispara al CAER el precio). El motor
`spotDefenseEngine.ts` ("use node") ya tiene `armSpotDefenseInternal` (núcleo del armado, SIN auth de
usuario, lo llaman el armado inicial y el auto-rearm del cron) y todo el reconcile/SL/BE/TP/drift/stop.

**Hueco que cierra 4a:** `persistSpotDefenseBot` (mutation, Fase 2) crea/persiste el bot pero NO arma
(línea 276-278: "el arranque lo dispara la ACTION de creación de Fase 4"). Y **ningún cron arma un bot
recién creado**: `reconcileAllSpotDefense` solo itera arms ya vivos (`listLiveSpotDefenseArmIdsInternal`);
`processSpotDefenseRearms` solo re-arma bots con un rearm vencido (cierre por SL + autoRearm). Por tanto
un bot creado nunca colocaría su trigger. 4a añade la action pública que la UI (4b/4c) llamará tras
persistir para arrancar el armado inicial.

## Diff a auditar — commit `c6c9bf0`, 1 archivo

`convex/spotDefenseEngine.ts`:
- import: `action` (junto a `internalAction`) y `assertExpectedNetwork` (de `./hlNetwork`).
- Nueva `export const armSpotDefenseBot = action({ args: { botId, expectedNetwork, confirm } })`:
  1. `assertExpectedNetwork(args.expectedNetwork)` — el cliente confirma la red que cree estar viendo.
  2. `if (!args.confirm) throw` — confirmación explícita.
  3. `user = getCurrentUserInternal`; `assertTradeLiveInternal` (exige `canTradeLive`).
  4. `hasManageBotsForUserInternal(user._id)` → si no, throw (exige `canManageBots`).
  5. `bot = getSpotDefenseBotInternal(botId)`; throw si no existe; throw si `bot.userId !== user._id`.
  6. `return runAction(internal.spotDefenseEngine.armSpotDefenseInternal, { botId })`.

Es un espejo recortado de `armPoolBotEntry` (`convex/triggerEngine.ts:86`), que sigue el mismo orden
(network → confirm → user → tradeLive → manageBots → ownership → delega en el internal).

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **Paridad de gates con persistSpotDefenseBot:** `persist` exige `requireBotManager` (canManageBots) +
   `hasPermission(canTradeLive)`. ¿La action exige EXACTAMENTE el mismo conjunto (assertTradeLive +
   hasManageBots), sin abrir un camino donde alguien con un permiso revocado pueda armar?
2. **Doble validación / TOCTOU:** la action revalida ownership y permisos, pero el armado real ocurre en
   `armSpotDefenseInternal`, que NO recibe `userId` (revalida ownership de la CREDENCIAL contra
   `bot.userId`, no contra la identidad). ¿Es seguro que el gate de identidad viva solo en el wrapper, o
   hay una ventana donde el bot cambie de dueño entre el check y el armado? (los bots no cambian de dueño;
   confirmar que es invariante).
3. **Red:** `assertExpectedNetwork` (cliente) + `armSpotDefenseInternal` revalida `bot.network ===
   hlNetwork()`. ¿Cubren juntos el caso de un cliente desincronizado de red sin armar en la red incorrecta?
4. **Idempotencia / doble click:** si la UI llama `armSpotDefenseBot` dos veces (doble click / retry),
   ¿qué pasa? `armSpotDefenseInternal` revalida FLAT + sin órdenes del coin + `reserveSpotDefenseArm` (OCC)
   + CAS `markArmSubmitting`. ¿Garantizan que un segundo armado concurrente no coloque un 2º trigger
   (no duplica entry)? ¿El primero deja al bot no-flat/orden viva y el segundo aborta limpio?
5. **Gate mainnet:** `armSpotDefenseInternal` revalida `mainnetSpotDefenseApproval`? (en la rama de
   armado). ¿El wrapper necesita revalidarlo también, o basta con que el internal lo haga? (verificar que
   el internal lo hace antes de colocar la orden).
6. **Errores / fuga de secretos:** ¿los throws nuevos filtran algo sensible? (botId/red son escalares
   no sensibles). ¿La anotación `Promise<any>` sigue siendo necesaria para cortar TS2589 del grafo mutuo?
7. **Bot pausándose / inactivo:** si el bot quedó `disarmPending`/`!active`/`status!=running` (p.ej. el
   usuario pausó justo antes), `armSpotDefenseInternal` lanza `[cancel]`. ¿La UI recibirá un error claro y
   NO un armado parcial?

## Nota de arquitectura del test (por qué NO hay test de la action)

El harness `tests/convexHarness.ts` carga una allowlist EXACTA mutation-safe y **excluye a propósito**
las actions "use node" (`spotDefenseEngine.ts`): ningún test ejecuta `armSpotDefenseBot` ni
`armSpotDefenseInternal`. La action 4a es pura ORQUESTACIÓN de piezas ya auditadas (auth queries de
`internal.users.*`, `getSpotDefenseBotInternal`, y el internal de armado que ya tuvo GO en Fases 2/3).
No introduce lógica de datos nueva. Si consideras que falta cobertura factible SIN cargar actions en el
harness, indícalo.

Verde actual: `npm run typecheck` EXIT 0, `npm test` **243/243**.
Devuelve: hallazgos (severidad + fix) y veredicto **GO / NO-GO** para 4a.
