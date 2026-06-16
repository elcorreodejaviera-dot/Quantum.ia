# Prompt de auditoría Codex — JAV-76 (SubscriptionBar real)

Eres un auditor senior. Audita el **PLAN** `docs/plan-jav76-subscriptionbar-real.md` (todavía NO hay
código). Contexto: Quantum.ia, portal de bots de cobertura sobre Hyperliquid. JAV-76 es **frontend
puro, sin money-path**; solo cambia cómo `SubscriptionBar` (`src/components/BotPortal.jsx:675`)
muestra el plan y la cobertura usada. El backend de planes (`convex/subscriptions.ts`,
`getMySubscription`, catálogo `PLANS`) ya existe en `master` (JAV-74) y NO se toca en este PR.

Semántica acordada con el usuario: el cap del plan (`coverageCapUsd`) mide **cobertura de pools**
(`Σ pool.liquidity` de pools con bot activo), NO el nocional de los bots. El nocional de bots
(`liquidity × (1+buffer/100)`, buffer hasta 100% → hasta 2×) es una métrica informativa aparte.

Evalúa y responde **GO / NO-GO** con hallazgos numerados (severidad ALTO/MEDIO/BAJO):

1. **Estados de `getMySubscription`**: ¿el plan distingue bien `undefined` (cargando) / `null` (no
   auth) / `{plan:null, cap:0}` (sin plan) / con plan? ¿Algún número engañoso o porcentaje con
   `cap = 0`? ¿Fail-closed correcto (0 ≠ ilimitado)?
2. **Cómputo de cobertura de pools**: contar `pool.liquidity` UNA vez por pool con ≥1 bot activo.
   ¿Riesgo de doble conteo si un pool tiene bot `il` + `trading`? ¿Bots activos en pools ausentes de
   `pools`?
3. **Nocional en bots**: `Σ liquidity×(1+(bufferPct ?? 0)/100)` sobre bots activos. ¿`bufferPct`
   ausente/NaN manejado? ¿La métrica es coherente con "el doble"?
4. **Conflicto de semántica con el backend** (`convex/subscriptions.ts:9-12` dice cap = Σ
   totalNotional CON buffer; el usuario dice cap = liquidez de pool SIN buffer). El plan lo difiere a
   JAV-77. ¿Es correcto NO tocar backend aquí? ¿Algún riesgo de que el display de JAV-76 y el
   enforcement de JAV-77 queden incoherentes para el usuario?
5. **Decisión cliente vs backend** para la cobertura usada de display: ¿razonable hacerlo en cliente
   en JAV-76 y dejar la fórmula autoritativa a JAV-77? ¿O conviene ya un `getMyUsedCoverage` backend?
6. **Limpieza**: eliminar la constante `SUBSCRIPTIONS` (línea 21). ¿Algún uso residual?
7. **Scope creep**: ¿el plan se mantiene frontend-only y no arrastra money-path?

Sé concreto: cita líneas del plan. Si hay un NO-GO, lista exactamente qué cambiar.
