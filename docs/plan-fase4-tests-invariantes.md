# Fase 4 — Tests de invariantes del motor (PR1: helpers puros)

## En una frase

Blindar con tests automatizados los invariantes de seguridad del motor, empezando por la lógica PURA
(sin red ni runtime Convex), que es donde más barato y valioso es. `vitest` ya está configurado
(`tests/**/*.test.ts`, env node) con un test existente; falta el script `npm test` y la cobertura de
los helpers críticos.

## Alcance de ESTE PR (PR1): SOLO `resolveLeverage` + `armErrorKind` (Codex #5)

Tests nuevos en `tests/`, sin tocar ningún archivo de `convex/` salvo (si fuera estrictamente
necesario) EXPORTAR una función pura ya existente. NO se cambia ninguna lógica de trading. Codex
recomienda acotar este PR a los DOS helpers puros más críticos. Los helpers de precisión HL
(`floorToDecimals`/`formatHlPrice`/`ceilHlPrice`/`aggressiveHlPriceStr`) viven en `hyperliquid.ts`
(`"use node"` + SDK) → su test requiere extracción y se DIFIERE a un PR posterior.

> **PRINCIPIO (Codex #4): los tests CONGELAN el contrato ya auditado, NO lo rediseñan.** Si un test
> "falla", se corrige el TEST — salvo que revele un bug real ya aceptado como fix. Aplica en especial a:
> (a) modo manual valida el valor CRUDO y DESPUÉS redondea; (b) `armErrorKind` sin prefijo → `transient`;
> (c) wrappers `Uncaught Error:` repetidos solo al inicio.

### 1. `resolveLeverage` (`convex/leverage.ts`) — módulo PURO, import directo
Invariantes (paridad ya auditada por Codex):
- **auto, piso 10×:** colateral holgado → `appliedLeverage === STANDARD_AUTO_LEVERAGE` (10) si el slider
  no llega; con slider (`manualLeverage`) como piso, no baja de él.
- **auto sube solo lo justo:** colateral ajustado → sube por encima del piso solo hasta `needed`, no más.
- **cap 20×:** `appliedLeverage ≤ min(AUTO_LEVERAGE_CAP, assetMaxLeverage)`.
- **bordes del cap (Codex #1):** `needed === hardCap` → abre exactamente al cap; `needed === hardCap+1`
  → `[blocked_margin]`.
- **bordes de colateral (Codex #1):** `usableReal === 0` y `usableReal < 0` → `[blocked_margin]`.
- **slider por encima del tope (Codex #1):** auto con slider > `AUTO_LEVERAGE_CAP` o > `assetMaxLeverage`
  → queda capado a `hardCap` (NO aplica el slider crudo).
- **manual respeta límites (Codex #1):** fuera de `[1,25]` → `[blocked_config]`; `25.4` y `0.6`
  rechazados (valida crudo ANTES de redondear); `24.6` → aplica `25`; `20.6` con `assetMaxLeverage=20`
  → rechaza tras redondear a `21`.
- **manual con `assetMaxLeverage` no fiable (Codex #1):** el código solo rechaza manual > assetMax cuando
  la metadata es entero ≥1; con metadata inválida/no entera NO bloquea (HL queda como autoridad final).
  El test CONGELA ese contrato exacto.
- **validaciones globales:** `reservedNotional ≤ 0`/no finito → `[blocked_config]`; en auto,
  `assetMaxLeverage` no entero ≥1 → `[blocked_config]`.
- **margen derivado:** `marginRequired === reservedNotional / appliedLeverage`.

### 2. `armErrorKind` (`convex/triggerRearm.ts`)
- clasifica por prefijo `[blocked_config]`/`[blocked_margin]`/`[transient]`/`[retry_incompatible]`,
  incluso bajo wrappers `Uncaught Error:` (solo al inicio).
- string desconocido / sin prefijo → `transient` (fail-safe: reintentar, nunca abandonar por error técnico).

## Import directo primero; extracción mínima solo si vitest lo exige (Codex #2/#3)

- **`resolveLeverage`/`leverage.ts`:** módulo PURO/hoja → **import directo (A)** con seguridad.
- **`armErrorKind`/`triggerRearm.ts`:** intentar SIEMPRE A primero. Importar `triggerRearm.ts` puede
  arrastrar `_generated/server`, `elog` y `engineEvents`. Si vitest se queja: **(B)** extraer SOLO el
  parser puro a un módulo hoja `convex/rearmErrors.ts` y re-exportarlo desde `triggerRearm.ts`.
  Byte-equivalente mientras NO cambien la regex, los tipos ni los callers.
- **NO exportar** `ALLOWED`/`ALLOWED_ARM` ahora (Codex #3): exportar un helper puro es inocuo, pero
  exponer los mapas de estado desde `executions.ts`/`triggerArms.ts` amplía superficie y arrastra más
  grafo → queda para PR2 con `convex-test`.

## Fuera de alcance (PR2/posterior, requiere DB/convex-test o extracción)
- **Helpers de precisión HL** (ítem 4): `hyperliquid.ts` es `"use node"` + SDK → extraer a un módulo
  hoja antes de testear. Posterior.
- **State machines** (ítem 3): `ALLOWED`/`ALLOWED_ARM` no exportados → exportar o `convex-test`. PR2.
- **Risk/reservation** (ítem 5): `committedMarginForAccount` necesita `ctx.db` → `convex-test`. PR2.

## Entregables
- `package.json`: script `"test": "vitest run"` — **YA existía** (no se modifica package.json).
- `tests/leverage.test.ts` (23 tests), `tests/armErrors.test.ts` (11 tests).

## RESULTADO de la implementación
- **Path A (import directo) FUNCIONÓ** para AMBOS módulos. `armErrorKind` se importa de `triggerRearm.ts`
  sin que vitest se queje → **NO hizo falta extraer a `convex/rearmErrors.ts`**. Cero cambios en
  `convex/` (ningún archivo de producción tocado).
- `npm test` → 53 tests verdes (34 nuevos + 19 del test de spot grid existente). `npm run typecheck` OK.

> Higiene de commit: el dir `tests/` ya contiene `hyperliquidSpot.test.ts` (trabajo de spot grid, sin
> commitear). Al commitear, añadir SOLO los archivos nuevos de Fase 4, nunca `git add tests/` entero.

## Verificación
- `npm test` (verde) + `npm run typecheck`. Los tests NO tocan HL real ni red.

## Flujo
plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → merge. Riesgo BAJO (tests only).
