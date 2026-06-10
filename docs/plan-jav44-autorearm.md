# Plan JAV-44 — Auto-rearm tras el SL (reabrir la cobertura automáticamente)

Última pieza del motor. Sobre OCO+TPs+SL. Cuando la posición se cierra (SL disparado, o cierre
de emergencia) y `bot.autoRearm === true`, **rearmar automáticamente una NUEVA generación** (volver a
colocar las entradas) sin intervención del usuario, para que la cobertura siga activa.

## Disparo
- En `reconcileArm`, justo después de `settleArm(closed)` (la única vía a terminal con posición que
  existió), si `bot.autoRearm === true` Y no hay kill/disarm Y `bot.active` Y `!bot.disarmPending`:
  encolar un rearmado.
- Solo desde `closed` (SL/cierre real). NO desde `failed`/`disarmed` (esos NO rearman: failed = nunca
  abrió/algo falló; disarmed = el usuario/kill lo paró).

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

## Decisiones para Codex/usuario
- Valor de `AUTOREARM_COOLDOWN_MS` (propuesta: 60s).
- ¿Rearmar también tras un `closed` por cierre de EMERGENCIA (SL falló)? (propuesta: NO rearmar tras
  emergencia — algo fue mal; requiere intervención. Solo rearmar tras un SL/cierre normal. Marcar el
  motivo del closed para distinguir.)
