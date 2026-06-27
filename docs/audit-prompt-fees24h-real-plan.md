# Prompt de auditoría (Codex) — PLAN: "Fees 24h por posición" REAL

Eres revisor técnico. Audita el **plan** `docs/plan-fees24h-real.md` (NO escribas código). Veredicto
**GO / NO-GO** con hallazgos accionables. Es una app Convex (backend) + React (frontend) de LP/DeFi.

## Contexto
El tile "Fees 24h (tu parte)" del portal muestra una estimación **pool-wide** (`fees1d * liquidez/TVL`,
`src/components/BotPortal.jsx:423-431`) que ignora la concentración del rango → da ~$3 cuando el cobrable
real on-chain de la posición de prueba (tokenId 5562243, Arbitrum) es **$15.46**. El usuario exige que sea
**REAL**. El plan propone derivar "Fees 24h" = Δ(collected+uncollected) en 24h vía snapshots horarios
(tabla nueva `pool_fee_snapshots` poblada por el cron de 1h existente), reutilizando la maquinaria JAV-117
inerte (`fetchUncollectedFeesRaw` = collect() simulado en RPC público SIN Alchemy, `pool_fee_events`,
`feeShareRatio`). Todo read-only/display.

## Verifica GO/NO-GO (sé escéptico; lee el código citado en el plan)
1. **Corrección del "real"**: ¿`fees_24h = feesAccum(now) − feesAccum(ref)` con
   `feesAccum = collected + max(tokensOwed − principalDebt, 0)` mide bien las fees generadas, sin double-count
   ni contaminación por precio? El plan valúa el delta RAW a spot al mostrar (no cachea USD). ¿Correcto el
   manejo de `principalDebt` (Decrease libera principal que infla tokensOwed)? Ver `poolScanner.ts:888-903`.
2. **Caso collects sin Alchemy**: un `collect()` baja uncollected sin ser pérdida; pero **un delta positivo
   también puede subcontar** si la `snapshotKey` cambió (ej: cobra y regenera → `collected` no avanza). No
   basta clampar negativos: si la key cambió, certificar `ok` exige los eventos completos de la ventana
   (Fase 4, getLogs estrecho RPC público); si no → `partial`. ¿Es honesto y suficiente? ¿El getLogs estrecho
   es viable o debe descartarse? ¿Hay un caso donde `partial` engañe al usuario?
3. **Snapshots**: tabla/índice (`by_pool_at`), elección del ref "más nuevo ≤ now−24h", bootstrap
   `warming_up`, retención/poda. ¿Sin interpolación es aceptable en v1? ¿Riesgos de huecos si el cron falla?
4. **Fallback `warming_up`**: mostrar el **valor USD 24h concentrado** `estimatedFees24hUsd = fees1d *
   feeShareRatio` (NO la APR `estimatedFeeApr = fees24hUsd / valor`, que es una tasa) etiquetado "Estimado".
   ¿Aceptable como transición o el usuario (que quiere REAL) preferiría `—`? ¿`feeShareStatus`
   `out_of_range`/`inconsistent` correctamente → `—`?
5. **Money-path**: confirmar que TODO es read-only/display: `fetchUncollectedFeesRaw` es `eth_call`
   (simulación, no envía tx); el writer solo inserta snapshots; la UI solo lee. ¿Algo toca ejecución/margen?
6. **Reutilización vs limpieza JAV-117**: ¿es correcto NO borrar el backend inerte y reutilizarlo? ¿Algún
   acoplamiento con el camino Alchemy `no_key` que rompa?
7. **Fases**: ¿el troceo (schema→writer→cron→lectura→getLogs opc.→UI) es auditable e incremental? ¿Falta
   alguna fase o verificación? ¿Costo del +1 eth_call/pool/hora vs `POOL_SCAN_CONCURRENCY=5`?
8. **Supuestos no verificados**: el plan marca 2 (el $15.46 on-chain; `prices` antes del 1er snapshot).
   ¿Algún otro supuesto oculto que deba verificarse antes de implementar?

Entrega: GO / NO-GO + lista priorizada de hallazgos (ALTO/MEDIO/BAJO) con la corrección sugerida.
