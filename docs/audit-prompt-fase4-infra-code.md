# Prompt de auditoría Codex — CÓDIGO de Fase 4 (infra vitest + tests), opción A

Eres un auditor senior. Audita un cambio FRONTEND/TOOLING para Quantum.ia. Contexto: la infra de tests
(vitest) venía acoplada al commit de spot grid (JAV-90, que el usuario gestiona aparte y ha pausado).
Por decisión del usuario (opción A) se SACA la infra a un commit propio sobre master, independiente del
spot grid, y encima van los tests puros de Fase 4. Reemplaza al PR #86 (que estaba enredado con el
commit de spot grid). Tests-only / tooling: CERO cambios en `convex/`.

Revisa el diff (2 commits sobre master):

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...elcorreodejaviera/fase4-test-infra -- package.json vitest.config.ts tests/ docs/
git -C $R log --oneline master..elcorreodejaviera/fase4-test-infra
```

Verificación ya hecha: `npm test` → 36 verdes; `npm audit --audit-level=critical` VERDE; `npm run
typecheck` OK.

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **Independencia del spot grid (CRÍTICO).** El diff debe tocar SOLO: `package.json` (script `test` +
   devDep `vitest`), `package-lock.json`, `vitest.config.ts`, `tests/leverage.test.ts`,
   `tests/armErrors.test.ts`, `docs/`. NADA de spot grid (sin `convex/hyperliquidSpot.ts`,
   `convex/cloids.ts`, `tests/hyperliquidSpot.test.ts`, ni connector). Confirma que no se cuela.

2. **vitest 4 vs 2.1.9 (la advisory).** El commit de spot grid traía `vitest ^2.1.9`, vulnerable a
   GHSA-5xrq-8626-4rwp (Vitest UI, `<=3.2.5`). Aquí se fija `^4.1.9` (parcheado) → `audit --audit-level
   =critical` verde. ¿Algún riesgo en el salto 2→4 para estos tests? (los 36 pasan). ¿El lockfile quedó
   coherente?

3. **Tests congelan contrato, no lo cambian.** `resolveLeverage`/`armErrorKind`: las aserciones deben
   reflejar el comportamiento ACTUAL (ya auditado en el plan de PR1, que diste GO). Sin cambios en
   `convex/`.

4. **`vitest.config.ts` acotado.** `include: ["tests/**/*.test.ts"]`, env node → no interfiere con el
   type-check de Convex (`convex/tsconfig.json`). Correcto.

5. **CERO impacto producción.** vitest es dev-tooling; no entra al runtime ni al bundle de la app
   (`vite build` usa su propio vite@6/esbuild, intacto). Confirma.

NOTA: el commit de spot grid del usuario (7386fb0, QSG PR1) queda preservado aparte (rama
`spot-grid/qsg-pr1-jav90`); este PR NO lo incluye. El #86 enredado se cerrará en favor de este.
