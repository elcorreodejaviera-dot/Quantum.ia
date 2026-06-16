# Prompt de auditoría Codex — JAV-76 CÓDIGO (SubscriptionBar real)

Eres un auditor senior. Audita el **CÓDIGO** del diff de JAV-76 (working tree, sin commit) contra el
plan ya aprobado `docs/plan-jav76-subscriptionbar-real.md`. Único archivo de código tocado:
`src/components/BotPortal.jsx` (componente `SubscriptionBar` + su callsite + se borró la constante
`SUBSCRIPTIONS`). **Frontend puro, sin money-path**; backend de planes (`convex/subscriptions.ts`) NO
se toca.

Para ver el diff: `git --no-pager diff -- src/components/BotPortal.jsx`.

Verifica y responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO):

1. **Estados de `getMySubscription`**: ¿se distingue bien `undefined` (cargando) / `null` (no auth) /
   `suspended` / `plan:null` (sin plan) / con plan? ¿El placeholder neutro evita mostrar uso 0 antes
   de tener `sub` + `botsFromDb` + `poolsFromDb`? ¿`loading` se deriva de los RAW (no de los `[]`
   normalizados)? ¿Algún `%` con `cap = 0` (fail-closed)?
2. **Suspendido**: ¿badge "Suspendido" (no "Online"), disponibilidad 0, sin sugerir operatividad?
3. **Cobertura de pools**: ¿cuenta `pool.liquidity` UNA vez por pool con ≥1 bot activo (set de
   `poolId`)? ¿Sin doble conteo con il + trading? ¿Bots activos en pools ausentes de `pools` →
   tratados como 0 sin romper?
4. **Nocional en bots**: `Σ liquidity × (1 + buffer/100)` sobre bots activos; ¿`buffer` normalizado
   contra NaN/Infinity/strings y clamp 0–100? ¿Métrica textual, SIN barra ni denominador de cap?
5. **`liquidityByPool`**: el map usa `p.id` (= pool `_id`) y los bots usan `b.poolId`. ¿Coinciden las
   claves? (¿`poolId` es el mismo `_id` string?) Si no coincidieran, la cobertura saldría 0 — verificar.
6. **Memos / dependencias**: ¿`useMemo` con deps correctas? ¿Hooks (`useQuery`, `useMemo`,
   `useState`) llamados SIEMPRE antes de cualquier `return` condicional (reglas de hooks)?
7. **Limpieza**: `SUBSCRIPTIONS` eliminada sin usos residuales; botón Upgrade `disabled`.
8. **Scope**: solo frontend, sin tocar money-path ni backend.

Sé concreto y cita líneas. Si hay NO-GO, lista exactamente qué cambiar.
