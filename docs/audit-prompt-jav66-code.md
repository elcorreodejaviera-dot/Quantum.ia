# Prompt de auditoría de CÓDIGO — JAV-66 (mover SL a break-even) — re-auditoría ronda 2

> Diff: rama `feat/jav66-breakeven-sl` (base master, sin commit). Plan: `docs/plan-jav-be-move.md`
> (rev.3, GO). Compila: `convex codegen` + `tsc -p convex/tsconfig.json` EXIT 0. Sin tests (proyecto
> sin runner). La ronda 1 dio **NO-GO (4 hallazgos)**; este diff los aborda con un **rediseño**.

## Rediseño (cómo se cierran los 4 hallazgos de ronda 1)

El error de ronda 1: la rotación BE se hacía "a mano" en un bloque propio y usaba el `triggerPx`
**persistido** (escrito por `prepareSlAttempt` ANTES de colocar) como prueba de "SL sano" → si la
colocación fallaba/pending, el ciclo siguiente creía el SL en BE y pasaba a TPs sin SL vivo; y el
escalado no disparaba porque `status` seguía `protected`.

**Rediseño:** la rotación NO se hace a mano. La activación del BE **degrada `protected→protecting`** y
deja que el **bloque (3) de `reconcileArm`** (ya auditado: confirma por CLOID, recoloca, escala a
emergencia) haga la rotación al nuevo trigger. Cómo cierra cada hallazgo:

- **H1 (place falla → protected sin SL, sin retry):** ahora durante la rotación `status==="protecting"`.
  El bloque (3) (`triggerEngine.ts`, `if (slOrder && (observedStatus!=="pending" || slSubmittedAt))`)
  confirma por CLOID y recoloca; ya no se confía en el `triggerPx` persistido como "sano".
- **H2 (pending no confirmado antes de TPs):** el bloque de TPs está gateado `if (arm.status ===
  "protected")`. En `protecting` se **salta** → los TPs no corren hasta que el bloque (3) confirme el
  SL `open` por CLOID y vuelva a `protected`. (slReady real.)
- **H3 (max attempts/deadline no escalan):** `activateBreakeven` resetea `protectDeadline` (now+4min) y
  `slAttempts=0`, y deja `status="protecting"`. El gate de emergencia
  (`(deadlinePassed||tooManyAttempts) && arm.status !== "protected"`) AHORA sí dispara durante la
  rotación → cierre de emergencia reduceOnly si no se logra el SL de BE a tiempo.
- **H4 (guard débil):** activación exige `beTrigger > markPx + hlTickSize(markPx, szDecimals)` (1 tick
  HL: el más restrictivo entre 6−szDecimals decimales y 5 cifras significativas).

## Cambios del diff (archivos)

- **`schema.ts`** — `trigger_arms` + `breakevenPct?` + `beMoved?` (opcionales, legacy-safe).
- **`hyperliquid.ts`** — `placeStopLoss` + `triggerPxOverride?` (sin override = idéntico).
- **`triggerArms.ts`** — `reserveArm` snapshotea `breakevenPct`; `prepareSlAttempt` acepta/persiste
  `triggerPx`; nueva **`activateBreakeven`** (CAS+token; solo desde `protected`; fija `beMoved=true`,
  `status="protecting"`, resetea `protectDeadline`+`slAttempts`+`slSubmittedAt`; idempotente).
- **`triggerEngine.ts`** — `markPx`/`beTrigger`/`desiredSlTrigger` (fuente única del trigger del SL);
  helper `hlTickSize`; bloque **(2.45) solo ACTIVACIÓN** (gate ganancia + guard tick → `activateBreakeven`);
  bloque **(3) rama "open"** detecta SL desactualizado (`triggerPx>0 && |triggerPx−desired|>tol`) →
  cancela para rotar; resize (2.4) y SL inicial (3) colocan con `desiredSlTrigger` override + persisten
  `triggerPx`. Snapshot validado/desactivado en el caller de `reserveArm` (no bloquea armado).
- **`bots.ts`** — cota `breakevenPct ≤ 50` (desacoplado de `stopLossPct`).

## Puntos a verificar (NO-GO si algún camino falla)

1. **Verifica que H1–H4 quedan cerrados** con el rediseño (arriba). ¿Algún camino con `beMoved=true` y
   sin SL vivo que NO recoloque (bloque 3) ni escale a emergencia (status protecting)?
2. **Degradación `protected→protecting`.** `activateBreakeven` hace un `ctx.db.patch` directo (no via
   `settleArm`), igual que `markEmergencyClosing`. ¿Es seguro saltarse `ALLOWED_ARM`? ¿Algún consumidor
   asume que `protected` no retrocede? ¿La ventana en `protecting` (TPs pausados, SL rotándose) es
   correcta? ¿`protecting→protected` (bloque 3) y `protecting→closed` (emergencia) están permitidos
   (sí en `ALLOWED_ARM`)?
3. **Ventana sin SL.** Tras activar BE, el bloque (3) cancela el +1% (rama "open" stale) y recoloca en
   BE el/los ciclo(s) siguientes. Al activarse, `markPx ≤ entry·(1−be/100)` (en ganancia) y el +1% está
   por ENCIMA → el precio está lejos del SL durante la rotación. ¿Aceptable? ¿`protectDeadline` reseteado
   da la red de emergencia correcta?
4. **Idempotencia / anti-doble-SL.** ¿La rotación vía bloque (3) conserva confirmar-antes-de-rotar
   (cancel → grace/negativa por CLOID → recolocar cloid nuevo)? `activateBreakeven` limpia `slSubmittedAt`
   → ¿afecta el grace del SL viejo (que se cancela por la rama stale, no por grace)?
5. **Detección de stale.** `slOrder.triggerPx > 0 && |triggerPx − desiredSlTrigger| > desired·5e-4`.
   ¿`5e-4` distingue +1% de BE (≈1% de separación) sin falsos positivos por deriva del entry medio?
   ¿El guard `triggerPx > 0` evita rotar filas legacy (triggerPx 0)? ¿Algún caso donde un SL correcto
   se considere stale y entre en bucle de cancelaciones?
6. **Paridad legacy / arm vivo.** Arms pre-deploy: `breakevenPct`/`beMoved` undefined → (2.45) no
   activa; rama stale gateada por `triggerPx>0` (legacy=0) → no rota. ¿El arm en producción AHORA
   cambia de comportamiento? ¿`prepareSlAttempt(triggerPx?)` default 0 mantiene compat?
7. **Paridad del flujo actual.** Con `beMoved=false`, `desiredSlTrigger == entry·(1+stopLossPct/100)`
   == valor de hoy; `placeStopLoss(override)` coloca el mismo trigger; la rama stale no dispara
   (triggerPx persistido == desired). ¿Cero regresión en SL inicial/resize/TPs sin BE?
8. **Margen / reduceOnly / fencing.** SL de BE reduceOnly full-size (no añade margen, no cierra de
   más). Todas las mutations bajo `renewArmReconcile`/token. ¿Algún `exchange.*` sin renovar lease?

## Entregable
GO / NO-GO + hallazgos numerados (ALTO/MEDIO/BAJO) con archivo:línea y corrección concreta.
