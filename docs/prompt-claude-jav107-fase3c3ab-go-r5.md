# JAV-107 Fase 3c-3a + 3c-3b - Reauditoria Codex r5

Commit auditado: `83efb5c`

Veredicto: **GO**

## Bloqueante r4

1. **GO - `newCloid` BE ya no queda fuera de cleanup**
   - Se agrego `spot_defense_arms.bePendingCloid`.
   - `ownCloids` ahora incluye la fila `sl` canonica y `arm.bePendingCloid`.
   - El motor persiste `bePendingCloid` antes de enviar el RPC del SL BE nuevo.
   - Si el viejo sigue vivo, el nuevo queda trackeado para `ensureSpotDefenseOrdersDead`, pausa/kill, drift y cierre terminal.
   - Al completar la rotacion, el `newCloid` pasa a la fila `sl` y `bePendingCloid` se limpia.

## Cerrados acumulados

- **GO** - BE ya no cancela el SL viejo antes de tener el nuevo colocado/confirmable.
- **GO** - No se sobrescribe el `oldCloid` hasta confirmar que murio.
- **GO** - Fill del `newCloid` BE pendiente cuenta como `closeReason:"sl"` y mantiene auto-rearm.
- **GO** - Auto-rearm ya no marca OK cuando `armSpotDefenseInternal` devuelve `ok:false`.
- **GO** - Rearm `running` con lease vencido se recupera; lease vivo no se roba.

## No bloqueante

- Faltaria un test focalizado que simule `bePendingCloid` vivo y cierre terminal para validar cleanup, pero el flujo de codigo ahora cubre el money-path.

## Verificacion

- `npm run typecheck`: OK.
- `npm test -- --run`: OK, `235/235`.

Resultado final: **GO**.
