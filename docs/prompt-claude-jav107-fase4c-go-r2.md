# Auditoria JAV-107 Fase 4c r2 - GO

Commit auditado: `474e0e7`  
Base del NO-GO: `d326dd1`  
Verificacion local: `npm run typecheck` OK, `npm test` OK (248/248), `npx vite build` OK con warnings no nuevos de Rollup/chunk.

## Hallazgos re-auditados

### ALTO / GO - Borrado de posicion con defensa viva

El NO-GO original queda cerrado. `removePosition` ahora valida ownership de la posicion y despues busca bots por `spotPositionId` via `by_position` (`convex/spot_positions.ts:102-124`). Bloquea si el bot esta activo, no esta `stopped`, tiene `disarmPending` o conserva un arm no terminal. Eso cubre el caso money-path: no se puede borrar la posicion mientras exista defensa/short/orden viva que quedaria sin tarjeta ni controles.

La UI tambien anticipa el bloqueo deshabilitando "Eliminar" cuando el bot de la lista no esta detenido (`src/components/BotPortal.jsx:1555-1573`). La autoridad real queda en backend, correcto. Un bot `stopped` sin arm vivo puede dejarse historico y la posicion se puede borrar; no es riesgo money-path.

### MEDIO / GO - Pausa visible con arm vivo

Corregido. `DefensaSpotViva` prioriza `bot.disarmPending` antes de mirar `arm` (`src/components/BotPortal.jsx:2610-2626`), asi que tras pausar muestra "Deteniendose" amber aunque el arm siga vivo hasta reconcile. El boton de pausa desaparece durante `disarmPending`, sin duplicar acciones.

### BAJO / GO - Gates cliente de acciones de tarjeta

Corregido para no ofrecer reintento/pausa a usuarios sin `canTradeLive` (`src/components/BotPortal.jsx:1713-1717`, `src/components/BotPortal.jsx:2739-2751`). Backend sigue siendo autoridad para armar y pausar.

Residual no bloqueante: `pauseSpotDefenseBot` exige `requireBotManager` (`canManageBots`), no `canTradeLive` (`convex/spotDefenseBots.ts:479-496`). Si los permisos se administran separados, un usuario con `canManageBots` pero sin `canTradeLive` no vera "Pausar defensa" aunque el backend si le permitiria reducir riesgo. Recomendacion: pasar tambien `canManageBots` a `SpotPositions/DefensaSpotViva` y gatear `Reintentar` con ambos permisos, `Pausar` con `canManageBots`.

### BAJO / GO - Motivo de rearm bloqueado

Corregido. `settleSpotDefenseRearm` deriva y persiste `lastRearmErrorKind` desde el prefijo del error (`convex/spotDefenseBots.ts:575-598`), compatible con el schema (`convex/schema.ts:661-667`) y con la tarjeta que ya lo mostraba.

## Cobertura y regresiones

- Tests nuevos cubren borrar con bot activo, borrar con arm no terminal aunque el bot este stopped, borrar con bot stopped sin arm vivo, borrar sin defensa, y clasificacion de `lastRearmErrorKind` (`tests/spotDefenseBackend.test.ts:638-693`).
- `spot_positions.ts` fue agregado al allowlist del harness (`tests/convexHarness.ts`), asi que el guard queda cubierto en tests Convex.
- No reaparecen referencias a `DEFAULT_PROTECTOR`, `loadProtector`, `saveProtector`, `recordSpotSignal`, `updateProtector`, `SpotProtectorBot` ni `position.protector`.
- `ExecutionsObservabilityPanel` sigue exportado/importado; `EVM_RE_PROTECTOR` sigue usado por alta de cuenta.
- Nota no money-path: `git show --check 474e0e7` falla por trailing whitespace en el doc `docs/prompt-claude-jav107-fase4c-nogo.md`, no por codigo.

## Veredicto

GO para JAV-107 Fase 4c r2. Los NO-GO de 4c quedan cerrados. Con este commit, JAV-107 queda apto para cerrar la epica de cara al PR, dejando solo el ajuste recomendado de permisos UI como deuda baja no bloqueante.
