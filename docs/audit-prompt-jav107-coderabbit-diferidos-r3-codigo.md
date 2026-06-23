# Re-auditoría r3 — JAV-107: CLOID HL del entry (cierre del NO-GO de Fix 1)

Audita el **CÓDIGO** del commit `4a93335` (rama `feat/jav107-spot-defense`). Emite **GO / NO-GO**.
Contexto: en r2 (commit `d60dc55`) **Fix 2 (auto-rearm durable) ya recibió GO**; **Fix 1 quedó NO-GO**
porque su cascada `orderStatus/openByCloid/fills` depende de `entry.cloid`, y la entry se creaba/enviaba
con el INPUT lógico crudo de `spotDefenseCloidInput` (`spot-defense:...`) en vez de un cloid HL válido
(`toHlCloid` → `0x`+32hex), a diferencia de SL/BE/TP. Esta r3 corrige SOLO eso.

## Fix aplicado (commit `4a93335`)

`convex/spotDefenseBots.ts` — `reserveSpotDefenseArm`:
- Import añadido: `toHlCloid` (junto a `spotDefenseCloidInput`).
- `const cloid = await toHlCloid(spotDefenseCloidInput(String(armId), generation, "entry"));`
  (antes: `spotDefenseCloidInput(...)` crudo). Este `cloid`:
  - se persiste en la fila `spot_defense_orders` (role `entry`),
  - se devuelve en la reserva (`{ ..., cloid }`) → el motor lo envía a HL como `c: cloid`,
  - es el identificador que usan `orderStatus` / `openByCloid` / `cancelByCloid` / `fillsByCloid`.
- `crypto.subtle` está disponible en el runtime de mutations de Convex (igual que `triggerArms.armCloid` y
  documentado en `convex/cloids.ts:9`), por eso el `await toHlCloid(...)` en la mutation es válido.

Test nuevo (`tests/spotDefenseBackend.test.ts`): tras `reserveSpotDefenseArm`, el `cloid` de la fila
`entry` cumple `^0x[0-9a-f]{32}$` y coincide con el `cloid` devuelto por la reserva (el que el motor envía
a HL).

## Preguntas

1. ¿El cloid del entry queda ahora 100% consistente entre persistencia, envío a HL (`c:`) y las 4 lecturas
   de reconciliación (`orderStatus`/`openByCloid`/`cancelByCloid`/`fillsByCloid`)? ¿Algún sitio que aún
   derive o compare el entry por el input crudo?
2. ¿`await toHlCloid(...)` en `reserveSpotDefenseArm` (mutation NON-node) es correcto y determinista (mismo
   armId+generation → mismo cloid), preservando la idempotencia del reintento?
3. Con el cloid ya válido, ¿la cascada de Fix 1 (orderStatus + open/triggered/waiting*/filled + grace +
   ensureDead + re-fill → failed) queda GO money-path? (la lógica ya se validó en abstracto en r2).
4. ¿Algún otro consumidor del entry cloid fuera de `reserveSpotDefenseArm` + el motor que requiera ajuste?

## Verificación
`npm run typecheck` EXIT 0; `npm test` **254/254** (+1: entry cloid 0x+32hex; +3 rearm de r2). Engine
"use node" fuera del harness por diseño. NO pusheado: pendiente este re-GO.

Devuelve hallazgos + veredicto **GO / NO-GO**. Con GO, los 2 diferidos quedan cerrados y se pushean al PR #111.
