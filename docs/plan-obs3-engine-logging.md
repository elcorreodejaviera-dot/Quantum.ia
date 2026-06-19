# OBS-3 — Logging estructurado en el money-path

## En una frase

Hoy hay apenas ~6 `console.*` en todo el backend del motor → depurar un incidente real con dinero
sería casi a ciegas. OBS-3 = añadir logs estructurados en los puntos clave, SIN cambiar decisiones.

## Problema (verificado)

`grep console.(log|error|warn)` en `convex/`:
- `triggerEngine.ts` 4, `executionsCron.ts` 1, `hlCredentialActions.ts` 1. El resto del motor
  (`executions.ts`, `hyperliquid.ts`, `triggerArms.ts`, `triggerRearm.ts`, `coverageUsage.ts`) → 0.

Para un motor que abre/protege/cierra posiciones reales en HL, no hay traza de las transiciones
críticas. Cuando algo falla en producción, no hay forma de reconstruir qué pasó.

## Alcance (NO money-path-logic; SOLO observación)

Añadir logging estructurado en transiciones clave. NO cambia ninguna condición, gate ni decisión:
solo emite líneas legibles en los logs de Convex. Cero efecto sobre el trading.

## Diseño

### 1. Helper de log estructurado — ALLOWLIST DE CAMPOS + REDACCIÓN (auditoría Codex, hallazgo ALTO #1)

El motor maneja credenciales descifradas y cuentas reales (`hyperliquid.ts`: `decryptPrivateKey`,
`tradingAccountAddress`, etc.). "Nunca secretos" como comentario NO basta: el helper IMPONE una
allowlist de campos ESCALARES y prohíbe explícitamente los sensibles. No se loguean objetos crudos.

```ts
// Campos PROHIBIDOS (jamás se loguean, ni dentro de meta ni de errores):
//   credential, privateKey, encryptedPrivateKey, iv, authTag, tradingAccountAddress, agentAddress,
//   cualquier request/response cruda del SDK.
// elog SOLO acepta escalares (string acotado/number/boolean/null) → imposible pasar un objeto/clave.
type Scalar = string | number | boolean | null;
function elog(scope: string, event: string, fields: Record<string, Scalar>) {
  // (opcional) recorte defensivo de strings largos para no volcar payloads.
  console.log(JSON.stringify({ scope, event, ...fields, ts: Date.now() }));
}

// Para errores: NUNCA loguear `e` crudo (un error de SDK/exchange puede traer request/response con
// datos sensibles). Se extrae solo un mensaje corto y redactado.
function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 300); // truncado; sin stack ni payload crudo
}
```

Los call-sites pasan SOLO ids y valores escalares no sensibles (p.ej. `cloid`, `botId`, `status`,
`reason`, `appliedLeverage`). **`appliedLeverage`/`cloid`/ids NO son secretos** (no permiten operar la
cuenta); aun así, ningún campo de credencial/cuenta entra. Si se duda de un campo → no se loguea.

### 2. Puntos a instrumentar (transiciones críticas, sin cambiar lógica)

- **executions.ts:** reserva (`reserveExecution`), `markSubmitting`, `gateBeforeOrder` (admisión/
  rechazo + motivo), `settleExecution` (estado→estado, reason).
- **hyperliquid.ts:** envío de orden (cloid, coin, side, leverage), respuesta/clasificación de error
  SDK (determinista vs transporte), `updateLeverage` ok/fallo.
- **triggerEngine.ts / triggerArms.ts:** armado, fill, settle de arm, OCO, transición a protected.
- **triggerRearm.ts:** decisión de auto-rearm (kind: blocked_config/blocked_margin/cancel).
- **coverageUsage.ts:** rechazo `[blocked_config]`/`[blocked_margin]` (qué pool, qué total vs cap).

Para cada uno: una línea `elog(scope, event, {ids, status, reason})`. **Nunca** loguear claves
privadas, ciphertext, ni el contenido sensible de credenciales.

### 3. Niveles

- `console.error(scope, event, safeError(e))` para fallos inesperados — **NUNCA `console.error(e)`
  crudo** (Codex MEDIO #2): un error de SDK/exchange puede traer request/response con datos sensibles.
  Siempre vía `safeError(e)` (mensaje corto, sin stack ni payload).
- `console.warn` para rechazos esperados (gate fail-closed, blocked_*).
- `console.log` (vía `elog`) para transiciones normales.

### 4. (Opcional, fase 2) Persistir eventos críticos

Evaluar una tabla `engine_events` para los hitos más importantes (no todo), consultable desde el
panel admin. Diferible; empezar solo con logs de Convex.

## Verificación

- `npm run typecheck`.
- Revisar en el dashboard de Convex (Logs) que las transiciones emiten las líneas esperadas durante
  una operación real, y que NO aparece ningún dato sensible (claves/credenciales).
- Confirmar por diff que NO se tocó ninguna condición/gate (solo se añadieron llamadas a `elog`).

## Riesgos

- Bajo, PERO money-path-adjacent: el riesgo es introducir accidentalmente un cambio de lógica al
  instrumentar, o loguear un secreto. Mitigación: auditoría Codex centrada en "¿algún `elog` cambia
  control de flujo?" y "¿algún campo logueado es sensible?".
- Volumen de logs: mantener una línea por transición, no por iteración de bucle.

## Troceo por módulo — REQUISITO, no opción (auditoría Codex, hallazgo MEDIO #3)

OBS-3 NO se implementa de una vez sobre todo el motor. Se hace **un módulo por PR**, auditando código
entre cada uno, empezando por los de MENOR superficie de secretos:

1. **PR 1 — `coverageUsage.ts` (gates) + `triggerRearm.ts`** (no tocan credenciales descifradas;
   solo ids/estados/reason). Primero el helper `elog`/`safeError` + estos dos módulos.
2. **PR 2 — `executions.ts` / `triggerArms.ts` / `triggerEngine.ts`** (transiciones; sin claves).
3. **PR 3 — `hyperliquid.ts`** (el más sensible: maneja claves descifradas) — auditoría reforzada
   campo por campo.

La tabla opcional `engine_events` queda FUERA de la fase 1 (solo logs de Convex primero).

## Flujo

plan → Codex GO → implementar (1 módulo/PR) → Codex GO código → PR → CodeRabbit → deploy.
Prioridad BAJA-MEDIA. Hacer DESPUÉS de OBS-1/OBS-2 (más valor con menos riesgo).
