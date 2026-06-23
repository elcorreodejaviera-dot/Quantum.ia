# JAV-107 Fase 3c-3c - Reauditoria Codex - NO-GO r2

Claude: repara estos hallazgos sobre el working tree actual en `feat/jav107-spot-defense`.

Contexto:
- Base auditada original: `ab20e53`
- Reauditoria: fixes no commiteados sobre `convex/schema.ts`, `convex/spotDefenseBots.ts`, `convex/spotDefenseEngine.ts`, `tests/spotDefenseBackend.test.ts`
- Verificacion local: `npm run typecheck` OK; `npm test` OK (`240/240`).
- Los fixes van en buena direccion, pero quedan riesgos money-path.

## Bloqueantes

1. ALTO - TP `open` que desaparece del book puede recolocarse antes de que `userFills` refleje el fill.
- En `convex/spotDefenseEngine.ts:531-547`, si `openByCloid(existing.cloid)` da false, solo se respeta grace para `pending` con `submittedAt`.
- Un TP que estaba `open`, dispara, sale de `frontendOpenOrders` y todavia no aparece en `userFills` puede marcarse `canceled` y recolocarse con un cloid nuevo.
- Riesgo: cuando el fill original aparezca despues, hubo dos TPs para el mismo `tpIndex` y se puede cerrar mas de lo configurado.
- Fix esperado: aplicar grace a cualquier intento enviado (`submittedAt`) antes de declararlo muerto, consultar `orderStatus` si aplica, y solo recolocar tras prueba negativa estable.

2. MEDIO - El pre-record de un nuevo intento TP no limpia `submittedAt` ni `oid` anteriores.
- En `convex/spotDefenseBots.ts:799-804`, el upsert conserva `submittedAt` y `oid` salvo que `markSubmitted`/`oid` vengan definidos.
- Cuando se prepara un nuevo intento `pending` pre-RPC, puede heredar `submittedAt`/`oid` del intento viejo.
- Eso rompe la semantica "pending sin submittedAt = preparado, no enviado" y puede hacer que el motor trate un intento nuevo como ya enviado.
- Fix esperado: cuando `markSubmitted` es falso/ausente en un pre-record de intento nuevo, limpiar explicitamente `submittedAt` y `oid`.

3. MEDIO - `slProtected` trata un SL `filled` como proteccion valida para colocar TPs.
- En `convex/spotDefenseEngine.ts:515`, `slProtected = rec.ok && r.state !== "pending"` incluye `r.state === "filled"`.
- Si el SL se ejecuta al colocarse, el motor puede continuar al loop de TPs aunque la posicion ya este cerrandose/cerrada.
- Fix esperado: `slProtected` debe ser verdadero solo para `r.state === "resting"`. Si `filled`, marcar SL filled y salir para que la rama flat/close-confirm cierre el arm.

## Checks esperados

- Agregar tests/regresiones para:
  1. TP `open` desaparece de open orders por trigger, `userFills` aun laggea: no se recoloca hasta pasar grace/prueba negativa.
  2. Recolocacion de TP limpia `submittedAt`/`oid` en el pre-record del nuevo attempt.
  3. SL colocado con resultado `filled` no permite colocar TPs en el mismo ciclo.
- Reejecutar `npm run typecheck`.
- Reejecutar `npm test`.

Resultado final: **NO-GO**.
