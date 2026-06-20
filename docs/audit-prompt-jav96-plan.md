# Prompt de auditoría Codex — PLAN de JAV-96 (orphan_orders falso positivo)

Eres un auditor senior. Audita el **PLAN** (no código aún) de un fix en el motor de cobertura de
Quantum.ia (money-path). Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Si GO,
confirma que el plan es seguro de implementar tal cual; si NO-GO, di exactamente qué cambiar.

## Documentos
- Plan: `docs/plan-jav96-orphan-orders.md`
- Issue: Linear JAV-96.

## Resumen del bug
El check `orphan_orders` (`src/lib/poolAudit.js:51`) marca falso positivo: lee
`trigger_orders.observedStatus` de la DB (`convex/admin.ts:291`), NO HL en vivo. Las órdenes de entrada
se ponen `open` al colocarse (`triggerEngine.ts:372`) pero al cancelarse en cierre/disarm
(`ensureOrdersDead`/`cancelByCloid`) nunca se pasan a `canceled` → quedan `open` rancio en arms
terminales. Fix propuesto (Opción A): marcar `observedStatus:"canceled"` SOLO donde `ensureOrdersDead`
ya confirmó muerte, vía nueva `markArmOrdersCanceled(armId, token, roles?)` bajo lease.

## Verifica (CRÍTICO primero)

1. **Corrección del enfoque.** ¿Marcar `open/pending → canceled` solo tras `ensureOrdersDead===true` es
   correcto y suficiente para eliminar el falso positivo sin enmascarar un huérfano REAL? ¿Hay algún
   camino de terminalización del arm (closed por SL, por TP-final, `armed_lower_only`, disarm/pausa,
   emergency, manual, `failed`) que cancele órdenes pero NO pase por `markArmOrdersCanceled` → quedaría
   rancio? Enumera los call sites de `settleArm`→terminal y di en cuáles falta la llamada.

2. **No enmascarar huérfano real.** ¿Es correcta la decisión de NO normalizar a ciegas en `settleArm`
   (para que un cancel fallido en silencio siga siendo detectable)? ¿O conviene una variante?

3. **Fencing / lease.** `markArmOrdersCanceled` debe respetar el mismo fencing que `setArmOrderObserved`
   (token + lease vigente). ¿El plan lo garantiza? ¿Riesgo de carrera con el reconcile que rota/recoloca
   órdenes (p.ej. un `entry_lower` que se re-arma en `armed_lower_only`)? Confirmar que NO se marca
   `canceled` una orden que sigue VIVA y armada (caso `armed_lower_only`: NO tocar `entry_lower`).

4. **Estados que NO se deben tocar.** Confirmar que solo `open`/`pending` → `canceled`, nunca
   `filled`/`triggered`/`rejected`/`canceled`. ¿Algún efecto sobre OCO, auto-rearm, conteo de
   whipsaw/consecutiveStops, o liberación de margen? (No debería: solo toca el campo observado de la
   orden, no la reserva ni el estado del arm.)

5. **Diagnóstico previo.** ¿El paso de diagnóstico (query Convex de trigger_orders open en arms
   terminales + `frontendOpenOrders` de la cuenta) es suficiente para distinguir rancio vs huérfano real
   antes de tocar money-path?

6. **Idempotencia y observabilidad.** `markArmOrdersCanceled` idempotente; `elog` solo escalares (sin
   cloids/claves sensibles). ¿OK?

7. **Tests.** ¿La cobertura propuesta (poolAudit pure + convex-test del cierre) congela el invariante
   "arm terminal ⇒ entradas en canceled, no open"? ¿Falta algún caso?

8. **Alternativa B.** ¿Estás de acuerdo en descartar por ahora el cruce contra HL live en `adminLive.ts`
   (coste RPC, no corrige la inconsistencia de datos) y dejarlo como endurecimiento posterior?
