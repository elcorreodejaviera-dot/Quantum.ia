Eres auditor senior money-path del proyecto Quantum.ia.

Codex reviso la ronda 2 del plan JAV-107: Bot de defensa de posiciones SPOT.

Veredicto actual: **NO-GO ronda 2**.

No escribas codigo todavia. Actualiza solo el plan para cerrar estos bloqueantes:

1. Sizing todavia no replica la reserva de margen real

El plan usa `withdrawable x leverageEfectivo x (1 - MARGIN_SAFETY_BUFFER)`, pero no exige descontar `committedMarginForAccount` ni reutilizar `resolveLeverage`, que es la fuente auditada del motor actual.

Requisito: crear `reserveSpotDefenseArm` equivalente a `reserveArm`: `availableCollateral`, `marginCommitted`, `resolveLeverage`, `MARGIN_SAFETY_BUFFER`, cap y OCC en una sola mutation.

2. Precondicion flat no cubre intervencion manual posterior

Aunque la cuenta este flat al armar, el usuario puede abrir/cerrar manualmente el mismo coin despues. En HL la posicion es neta, asi que SL/TP/stop del bot pueden quedar sobredimensionados o cerrar exposicion ajena.

Requisito: exigir cuenta dedicada para spot-defense o anadir detector de drift en cada reconcile. Si `szi` real no coincide con el tamano esperado del arm tras fills/TPs, cancelar solo ordenes propias, marcar `manual_intervention/unknown`, y no hacer market close ciego.

3. Cap por `spot-defense:<botId>` no encaja con precheck antes de crear

El plan calcula cap restante en `precheckSpotDefenseCreate`, pero la clave propuesta es `spot-defense:<botId>` y todavia no existe `botId`. Ademas el cap no puede ser solo preflight: debe ser atomico en reserva/envio para evitar carreras.

Requisito: usar `spot-position:<spotPositionId>` si se valida antes de insertar, o insertar bot primero y reservar con `spot-defense:<botId>`. En cualquier caso, validar cap en `reserveSpotDefenseArm`, `markArmSubmitting` y `gateArmBeforeOrder`.

4. Cobertura parcial por cap/margen puede ocultar infra-cobertura

El plan permite `min(...)` y avisa en UI si queda parcial, pero eso puede crear una defensa mucho menor a la posicion que el usuario cree cubierta.

Requisito: requerir confirmacion explicita cuando `notionalEfectivo < requestedNotional`, persistir `requestedNotionalUsd` y `effectiveNotionalUsd`, y mostrar porcentaje cubierto. Opcionalmente bloquear si queda por debajo de un umbral minimo.

Entrega:

- Actualiza solo `docs/plan-jav107-spot-defense.md` y el prompt de auditoria si aplica.
- No implementes codigo.
- Resume como cerraste cada bloqueante.
- Pide una tercera auditoria Codex antes de pasar a Fase 1.

Objetivo: obtener GO de plan en ronda 3.
