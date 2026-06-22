# JAV-107 Fase 3c-3a + 3c-3b - Reauditoria Codex r3

Commit auditado: `1ddc823`

Veredicto: **NO-GO**

## Bloqueante

1. **ALTO - El SL BE nuevo puede llenarse antes de quedar trackeado**
   - El fix ya no sobrescribe el `sl` canonico hasta confirmar que `oldCloid` murio. Eso cierra el huerfano del SL viejo.
   - Pero en `convex/spotDefenseEngine.ts:379-407`, si el SL BE `newCloid` queda vivo o se llena y `oldCloid` todavia no esta muerto, la DB conserva solo el `oldCloid`.
   - Si `newCloid` se llena antes del siguiente reconcile, la rama flat solo revisa fills del `slOrder` actual de DB, que sigue siendo `oldCloid`.
   - Resultado: el cierre por SL BE puede terminar con `closeReason:"manual"` en vez de `"sl"`, y entonces no dispara auto-rearm.

## Fix pedido

- Trackear el `newCloid` apenas se envia/acepta, sin perder el `oldCloid`.
- Opciones validas:
  - soportar dos filas durante la rotacion (`sl_old`/`sl_new` o intento por CLOID);
  - guardar un campo temporal tipo `bePendingCloid` en el arm;
  - o en la rama flat, antes de closeReason, comprobar fills del `newCloid` deterministico si `!beMoved` y hay BE en curso.
- Solo cerrar como `"manual"` despues de descartar fills tanto del viejo como del nuevo BE pendiente.

## Cerrado de r2

- **GO** - Ya no se pierde tracking del `oldCloid`: ahora se cancela y se exige `openByCloid(oldCloid) === false` antes de sobrescribir la fila `sl`.

## Verificacion

- `npm run typecheck`: OK.
- `npm test -- --run`: OK, `235/235`.

Resultado final: **NO-GO**.
