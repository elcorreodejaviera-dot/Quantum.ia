# Auditoria JAV-109 - TPs add/remove

Commit auditado: `528760b`
Rama: `feat/jav109-tps-add-remove`
Alcance: frontend-only, `src/components/BotPortal.jsx`

## Veredicto

**GO**

## Bloqueantes

Ninguno.

## Altos

Ninguno.

## Medios

- **GO** - No hay limite de cantidad de TPs en UI. Backend valida valores y `sum(closePct) <= 100`, asi que no hay riesgo de sobrecierre, pero conviene considerar un maximo operativo futuro.

## Bajos

- **GO** - `key={i}` puede mover foco/estado visual al borrar una fila intermedia, pero no corrompe payload porque el array real esta controlado por el padre.
- **GO** - La UI no avisa antes de guardar si `sum(closePct) > 100`; backend lo rechaza correctamente.
- **GO** - Quedan textos/comentarios algo desactualizados: "Cantidad fija" y "Take Profits (3 niveles)".

## Confirmaciones

- Filas incompletas se filtran en los 3 guardados con `gainPct > 0 && closePct > 0`.
- `tps: []` es aceptado por pool bots y spot defense.
- Pool no depende de TPs obligatorios.
- Botones nuevos usan `type="button"` y `aria-label`.

## Verificacion

- `npm run typecheck` OK
- `npm test` OK: 254 tests
- `vite build` aislado OK

No se ejecuto `npm run build` porque despliega Convex.
