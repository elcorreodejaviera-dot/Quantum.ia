# Prompt de auditoría Codex — CÓDIGO de Fase 6-D (explicaciones)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de la Fase 6-D de Quantum.ia: "explicaciones estilo
curso" en la tarjeta del bot. El plan ya tiene tu GO (tras 4 ajustes). FRONTEND-PURO: cero backend,
cero cambio de lógica de trading.

Revisa el diff:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/fase6d-explicaciones -- src/ tests/ docs/
```

Verificación ya hecha: `npm test` → 66 verdes (incl. `tests/explainBot.test.ts`); `npm run typecheck`
OK; `npx vite build` OK.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **Refactor SIN cambio de comportamiento (CRÍTICO).** Los cálculos `capital`/`levText`/`slOrder`/
   `beState` se extrajeron de `CoberturaViva` a `src/lib/armView.js` y se reusan. Confirma que la lógica
   es BYTE-EQUIVALENTE a la inline previa: `capitalPerPosition` (regla OCO `reservationReduced`/
   `allowReentryFromAbove`), `leverageText` (Auto/Auto·Nx/Nx), `slOrderOpen` (sl_upper|sl + open),
   `beState` (be ≤ entry·1.001 / be_pending / null). La variable local `beState` se renombró a `be`
   (import `beState as beStateOf`) — ¿alguna referencia perdida?

2. **SL real, no inferido (Codex MEDIO#1 del plan).** `explainBot` usa `slOrderOpen(arm)` (orden
   abierta real); si no hay SL abierto → "Colocando la protección…" / "Protección verificándose…" por
   estado, NUNCA un SL teórico desde entryPrice+stopLossPct. ¿Correcto?

3. **failed sin motivo inventado (MEDIO#2).** `arm.status==="failed"` → solo "El último armado falló";
   el `kind` solo desde `bot.lastRearmErrorKind` (rearm blocked). Sin `arm.error`. ¿Confirmado?

4. **No maquilla estados.** blocked/pausado/esperando se muestran tal cual. ¿De acuerdo?

5. **Sin datos sensibles / frontend-puro.** El diff toca SOLO `src/lib/armView.js`, `BotPortal.jsx`,
   `bot-portal.css`, `tests/`, `docs/`. Las frases solo usan datos ya visibles del usuario (precios/
   triggers/capital/estado); nada de claves/direcciones. `explainBot` es puro (sin React, formateo
   propio) y testeado. ¿Algo fuera de lugar?
