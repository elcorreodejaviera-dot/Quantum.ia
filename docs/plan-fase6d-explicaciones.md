# Fase 6-D — Explicaciones estilo curso (frontend-puro)

## En una frase

Cada bot explica en lenguaje simple qué está haciendo, traduciendo el estado del arm/bot/pool que la UI
YA tiene (`listMyActiveArms` + bot config) a 1-3 frases. CERO backend, cero cambio de lógica de trading.

## Por qué es barato y seguro

Los datos YA están disponibles en el frontend, repartidos entre `arm` y `bot` (Codex BAJO#3):
- **del `arm`** (`listMyActiveArms`): `status`, `side`, `triggerPx`, `lowerEdge`, `upperEdge`,
  `appliedLeverage`, `reservedNotional`, `reservationReduced`, `allowReentryFromAbove`, `entryPrice`,
  `beMoved`, `orders` (incl. la orden `sl_upper` para el SL real).
- **del `bot`** (que `CoberturaViva` ya recibe): `stopLossPct`, `autoRearm`, `autoLeverage`,
  `rearmStatus`, `lastRearmErrorKind`, `disarmPending`, `active`.
- `pool` (precio/min/max) y `hlBalance` ya llegan al componente.

`CoberturaViva` (`BotPortal.jsx:180`) ya deriva `estado`/distancias/capital/levText/slOrder/beState. La
feature solo AÑADE un helper de texto y lo renderiza. Sin queries nuevas, sin tocar el motor.

## Diseño

### Helper puro `explainBot(bot, arm, pool, hlBalance)` → `string[]`
Función pura (sin React, testeable) que devuelve frases según el estado. Usa `arm` para estado/órdenes
y `bot` para config (Codex BAJO#3).

**(Codex BAJO#4) Extraer, NO copiar.** Los cálculos que hoy viven inline en `CoberturaViva` —
`capital` por posición (con la regla `reservationReduced`/OCO), `levText`, `slOrder` (la `sl_upper`
abierta) y `beState` — se sacan a helpers COMPARTIDOS (p.ej. `src/lib/armView.js`) que consumen TANTO
`CoberturaViva` como `explainBot`, para que no diverjan. El PR refactoriza `CoberturaViva` para usar
esos helpers (sin cambiar su comportamiento) y los reutiliza en `explainBot`.

Frases por situación (datos de `arm` para estado/órdenes, de `bot` para config):
- **Esperando trigger** (armed / armed_lower_only): «Esperando a que {asset} toque {lowerEdge}{ y/o
  upperEdge}». Si `side==="Short"`: «Si perfora abajo, cubro un short de ≈{capital} USDC ({levText})».
  (`capital`/`levText` salen de los helpers COMPARTIDOS, no recalculados.)
- **Posición abierta** (filled/protecting/protected): «Short de {asset} abierto en ≈{entryPrice}.»
  - **(Codex MEDIO#1) El SL NO se infiere de entryPrice+stopLossPct.** Se reutiliza la MISMA lógica que
    ya usa `CoberturaViva` (la orden `sl_upper` abierta en `arm.orders` + `beState`/`beMoved`): si hay SL
    abierto → «Protección en ≈{slTriggerReal}{ (movido a break-even) si beMoved}»; si NO hay SL abierto
    todavía → según estado: «Colocando la protección…» (protecting) / «Protección verificándose»
    (unknown). NUNCA un SL teórico.
- **Capital**: «Capital por posición: {capitalPerPosition} USDC{ · disponible {hlBalance} si lo hay}».
  (Es capital/nocional, deriva de `reservedNotional`; NO es `marginReserved`, que no expone
  `listMyActiveArms` — Codex MEDIO#1 del código.)
- **Auto-rearm**: si `bot.autoRearm`: «Si cierra por SL, reintento la cobertura en ~5 min».
- **Bloqueado/pausa/fallo**: NO maquillar (igual que hoy, Codex #5):
  - rearm blocked → «Bloqueado{: bot.lastRearmErrorKind}: revisa margen/plan» (el kind SÍ está en `bot`).
  - pausa → «Pausado».
  - **(Codex MEDIO#2)** arm `failed` → solo «El último armado falló» (NO hay `arm.error` en
    `listMyActiveArms` → no se inventa motivo; si el fallo viene de rearm, usar `bot.lastRearmErrorKind`).
    Añadir `arm.error` queda FUERA de este PR (sería backend).

Reglas: lenguaje simple, sin jerga; números con los helpers existentes; si falta un dato (precio/saldo/
SL real) la frase se omite, no muestra «—» raros. NUNCA inventa estado ni SL: deriva 1:1 del backend.

### Render
Un bloque pequeño dentro de `CoberturaViva` (o componente `BotExplain` adyacente) que mapea
`explainBot(...)` a una lista de líneas con tono coherente (el `tone` ya calculado). Solo presentación.

## Verificación
- `npm run typecheck` + `npx vite build`.
- (Opcional, recomendado) un test puro `tests/explainBot.test.ts` que congele las frases por estado
  (la infra de vitest ya está en master).
- Revisar en el navegador que cada estado del bot muestra la frase correcta y NADA sensible.

## Fuera de alcance (otras sub-features de Fase 6)
- A (scoring de rango), B (recomendador de hedge), C (modo auditoría de pool) → PRs posteriores.

## Riesgos
- Muy bajo: frontend read-only, deriva de datos ya mostrados. Único riesgo = redacción/condición de una
  frase → se valida visualmente + test puro.

## Flujo
plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → merge.
