# Prompt de auditoría Codex — PLAN de Fase 4 PR1 (tests de invariantes, helpers puros)

Eres un auditor senior. Audita el PLAN (no hay código aún) de la Fase 4 PR1 para Quantum.ia: tests
unitarios de los helpers PUROS del motor con `vitest` (ya configurado). Tests-only, sin tocar lógica.

Lee el plan y el contexto:

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
sed -n '1,200p' $R/docs/plan-fase4-tests-invariantes.md
git -C $R show HEAD:convex/leverage.ts | sed -n '36,112p'   # resolveLeverage (lo que se testea)
sed -n '1,12p' $R/vitest.config.ts
head -45 $R/tests/hyperliquidSpot.test.ts                    # estilo del test existente
git -C $R show HEAD:convex/triggerRearm.ts | sed -n '30,55p' # armErrorKind
```

Responde **GO / NO-GO del plan** con hallazgos numerados (ALTO/MEDIO/BAJO). Verifica:

1. **Cobertura de invariantes correcta.** Para `resolveLeverage`, ¿los casos listados cubren los
   invariantes de seguridad reales (piso 10×, sube-solo-lo-justo, cap 20×, blocked_margin si no cabe,
   manual valida crudo-luego-redondea, manual > assetMax rechazado)? ¿Falta algún caso límite peligroso
   (p.ej. `usableReal` exactamente 0, `needed === hardCap`, slider > cap)?

2. **Import directo vs extracción (decisión clave).** El plan propone import directo (A) y, si vitest
   no puede importar `triggerRearm.ts`/`hyperliquid.ts` (definen funciones Convex; `hyperliquid.ts` es
   `"use node"`), extraer los helpers puros a un módulo HOJA y re-exportar (B). ¿Es aceptable B como
   movimiento byte-equivalente sin riesgo? ¿O prefieres que se intente SIEMPRE A primero y solo se
   extraiga lo mínimo? ¿Hay riesgo de que exportar un mapa/función altere el bundle de Convex?

3. **Que los tests CONGELEN el contrato, no lo cambien.** El objetivo es fijar el comportamiento ya
   auditado (paridad de leverage, fail-safe de armErrorKind → transient). ¿El plan deja claro que si un
   test "falla", se corrige el TEST salvo que revele un bug real, nunca se relaja un invariante?

4. **Alcance.** ¿Es correcto dejar state machines (ALLOWED/ALLOWED_ARM, no exportados) y
   risk/reservation (necesita ctx.db) para un PR2 con `convex-test`? ¿O algo de eso es barato ya?

5. **Tooling.** Añadir `"test": "vitest run"` a package.json cumple el criterio "`npm test` existe".
   ¿Algún ajuste de `vitest.config.ts` necesario (include ya cubre `tests/**/*.test.ts`)?
