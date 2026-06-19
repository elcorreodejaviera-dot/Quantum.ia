# Prompt de auditoría Codex — CÓDIGO de Fase 4 PR1 (tests de invariantes)

Eres un auditor senior. Audita la IMPLEMENTACIÓN de la Fase 4 PR1 para Quantum.ia: tests unitarios de
`resolveLeverage` (leverage.ts) y `armErrorKind` (triggerRearm.ts) con `vitest`. El plan ya tiene tu GO.
**Tests-only: CERO cambios en `convex/`** (path A / import directo funcionó, no hizo falta extraer).

Revisa el diff:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/fase4-tests-invariantes -- tests/ package.json
# Contrato testeado (la fuente de verdad, NO debe haber cambiado):
git -C $R show HEAD:convex/leverage.ts | sed -n '36,112p'
git -C $R show HEAD:convex/triggerRearm.ts | sed -n '30,40p'
```

Verificación ya hecha: `npm test` → 53 verdes (34 nuevos + 19 del test de spot grid existente);
`npm run typecheck` OK. NO se modificó ningún archivo de `convex/` ni `package.json` (el script `test`
ya existía).

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **Los tests CONGELAN el contrato real (CRÍTICO).** Cada aserción debe coincidir con el comportamiento
   ACTUAL de `resolveLeverage`/`armErrorKind`, no con uno deseado. Recalcula a mano los casos numéricos
   clave: `usableReal = availableCollateral*(1-0.10) - marginCommitted`; `needed = ceil(reservedNotional
   / usableReal)`; `hardCap = min(20, assetMaxLeverage)`; `applied = min(hardCap, max(floor, needed))`.
   Ej.: reservedNotional=15000, availableCollateral=1000 → usableReal=900, needed=ceil(16.67)=17 → 17.
   ¿Algún `expect` con número equivocado que "congele" un valor incorrecto?

2. **Bordes peligrosos cubiertos (de tu auditoría del plan).** `usableReal === 0` y `< 0`; `needed ===
   hardCap` (abre) vs `hardCap+1` (blocked_margin); slider > cap/assetMax (capado, no crudo); manual
   25.4/0.6 rechazados, 24.6→25, 20.6 con max=20 rechaza tras redondear a 21; manual con assetMax no
   entero NO bloquea. ¿Falta alguno?

3. **`armErrorKind`: regex correcta.** Cubre los 5 prefijos, wrapper `Uncaught Error:` (repetido, solo
   al inicio), prefijo EMBEBIDO no-al-inicio → transient, vacío → transient. ¿Coincide con la regex
   `^(?:Uncaught Error:\s*)*\[(...)\]`?

4. **Cero impacto en producción.** El diff toca SOLO `tests/`. No se modificó `convex/` ni se exportó
   nada nuevo (path A no lo requirió). Confirma que no hay cambios colaterales.

5. **Higiene.** Solo se commitearon `tests/leverage.test.ts` y `tests/armErrors.test.ts` (+ docs); NO el
   `tests/hyperliquidSpot.test.ts` preexistente (trabajo de spot grid sin commitear, ajeno a este PR).
