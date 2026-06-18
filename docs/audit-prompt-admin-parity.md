# Prompt de auditoría (Codex) — Plan JAV-84 (paridad panel Admin)

Eres un auditor senior. Audita el **PLAN** (no hay código aún) en `docs/plan-admin-parity.md` para llevar
el panel Admin (`src/components/AdminView.jsx` + `convex/admin.ts`) a paridad con el mockup
`docs/mockups/admin-tab.html`, arreglando el bug del TVL (usa `pool.tvl` del pool entero de Uniswap en
vez de la liquidez de la posición LP del usuario).

Contexto del repo (Quantum.ia): React+Vite + Convex + Clerk + Hyperliquid (`@nktkas/hyperliquid`). Reglas
duras (CLAUDE.md): NO mezclar refactors amplios con lógica de trading; las **queries** Convex no hacen red;
los datos en vivo deben ir en **acciones** read-only; `leverage.ts` es la única fuente de leverage/margen;
la contabilidad de margen incluye ejecuciones y trigger_arms; testnet/mainnet explícito; nunca firmar/
ordenar fuera del money-path ya auditado.

Verifica y responde **GO / NO-GO** con hallazgos accionables:
1. ¿La semántica "monitoreado = Σ `initialLiquidityUsd` de pools con bot activo" es correcta, o debería ser
   el `hedgeNotionalUsd`/liquidez en vivo? ¿Riesgo de mostrar números engañosos o null mal manejados?
2. ¿Las acciones admin nuevas (`adminLive.ts`: clearinghouseState HL + poolScanner RPC) son estrictamente
   read-only y no tocan el money-path? ¿`requireAdmin` + acotación + manejo de fallo→"—" suficientes?
3. ¿Reusar `setSubscriptionPlan`/`setUserSuspended`/`grant·revoke*` desde el panel respeta sus invariantes
   (admin no asignable, etc.)? ¿Algún gate que falte revalidar?
4. Rendimiento: fan-out de acciones por usuario/posición al expandir — ¿topes, N+1, abuso? ¿Caché?
5. ¿Algo del mockup se está prometiendo sin dato disponible (p.ej. Revert) y el plan lo difiere bien?
6. Fronteras testnet/mainnet, multi-cuenta HL, y enmascarado de la dirección/colateral.
7. Cualquier riesgo de romper la vista (excepción no capturada → pantalla en blanco) como pasó con el routing.
