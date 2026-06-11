# HANDOFF — Motor de cobertura automática (JAV-44) — 2026-06-10

Estado para retomar el trabajo en otra sesión. Todo el código y los planes están en este repo
(ramas `feat/jav44-*` + `docs/plan-jav44-*.md`). Este doc resume el QUÉ HACER al volver.

## Qué es
Motor de cobertura automática para bots IL. Replica el ciclo de la cuenta de referencia:
**entra (1 o 2 triggers nativos en los bordes del rango) → OCO → SL stop-market full-size → TPs
parciales sobre el búfer → cierre de emergencia (red de seguridad) → auto-rearm.** En mainnet.

Construido por PIEZAS apiladas; cada una con **plan GO + código GO de Codex**.

## Stack de PRs (mergear EN ESTE ORDEN, con `deploy` real en cada uno)
| PR | Pieza | Rama | Base | Estado |
|----|-------|------|------|--------|
| #19 | Fundación (state machine, margen OCC compartido, pausa-segura, kill-switch) | (merged) | master | ✅ MERGEADO + desplegado |
| #20 | SL post-fill + habilitar mainnet | `feat/jav44-sl-postfill` | master | OPEN — Codex GO; CodeRabbit OK (2 fixes aplicados) |
| #21 | TPs parciales sobre el búfer | `feat/jav44-tps-buffer` | feat/jav44-sl-postfill | OPEN — Codex GO; **CodeRabbit pendiente** |
| #22 | 2º trigger (borde superior) + OCO | `feat/jav44-oco-upper` | feat/jav44-tps-buffer | OPEN — Codex GO; **CodeRabbit pendiente** |
| (sin PR) | auto-rearm tras SL | `feat/jav44-autorearm` | feat/jav44-oco-upper | plan GO; **código SIN implementar** |

## Archivos clave del motor
- `convex/schema.ts` — tablas `trigger_arms` + `trigger_orders` (+ campos del bot: hedgeNotionalUsd, bufferPct, tps, allowReentryFromAbove, autoRearm, disarmPending).
- `convex/triggerArms.ts` — máquina de estados con lease/fencing, reserva OCC (margen/daily compartidos con JAV-43), helpers por rol.
- `convex/triggerEngine.ts` — `armPoolBotEntry` (acción) + `reconcileArm` (cron) con las fases pre-fill (OCO) y de posición (SL/TPs/emergencia/closed).
- `convex/executions.ts` — `committedMarginForAccount`/`dailyNotionalUsed` (suman ambos motores).
- `convex/crons.ts` — "reconcile pool arms" cada 1 min.
- Planes: `docs/plan-jav44-{sl-postfill,tps-buffer,oco-upper,autorearm}.md`.

## PASOS PARA RETOMAR
1. **CodeRabbit en #21 y #22** — si no posteó, re-disparar: `gh pr comment 21 --body "@coderabbitai review"` (y 22). Aplicar sus hallazgos en cada rama. (CodeRabbit estaba rate-limited; la cuota es horaria.)
2. **Implementar auto-rearm** (`docs/plan-jav44-autorearm.md` rev.2, GO): tras `closeReason==="sl"` + `bot.autoRearm` + gates + cooldown → `armBotInternal` (refactor de `armPoolBotEntry` sin auth de usuario). Luego: Codex código → PR → CodeRabbit.
3. **Mergear el stack en orden** #20→#21→#22→auto-rearm, con **`node node_modules/convex/bin/main.js deploy`** en cada merge (el deploy SÍ type-checkea; el `codegen` NO — así se coló el bug de `szDecimals`).
4. **Verificar env**: Convex `HL_NETWORK=mainnet`, Railway `VITE_HL_NETWORK=mainnet`, cuenta HL con fondos.
5. **Prueba REAL** (sin tests simulados — decisión del usuario): bot IL con `hedgeNotionalUsd`, `bufferPct`, `tps`, `allowReentryFromAbove`, `autoRearm` → observar `trigger_arms` (`armed`→`filled`→`protected`→...).

## Notas operativas (IMPORTANTE)
- **`gh` se usa SIN `GH_TOKEN`** (el token clásico fue revocado por exposición; el keyring de `gh` es válido). Hacer `unset GH_TOKEN` antes de los comandos `gh`.
- **Push** por SSH: `GIT_SSH_COMMAND='ssh -F /dev/null' git push origin <rama>`.
- **Convex deploy**: `node node_modules/convex/bin/main.js deploy` (despliega a producción strong-sandpiper-848).
- **Auditorías**: las corre el USUARIO en otra terminal (`codex exec ...` y CodeRabbit) y pega el veredicto; el asistente prepara el prompt pero no las dispara.
- **Bug cazado por CodeRabbit que Codex no vio** (lección): `reconcileArm` extraía solo `assetId`, faltaba `szDecimals` → ReferenceError en runtime. Arreglado en las 4 ramas. El `codegen` no lo cazó (no type-checkea a fondo); el `deploy`/tsc sí. → SIEMPRE deploy + CodeRabbit antes de producción.

## Garantías del motor (verificadas por Codex)
Sin: trigger huérfano, doble-SL/doble-TP, short desnudo (SL full-size sobre `szi` real + cierre de
emergencia), doble reserva de margen, exposición 2x sin margen en doble-fill (reserva worst-case 2×,
reducción a 1× solo tras OCO confirmado), pausar/kill con posición u orden viva, closed prematuro.
