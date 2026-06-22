Eres auditor senior money-path del proyecto Quantum.ia.

Codex audito la Fase 2 de JAV-107: backend creacion/config + reserva atomica + cap namespaced.

Veredicto actual: **NO-GO Fase 2**.

No implementes Fase 3 todavia. Corrige la Fase 2 en la misma rama cerrando estos bloqueantes:

1. Gates live no revalidados en reserva/CAS

`persistSpotDefenseBot` valida `canTradeLive` solo al crear, pero `reserveSpotDefenseArm`, `markArmSubmitting` y `gateArmBeforeOrder` no revalidan `tradingEnabled`, `simulationMode=false`, `canTradeLive` vigente ni ownership de credencial. Si se revoca permiso o se apaga kill-switch entre persist y envio, el CAS podria permitir la orden.

Requisito: anadir guard live equivalente a `assertLiveAdmissible`: `tradingEnabled`, `!simulationMode`, owner con `canTradeLive`, credencial owned, red, mainnet gate. Usarlo en `reserveSpotDefenseArm`, `markArmSubmitting` y `gateArmBeforeOrder`.

2. Exclusividad JAV-102 incompleta en rutas existentes

La nueva defensa escanea `bots`/`spot_defense_bots`/`spot_grid_bots`, pero las rutas existentes no escanean `spot_defense_bots`. Un usuario puede crear primero spot-defense BTC y luego una cobertura pool BTC en la misma cuenta porque `bots.ts` solo mira `bots` y `spot_grid_bots`.

Requisito: actualizar `getOrCreatePoolBot`, `spotGridBots.assertCreateGuards` y `hlCredentials.revokeById` para considerar `spot_defense_bots` y/o `spot_defense_arms` vivos.

3. Reconfiguracion con arm vivo si `active=false`

El codigo solo bloquea reconfigurar si hay arm vivo y `args.active` es true. Con `active=false`, permite cambiar cuenta, trigger, SL, TP y nocional mientras existe un arm no terminal.

Requisito: si hay arm vivo, permitir unicamente transicion segura de pausa/desarmado. No permitir patch completo de config/cuenta/nocional mientras exista arm no terminal.

4. `reserveSpotDefenseArm` no exige bot activo/no pausandose

La reserva solo rechaza `status === "stopped"`. Puede insertar un arm `arming` para un bot inactivo, pausado o con `disarmPending`, y luego el CAS lo bloquea dejando estado que consume cap/margen.

Requisito: antes de insertar arm exigir `bot.active === true`, `bot.status === "running"` y `!bot.disarmPending`.

5. No reutiliza `resolveLeverage`; cambia semantica auditada

Fase 2 implementa leverage a mano: manual se capea silenciosamente a `maxLev`, auto usa `min(AUTO_LEVERAGE_CAP,maxLev)`. `resolveLeverage` rechaza manual > max activo y en auto calcula el leverage necesario desde el piso configurado.

Requisito: usar `resolveLeverage` como fuente unica, o justificar y testear explicitamente una semantica distinta. Preferencia Codex: usar `resolveLeverage`.

Verificacion que ya paso pero no alcanza para GO:

- `npm run typecheck` OK
- `npm test -- --run tests/spotDefenseBackend.test.ts tests/reservation.test.ts` OK

Entrega esperada:

- Corrige la Fase 2.
- Agrega tests para cada bloqueo anterior.
- No pases a Fase 3 hasta nueva auditoria Codex.
- Devuelve resumen de cambios y pide reauditoria.

Objetivo: obtener GO de codigo Fase 2.
