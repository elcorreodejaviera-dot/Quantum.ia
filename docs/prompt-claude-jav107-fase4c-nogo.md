# Auditoria JAV-107 Fase 4c - NO-GO

Commit auditado: `d326dd1`  
Archivo principal: `src/components/BotPortal.jsx`  
Verificacion local: `npm run typecheck` OK, `npm test` OK (243/243), `npx vite build` OK con warnings no nuevos de Rollup/chunk.

## Hallazgos

### ALTO / NO-GO - Una posicion spot con defensa real se puede eliminar y deja el bot huerfano

La UI permite eliminar la posicion aunque ya exista `defBot` (`BotPortal.jsx:1517`, `BotPortal.jsx:1555-1568`). La tarjeta viva solo se renderiza si existe una posicion que matchee `defenseByPositionId[position.id]` (`BotPortal.jsx:1260-1264`, `BotPortal.jsx:1707-1712`). Pero el backend de `removePosition` solo valida auth/ownership y borra el registro (`convex/spot_positions.ts:99-107`); no consulta `spot_defense_bots` ni arms vivos.

Impacto: un usuario puede borrar del portal la posicion defendida mientras el bot/short/ordenes siguen vivos. El bot queda listado por `listMySpotDefenseBots`, pero ya no tiene tarjeta ni controles porque no hay posicion con ese `spotPositionId`. Eso puede dejar al usuario sin camino UI para pausar/reintentar/reconfigurar y permitir recrear otra posicion del mismo asset con otro id, abriendo riesgo de defensas duplicadas o invisibles.

Fix: bloquear en backend `removePosition` si existe un `spot_defense_bot` activo/no detenido para ese `spotPositionId` o cualquier arm no terminal. En UI, deshabilitar/explicar "pausa la defensa antes de eliminar". Si se permite limpiar historico, debe ser solo cuando no haya arm vivo y el bot este terminal/stopped, o con una operacion explicita que cierre/limpie ambos recursos de forma segura.

### MEDIO / NO-GO - `disarmPending` no se refleja como "Deteniendose" mientras hay arm vivo

`pauseSpotDefenseBot` con arm vivo setea `disarmPending: true` y deja el arm no terminal hasta que el reconcile lo cierre (`convex/spotDefenseBots.ts:477-496`). La tarjeta, sin embargo, prioriza `if (arm)` antes de `bot.disarmPending` (`BotPortal.jsx:2604-2619`). Resultado: despues de pausar una defensa viva, la UI puede seguir mostrando "Armado (trigger vivo)" / "Protegido" en verde en vez de "Deteniendose". El boton de pausar si desaparece por `bot.active && !bot.disarmPending` (`BotPortal.jsx:2738-2741`), asi que no duplica acciones, pero la observabilidad money-path queda incorrecta.

Fix: dar prioridad visual a `bot.disarmPending` aunque exista `arm`, con tono amber y texto "Deteniendose"; si hace falta, mostrar el estado del arm como subtexto.

### BAJO / GO - Los botones de la tarjeta no reciben gate cliente de permisos

`SpotPositions` recibe `canTradeLive` y lo usa para abrir/configurar defensa (`BotPortal.jsx:1713-1722`), pero no lo pasa a `DefensaSpotViva` (`BotPortal.jsx:1710-1711`). La tarjeta muestra `Reintentar armado` y `Pausar defensa` solo por estado del bot (`BotPortal.jsx:2733-2741`). El backend protege el armado con `armSpotDefenseBot` (permisos + red + confirm) y pausa exige `requireBotManager`, por lo que no abre un bypass critico. Aun asi, tras revocar permisos la UI puede ofrecer acciones que luego fallan o que dependen solo del gate backend.

Fix: pasar permisos a la tarjeta y ocultar/deshabilitar acciones cuando el usuario no tenga el permiso correspondiente. Mantener el backend como autoridad.

### BAJO / GO - El motivo clasificado de `blocked` no aparece para defensa spot

La tarjeta muestra `bot.lastRearmErrorKind` en estado bloqueado (`BotPortal.jsx:2613-2615`), pero el settle de rearm de defensa spot solo persiste `lastRearmError`, no `lastRearmErrorKind` (`convex/spotDefenseBots.ts:588-593`). No afecta ejecucion ni seguridad, pero reduce diagnostico en una tarjeta que pretende ser operativa.

Fix: o bien persistir `lastRearmErrorKind` en spot defense como hace el motor de pools, o hacer fallback visual a `lastRearmError` limpiando el prefijo `[blocked_*]`.

## Puntos cubiertos sin hallazgo bloqueante

- Reintento de armado: `busy` reduce doble click en cliente y el backend mantiene las barreras fuertes (`flat`, ordenes del coin, OCC, CAS, red, permisos). Un doble retry no deberia duplicar entry.
- Hooks: `DefensaSpotViva` es componente real renderizado dentro del `.map`; no hay hooks llamados directamente en el loop.
- Lista/detail/saldos: el detail revalida ownership y devuelve solo arm vivo + ordenes; saldos se deduplican por cuenta.
- Simulacion borrada: no quedan referencias a `DEFAULT_PROTECTOR`, `loadProtector`, `saveProtector`, `recordSpotSignal`, `updateProtector`, `SpotProtectorBot` ni `position.protector`.
- `ExecutionsObservabilityPanel` queda exportado y `AdminView` lo importa/renderiza. `EVM_RE_PROTECTOR` sigue usado por alta de cuenta, no es referencia colgante del simulador.
- Secretos: la tarjeta usa datos publicos/operativos (label, direccion truncada o title, saldos, PnL); no expone private key.

## Veredicto

NO-GO para Fase 4c hasta cerrar el bloqueo de borrado/orfandad y corregir la senalizacion de pausa pendiente. JAV-107 no deberia cerrarse para PR con este commit tal como esta, aunque las verificaciones tecnicas compilen y pasen.
