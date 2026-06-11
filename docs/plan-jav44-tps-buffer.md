# Plan JAV-44 — TPs parciales sobre el BÚFER (recuperar pérdidas de SL encadenados) — rev.2

## (Codex #1) Representación CERRADA de N TPs
`trigger_orders`: `role: "entry_lower" | "sl_upper" | "tp"` + **`tpIndex: v.optional(v.number())`**
(solo presente en `role:"tp"`, valores 0..N-1). **Índice nuevo `by_arm_role_index` = `[armId, role,
tpIndex]`** para lookup/unicidad por TP individual (el `by_arm_role` actual `[armId, role]` solo da
UNA fila por role → no sirve para N TPs). Unicidad de un TP = `(armId, "tp", tpIndex)`. cloid
determinista `botId|generation|tp:<tpIndex>:<attempt>`. `entry_lower`/`sl_upper` no usan `tpIndex`.
`getArmOrdersInternal` (todos por armId) sigue sirviendo para `ensureOrdersDead`/cancelación. Para
un TP concreto: query por `by_arm_role_index` con `tpIndex`.

## (Codex #2) Tamaño mínimo por TP tras redondeo
Cada `TP_i size = floorToDecimals(bufferSize * closePct_i/100, szDecimals)`. **Si queda ≤ 0 → OMITIR
ese TP** (no se coloca): su porción de búfer simplemente NO se cierra con TP y queda como parte de la
posición protegida por el SL full-size (seguro, no desnuda nada). Validar también en el armado:
`tps[i].gainPct > 0`, `closePct_i > 0`, `Σ closePct_i ≤ 100`. Con búfer pequeño o muchos TPs, los que
redondeen a 0 se descartan silenciosamente (alerta opcional), nunca se envía un size 0/ inválido a HL.


