# Auditoría de CÓDIGO — JAV-107: 2 hallazgos money-path diferidos de CodeRabbit

Eres un auditor senior de código money-path en Hyperliquid. Audita el **CÓDIGO** del commit `659696c`
(rama `feat/jav107-spot-defense`, checkout hecho). Emite **GO / NO-GO** por hallazgo con severidad. No
reescribas el código. Contexto: épica JAV-107 (bot de defensa spot = UN short trigger SELL que dispara al
CAER). CodeRabbit marcó 2 hallazgos money-path que se difirieron para esta auditoría dedicada.

## Fix 1 — Recovery de `entry` pre-fill muerta (`convex/spotDefenseEngine.ts`, rama PRE-FILL)

**Hallazgo:** si `updateLeverage` queda incierto antes de enviar la entry, o HL devuelve `st.error`, el arm
puede quedar `submitting`/`unknown` con la entry rechazada/no materializada. La rama pre-fill solo buscaba
fills y, sin `wantDisarm`, retornaba `armed_waiting` para siempre → nunca probaba muerte por CLOID ni
liberaba la reserva (margen tomado indefinidamente).

**Fix (tras la rama `wantDisarm`, antes de `return armed_waiting`):**
- Si `!openByCloid(entry.cloid)` (la entry NO está viva en el book):
  - `recoveryAt = arm.submittedAt ?? entry.submittedAt ?? arm.updatedAt ?? arm.createdAt`; si
    `now - recoveryAt <= SL_SUBMIT_GRACE_MS` (60s) → `skipped: entry_pending_grace` (pudo no reflejarse aún).
  - `ensureSpotDefenseOrdersDead([entry.cloid])`; si no todas muertas → `skipped: entry_cancel_confirm`.
  - Re-chequeo `fillsByCloid` (fill de último momento) → si llenó, `settle(filled)`.
  - Si confirmadamente muerta → `settle(failed, "[blocked_config] entry no viva...")`; si la cuarentena
    (`SD_SUBMIT_QUARANTINE_MS`=90s en settleSpotDefenseArm) lo bloquea → `skipped: entry_dead_quarantined`.
- Un arm `armed` con su trigger SELL EN REPOSO da `openByCloid=true` (los triggers aparecen en
  `frontendOpenOrders`, igual que el SL break-even ya usa) → sigue en `armed_waiting`, no se toca.

### Preguntas Fix 1
1. ¿`openByCloid` (vía `frontendOpenOrders`) refleja SIEMPRE un trigger SELL en reposo? Si un trigger
   resting NO apareciera, se terminalizaría por error un arm vivo. (El SL break-even ya depende de esto.)
2. El ancla `arm.submittedAt`: ¿está garantizada NO-null para los estados que llegan a esta rama
   (submitting/armed/unknown)? (arming con submittedAt==null se recupera antes, línea ~249.)
3. ¿La doble prueba (openByCloid + ensureSpotDefenseOrdersDead + re-fill) evita terminalizar con un fill en
   vuelo o un trigger que disparó entre lecturas?
4. La cuarentena de `settleSpotDefenseArm` (90s) ¿interactúa bien con el grace (60s)? (entre 60–90s →
   quarantined → skip → reintenta; tras 90s → failed). ¿Algún loop o estado atascado?

## Fix 2 — Auto-rearm durable tras `failed` (`convex/spotDefenseBots.ts:settleSpotDefenseArm`)

**Hallazgo:** `settleSpotDefenseArm` solo reprogramaba el auto-rearm en `closed`+`closeReason="sl"`. Si un
arm llega a `failed` (armado inicial desde la UI que falla, o `armed`/`submitting` que nunca llenó y se
terminaliza — incl. el Fix 1), un bot con `autoRearm=true` quedaba sin arm vivo y SIN rearm pendiente →
cobertura caída en silencio (el único retry era el botón manual de la tarjeta).

**Fix:** nueva rama en el bloque terminal: si `status==="failed" && bot.active && bot.status==="running"
&& bot.autoRearm===true && bot.rearmStatus===undefined` → agenda `rearmStatus="pending"`,
`nextRearmAt=now+SD_REARM_COOLDOWN_MS`, `rearmAttempts=0`, `lastRearmError=error`.

El guard `rearmStatus===undefined` evita pisar un ciclo de rearm **en curso** (`running` con lease) o ya
agendado (`pending`/`blocked`): ese caso lo gestiona `settleSpotDefenseRearm` del cron (con backoff y
escalado a `blocked`).

### Preguntas Fix 2
1. **Ordenamiento durante un rearm-cycle:** cuando el cron arma vía `armSpotDefenseInternal` y el arm
   termina `failed`, `settleSpotDefenseArm(failed)` corre ANTES de `settleSpotDefenseRearm`. En ese momento
   `bot.rearmStatus==="running"` (lo puso `claimSpotDefenseRearm`) → el guard `===undefined` lo salta y
   deja que el cron gestione (backoff/blocked/attempts). ¿Correcto y sin doble agendado ni pérdida de
   `rearmAttempts`?
2. **Worker muerto en un rearm-cycle:** `rearmStatus="running"` con lease vencido → `claimSpotDefenseRearm`
   ya lo recupera (línea ~575). ¿Mi rama lo deja en paz (no es `undefined`) para no interferir?
3. **Escalado:** una vez agendado `pending`, los reintentos del cron incrementan `rearmAttempts` y escalan
   a `blocked` si el fallo persiste por config/margen. ¿El reset a `rearmAttempts=0` solo en la 1ª
   transición a failed es correcto (no resetea en cada ciclo)?
4. **Pausa concurrente:** si `bot.disarmPending` está activo, la rama previa (`if bot?.disarmPending`) tiene
   precedencia y NO se agenda rearm. ¿Bien?

## Verificación

- `npm run typecheck` EXIT 0; `npm test` **253/253** (+3 tests: failed→rearm agenda / sin-autoRearm /
  no-pisa-running). El Fix 1 (engine "use node") queda fuera del harness por diseño (allowlist mutation-safe).
- NO se ha pusheado: pendiente de este GO.

Devuelve hallazgos (severidad + fix) y veredicto **GO / NO-GO** por cada fix.
