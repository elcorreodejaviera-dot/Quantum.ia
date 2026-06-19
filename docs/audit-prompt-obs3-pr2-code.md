# Prompt de auditoría Codex — CÓDIGO de OBS-3 PR2 (logging del motor: coverage + ejecuciones + arms)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de OBS-3 PR2 para Quantum.ia (portal de bots sobre
Hyperliquid, capital real). El plan maestro (`docs/plan-obs3-engine-logging.md`) ya tiene tu GO. PR1
(helper `log.ts` + `triggerRearm.ts`) ya está mergeado en `master`. Este PR2 instrumenta cuatro
módulos del money-path con el MISMO helper `elog` — SOLO observación, sin cambiar ninguna decisión.

Revisa el diff (rama basada en `master`):

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/obs3-engine-logging-pr2 -- convex/
```

Verificación ya hecha: `npm run typecheck` EXIT 0.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO).

## Contrato del helper (recordatorio, NO cambia en este PR)
`elog(scope, event, fields)` (en `convex/log.ts`) SOLO acepta escalares (`string|number|boolean|null|
undefined`), envuelve en try/catch (nunca lanza), emite una línea JSON. PROHIBIDO loguear: privateKey,
encryptedPrivateKey, iv, authTag, credential, tradingAccountAddress, agentAddress, request/response
crudos del SDK.

## Invariantes a verificar (los DOS críticos primero)

1. **CERO cambio de control de flujo (CRÍTICO).** Confirma que CADA edición solo AÑADE una llamada a
   `elog` y no altera condiciones, returns, orden de `await`, fencing de leases, gates de admisión/
   cobertura, ni los `ctx.db.patch`. Presta atención a las 3 líneas de `gateBeforeOrder` en
   `executions.ts` que pasaron de `if (...) return` de una línea a bloque `{ elog; return }`: la
   condición y el valor de retorno deben ser idénticos.

2. **NINGÚN campo sensible (CRÍTICO).** Repasa los ~24 call-sites de `elog`. Solo deben aparecer:
   ids (`String(armId/requestId/botId/poolId)`), estados/eventos (`from`/`to`/`status`/`reason`/
   `gate`/`closeReason` = enums internos), `appliedLeverage`/`generation`/`asset`/`side`, booleans
   (`anyFilled`/`anyPlaced`/`transportUncertain`/`hadError`/`twoEntries`/`fromRearm`) y números no
   sensibles (`total`/`cap`/`filledSize`). NADA de claves/credenciales/direcciones/payloads del SDK.
   - En particular: `triggerEngine.ts` `entries_sent` loguea `hadError: !!hardError` (BOOLEAN), NO el
     string `hardError` del SDK. `executions.ts` `transition` loguea solo `from`/`to`, NO `error`.
     `settleArm`/`closeArmAndScheduleRearm` loguean `closeReason` (enum), NO `error`. ¿Algún sitio se
     escapó y loguea un string de error crudo?

3. **`elog` no rompe el money-path.** El helper ya es best-effort (try/catch). Aun así, ¿algún `elog`
   se colocó donde una excepción suya (imposible hoy) o un coste added afectaría una transacción OCC?
   Todos van DESPUÉS del `ctx.db.patch`/`insert` relevante o en ramas de retorno, ¿correcto?

4. **Coherencia con el estado real (como en PR1).** Las líneas de `transition` se emiten SOLO cuando
   la transición se aplicó de verdad (tras fencing + ALLOWED + cuarentena N6 en `settleArm`; tras los
   early-returns de no-op). ¿Algún `elog("…","transition")` puede emitirse en un no-op (fencing fallido,
   estado terminal, transición no permitida)? No debería: van tras los guards.

5. **Volumen de logs.** Una línea por transición, no por iteración de bucle. Revisa
   `applyTransition` (lo llama un bucle en `closeOpenExecutionsForBotInternal`: una línea por ejecución
   cerrada al borrar el bot = aceptable, no es hot-path) y `gate_before_order`/`entries_sent` (una por
   intento de orden). ¿Algún `elog` quedó dentro de un bucle caliente o de reconcile por-tick?

## Mapa de call-sites (para tu verificación)
- `coverageUsage.ts`: `cap_rejected` antes del throw `[blocked_margin]`.
- `executions.ts`: `reserved`, `reserve_dedupe`, `submitting`(+`_blocked` x2), `gate_before_order`
  (state/expired/claimed/blocked_admissible/blocked_coverage/ok), `transition` (en `applyTransition`).
- `triggerArms.ts`: `reserved`, `submitting`(+`_blocked`), `gate_before_order` (blocked_coverage/ok),
  `transition` (en `settleArm`, `closeArmAndScheduleRearm`, `transitionToArmedLowerOnly`),
  `breakeven_activated` (en `activateBreakeven`).
- `triggerEngine.ts`: `entries_sent` (clasificación del envío de entradas; el `settleArm` posterior ya
  registra la transición resultante).

NOTA: `hyperliquid.ts` (claves descifradas) queda para PR3 — NO se toca aquí.
