# Plan JAV-44 — Auto-rearm tras el SL (reabrir la cobertura automáticamente) — rev.2

## (Codex #1) Discriminar el MOTIVO del cierre — campo `closeReason`
Hoy todo cierre converge a `closed` sin registrar por qué. El auto-rearm debe dispararse SOLO cuando
el SL disparó (literal "reabrir tras SL"), NO tras cierre de emergencia / manual / disarm. Por tanto:
- **Nuevo campo `trigger_arms.closeReason: v.optional(v.union("sl","manual","emergency","disarm"))`.**
- **Marcador de emergencia:** cuando se decide el cierre de emergencia (`mustEmergencyClose`), fijar
  un flag persistente en el arm (`emergencyClosing: v.optional(v.boolean())`) ANTES de mandar el
  market close. Si era por kill/disarm, distinguir el origen para `closeReason`.
- **Al alcanzar `closed`** (detección szi==0 + ensureOrdersDead): determinar `closeReason`:
  - si el `sl_upper` está `observedStatus:"filled"` (el SL llenó) → `closeReason = "sl"`.
  - si `emergencyClosing` estaba puesto → `"emergency"` (o `"disarm"` si vino de wantDisarm/kill).
  - en otro caso (szi==0 sin SL llenado ni emergencia) → `"manual"` (cierre externo del usuario).
  Persistir `closeReason` en el `settleArm(closed)`.
- **Auto-rearm SOLO si `closeReason === "sl"`** Y `bot.autoRearm`. Nunca tras emergency/manual/disarm.


Última pieza del motor. Sobre OCO+TPs+SL. Cuando la posición se cierra (SL disparado, o cierre
de emergencia) y `bot.autoRearm === true`, **rearmar automáticamente una NUEVA generación** (volver a
colocar las entradas) sin intervención del usuario, para que la cobertura siga activa.

## Disparo
- En `reconcileArm`, justo después de `settleArm(closed)`, si **`closeReason === "sl"`** (el SL
  disparó) Y `bot.autoRearm === true` Y no hay kill/disarm Y `bot.active` Y `!bot.disarmPending` Y
  pasado el cooldown: encolar un rearmado.
- Solo tras un cierre por SL. NO tras `failed`/`disarmed`/`emergency`/`manual`.

## Cómo rearmar (sin auth de usuario)
`armPoolBotEntry` hoy es una ACTION pública (usa la identidad del usuario). El auto-rearm corre desde
el cron (sin identidad). Refactor:
- Extraer el núcleo de armado a **`armBotInternal(botId, userId)`** (internalAction): carga bot/pool/
  credencial, revalida TODOS los gates con `assertLiveAdmissible(userId,...)` (no necesita auth),
  recalcula tamaños con `markPx`/`minRange`/`maxRange` FRESCOS (el rango pudo cambiar), reserva (nueva
  generación, OCC unicidad), CAS, coloca las entradas (lower + upper si aplica). 
- `armPoolBotEntry` (action pública) = auth + `getCurrentUserInternal` → llama a `armBotInternal`.
- `autoRearmBot` = el cron/reconcile llama a `armBotInternal(botId, bot.userId)` tras un `closed`.
- **Unicidad:** `reserveArm` ya exige "una sola generación NO terminal por bot". El `closed` es
  terminal → la nueva generación pasa. Si por carrera quedara otra viva, reserveArm la rechaza (seguro).

## Anti-bucle (crítico)
Un SL que dispara repetido podría rearmar en bucle rápido quemando comisiones/capital. Mitigaciones:
- **Cooldown:** no rearmar si el último arm del bot cerró hace menos de `AUTOREARM_COOLDOWN_MS`
  (p.ej. 60s). Campo/lookup: el `closedAt`/`updatedAt` del arm cerrado.
- **Precondición natural:** las entradas son triggers en los BORDES del rango; tras rearmar, solo
  disparan si el precio vuelve a salir del rango → no es un bucle inmediato salvo que el precio oscile
  justo en el borde (el cooldown lo amortigua).
- **Límite diario compartido** (ya existe): si el rearmado supera el nocional diario, `reserveArm`
  lo rechaza → el bucle se autolimita por el límite del usuario.
- **(Opcional) contador de rearmados** por ventana para alertar/parar si se dispara demasiado.

## Gates en el rearmado (mismos que el armado manual)
canTradeLive (del bot.userId), tradingEnabled, !simulationMode, bot active/il/short, ownership,
pool no cerrado, red = hlNetwork(), precondición flat (szi==0 — la posición anterior ya cerró),
sin órdenes incompatibles, mark>triggerPxNormalized (lower) / mark<upperEdge (upper). Si algún gate
falla, NO rearmar (queda sin cobertura hasta que el usuario reactive — seguro, no abre nada inválido).

## Cambios concretos
- `triggerEngine`: refactor `armBotInternal` (internalAction) + `armPoolBotEntry` lo invoca;
  `reconcileArm` tras `closed` con `bot.autoRearm` → `ctx.runAction(armBotInternal, {botId, userId})`
  (respetando cooldown).
- `triggerArms`: helper `lastClosedArmAt(botId)` (para el cooldown) o reusar by_bot_generation +
  filtro. Constante `AUTOREARM_COOLDOWN_MS`.
- Sin cambios de schema (autoRearm ya existe en el bot; la unicidad de generación ya está).

## Invariantes a preservar
- Nunca dos generaciones no-terminales (reserveArm). Nunca rearmar con kill/disarm/pausa activos.
- El rearmado pasa por TODO el pipeline auditado (reserva→CAS→gate→place→OCO→SL→TPs→cierre).
- Cooldown + límite diario evitan el bucle. Si falla un gate, no abre nada (seguro).

## Verificación (mainnet real)
1. Bot IL con autoRearm=true → entra → SL cierra → tras el cooldown, se rearma una nueva generación
   (nuevas entradas en los bordes del rango actual).
2. Pausar/kill durante el ciclo → no rearma.
3. SL en bucle rápido → el cooldown + límite diario lo frenan.

## Decisiones (CERRADAS)
- Rearmar SOLO si `closeReason === "sl"` (SL disparado). NO tras emergency/manual/disarm/failed. ✓ (Codex #1)
- `AUTOREARM_COOLDOWN_MS` = 60s (propuesta; ajustable).