Sobre la pieza SL post-fill (PR #20). El bot ya: entra (trigger nativo) → al llenarse arma el SL
full-size → `protected` → cierre de emergencia como red. Esta pieza añade los **Take Profit parciales**.

## Estrategia (aclaración del usuario)
La posición se abre con **pool + búfer**:
- **Capital pool** (`hedgeNotionalUsd`) = la cobertura del IL; se mantiene abierta, protegida por el SL.
- **Capital búfer** (`bufferPct`% del pool) = extra sobre el que se toman ganancias parciales.
Los **TPs cierran SOLO la porción del búfer** (Take Profit Market, reduceOnly, triggers ABAJO del
entry = el short gana al caer el precio). Como Σ(tamaños TP) ≤ búfer, **el pool nunca lo cierran los
TPs** → sigue abierto bajo el SL full-size. Objetivo: recuperar las pérdidas mínimas de varios SL.

## Sizing (cambio en la ENTRADA)
- **Total entrada = `hedgeNotionalUsd * (1 + bufferPct/100)`** (pool + búfer). Coincide con el
  `effectiveCapital` que ya muestra la UI (`poolCapital * (1+bufferPct/100)`).
- `bufferNotional = hedgeNotionalUsd * bufferPct/100`. `poolNotional = hedgeNotionalUsd`.
- `size` de la entrada se calcula sobre el **total** (con la misma cota conservadora `notionalCapPx`
  de la pieza actual). El nocional reservado/margen se calculan sobre el total (afecta margen compartido).
- **SL = full-size** (ya implementado: usa `filledSize` total, reduceOnly) → protege pool+búfer; al
  reducirse por los TPs, el SL reduceOnly se ajusta solo (cierra lo que quede).
- **TP_i size = bufferSize * closePct_i / 100**, con `bufferSize = floor(filledSize * bufferPct/(100+bufferPct))`
  (la fracción del fill total que es búfer). Σ(closePct_i) ≤ 100 (validar). Truncar a szDecimals;
  el residuo por redondeo se queda como pool (seguro).

## Órdenes TP (HL)
- Por cada `tps[i] = {gainPct, closePct}`: **Take Profit Market**, cerrar short = **BUY** reduceOnly,
  `tpsl:"tp"`, trigger BELOW = `entryPrice * (1 - gainPct/100)` (normalizado al tick, floor), banda
  agresiva ceil para el market de cierre. cloid determinista `botId|generation|tp:i|attempt`.
- Representación: `role:"tp"` + `tpIndex` (ver Codex #1 arriba). Lookup/unicidad por
  `by_arm_role_index [armId, role, tpIndex]`. cloid `botId|generation|tp:<tpIndex>:<attempt>`.

## Flujo (extender la FASE DE POSICIÓN de reconcileArm, sin romper lo auditado)
Cuando el arm está en `protected` (SL ya colocado) y aún no se han colocado los TPs:
1. Colocar los TPs (cada uno con su cloid/attempt), confirmando por CLOID igual que el SL
   (slSubmittedAt-equivalente por TP, grace + prueba negativa antes de rotar → anti-doble-TP).
2. Estado: el arm sigue en `protected` (la posición sigue abierta y protegida). Los TPs son órdenes
   hijas observables; su fill reduce la posición (parcial), NO cierra el arm.
3. `closed` solo cuando szi==0 (SL/cierre total) Y `ensureOrdersDead` de TODOS los roles (SL + TPs).
   Al cerrar, cancelar los TPs residuales (ya cubierto por `ensureOrdersDead` generalizado a todos).
4. **Reintento/política de fallo de TPs:** un TP que no se coloca NO es crítico (no deja la posición
   desnuda — el SL la cubre). Reintentar acotado; si un TP falla definitivamente, seguir (alerta),
   NO escalar a cierre de emergencia (eso es solo para el SL). El pool sigue protegido por el SL.

## Cambios concretos
- `schema`: `trigger_orders.role` += `tp` + `tpIndex: v.optional(v.number())` + índice
  `by_arm_role_index [armId, role, tpIndex]`. Marcador `submittedAt`-equivalente POR TP (en el
  propio `trigger_order`, p.ej. `submittedAt` en la fila, en vez de un único campo en el arm) para el
  confirmar-antes-de-rotar por TP. Validar `Σ closePct ≤ 100` y omitir TPs que redondeen a 0 (Codex #2).
- `armPoolBotEntry`: sizing total (pool+búfer); validar `Σ closePct ≤ 100`, `bufferPct` válido,
  `tps` válidos; persistir `bufferPct`/`tps` en el snapshot del arm (inmutable).
- `reconcileArm`: tras `protected`, colocar/confirmar los TPs (reusar el patrón del SL: prepareTpAttempt,
  markTpSubmitted, confirmar-antes-de-rotar). Incluir los cloids de TP en `ensureOrdersDead`.
- `triggerArms`: helpers por (role,tpIndex); `getArmOrdersInternal` ya devuelve todos (sirve para
  cancelar/cerrar). Margen: los TPs no añaden margen (reduceOnly, misma posición) — NO doble-contar.

## Invariantes a preservar
- Nada de doble-TP/TP huérfano (confirmar-antes-de-rotar por cada cloid, como el SL).
- `closed` nunca con un TP/SL vivo (ensureOrdersDead sobre todos los roles).
- El SL full-size sigue cubriendo todo; los TPs solo cierran ≤ búfer (el pool nunca queda desnudo).
- Margen compartido NO cambia (los TPs son reduceOnly sobre la misma posición ya reservada).

## Verificación (mainnet real)
1. Bot IL con `hedgeNotionalUsd`, `bufferPct>0`, `tps=[{gainPct,closePct},…]` → entra short por
   `total = hedge*(1+bufferPct/100)` → SL full-size (`protected`) + N TPs Take Profit Market abajo.
2. El precio cae a un TP → cierra esa fracción del búfer (profit), el resto sigue abierto + SL vivo.
3. El precio sube al SL → cierra el resto → `closed`, con los TPs residuales cancelados.

## Riesgos / decisiones para Codex/usuario
- ¿`bufferNotional` = `hedge*bufferPct/100` (porcentaje del pool) o un campo propio? (propuesta: % del pool).
- Banda del TP market (1%? como el SL) — gap puede no llenar; aceptable (no desprotege).
- (CERRADO Codex #1) Unicidad de TPs: `role:"tp"`+`tpIndex` + índice `by_arm_role_index`.
- (CERRADO Codex #2) TPs que redondean a 0 → se omiten (quedan como pool bajo el SL).
