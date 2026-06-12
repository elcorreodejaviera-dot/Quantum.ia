# Prompt de auditoría Codex — Autoleverage (función de seguridad de cobertura)

Cambios SIN commitear en el working tree (base master). Plan en `docs/plan-autoleverage.md`
(GO de plan de Codex tras 2 rondas). Pega el bloque de abajo en Codex (otra terminal, dentro
del repo). Para ver el diff completo: `git diff` + el archivo nuevo `convex/leverage.ts`
(untracked, míralo con `cat convex/leverage.ts`).

---

Eres un auditor de código senior. Revisa los cambios SIN COMMITEAR en el working tree del repo
Quantum.ia (portal de bots de cobertura de liquidez en Hyperliquid **mainnet, capital real**).
Base master. Diff: `git diff`; archivo nuevo untracked: `convex/leverage.ts`; plan:
`docs/plan-autoleverage.md`.

## Qué se implementa

Arreglo del **autoleverage**. Antes, con `bot.autoLeverage = true` el backend forzaba
**leverage = 1x** (peor caso de margen) en los dos motores → activar "Auto" rompía la apertura
por falta de margen. Semántica correcta acordada con el usuario (función de SEGURIDAD para
proteger al menos el nocional del pool aunque el colateral sea pequeño):

- Base = **10x**. Si a 10x el colateral no cubre el nocional, **subir solo lo justo** hasta un
  **tope de 20x** (decisión explícita del usuario), nunca por encima del `maxLeverage` del activo.
- Si ni al tope cabe → `[blocked_margin]` (NO abrir una cobertura infradimensionada en silencio).
- `autoLeverage = false` → leverage manual `round(bot.leverage)`, validado 1–25 (igual que antes).

## Arquitectura

La decisión del leverage se movió a las mutations de reserva (`reserveExecution` JAV-43 y
`reserveArm` JAV-44), donde se conoce el margen ya comprometido por la cuenta — para que sea
ATÓMICA con el gate de margen y el leverage enviado a HL (`updateLeverage`) sea SIEMPRE el mismo
con el que se dimensiona el margen. Helper puro único: `convex/leverage.ts:resolveLeverage`.

## CONTEXTO CRÍTICO DEL PROYECTO

- Trading REAL en mainnet beta. Subir leverage en isolated **acerca la liquidación** — verifica
  que el tope 20x se respeta SIEMPRE y que jamás se envía a HL un leverage > min(20, maxActivo).
- `committedMarginForAccount` suma el margen comprometido por AMBOS motores (IOC manual JAV-43 +
  triggers JAV-44). El gate de margen usa `MARGIN_SAFETY_BUFFER = 0.10`. El helper DEBE usar el
  MISMO buffer en su `usableReal`, si no el leverage elegido podría no pasar el gate (o pasarlo
  con holgura distinta).
- `convex codegen` NO type-checkea los cuerpos a fondo; el type-check real es `deploy` (ya pasé
  `tsc --noEmit -p convex/tsconfig.json` EXIT 0, pero señala cualquier cosa que rompa en runtime).
- Hay filas LEGACY en `execution_requests` sin el nuevo campo `appliedLeverage`.

## Revisa CON LUPA

1. **`convex/leverage.ts` (helper `resolveLeverage`)** — el corazón:
   - Coherencia matemática: con `lev = ceil(reservedNotional/usableReal)`, ¿se garantiza
     `marginRequired ≤ usableReal` y por tanto que el gate posterior pasa? ¿Hay algún caso (lev
     capado a 10 por la base cuando needed<10) donde NO pase? ¿Off-by-one en el `ceil`?
   - `usableReal <= 0` → `[blocked_margin]`. ¿División por cero o `Infinity`/`NaN` en algún punto?
   - `assetMaxLeverage`: estrictamente `Number.isInteger && >= 1`, sin truncar (un 20.9 se rechaza).
     ¿Correcto? ¿Y si `maxActivo < 10`? (clamp: `min(hardCap, max(10, needed))` con hardCap<10 →
     resultado = hardCap; ¿deseable que use el máximo del activo aunque sea <10?)
   - Modo manual: `round(manualLeverage)` validado 1–25. ¿`round` puede producir >25 o <1 tras
     validar? ¿Paridad EXACTA con el comportamiento previo (antes era `Math.round` de un valor
     validado en [1,25] en hyperliquid.ts, y [1,25] en triggerEngine.ts)?
   - Clasificación de errores: capacidad → `[blocked_margin]`; params/metadata → `[blocked_config]`.
     ¿Algún throw mal clasificado que el cron de auto-rearm interpretaría mal?

2. **`getAssetMeta` (hyperliquid.ts)** — añade `maxLeverage` de `meta.universe[idx].maxLeverage` EN
   CRUDO, **sin validar** (puede ser `NaN` si HL lo omite): `getAssetMeta` lo usan también rutas
   defensivas (cierre de emergencia, reconciliación) que NO deben fallar por metadata exclusiva de
   apertura. La validación estricta (entero ≥ 1) vive en `resolveLeverage`, solo en el camino de
   apertura/reserva (modo AUTO). ¿El otro call site de `getAssetMeta` (el que solo destructura
   `{assetId, szDecimals}`) sigue OK con el nuevo campo?

