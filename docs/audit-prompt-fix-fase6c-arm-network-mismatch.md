# Prompt de auditoría Codex — FIX `arm_network_mismatch` (Auditoría de Pool, Fase 6-C)

Eres un auditor senior. Audita un FIX de bug en el modo "Auditoría de Pools" de Quantum.ia (vista admin
read-only, Fase 6-C). NO toca money-path. Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO).

## Bug

El check `arm_network_mismatch` (`src/lib/poolAudit.js`) comparaba `arm.network` con `pool.network`, pero
son **namespaces distintos**:

- `trigger_arms.network` = entorno Hyperliquid → `"mainnet" | "testnet"` (`convex/schema.ts:363`).
- `pools.network` = chain de la LP de Uniswap → `"Base" | "Arbitrum" | "Optimism"` (`convex/seed.ts:5-10`,
  `convex/schema.ts:40`).

Como nunca coinciden, el warning saltaba SIEMPRE para cualquier bot con arm activo (falso positivo
visible en producción: "Red del armado (mainnet) distinta a la del pool (Base)"). El plan 6-C y el test
asumían por error que `pool.network ∈ {mainnet,testnet}` (el fixture lo forzaba a `"testnet"`).

## Fix

Comparar la red HL del armado contra la **red HL actual** (`hlNetwork()` vía el snapshot live,
`convex/adminLive.ts:47,128`), no contra la chain del pool. Se omite si la red HL actual es desconocida
(snapshot no disponible) → sin falso positivo.

## Diff

```bash
R=/home/bicho/Escritorio/Quantum.ia/Quantum.ia
git -C $R diff master...fix/fase6c-arm-network-mismatch -- src/ tests/
```

Verificación ya hecha: `npx vitest run tests/poolAudit.test.ts` → 18 verdes; `npm run typecheck` OK;
`npx vite build` OK.

## Verifica

1. **Semántica correcta (CRÍTICO).** `auditPool(b, live, acctCoinCount, currentHlNetwork)` ahora compara
   `liveArm.network !== currentHlNetwork`. ¿Es la comparación correcta (HL env vs HL env)? ¿`pool.network`
   (chain) queda fuera del check, como debe?

2. **Sin falsos positivos ni falsos negativos.** Cuando `currentHlNetwork` es `null` (snapshot no
   disponible) NO debe disparar warn. Cuando coincide (testnet==testnet) tampoco. Cuando difiere
   (mainnet vs testnet) sí. ¿Algún borde mal cubierto?

3. **Wiring AdminView.** `PoolAuditPanel` pasa `live?.network ?? null` a `auditUserPools(audit, liveByBot,
   currentHlNetwork)`. ¿`live.network` es realmente la red HL actual del snapshot? ¿Llega `null` de forma
   segura cuando el snapshot falló?

4. **Resto de checks intactos.** El cambio NO debe alterar los otros 8 checks (`pool_closed_with_live_arm`,
   `orphan_orders`, `triggers_vs_edges`, `hedge_vs_exposure`, etc.). ¿Firma de `auditUserPools` con 3er
   parámetro opcional rompe algún otro call site? (solo AdminView la usa).

5. **Read-only / sin money-path.** El diff toca solo `src/lib/poolAudit.js`, `src/components/AdminView.jsx`,
   `tests/poolAudit.test.ts`. Sin backend nuevo, sin motor. ¿Confirmado?
