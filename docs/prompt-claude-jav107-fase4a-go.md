# JAV-107 Fase 4a - Auditoria Codex - GO

Claude: Codex audito el commit `c6c9bf0` en `feat/jav107-spot-defense`.

Contexto:
- Commit auditado: `c6c9bf0` (`armSpotDefenseBot`, action publica de armado manual).
- Archivo de codigo auditado: `convex/spotDefenseEngine.ts`.
- Verificacion local: `npm run typecheck` OK; `npm test` OK (`243/243`).
- No se modifico codigo durante esta auditoria.

## Veredicto

**GO** para JAV-107 Fase 4a.

## Hallazgos

No encontre hallazgos bloqueantes ni riesgos money-path nuevos en el wrapper publico.

## Puntos validados

1. Paridad de permisos con `persistSpotDefenseBot`.
- `armSpotDefenseBot` exige usuario autenticado, `canTradeLive` via `assertTradeLiveInternal` y `canManageBots` via `hasManageBotsForUserInternal`.
- Esto cierra el bypass de armar manualmente con `canManageBots` revocado.

2. Doble validacion / TOCTOU.
- El wrapper valida ownership (`bot.userId === user._id`).
- `armSpotDefenseInternal` vuelve a validar que la credencial pertenezca al `bot.userId`.
- Los bots no tienen ruta de cambio de dueño; aun asi, los gates live se revalidan en `reserveSpotDefenseArm`, `markArmSubmitting` y `gateArmBeforeOrder`.

3. Red.
- `assertExpectedNetwork(expectedNetwork)` rechaza cliente desincronizado.
- `armSpotDefenseInternal` vuelve a exigir `bot.network === hlNetwork()`.
- El gate mainnet dedicado se aplica dentro de `assertSpotDefenseLiveAdmissible`, usado por reserva/CAS/gate pre-RPC.

4. Idempotencia / doble click.
- Dos llamadas concurrentes no deberian duplicar entry: el internal exige flat + sin ordenes del coin, y `reserveSpotDefenseArm` rechaza si ya hay arm no terminal.
- `markArmSubmitting` y `gateArmBeforeOrder` sostienen el fencing antes del RPC.

5. Bot pausado/inactivo.
- Si el bot queda `!active`, `status != running` o `disarmPending`, el internal aborta antes de enviar orden.
- Si el cambio ocurre despues de reservar, los CAS/gates siguientes lo vuelven a bloquear.

6. Errores / secretos / TS2589.
- Los throws nuevos no exponen secretos; solo mencionan confirmacion, permisos, ownership/red/bot.
- `Promise<any>` sigue siendo coherente con el patron local para cortar inferencia profunda en actions node.

## Residual no bloqueante

- No hay test directo de la action porque el harness excluye actions `"use node"`. Es aceptable para 4a: el diff solo orquesta auth/ownership/red y delega el money-path al internal ya auditado. Cuando el harness soporte actions node o haya e2e, conviene cubrir confirm/network/permissions/ownership/doble-click.

Resultado final: **GO**.
