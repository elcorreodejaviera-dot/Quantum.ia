# Prompt de auditoría (Codex) — CÓDIGO: JAV-120 Fase 0 (schema `pool_fee_snapshots`)

Audita el **código** del commit `649bdc6` (rama `elcorreodejaviera/jav-120-fees-24h-real`). Veredicto
**GO / NO-GO**. Es la Fase 0 del plan `docs/plan-fees24h-real.md` (v3, GO condicionado tuyo ya resuelto en
`docs/audit-fees24h-real-plan-v2-codex.md`). **Solo schema, aditivo, sin lógica.**

## Qué cambia
- `convex/schema.ts`: nueva tabla `pool_fee_snapshots` + índice `by_pool_at` (`["poolId","at"]`). Campos:
  `poolId`, `at`, `tokensOwed0/1Raw`, `collected0/1Raw`, `principalDebt0/1Raw`, `snapshotKey` (string),
  `safeHeadBlock` (number), `aggregatesComplete` (bool). Comentario explica el neteo-al-leer y el rol de
  cada campo.
- Docs del plan + auditorías (no código).

## Verifica GO/NO-GO
1. **Aditivo y seguro**: ¿la tabla es puramente nueva, sin tocar tablas/índices existentes ni requerir
   migración? ¿Ninguna función la referencia aún (inerte)? Confirmar que no hay cron ni mutation que la use.
2. **Tipos y convención**: ¿los raw como `string` (uint256) y `safeHeadBlock` como `number` son coherentes
   con `pool_fee_events` (`schema.ts:106-117`)? ¿`snapshotKey` string es adecuado para la huella de
   `readPositionSnapshotKey` (`poolScanner.ts:464-480`)?
3. **Índice**: ¿`by_pool_at ["poolId","at"]` sirve para (a) buscar el ref "más nuevo ≤ now−24h" y (b) podar
   por antigüedad? ¿Falta algún índice para la Fase 1/3?
4. **Diseño consistente con el plan v3**: ¿los campos alcanzan para el neteo NETO al leer
   (`collected + max(tokensOwed − principalDebt, 0)`), la regla de status por `snapshotKey`/`aggregatesComplete`,
   la tolerancia de antigüedad (usa `at`) y el `getLogs` exacto de F4 (usa `safeHeadBlock`)? ¿Sobra o falta
   algún campo?
5. **Sin efectos**: confirmar que NO es money-path, NO hay deploy de lógica, y que `codegen`/`typecheck`
   pasan (verificado: OK).

Checks: `npx convex codegen` + `npm run typecheck` (verificado OK). No hay UI ni build en esta fase.
