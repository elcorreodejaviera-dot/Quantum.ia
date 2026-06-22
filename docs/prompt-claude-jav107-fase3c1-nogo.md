# JAV-107 Fase 3c-1 — NO-GO Codex

Claude: aplica estos bloqueantes de Codex en la rama `feat/jav107-spot-defense`.

Contexto:
- Prompt auditado: `docs/audit-prompt-jav107-fase3c1-codigo.md`
- Commit auditado: `2705f8a`
- Alcance: Fase 3c-1, `reconcileSpotDefenseArm` + `recordSpotDefenseSlOrder`
- Verificacion actual: `typecheck` OK, tests OK (`226/226`), pero los tests no cubren estos bloqueantes.

## Bloqueantes

1. ALTO — `wantDisarm` reporta `disarmed` aunque la transicion puede fallar.
- En `convex/spotDefenseEngine.ts`, fase pre-fill, se llama `settleSpotDefenseArm(... status:"disarmed")` y se devuelve `{ result:"disarmed" }` sin revisar `r.ok`.
- `ALLOWED_SD` no permite `submitting -> disarmed` ni `unknown -> disarmed`.
- Resultado: el reconcile puede cancelar y decir que desarmo, pero el arm queda vivo/atascado.
- Fix: permitir transiciones correctas o pasar por `disarming`; siempre validar `settle.ok` y devolver skipped/failure si no aplico.

2. ALTO — `closed/disarmed` puede dejar ordenes huerfanas vivas.
- `cancelOwnByCloid` solo envia cancel por CLOID, traga errores y no confirma muerte en `frontendOpenOrders`.
- En flat close y pre-fill disarm se terminaliza en el mismo ciclo despues de cancelar.
- Resultado: un trigger propio puede seguir vivo en HL con el arm ya `closed`/`disarmed`.
- Fix: implementar `ensureSpotDefenseOrdersDead` como el pool: leer open orders, cancelar vivos, retornar false si alguno estaba vivo; no terminalizar hasta un ciclo posterior que confirme todos muertos. Marcar ordenes `canceled` solo tras prueba negativa.

3. ALTO — SL puede quedar vivo en HL pero no persistido.
- `placeStopLoss` ocurre antes de persistir/renovar el estado del intento de SL.
- Si expira el lease, falla `recordSpotDefenseSlOrder`, o crashea despues del RPC, queda un SL aceptado por HL sin tracking local.
- Tambien se ignora el resultado de `recordSpotDefenseSlOrder` y luego se hace `settle` igual.
- Fix: preparar/upsert `sl` pending antes del RPC con CLOID determinista, renovar lease antes de enviar, despues del RPC validar `recordSpotDefenseSlOrder.ok` y `settle.ok`; si falla, no fingir protected.

4. ALTO — cierre flat usa una sola lectura de `szi==0`.
- El schema ya tiene `closeConfirmSince`, pero `reconcileSpotDefenseArm` solo espera desde `filledAt`.
- Resultado: una lectura transitoria flat tras lag de HL puede cerrar el arm prematuramente.
- Fix: primera lectura flat setea `closeConfirmSince`; segundo ciclo tras grace confirma flat + ordenes muertas y recien ahi `closed`. Si vuelve posicion abierta, limpiar `closeConfirmSince`.

5. MEDIO/ALTO — reconcile no revalida `mainnetSpotDefenseApproval`.
- `wantDisarm` chequea `tradingEnabled`, `simulationMode`, bot, red, cuenta y `canTradeLive`, pero no el gate dedicado `mainnetSpotDefenseApproval`.
- Resultado: puede colocar SL en mainnet aunque el gate dedicado de spot-defense este cerrado.
- Fix: exponer/reusar helper de admision o query interna para el gate mainnet; incluirlo en reconcile antes de cualquier RPC que coloque/cancele como politica de seguridad.

## Esperado para reauditoria

- Agregar tests que fallen con los 5 casos anteriores.
- Reejecutar `npm run typecheck`.
- Reejecutar suite completa `npm test -- --run`.
