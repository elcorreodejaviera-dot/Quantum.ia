# JAV-107 Fase 3c-3a + 3c-3b - Reauditoria Codex r4

Commit auditado: `f17838a`

Veredicto: **NO-GO**

## Bloqueante

1. **ALTO - `newCloid` BE sigue fuera de `ownCloids` y puede quedar huerfano**
   - El fix de `f17838a` agrega deteccion de fills del `newCloid` deterministico en la rama flat (`convex/spotDefenseEngine.ts:304-313`).
   - Eso corrige el caso donde el SL BE nuevo se llena y habia que cerrar con `closeReason:"sl"`.
   - Pero el `newCloid` sigue sin persistirse ni sumarse a `ownCloids` mientras la fila `sl` conserva el `oldCloid`.
   - `ownCloids` sale solo de DB (`convex/spotDefenseEngine.ts:254`), y `ensureSpotDefenseOrdersDead` solo cancela esos CLOIDs.
   - Si el `newCloid` queda vivo y luego hay salida por `oldCloid`, pausa/kill, market close, o cierre manual, el motor puede terminalizar/cerrar sin cancelar el `newCloid`.
   - Riesgo: orden reduceOnly BE viva en HL pero sin tracking; puede bloquear auto-rearm por "orden abierta del coin" o cerrar una cobertura futura.

## Fix pedido

- El `newCloid` debe entrar al set de ordenes propias apenas se envia/acepta o mientras la rotacion BE esta pendiente.
- Opciones validas:
  - persistir `bePendingCloid` / `bePendingAttempt` en el arm;
  - soportar dos filas temporales de SL durante rotacion;
  - o calcular y agregar el `newCloid` pendiente a `ownCloids` en cada reconcile hasta que `beMoved=true`.
- `ensureSpotDefenseOrdersDead` y cualquier rama terminal deben cancelar tanto `oldCloid` como `newCloid` pendiente.

## Cerrado de r3

- **GO parcial** - Un fill del `newCloid` BE no trackeado ya puede contar como `closeReason:"sl"`.
- **NO cerrado** - El `newCloid` vivo no queda trackeado para cancelacion/cleanup.

## Verificacion

- `npm run typecheck`: OK.
- `npm test -- --run`: OK, `235/235`.

Resultado final: **NO-GO**.
