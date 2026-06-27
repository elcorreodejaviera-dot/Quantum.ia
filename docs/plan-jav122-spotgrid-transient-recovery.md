# Plan JAV-122 — Spot Grid: error transitorio de HL (502) no debe matar el bot

> Objetivo doble (el del issue): (1) **Prevención** — un fallo transitorio de Hyperliquid (502 Bad
> Gateway / timeout / red) NO debe volcar el bot a `error` permanente ni exponer HTML crudo; (2)
> **Recuperación** — distinguir `error` transitorio vs fatal y que el cron retome los transitorios con
> backoff + tope, dejando `error` terminal solo lo realmente fatal.
>
> **Rev.2 (tras Codex NO-GO r1) — 3 cierres:**
> 1. **(BLOQUEANTE) Contadores separados.** El plan r1 usaba `transientFailCount` para escalar (≥12) Y
>    como contador de recuperación (<8): un bot escalado tenía count≥12 > 8, así que la query de
>    recuperación NUNCA lo tomaba. Ahora hay **dos campos distintos**: `transientFailCount` (prevención,
>    se resetea a 0 AL escalar) y `errorRecoveryAttempts` (recuperación, arranca en 0 en la escalada).
> 2. **(ALTO) Reset en TODA ronda exitosa.** El reset r1 vivía en `setSpotGridFillCursor` (`:680-682`),
>    que solo corre `if (maxTime > fillCursor)` (hay fills nuevos) → una ronda OK sin fills no reseteaba y
>    fallos NO consecutivos se acumulaban hasta escalar. Ahora el reset va en una mutation dedicada
>    `markSpotGridReconcileSuccess`, llamada en el punto de éxito del loop del cron (`:717`, tras
>    `reconcileOneBot`), que corre SIEMPRE que la ronda completa sin excepción (con o sin fills, running o
>    paused).
> 3. **(ALTO) "Nunca HTML" en TODOS los paths persistidos.** Quedaban dos `markSpotGridOrder({errorMessage:
>    safeError(e)})` en los catches de colocación de órdenes (`spotGridEngine.ts:600` y `:675`) que
>    persisten en `spot_grid_orders.errorMessage` y podían meter el cuerpo HTML de un 502. Ahora esos dos
>    catches pasan por `classifySpotGridError(e)` y persisten el mensaje LIMPIO (fijo para transitorio;
>    `safeError` solo para determinista, que no trae HTML).
>
> **Rev.3 (tras Codex NO-GO r2) — 1 bloqueante + 4 condicionados:**
> 1. **(BLOQUEANTE) El catch debe distinguir el ORIGEN del bot.** En r2 el catch llamaba siempre a
>    `bumpSpotGridTransient`; un transitorio durante una RECUPERACIÓN (bot que entró a la ronda en
>    `status:"error"`) incrementaría `transientFailCount` (irrelevante) y dejaría `errorRecoveryAttempts`
>    en 0 → el tope de recuperación nunca avanza, reintentos infinitos. Fix: capturar `wasError =
>    (bot.status === "error")` por bot y ramificar (transitorio+activo → `bumpSpotGridTransient`;
>    transitorio+recuperación → `bumpSpotGridErrorRecovery`; éxito+activo → `markSpotGridReconcileSuccess`;
>    éxito+recuperación → `recoverSpotGridFromError`).
> 2. **(COND) Contadores se calculan DENTRO de la mutation bajo `leaseOk`.** En r2 el catch (action)
>    calculaba `n = (bot.transientFailCount ?? 0) + 1` sobre un snapshot → race. Ahora el incremento y la
>    decisión de escalar viven DENTRO de `bumpSpotGridTransient`/`bumpSpotGridErrorRecovery`, que leen el
>    valor actual del bot bajo `leaseOk(token)` y devuelven `{escalated}`.
> 3. **(COND) Sanear las actions user-facing `createSpotGridBot`/`stopSpotGridBot`.** Tocan HL
>    (`spotGridActions.ts:55-57` resolve/price/balance; stop: open orders/cancel/price/balance) y un 502
>    propaga `e.message` (HTML) al portal. Se envuelve el cuerpo de ambas actions → re-lanzar
>    `new Error(classifySpotGridError(e).message)` (transitorio = texto fijo; determinista = `safeError`,
>    que preserva intactos los mensajes de validación tipo "Balance insuficiente").
> 4. **(COND) El cron Spot Grid corre cada 1 MIN, no 5.** Confirmado en `convex/crons.ts:49-52` ("reconcile
>    spot grid", `{ minutes: 1 }`). Corregidas todas las referencias de cadencia.
> 5. **(COND) `errorRecoveryAttempts` incluido en legacy-safe y DoD.**
>
> **Rev.4 (tras Codex NO-GO r3) — 1 bloqueante (carrera):** `wasError` se tomaba del snapshot de la lista
> inicial y `recoverSpotGridFromError` no revalidaba el estado bajo el lease → una pausa/stop concurrente
> entre el listado y el success podía **revivir a `running`** un bot ya cambiado durante la ronda. Fix:
> 1. **`claimSpotGridReconcile` devuelve `wasError` calculado desde DB al tomar el lease** (no desde la
>    lista). El loop usa `claim.wasError`, autoritativo en el instante del claim.
> 2. **`recoverSpotGridFromError` es no-op si el bot ya NO sigue en `error`+`errorKind:"transient"`** bajo
>    ese lease (revalida `bot.status==="error" && bot.errorKind==="transient"` además de `leaseOk`; si no,
>    no toca nada). Igual blindaje en `bumpSpotGridErrorRecovery`.
> 3. **Test de carrera:** bot listado como `error` recuperable → pausa/stop ANTES del success →
>    `recoverSpotGridFromError` NO lo revive a `running`.
>
> **Rev.5 (tras Codex NO-GO r4) — 1 bloqueante money-path + 2 medios:**
> 1. **(BLOQUEANTE) Preservar `running` vs `paused` al escalar y restaurarlo en recovery.** Rev.4
>    recuperaba SIEMPRE a `running`; un bot que el usuario dejó `paused` y que escaló a `error` por
>    transitorios volvía a `running` al recuperarse → el siguiente tick podía colocar órdenes, anulando la
>    pausa (`reconcileOneBot` decide colocar con `isRunning = bot.status === "running"`,
>    `spotGridEngine.ts:526-528`). Fix: nuevo campo `recoverToStatus: "running"|"paused"`; al escalar,
>    `bumpSpotGridTransient` guarda `recoverToStatus = bot.status === "paused" ? "paused" : "running"`;
>    `recoverSpotGridFromError` restaura a ESE estado. Si falta (no debería: se escribe atómico con
>    `errorKind:"transient"`) → **no-op conservador** (no revive a `running` "a ciegas").
> 2. **(MEDIO) Terminalidad accionable.** Al superar `SPOT_GRID_MAX_ERROR_RECOVERIES`,
>    `bumpSpotGridErrorRecovery` setea `errorMessage` a un texto accionable ("Errores transitorios de HL
>    persistentes: reintentos automáticos agotados; revisá/reiniciá el bot.") para que la UI
>    (`SpotGridView.jsx:350` muestra `errorMessage`) distinga "sigue reintentando" de "agotado".
> 3. **(MEDIO) Constantes en módulo hoja non-node.** Las mutations de `spotGridBots.ts` (non-node) usan
>    `SPOT_GRID_MAX_TRANSIENT_FAILS`/`MAX_ERROR_RECOVERIES`/backoffs; declararlas en `spotGridEngine.ts`
>    (`"use node"`) y importarlas contaminaría el módulo non-node. Van a un módulo hoja sin `"use node"`
>    (`convex/spotGridConstants.ts`), importado por ambos. `classifySpotGridError` (usa `TransportError`
>    del SDK) permanece en tierra node y lo importan solo las actions/engine.
>
> **Rev.6 (tras Codex NO-GO r5) — 1 alto (convergencia) + 1 medio (estado fantasma):**
> 1. **(ALTO) `recoverToStatus` ausente no debe quedar en recovery infinito.** El no-op conservador de
>    Rev.5 evitaba revivir a ciegas, pero el bot seguía en el set recuperable: cada tick se reclamaba,
>    `recoverSpotGridFromError` devolvía `{ok:false}` y se repetía, sin consumir intentos ni volverse
>    accionable. Fix (doble): (a) la query `listRecoverableErrorSpotGridBotsInternal` exige además
>    `recoverToStatus ∈ {running, paused}` → un error-transient sin estado de retorno NO es recuperable;
>    (b) defensa: si `recoverSpotGridFromError` igual se invoca sin `recoverToStatus`, **terminaliza**
>    (`errorKind:"fatal"`, limpia campos de recovery, `errorMessage` accionable), no no-op silencioso.
> 2. **(MEDIO) Limpiar campos de recovery al salir del estado transitorio (fatal o gate.policy).**
>    `setSpotGridStatus` ahora NORMALIZA los campos de recovery (`recoverToStatus`, `transientFailCount`,
>    `errorRecoveryAttempts`, `nextRetryAt`) en toda transición que NO sea error-transient. El catch fatal
>    y el **gate-loop** (`spotGridEngine.ts:702-708`) los limpian: `gate.policy==="error"` →
>    `errorKind:"fatal"` (no se re-recupera); `gate.policy==="paused"` → limpia `errorKind`/`recoverToStatus`
>    (paused limpio, sin estado fantasma de una recuperación previa).
>
> **Rev.7 (tras Codex GO-condicionado r6) — 3 condiciones de precisión + 1 bajo:**
> 1. **(COND-1) El claim espeja el PREDICATE COMPLETO de la query recuperable** (no solo
>    `error && errorKind:transient`): además `recoverToStatus ∈ {running,paused}` y
>    `errorRecoveryAttempts < MAX`. Helper compartido `isRecoverableError(bot)` para mantener claim y query
>    en sincronía (el claim es el punto autoritativo bajo lease).
> 2. **(COND-2) `setSpotGridStatus` borra/setea `errorKind` EXPLÍCITAMENTE** (asignación incondicional, no
>    `if (!== undefined)`): `status==="error"` → `errorKind ?? "fatal"` (los errores de stop nunca conservan
>    un `transient` previo); `status!=="error"` → `errorKind: undefined`.
> 3. **(COND-3) Quitado el texto viejo "no-op conservador"** para `recoverToStatus` ausente (schema, test,
>    legacy-safe) → ahora coherente: no es recuperable; si se fuerza, terminaliza a `fatal`.
> 4. **(BAJO) `setSpotGridBootstrap`** también limpia campos de recovery al setear `status:"error"` fatal
>    (consistencia con la regla general).

## Causa raíz (confirmada, NO re-investigar)
- Catch genérico del loop del cron en `convex/spotGridEngine.ts:718-719`:
  `setSpotGridStatus({status:"error", errorMessage: safeError(e)})` ante **CUALQUIER** excepción.
- `safeError(e)` (`convex/log.ts:26`) devuelve `e.message.slice(0,300)` → para un 502 eso es el
  **cuerpo HTML de nginx** ("502 Bad Gateway"), que termina en el portal.
- Una vez en `error`, el cron lo ignora: `listActiveSpotGridBotsInternal`
  (`convex/spotGridBots.ts:702`) solo toma `running`/`paused`, y `claimSpotGridReconcile`
  (`:459`) solo claima `running`/`paused` → **no se recupera solo**.
- Todas las llamadas a HL del reconcile y del bootstrap (`getUserFees`, `getSpotPrice`,
  `gatedPlaceIoc`, órdenes) son funciones JS planas que se ejecutan en el MISMO contexto del catch
  `:718` → la excepción del SDK llega **intacta** a ese catch (`instanceof` funciona).

## Reuso (patrones ya existentes en el repo — NO inventar)
1. **Clasificador de transitorio = `e instanceof TransportError`** del SDK `@nktkas/hyperliquid`. Ya es
   el criterio canónico del repo: `convex/hyperliquid.ts:248` y `:597` lo usan para separar "transporte
   (5xx/timeout/red, reintentable)" de "determinista (rechazo explícito de HL / validación / firma)".
   `HttpRequestError extends TransportError` ⇒ el 502 cae como transitorio. **Robusto y sin parsear el
   cuerpo HTML.**
2. **Máquina estado-con-lease + backoff + tope** ya resuelta en `convex/triggerRearm.ts` (auto-rearm
   JAV-44): `errorKind` por categoría, `nextRetryAt` (backoff), reintento del cron bajo lease, alerta en
   la transición. Espejar esa filosofía: *un fallo técnico nunca abandona; solo lo fatal queda terminal*.

## Schema — `spot_grid_bots` (todo opcional → legacy-safe)
Añadir en `convex/schema.ts` (junto a `errorMessage`, `:618`):
- `errorKind: v.optional(v.union(v.literal("transient"), v.literal("fatal")))` — clasificación del
  último error. Se setea SIEMPRE que se pone `status:"error"`.
- `transientFailCount: v.optional(v.number())` — fallos transitorios **consecutivos** mientras el bot
  sigue activo (Parte 1). Se resetea a 0 en CADA ronda exitosa y también AL escalar a `error`. Ausente = 0.
- `errorRecoveryAttempts: v.optional(v.number())` — **(Codex r1 BLOQUEANTE)** contador SEPARADO de
  intentos de recuperación desde `error` (Parte 2). Arranca en 0 cuando el bot entra a `error` por
  escalada; lo incrementa cada reintento de recuperación fallido. Independiente de `transientFailCount`
  para que un bot escalado (cuyo `transientFailCount` llegó al tope de prevención) SÍ entre al set
  recuperable. Ausente = 0.
- `nextRetryAt: v.optional(v.number())` — gate de backoff: hasta ese instante NO se re-claima el bot.
  Ausente/0 = sin backoff. Lo usan ambas partes (backoff corto en prevención, largo en recuperación).
- `recoverToStatus: v.optional(v.union(v.literal("running"), v.literal("paused")))` — **(Codex r4
  BLOQUEANTE)** estado al que debe volver la recuperación. Se escribe ATÓMICO con la escalada a `error`
  (mismo patch que `errorKind:"transient"`), capturando si el bot estaba `running` o `paused`. **Ausente →
  el bot NO es recuperable** (la query lo excluye, ver Parte 2.1); si aun así se invoca
  `recoverSpotGridFromError`, **terminaliza** (`errorKind:"fatal"` + mensaje accionable), no revive.

Constantes (en un **módulo hoja sin `"use node"`** `convex/spotGridConstants.ts`, importable por
`spotGridBots.ts` (non-node, las usa en los bumps) Y `spotGridEngine.ts` — **(Codex r4 MEDIO)** NO
declararlas en `spotGridEngine.ts` (`"use node"`) para no contaminar el módulo non-node; espejo de
`triggerRearm`):
- `SPOT_GRID_TRANSIENT_BACKOFF_MS = 60_000` (1 min entre reintentos tras un transitorio; el cron corre
  cada **1 min** (`crons.ts:49-52`), así que en la práctica es "próximo tick" y el backoff casi nunca
  retrasa — su rol es cerrar la ventana de re-claim inmediato dentro del mismo minuto).
- `SPOT_GRID_MAX_TRANSIENT_FAILS = 12` — tras 12 transitorios consecutivos (~12 min de 502
  ininterrumpido, dado el cron de 1 min) se **escala** a `error`+`errorKind:"transient"` (alerta) en vez
  de seguir en silencio.
- `SPOT_GRID_ERROR_RETRY_BACKOFF_MS = 15 * 60_000` — backoff de la recuperación desde `error`.
- `SPOT_GRID_MAX_ERROR_RECOVERIES = 8` — tope de reintentos de recuperación; superado, queda terminal.

## Helper de clasificación + mensaje seguro (nuevo, en tierra node — `spotGridEngine.ts` o un helper node)
> Usa `TransportError` del SDK → NO puede vivir en `spotGridBots.ts` (non-node). Lo importan solo las
> actions/engine (que ya son node). Las mutations non-node NO clasifican: reciben el `message` ya limpio.
```ts
// "transient": fallo de transporte de HL (5xx/timeout/red) → reintentar, NO marcar error.
// "fatal": determinista (validación/firma/rechazo HL/lógica de bot) → error terminal.
function classifySpotGridError(e: unknown): { kind: "transient" | "fatal"; message: string } {
  if (e instanceof TransportError) {
    return { kind: "transient", message: "Error transitorio de Hyperliquid (red/5xx/timeout); reintentando." };
  }
  return { kind: "fatal", message: safeError(e) };   // determinista → mensaje corto (ya sin HTML crudo)
}
```
- Importar `TransportError` desde `@nktkas/hyperliquid` (ya importado en `hyperliquid.ts`; exponerlo o
  re-importar). El mensaje transitorio es **fijo y limpio**: nunca el cuerpo HTML del 502.

---

## Parte 1 — Prevención (el fix principal): catch `:718` no flipa a `error` en transitorio

Reescribir el `catch (e)` del loop en `reconcileAllSpotGrids` (`spotGridEngine.ts:718-723`):

```ts
// (Codex r3 BLOQUEANTE) wasError viene del CLAIM, leído de DB al tomar el lease — NO del snapshot de la
// lista (que puede estar rancio por una pausa/stop concurrente):
//   const claim = await ctx.runMutation(internal.spotGridBots.claimSpotGridReconcile, { botId: bot._id });
//   if (!claim.ok) continue;
//   const { token, wasError } = claim;   // wasError = (status === "error") en el instante del claim
} catch (e) {
  const { kind, message } = classifySpotGridError(e);
  if (kind === "transient") {
    if (wasError) {
      // (Codex r2 BLOQUEANTE) Transitorio durante RECUPERACIÓN → contador de recuperación, NO el de
      // prevención. La mutation incrementa errorRecoveryAttempts bajo lease y reprograma backoff largo.
      await ctx.runMutation(internal.spotGridBots.bumpSpotGridErrorRecovery, { botId: bot._id, token });
      elog("spotgrid", "recovery_transient_retry", { botId: String(bot._id) });
    } else {
      // Activo: la mutation incrementa transientFailCount bajo lease y, si alcanza el tope, ESCALA a error
      // (reset transientFailCount→0, errorRecoveryAttempts→0, alerta). NO tocar status si no escala.
      const r = await ctx.runMutation(internal.spotGridBots.bumpSpotGridTransient, { botId: bot._id, token, message });
      elog("spotgrid", r.escalated ? "reconcile_transient_escalated" : "reconcile_transient_retry", { botId: String(bot._id), fails: r.count });
    }
  } else {
    // Fatal (también si ocurre durante recuperación): flip a errorKind:"fatal" → sale del set recuperable.
    await ctx.runMutation(internal.spotGridBots.setSpotGridStatus, {
      botId: bot._id, token, status: "error", errorKind: "fatal", errorMessage: message,
    });
    elog("spotgrid", "reconcile_error", { botId: String(bot._id), err: message });
  }
} finally {
  await ctx.runMutation(internal.spotGridBots.releaseSpotGridReconcile, { botId: bot._id, token });
}
```
**Cómputo de contadores DENTRO de la mutation (Codex r2 COND):** el `catch` (action) NO calcula ni
incrementa; solo decide la RAMA por `wasError`+`kind`. Toda lectura+incremento+decisión de escalada ocurre
bajo `leaseOk(token)` en la mutation, evitando races sobre un snapshot del bot.

Cambios de soporte en `convex/spotGridBots.ts`:
- **`setSpotGridStatus`** (`:616`): añadir arg opcional `errorKind`. **(Codex r6 COND-2: semántica
  EXPLÍCITA, no condicional)** — un patrón `if (a.errorKind !== undefined) patch.errorKind = a.errorKind`
  NO borraría un `errorKind` viejo. Regla:
  - `status === "error"`: `patch.errorKind = a.errorKind ?? "fatal"` (los paths de stop `:771-826` setean
    `error` SIN `errorKind` → deben quedar `fatal`, NUNCA conservar un `transient` previo). Esta mutation
    NO produce error-transient (esa la hace `bumpSpotGridTransient` con su propio patch).
  - `status !== "error"` (`running`/`paused`/`stopped`): `patch.errorKind = undefined` y
    `patch.errorMessage = undefined` (salvo que se pase `errorMessage` explícito, p.ej. `gate.reason`).
  **(Codex r5 MEDIO)** además NORMALIZA siempre los campos de recovery: `recoverToStatus: undefined,
  transientFailCount: 0, errorRecoveryAttempts: 0, nextRetryAt: 0`. Mantener `emitSpotGridErrorAlert` (la
  alerta solo dispara en transición a `error`, que ahora es fatal o escalada → señal útil, no ruido).
- **`bumpSpotGridTransient`** (NUEVA internalMutation, args `{botId, token, message}`) **(Codex r2
  COND)**: bajo `leaseOk(token)`, LEE el bot, `n = (bot.transientFailCount ?? 0) + 1`. Si
  `n >= SPOT_GRID_MAX_TRANSIENT_FAILS` → **escala** atómicamente: `status:"error"`,
  `errorKind:"transient"`, `errorMessage:message`, `transientFailCount:0`, `errorRecoveryAttempts:0`,
  **`recoverToStatus: bot.status === "paused" ? "paused" : "running"`** (Codex r4 BLOQUEANTE: captura el
  estado previo para restaurarlo en recovery) (vía `emitSpotGridErrorAlert` igual que `setSpotGridStatus`,
  ya que hay transición a `error`), devuelve `{escalated:true, count:n}`. Si no escala → patch
  `{ transientFailCount:n, nextRetryAt: Date.now() + SPOT_GRID_TRANSIENT_BACKOFF_MS, updatedAt }`, **NO
  toca `status` ni `errorMessage`**, devuelve `{escalated:false, count:n}`. Idempotente por fencing del
  token. (Solo se llama en la rama transitorio+activo, donde `bot.status` ∈ {running, paused}.)
- **`bumpSpotGridErrorRecovery`** (NUEVA internalMutation, args `{botId, token}`) **(Codex r2
  BLOQUEANTE)**: bajo `leaseOk(token)` **Y solo si el bot SIGUE en `status:"error"` +
  `errorKind:"transient"`** (Codex r3: revalidar, no-op en otro caso): patch
  `{ errorRecoveryAttempts: (bot.errorRecoveryAttempts ?? 0) + 1, nextRetryAt: Date.now() +
  SPOT_GRID_ERROR_RETRY_BACKOFF_MS, updatedAt }`. Mantiene `status:"error"` y `errorKind:"transient"`.
  **(Codex r4 MEDIO)** si el nuevo `errorRecoveryAttempts >= SPOT_GRID_MAX_ERROR_RECOVERIES` (tope
  alcanzado → la query deja de devolverlo, terminal): además setear `errorMessage` a un texto ACCIONABLE
  ("Errores transitorios de HL persistentes: reintentos automáticos agotados; revisá o reiniciá el bot.")
  para que la UI (`SpotGridView.jsx:350`) distinga "sigue reintentando" de "agotado".
- **`recoverSpotGridFromError`** (NUEVA internalMutation, args `{botId, token}`) **(Codex r3
  BLOQUEANTE)**: bajo `leaseOk(token)` **Y solo si el bot SIGUE en `status:"error"` +
  `errorKind:"transient"`** → patch `{ status: bot.recoverToStatus ?? <no-op>, errorMessage: undefined,
  errorKind: undefined, transientFailCount:0, errorRecoveryAttempts:0, nextRetryAt:0,
  recoverToStatus: undefined, updatedAt }`, devuelve `{ok:true, restoredTo}`. **(Codex r4 BLOQUEANTE)
  restaura `bot.recoverToStatus`** (el estado previo `running`/`paused`), NO siempre `running`. **Si
  `recoverToStatus` falta** (no debería, dado el nuevo filtro de la query; defensa Codex r5 ALTO) →
  **terminaliza** en vez de no-op silencioso: `errorKind:"fatal"`, limpia campos de recovery,
  `errorMessage` accionable ("estado de retorno desconocido; reiniciá el bot") → el bot sale del set
  recuperable (no queda en bucle de claim/no-op). Si la revalidación de estado/lease falla (pausa/stop
  concurrente durante la ronda) → **no-op** `{ok:false}`. Es la barrera que impide que `claim.wasError`
  rancio reviva un bot ya transicionado y que una pausa del usuario se anule.
- **`markSpotGridReconcileSuccess`** (NUEVA internalMutation) **(Codex r1 ALTO)**: bajo `leaseOk(token)`,
  patch `{ transientFailCount: 0, nextRetryAt: 0, updatedAt }`. Se llama en el punto de ÉXITO del loop del
  cron (ver abajo), que corre en TODA ronda que completa sin excepción — con o sin fills, running o
  paused. **Sustituye** el reset-atado-a-fills de r1. (NO confundir con `setSpotGridFillCursor`, que sigue
  siendo solo para el cursor de fills.)
- **Reset en el loop del cron** (`reconcileAllSpotGrids`, `spotGridEngine.ts:717`): tras
  `reconcileOneBot(...)` retornar sin lanzar y antes de `reconciled++`, llamar
  `markSpotGridReconcileSuccess({botId, token})`. Así el reset NO depende de que haya fills nuevos.

**Backoff en el claim** (`claimSpotGridReconcile`, `:459`): añadir gate
`if ((bot.nextRetryAt ?? 0) > Date.now()) return { ok:false }` → respeta el backoff de un bot que acaba
de fallar (transitorio activo o recuperación). El cron corre cada 1 min, así que el backoff corto (60 s)
de prevención casi nunca bloquea; el largo (15 min) de recuperación sí espacia los reintentos desde
`error`. Este gate aplica a running/paused Y a los `error` recuperables (ver Parte 2).

### Sanear los catches de colocación de órdenes (`spotGridEngine.ts:600` y `:675`) — (Codex r1 ALTO)
Hoy ambos hacen `markSpotGridOrder({ ..., errorMessage: safeError(e) })`, que persiste en
`spot_grid_orders.errorMessage`; un 502 ahí mete el cuerpo HTML. Cambiar a:
```ts
} catch (e) {
  const { message } = classifySpotGridError(e);   // transitorio → texto fijo; determinista → safeError corto
  await ctx.runMutation(internal.spotGridBots.markSpotGridOrder, { botId, token, cloid: o.cloid, errorMessage: message });
}
```
Estos catches NO escalan el bot (solo marcan la orden y la ronda sigue); la marca es informativa por orden
y nunca debe contener HTML. El `markSpotGridOrder({errorMessage:"submitting sin confirmar tras reintentos"})`
de `:592` ya es un literal limpio (no cambia). Revisar al implementar que NO quede ningún otro
`errorMessage: safeError(e)` sobre un path money que pueda ver un `TransportError` (el de bootstrap `:419`
envuelve `deriveSeededGrid`, pura aritmética → no produce HTML; se deja como fatal).

### Sanear actions user-facing `createSpotGridBot` / `stopSpotGridBot` — (Codex r2 COND)
Ambas tocan HL y un 502 propaga `e.message` (HTML) al portal, que lo muestra tal cual:
- `createSpotGridBot` (`convex/spotGridActions.ts`): `resolveSpotAsset:55`, `getSpotPrice:56`,
  `getSpotBalance:57`.
- `stopSpotGridBot` (`convex/spotGridEngine.ts:731`): `getOpenSpotOrders`, cancels, `getSpotPrice:781`,
  `getSpotBalance:782/823`.
Envolver el cuerpo de cada action y re-lanzar el error **clasificado**:
```ts
try { /* … cuerpo actual … */ }
catch (e) { throw new Error(classifySpotGridError(e).message); }   // transitorio → texto fijo; determinista → safeError
```
`classifySpotGridError` deja **intactos** los mensajes deterministas de validación ("Balance insuficiente",
"Cuenta ajena", etc.) porque su rama fatal usa `safeError(e)` = el mismo `e.message` recortado. Solo el
`TransportError` (502/timeout) se reemplaza por el texto fijo. `classifySpotGridError` debe vivir en un
módulo importable por las dos actions (p.ej. exportarlo desde `spotGridEngine.ts` o un util compartido;
`stopSpotGridBot` ya vive ahí). **No** cambia ninguna semántica de negocio, solo el texto del error.

### Bootstrap (`runSeededBootstrap`, `:408-519`) — NO requiere cambios de clasificación
- Sus `setSpotGridBootstrap({status:"error"})` (`:419,430,447,472,486`) son fallos **deterministas/
  fatales por construcción** (math de `deriveSeededGrid`, semilla inválida, IOC sin fill, semilla
  insuficiente). Correcto que queden `error`. Para coherencia, pasarles `errorKind:"fatal"` (extender
  `setSpotGridBootstrap` con el arg opcional, igual que `setSpotGridStatus`). **(Codex r6 BAJO)** cuando
  `setSpotGridBootstrap` setea `status:"error"`, debe además **limpiar los campos de recovery**
  (`recoverToStatus`, `transientFailCount:0`, `errorRecoveryAttempts:0`, `nextRetryAt:0`) — misma regla
  "toda transición no-error-transient limpia recovery". (En la práctica el bootstrap solo corre con el bot
  `running` y la recuperación limpia antes de volver a `running`, así que no debería haber `recoverToStatus`
  vivo aquí; la limpieza es defensa por consistencia.)
- Un 502 dentro del bootstrap (`getSpotPrice` `:410`, órdenes IOC) lanza `TransportError` que **sube al
  catch `:718`** (no se captura localmente) → lo maneja la Parte 1. **Un único punto de clasificación.**

---

## Parte 2 — Recuperación automática del cron desde `error` transitorio

Para bots que SÍ acabaron en `error`+`errorKind:"transient"` (escalada tras tope, o legacy/incidente).

1. **Nueva query `listRecoverableErrorSpotGridBotsInternal`** (`spotGridBots.ts`, junto a `:702`):
   bots con `status==="error"` ∧ `errorKind==="transient"` ∧ `(nextRetryAt ?? 0) <= Date.now()` ∧
   `(errorRecoveryAttempts ?? 0) < SPOT_GRID_MAX_ERROR_RECOVERIES` ∧ **`recoverToStatus ∈ {running,
   paused}`** (Codex r5 ALTO: un error-transient SIN estado de retorno NO es recuperable → no entra al
   bucle de claim/no-op infinito; queda `error` terminal para intervención). **(Codex r1 BLOQUEANTE)** el
   filtro del tope es sobre `errorRecoveryAttempts` (contador propio de la Parte 2), NO sobre
   `transientFailCount` (que en un bot escalado vale 0 tras el reset de la escalada). Usa índice
   `by_status_updated` filtrando en memoria por los otros campos (volumen bajo). **NO** incluir
   `errorKind:"fatal"` ni los que superan el tope (quedan terminal, requieren intervención).

2. **El cron `reconcileAllSpotGrids` también itera estos bots.** Mínima fricción: concatenar
   `[...activos, ...recuperables]` en la lista que ya agrupa por cuenta (`:689`). Cada bot recuperable
   pasa por el MISMO flujo claim→gate→reconcile.

3. **`claimSpotGridReconcile`** debe admitir `error` recuperable **espejando el PREDICATE COMPLETO de la
   query** (Codex r6 COND-1; el claim es el punto autoritativo bajo lease — si fuera más laxo que la
   query, reclamaría estados que la query ya considera terminales/no recuperables). Gate `:464`:
   `status === "running" || status === "paused" || (status === "error" && errorKind === "transient" &&
   (recoverToStatus === "running" || recoverToStatus === "paused") && (errorRecoveryAttempts ?? 0) <
   SPOT_GRID_MAX_ERROR_RECOVERIES)`, respetando además el gate de `nextRetryAt` (común a todos). (Espejo de
   `claimSpotGridReconcileForStop` `:475`, que ya admite `error`.) **Mantener el predicate del claim y el
   de `listRecoverableErrorSpotGridBotsInternal` en sincronía** (idealmente un helper compartido
   `isRecoverableError(bot)` en `spotGridBots.ts` que usen ambos). **(Codex r3 BLOQUEANTE)** además devolver `wasError: bot.status === "error"` en el resultado
   del claim (leído de DB bajo la misma transacción del lease) → el loop usa `claim.wasError` como origen
   autoritativo, NO el `status` del snapshot de la lista. El `assertSpotGridLiveAdmissible` (gate, `:704`)
   sigue corriendo: si el bot ya no es admisible, lo manda a su `policy` (paused/error) — pero ahora
   **limpiando los campos de recovery** (ver punto 5).

4. **Resultado del reintento de recuperación:**
   - **Éxito** (reconcile completa): en el punto de éxito del loop (`:717`), cuando `claim.wasError`,
     llamar `recoverSpotGridFromError({botId, token})` en lugar de `markSpotGridReconcileSuccess`. La
     mutation, **bajo `leaseOk(token)` Y revalidando que el bot SIGUE en `status:"error"` +
     `errorKind:"transient"`** (Codex r3 BLOQUEANTE), restaura `status` a **`bot.recoverToStatus`** (el
     estado previo `running`/`paused`, Codex r4 BLOQUEANTE — NO siempre `running`), limpia `errorMessage`,
     `errorKind`, `recoverToStatus`, `transientFailCount:0`, `errorRecoveryAttempts:0`, `nextRetryAt:0`.
     **Si el bot ya NO está en error transitorio** (pausa/stop concurrente) → **no-op** (`{ok:false}`, no
     revive nada). **Si falta `recoverToStatus`** (no debería, dado el filtro de la query; defensa
     Codex r5 ALTO) → **terminaliza**: `errorKind:"fatal"`, limpia campos de recovery, `errorMessage`
     accionable ("estado de retorno desconocido; reiniciá el bot") → sale del set recuperable (NO no-op
     silencioso que lo dejaría en bucle).
   - **Falla otra vez (transitorio):** una mutation `bumpSpotGridErrorRecovery` (bajo `leaseOk` Y solo si
     el bot SIGUE en `error`+`errorKind:"transient"`; si no, no-op) incrementa **`errorRecoveryAttempts`**
     y reprograma `nextRetryAt = now + SPOT_GRID_ERROR_RETRY_BACKOFF_MS` (backoff largo), manteniendo
     `status:"error"`. Al superar `SPOT_GRID_MAX_ERROR_RECOVERIES` la query (1) deja de devolverlo →
     **error terminal** (alerta ya emitida en la escalada). Mantener `errorKind:"transient"` para
     trazabilidad ("se intentó, no pudo"). (Es un contador DISTINTO de `bumpSpotGridTransient`, que opera
     sobre bots activos; este opera sobre bots en `error`.)
   - **Falla con error fatal:** `setSpotGridStatus(error, errorKind:"fatal")` → sale del set recuperable.

5. **Gate-loop y fatal limpian el estado de recovery (Codex r5 MEDIO).** Regla general: **`setSpotGridStatus`
   normaliza (borra) los campos de recovery (`recoverToStatus`, `transientFailCount`,
   `errorRecoveryAttempts`, `nextRetryAt`) en TODA transición que NO sea la escalada error-transient** (esa
   la hace `bumpSpotGridTransient` con su propio patch). En el gate-loop `spotGridEngine.ts:702-708`, al
   aplicar `gate.policy` vía `setSpotGridStatus`:
   - `gate.policy === "error"` (bot_not_found/owner_not_found/hl_network_unset): pasar `errorKind:"fatal"`
     → NO es un transitorio de HL, no debe re-recuperarse; se limpian los campos de recovery.
   - `gate.policy === "paused"` (switches/permisos/red): pasar `errorKind: undefined` → paused limpio, sin
     `errorKind`/`recoverToStatus` fantasma de una recuperación previa.
   El catch **fatal** del cron (ya pasa `errorKind:"fatal"`) hereda la misma limpieza.

   **`pauseSpotGridBot` (`spotGridBots.ts:257-264`) — pausa manual sobre un bot en `error`.** Hoy admite
   pausar cualquier estado salvo `stopped` (incluido `error`) y hace su PROPIO `patch({status:"paused"})`
   SIN pasar por `setSpotGridStatus` → dejaría `errorKind:"transient"`/`recoverToStatus`/contadores
   fantasma sobre un bot pausado. Fix: su patch debe limpiar también
   `errorKind: undefined, errorMessage: undefined, recoverToStatus: undefined, transientFailCount: 0,
   errorRecoveryAttempts: 0, nextRetryAt: 0` (pausa manual = estado limpio, sale de la condición de
   error). NO comparte `setSpotGridStatus` (no tiene lease/token), así que la limpieza va explícita en su
   patch. (`stopSpotGridBot` ya termina en `stopped` vía `setSpotGridStatus`, que normaliza; sin cambio.)

---

## Lo que NO se toca
- Lógica de grid (niveles, ciclos, reposición, semilla), cálculo de profit, idempotencia por cloid.
- Fencing por token / `leaseOk` (se reutiliza tal cual).
- `stopSpotGridBot` y su claim dedicado (`claimSpotGridReconcileForStop`): el usuario sigue pudiendo
  parar+liquidar un bot en `error` (transitorio o fatal) — ese claim ya admite `error`.
- `emitSpotGridErrorAlert`: la alerta sigue disparando solo en transición a `error` (ahora = fatal o
  escalada). Los reintentos transitorios silenciosos NO alertan (eso era el ruido a evitar).

## Tests (convex-test, reusar infra de Fase 4 / motor spot grid)
1. **Transitorio no mata:** mock de cliente HL que lanza `TransportError` en `getUserFees` → tras el
   tick, el bot sigue `running`, `transientFailCount===1`, `nextRetryAt>now`, `errorMessage` SIN tocar.
2. **No expone HTML (bot):** el `TransportError` lleva cuerpo "502 Bad Gateway <html>…" → `errorMessage`
   del bot nunca contiene "<html"/"502 Bad Gateway" (queda sin setear en transitorio; en escalada =
   mensaje fijo limpio).
2b. **No expone HTML (orden) (Codex r1 ALTO):** un `TransportError` en el catch de colocación (`:600`/`:675`)
   → `spot_grid_orders.errorMessage` recibe el texto fijo limpio, nunca el cuerpo HTML.
3. **Escalada por tope:** N=`MAX_TRANSIENT` fallos consecutivos → bot pasa a `error`+`errorKind:transient`
   y se emite alerta UNA vez.
4. **Reset en éxito SIN fills (Codex r1 ALTO):** transitorio (count=3) seguido de una ronda OK que NO
   produce fills nuevos (`maxTime` no avanza) → `transientFailCount===0`, `nextRetryAt===0`. (Falla con
   el reset r1 atado a `setSpotGridFillCursor`; pasa con `markSpotGridReconcileSuccess` en el loop.)
4b. **Fallos NO consecutivos no escalan:** alternar fallo transitorio / ronda OK varias veces → nunca
   llega a `MAX_TRANSIENT_FAILS` (el contador se resetea entre medias) → el bot nunca escala a error.
5. **Fatal va a error:** error determinista (no `TransportError`, p.ej. `ApiRequestError`/validación) →
   `error`+`errorKind:fatal` + mensaje corto.
6. **Recuperación desde error (Codex r1 BLOQUEANTE):** bot `running` que escaló a error (por tanto
   `transientFailCount` ya reseteado a 0, `errorRecoveryAttempts=0`, `recoverToStatus:"running"`) con
   `nextRetryAt<=now` → la query SÍ lo devuelve, el cron lo claima y, con HL OK, vuelve a `running` y
   limpia errorMessage/errorKind/contadores/recoverToStatus.
   (Regresión directa del bug que Codex marcó: con el contador único, este bot nunca se recuperaba.)
7. **Tope de recuperación:** error transitorio que sigue fallando → `errorRecoveryAttempts` sube hasta
   `MAX_ERROR_RECOVERIES`; después la query no lo devuelve, queda `error` terminal.
8. **Fatal NO se recupera:** `error`+`errorKind:fatal` nunca es claimado por el cron.
9. **Origen recuperación NO toca el contador de prevención (Codex r2 BLOQUEANTE):** bot en `error`
   recuperable cuyo reintento vuelve a fallar con `TransportError` → `errorRecoveryAttempts` incrementa
   (NO `transientFailCount`), `nextRetryAt` = backoff largo. Tras `MAX_ERROR_RECOVERIES`, terminal.
10. **Action user-facing no expone HTML (Codex r2 COND):** `createSpotGridBot`/`stopSpotGridBot` con un
    `TransportError` mockeado en su lectura HL → el error re-lanzado NO contiene HTML (texto fijo); un
    error de validación determinista ("Balance insuficiente") se preserva intacto.
11. **Contadores bajo lease (Codex r2 COND):** un bump con `token` inválido/vencido (`leaseOk` falso) es
    no-op (no incrementa contadores).
12. **Carrera recuperación vs pausa (Codex r3 BLOQUEANTE):** bot listado como `error`+`errorKind:transient`
    → el cron lo claima (`claim.wasError===true`) → ANTES del success, una pausa/stop concurrente cambia
    su `status` (p.ej. a `paused`, o `errorKind` a `fatal`) → al llegar al éxito, `recoverSpotGridFromError`
    revalida y es **no-op**: el bot NO vuelve a `running`, conserva el estado que dejó la transición
    concurrente. Igual para `bumpSpotGridErrorRecovery` (no incrementa si ya no es error transitorio).
13. **Recuperación preserva `paused` (Codex r4 BLOQUEANTE):** bot `paused` → 12 transitorios →
    escala a `error`+`errorKind:transient` con `recoverToStatus:"paused"` → HL responde → recovery OK →
    el bot queda **`paused`**, NO `running`; el siguiente tick NO coloca órdenes (`isRunning` falso).
    Variante con `recoverToStatus:"running"` → vuelve a `running`. Variante sin `recoverToStatus` (legacy)
    → la query NO lo devuelve; si se fuerza `recoverSpotGridFromError`, terminaliza a `errorKind:"fatal"`
    (cubierto por test #15).
14. **Terminalidad accionable (Codex r4 MEDIO):** al alcanzar `MAX_ERROR_RECOVERIES`, `errorMessage`
    contiene el texto "reintentos automáticos agotados…" (no el genérico) y la query ya no lo devuelve.
15. **`recoverToStatus` ausente NO entra en bucle (Codex r5 ALTO):** bot `error`+`errorKind:transient`
    SIN `recoverToStatus` → la query `listRecoverableErrorSpotGridBotsInternal` NO lo devuelve (no se
    reclama indefinidamente). Si se fuerza una invocación de `recoverSpotGridFromError` sobre él →
    terminaliza a `errorKind:"fatal"` + `errorMessage` accionable (no no-op silencioso).
16. **Limpieza de recovery al salir de transitorio (Codex r5 MEDIO):** bot que venía de
    `error`+`errorKind:transient` (con `recoverToStatus`/contadores) → (a) gate devuelve `policy:"error"`
    → queda `error`+`errorKind:"fatal"` y `recoverToStatus`/contadores LIMPIOS (no re-recuperable); (b)
    gate devuelve `policy:"paused"` → queda `paused` SIN `errorKind`/`recoverToStatus`; (c) catch fatal →
    `errorKind:"fatal"` + recovery limpio. Ningún estado fantasma sobrevive.
17. **Pausa manual sobre error transitorio (Codex r5 MEDIO):** bot en `error`+`errorKind:transient`
    (+`recoverToStatus`/contadores) → `pauseSpotGridBot` → queda `paused` SIN
    `errorKind`/`errorMessage`/`recoverToStatus`/contadores; la query de recuperación no lo ve (status
    paused) y no queda estado fantasma.
18. **Claim espeja la query (Codex r6 COND-1):** un bot `error`+`errorKind:transient` que la query NO
    devuelve (sin `recoverToStatus`, o `errorRecoveryAttempts>=MAX`, o `nextRetryAt>now`) tampoco es
    claimado por `claimSpotGridReconcile` (predicate idéntico vía `isRecoverableError`). Y `running`/`paused`
    se siguen claimando normalmente.
19. **`errorKind` explícito en stop (Codex r6 COND-2):** bot que venía de `errorKind:transient` y entra a
    un path de stop incompleto (`setSpotGridStatus(status:"error")` sin `errorKind`) → queda
    `errorKind:"fatal"`, nunca conserva `transient`.

## DoD
- Un 502/timeout de HL deja el bot operativo (sigue `running`/`paused`), sin HTML en el portal, y se
  reintenta solo al próximo tick (cron de 1 min).
- `createSpotGridBot`/`stopSpotGridBot` nunca muestran HTML crudo al usuario ante un fallo de transporte.
- Solo errores fatales (o transitorios persistentes ~12 ticks) llegan a `error`; los transitorios en
  `error` se recuperan solos con backoff largo + tope `errorRecoveryAttempts`.
- **La recuperación restaura el estado previo (`running`/`paused`), nunca reactiva un bot pausado**
  (Codex r4): un `paused` que pasó por `error` transitorio vuelve a `paused`. Al agotar el tope, el
  `errorMessage` queda accionable.
- **Convergencia (Codex r5):** ningún `error`-transitorio queda en bucle de recovery infinito — sin
  `recoverToStatus` no es recuperable (o se terminaliza). Al salir del estado transitorio (fatal o
  gate.policy) se limpian SIEMPRE los campos de recovery → sin estado fantasma ni `errorKind:"transient"`
  heredado donde ya no corresponde.
- `errorKind` distingue transitorio vs fatal en todos los sets de `error`. El catch del cron ramifica por
  `wasError` **devuelto por el claim (leído de DB bajo lease)**, no por el snapshot de la lista; todos los
  contadores se calculan dentro de mutations bajo `leaseOk`. `recoverSpotGridFromError` y
  `bumpSpotGridErrorRecovery` **revalidan `error`+`errorKind:transient` bajo el lease** → una
  pausa/stop concurrente nunca es revivida a `running`.
- Campos nuevos opcionales (legacy-safe): bots viejos sin
  `errorKind/transientFailCount/errorRecoveryAttempts/nextRetryAt/recoverToStatus` funcionan (tratados
  como 0/ausente) en claim, query de recuperación, bumps y resets. **`recoverToStatus` ausente → el bot
  NO es recuperable** (excluido por la query Y por el predicate del claim); si se fuerza la recuperación,
  `recoverSpotGridFromError` terminaliza a `errorKind:"fatal"`. Nunca revive a ciegas ni queda en bucle.
- Constantes compartidas en módulo hoja non-node (`spotGridConstants.ts`); `classifySpotGridError`
  (usa SDK) solo en tierra node.
- `npm run typecheck` OK, tests verdes. Toca `convex/` → `convex deploy` (Convex prod es deployment
  aparte del dev `strong-sandpiper-848`). Verificar `HL_NETWORK=mainnet`.
- Flujo: **este plan → GO Codex → implementar en rama nueva desde master → GO Codex código → PR →
  CodeRabbit → merge → deploy.**
