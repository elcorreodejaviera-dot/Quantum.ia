# Prompt de auditoría (Codex) — CÓDIGO: JAV-112 fix del gate de la barra Loan health

**Delta sobre el PR #117 (ya GO previo).** Corrige un **Major de CodeRabbit**: el gate que decide si hay
préstamo activo usaba `borrowHealth` redondeado y ocultaba la barra justo con HF≈1.0. Commit `4efa9c1`,
1 archivo: `src/components/BotPortal.jsx`. Sigue siendo **solo-UI / display**. Veredicto **GO / NO-GO**.

## Contexto del bug

- `convex/actions/poolScanner.ts:615`: `borrowHealth = clamp(0,100, round((hf-1)×100))`. Para un préstamo
  con HF en `[1.00, 1.005)` (≈0.5% de liquidación) → `borrowHealth = 0`.
- `fetchPositionLiquidity` (`poolScanner.ts:633-647`) **siempre** devuelve `amountToRepay`, `healthFactor`,
  `borrowHealth`, etc. — los campos viajan aunque `borrowHealth===0`.
- Antes: `BotPortal.jsx:388` `hasBorrowData = pool.borrowHealth > 0` Y `BotPortal.jsx:3803`
  `...(pd.borrowHealth > 0 ? {...} : {})` poblaba `healthFactor`/`amountToRepay` solo si `borrowHealth>0`.
  Resultado: con HF≈1.0 la tarjeta mostraba "Sin apalancamiento" y los campos quedaban en su default 0.
- El fix sugerido por CodeRabbit (`healthFactor>0 && amountToRepay>0` solo en la línea 388) **no
  bastaba**: esos campos no se poblaban porque el gate de la 3803 seguía en `borrowHealth>0`.

## Qué cambia (`4efa9c1`)

- `BotPortal.jsx:388`: `hasBorrowData = pool.amountToRepay > 0` (deuda real, sin redondeo).
- `BotPortal.jsx:~3803`: la población condicional del pool pasa a `pd.amountToRepay > 0 ? {...} : {}`.
- Se elimina `borrowHealth` del objeto `pool` (default en ~3780 y copia en ~3804): ya no se lee en
  BotPortal tras el rediseño (la barra usa `healthFactor`; `AdminView` usa su propio `borrowHealth`).

## Verifica GO/NO-GO

1. **Corrección del gate**: ¿`amountToRepay > 0` es señal fiel de "préstamo activo"? En el scanner
   `amountToRepay = round(debt/1e6×100)/100` y solo es `>0` cuando `debt>0` (rama `debt>0 && collateral>0
   && fullValue>0`), que es exactamente cuando `healthFactor`/`leverageRevert` se calculan. ¿De acuerdo?
2. **Sin falsos negativos/positivos**: ¿se muestra la barra siempre que hay deuda (incl. HF≈1.0 → marcador
   en el extremo rojo, `--hp` clamp a 0) y se oculta cuando no hay préstamo (en vault sin deuda: `debt===0`
   → `amountToRepay=0`)?
3. **`pool.amountToRepay` siempre numérico**: default `0` en el objeto pool (~3782) y `pd.amountToRepay ??
   0` al poblar. ¿`> 0` nunca compara contra `undefined`?
4. **borrowHealth muerto**: confirma que tras el cambio no queda ninguna lectura de `pool.borrowHealth` en
   `src/components/BotPortal.jsx` (grep) y que `AdminView.jsx` usa su propia fuente, intacta.
5. **Sin efectos**: ¿sigue siendo solo-display, sin tocar persistencia, motor ni scanner?

Checks: `npx vite build` (OK) + revisión visual con préstamo Revert activo. NO `npm run build`.