3. **`reserveExecution` (executions.ts)**:
   - Ya NO recibe `marginRequired` del action; lo calcula el helper. ¿Se eliminaron todas las
     referencias al arg viejo? ¿El gate de margen usa el `marginRequired` del helper (no el viejo)?
   - Persiste `appliedLeverage` + `marginReserved = marginRequired`. ¿Coherente con el schema nuevo?
   - **Idempotencia/dedupe (Codex #3 del plan):** la rama `existing` devuelve
     `appliedLeverage: existing.appliedLeverage` SIN recalcular. Una fila legacy lo devuelve
     `undefined`. Verifica que el caller (hyperliquid.ts) NO ejecuta `updateLeverage` en la rama
     dedupe/alreadyExists (retorna antes). ¿Algún camino donde un `appliedLeverage` undefined llegue
     a `updateLeverage`?

4. **`executePerpMarketOrder` (hyperliquid.ts)**:
   - Se quitó el cálculo local de leverage. `appliedLeverage` se lee de `reservation` SOLO en la
     rama de reserva NUEVA (tras el early-return de `alreadyExists`), con guard de finitud. ¿El
     orden de lectura es correcto (no se usa antes de definir)? ¿`updateLeverage` usa ese valor?

5. **`reserveArm` (triggerArms.ts)**:
   - Ya NO recibe `appliedLeverage`/`marginReserved`; los calcula el helper con `reservedNotional`
     (que el action pasa con el factor 2× del OCO). ¿El leverage/margen se dimensionan sobre el
     WORST-CASE 2×, como antes? Persiste `appliedLeverage`+`marginReserved` en el arm y los devuelve.
   - Se quitaron las validaciones de args `marginReserved>0` y `appliedLeverage>0` (ahora el helper
     valida). ¿Queda algún hueco de validación en la frontera de persistencia?

6. **`triggerEngine.ts armPoolBotEntry`**:
   - Se eliminó el cálculo local `effLev/appliedLeverage/orderMargin/marginRequired`. `appliedLeverage`
     se recibe de `reserveArm` y se usa en `updateLeverage`. ¿El `orderNotional`/`reservedNotional`
     (factor 2×) siguen correctos?
   - **OCO crítico:** la reducción 2×→1× (`reduceArmReservation`, dos call sites) lee
     `arm.reservedNotional/2` y `arm.marginReserved/2` del arm PERSISTIDO — NO de `appliedLeverage`.
     Verifica que sigue siendo consistente con el nuevo `marginReserved` derivado del helper (= 
     `reservedNotional/lev`), y que tras el OCO el margen reservado 1× = `orderNotional/lev`.

7. **schema.ts**: `execution_requests.appliedLeverage: v.optional(v.number())`. ¿Optional es
   suficiente para no invalidar filas legacy en el `deploy`? ¿Algún índice/uso que asuma presente?

## Invariantes a confirmar (NO deben romperse)

- Leverage entero siempre; el enviado a HL == el usado para el margen.
- En modo AUTO: nunca leverage > min(20, maxActivo); nunca posición infradimensionada silenciosa.
  (En modo MANUAL se conserva el rango 1–25 previo; además, CUANDO la metadata es fiable —`maxActivo`
  entero ≥ 1— se rechaza `appliedLeverage > maxActivo` ANTES de reservar (fix #2); si HL la omite, no
  se acota y HL queda como autoridad final, sin bloquear por metadata ausente (fix #1).)
- `getAssetMeta` NO valida maxLeverage (rutas defensivas no deben fallar); la validación estricta
  vive en `resolveLeverage`, solo en el camino de apertura/reserva.
- Gate de margen atómico con `MARGIN_SAFETY_BUFFER` y `committedMarginForAccount` intacto (solo
  cambia el leverage de entrada).
- `autoLeverage = false` ⇒ comportamiento idéntico al actual (regresión).
- Dedupe/legacy: no recalcula, no re-ejecuta `updateLeverage`.

## Casos límite a validar

- Colateral suficiente aislado pero insuficiente tras `marginCommitted` de otra orden viva.
- OCO (`reservedNotional = 2× orderNotional`): leverage sobre 2×, reducción posterior /2.
- `maxActivo < 20`. Colateral que no cabe ni a 20x → `[blocked_margin]`.

Devuelve GO / NO-GO con hallazgos numerados por severidad (ALTO/MEDIO/BAJO) y archivo:línea.

---

## RE-AUDITORÍA (ronda 2) — fixes de los 2 ALTO aplicados en `convex/leverage.ts`

La ronda 1 dio NO-GO por #1 y #2 (ambos en el modo manual). Aplicado SOLO en `leverage.ts`
(#3 y #4 diferidos a JAV-53/JAV-54). Verifica que cierran los hallazgos sin regresión:

- **#1** — La validación estricta de `assetMaxLeverage` (`Number.isInteger && ≥1`) y las de
  `availableCollateral`/`marginCommitted` se MOVIERON dentro de la rama AUTO. La rama manual ya no
  se bloquea por metadata del activo ausente/cambiada. `reservedNotional` queda como validación
  global (lo usan ambos modos). ¿Queda algún hueco de validación en manual?
- **#2** — En manual, tras `round(manualLeverage)`, se rechaza con `[blocked_config]` si
  `appliedLeverage > assetMaxLeverage` ANTES de reservar — pero SOLO cuando la metadata es fiable
  (`Number.isInteger(assetMaxLeverage) && ≥1`). Si HL la omite (NaN), NO bloquea (conserva la
  regresión de #1; HL queda como autoridad). ¿Esta reconciliación de #1↔#2 es correcta, o esperás
  un cap manual incondicional? Confirma que no reintroduce el problema de reserva-colgada en el caso
  común (metadata presente).

Confirma GO/NO-GO de la ronda 2.
