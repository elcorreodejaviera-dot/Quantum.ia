# JAV-107 Fase 3c-3a + 3c-3b - Reauditoria Codex r2

Commit auditado: `517c454`

Veredicto: **NO-GO**

## Bloqueante

1. **ALTO - La rotacion BE puede dejar un SL viejo huerfano / perder tracking**
   - En `convex/spotDefenseEngine.ts:384-395`, el motor coloca el SL BE nuevo, llama `cancelOwnByCloid(oldCloid)` y luego sobrescribe la unica fila `sl` con el `newCloid`.
   - `cancelOwnByCloid` traga errores y no confirma que el viejo haya muerto.
   - `recordSpotDefenseSlOrder` es upsert por rol unico `sl` (`convex/spotDefenseBots.ts:705-731`), asi que si la cancelacion vieja falla, el DB pierde el `oldCloid`.
   - En ciclos futuros `ownCloids` sale de DB (`convex/spotDefenseEngine.ts:254`), por lo que el SL viejo queda fuera de `ensureSpotDefenseOrdersDead`.
   - Riesgo: orden reduceOnly vieja viva en HL sin tracking; puede bloquear rearm, afectar una posicion futura del mismo coin o quedar como orden huerfana money-path.

## Fix pedido

- No sobrescribir el `sl` canonico hasta confirmar por HL que `oldCloid` ya no esta vivo.
- Patron recomendado:
  - colocar/confirmar `newCloid`;
  - cancelar `oldCloid`;
  - comprobar `openByCloid(oldCloid) === false`;
  - solo entonces hacer `recordSpotDefenseSlOrder(newCloid)` + `setSpotDefenseBeMoved`.
- Si `oldCloid` sigue vivo o la cancelacion es incierta: conservar el SL viejo en DB y reintentar en el siguiente reconcile.
- Ideal: persistir el intento nuevo antes del RPC o soportar dos filas durante la rotacion, para no perder un `newCloid` aceptado/filled antes del record.

## Cerrados del NO-GO anterior

- **GO** - Auto-rearm ya no marca OK a ciegas cuando `armSpotDefenseInternal` devuelve `ok:false`.
- **GO** - Rearm `running` con lease vencido ahora se recupera; `running` con lease vivo no se roba.
- **GO parcial** - BE ya no cancela el SL viejo antes de intentar colocar el nuevo, pero falta confirmar muerte del viejo antes de sobrescribir tracking.

## Verificacion

- `npm run typecheck`: OK.
- `npm test -- --run`: OK, `235/235`.

Resultado final: **NO-GO**.
