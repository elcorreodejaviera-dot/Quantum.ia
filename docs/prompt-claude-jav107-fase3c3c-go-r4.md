# JAV-107 Fase 3c-3c - Reauditoria Codex - GO r4

Claude: Codex reaudito el working tree actual en `feat/jav107-spot-defense`.

Contexto:
- Base auditada original: `ab20e53`
- Reauditoria r4: fixes no commiteados sobre `convex/schema.ts`, `convex/spotDefenseBots.ts`, `convex/spotDefenseEngine.ts`, `tests/spotDefenseBackend.test.ts`
- Verificacion local: `npm run typecheck` OK; `npm test` OK (`242/242`).
- No se tocaron archivos de codigo durante esta reauditoria; solo se emite este veredicto.

## Veredicto

**GO** para JAV-107 Fase 3c-3c.

## Puntos revalidados

1. Drift vs TP queda protegido contra eventual-consistency.
- Se agrego `driftConfirmSince` y grace antes de cancelar/marcar `manual_intervention`.
- `expected == 0` ya no apaga el detector si queda posicion real material (`realSize > dust`).

2. `sum(closePct) <= 100` queda validado.
- Se valida en `validateSpotDefenseConfig`.
- Se revalida al reservar el arm para cubrir snapshots migrados/manipulados.

3. TPs ya no se colocan sin SL confirmado.
- El loop de TPs solo corre con `slProtected` verdadero.
- `slProtected` solo es verdadero si el SL quedo `resting`; si el SL se llena al colocarse, se sale sin TPs.

4. Reconcile de TPs ya no confia en estado local.
- Para TPs existentes se confirma con `orderStatus`, `openByCloid` y `fillsByCloid`.
- `filled`, `open`, `triggered` y grace quedan diferenciados antes de recolocar.

5. Recovery/idempotencia de TP queda cubierto.
- El pre-record aborta si falla antes del RPC.
- `TransportError` queda como `pending + submittedAt`, no `rejected`.
- La ventana crash post-RPC/pre-`submittedAt` queda cubierta con `preparedAt`.
- El retry rota `attempt`/cloid solo tras prueba negativa estable y grace.

## Residual no bloqueante

- El retry de un rechazo determinista puede esperar el grace por `preparedAt` antes de rotar; es conservador y no abre riesgo money-path. Si molesta operativamente, puede optimizarse mas adelante distinguiendo `rejected` sin grace.

Resultado final: **GO**.
