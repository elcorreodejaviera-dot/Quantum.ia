Eres auditor senior money-path del proyecto Quantum.ia.

Codex reaudito la Fase 2 de JAV-107 despues del commit `fc51a53`.

Veredicto actual: **NO-GO Fase 2**.

Se cerraron varios bloqueantes anteriores, pero queda este bloqueo money-path:

1. El live guard no se usa en ambos CAS

`assertSpotDefenseLiveAdmissible` existe y se usa en `reserveSpotDefenseArm`, pero `markArmSubmitting` y `gateArmBeforeOrder` siguen revalidando solo bot activo/red/mainnet/cap. No revalidan `tradingEnabled`, `simulationMode=false`, `canTradeLive` vigente ni ownership de credencial justo antes del envio.

Referencias:

- Guard definido: `convex/spotDefenseBots.ts:42`
- Usado en reserva: `convex/spotDefenseBots.ts:259`
- Falta en CAS: `convex/spotDefenseBots.ts:354` y `convex/spotDefenseBots.ts:379`

Requisito:

- Llamar `assertSpotDefenseLiveAdmissible(ctx, arm.botId)` tambien en `markArmSubmitting`.
- Llamarlo tambien en `gateArmBeforeOrder`.
- Debe correr antes de pasar a `submitting` y antes de permitir el envio.
- Agregar tests que apaguen `tradingEnabled`, activen `simulationMode` o revoquen `canTradeLive` entre reserva y CAS, verificando que ambos CAS bloquean.

Hallazgo adicional no bloqueante pero recomendado:

2. Revocar credencial deja bots spot-defense sin arm con `hlAccountId` borrado

`revokeById` bloquea arms vivos, pero si hay `spot_defense_bots` activos sin arm, borra la credencial y no detiene/actualiza esos bots. Pool bots si se desactivan al final.

Referencia:

- `convex/hlCredentials.ts:66`

Recomendacion:

- En `revokeById`, al revocar una credencial sin arms vivos, desactivar/limpiar los `spot_defense_bots` vinculados a esa cuenta, igual que se hace con `bots`.

Cierres ya correctos:

- Exclusividad pool/grid actualizada.
- Reconfiguracion con arm vivo bloqueada.
- Reserva exige bot admisible.
- `resolveLeverage` ya se usa en reserva.

Verificacion ya ejecutada:

- `npm run typecheck` OK
- `npm test -- --run tests/spotDefenseBackend.test.ts tests/reservation.test.ts tests/poolBotExclusivity.test.ts` OK, 24/24.

Entrega esperada:

- Corrige el CAS live guard.
- Agrega tests de CAS.
- Opcional pero recomendado: corrige revocacion de credencial para bots spot-defense sin arm vivo.
- Pide nueva reauditoria Codex antes de Fase 3.

Objetivo: obtener GO de codigo Fase 2.
