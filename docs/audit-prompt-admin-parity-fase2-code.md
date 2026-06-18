# Prompt de auditoría (Codex) — CÓDIGO Fase 2 de JAV-84 (datos en vivo del panel Admin)

Audita el **código** (working tree, sin commit) de la Fase 2 del plan `docs/plan-admin-parity.md`.
Archivos: `convex/adminLive.ts` (NUEVO), `convex/admin.ts` (query interna + campos), `src/components/AdminView.jsx`.

Diseño aprobado (plan GO): UNA acción agregada `getUserAdminLiveSnapshot({userId})`, read-only, que rellena
en vivo: liquidez LP actual + fees s/cobrar + in/out range (poolScanner) y colateral + PnL no realizado por
activo (HL Info `clearinghouseState`). Datos cacheados (Fase 1) se ven al instante; lo vivo entra al expandir.

Cambios:
- `convex/admin.ts`: `getUserLiveTargetsInternal` (internalQuery) → posiciones (pools con bot activo:
  botId, baseAsset, hlAccountId, tokenId, network, poolAddress, rango) TOPADAS a `MAX_LIVE_POSITIONS=8`
  + cuentas HL (id, tradingAccountAddress). `getUserDetail` ahora incluye `baseAsset` y `hlAccountId` por posición.
- `convex/adminLive.ts`: action `getUserAdminLiveSnapshot`. Gate admin por
  `ctx.runQuery(internal.users.getCurrentAdminInternal)` (no `requireAdmin` en action). Posiciones SECUENCIAL,
  cada una en try/catch → null + flag `partial.positions`. `scanPoolByTokenId` (precio/estado) +
  `fetchPositionLiquidity` (liquidez/fees) vía `ctx.runAction(api.*)` (auth propaga). HL: `clearinghouseState`
  por `hlInfoUrl()` con timeout 10s, fallo → null + `partial.hl`; dirección enmascarada `0x12..ab`;
  colateral = `marginSummary.accountValue`; `pnlByCoin` = Σ `unrealizedPnl` por coin. NUNCA exchange/clave.
- `AdminView.jsx`: `useAction` al expandir, en try/catch (fallo → live=null, "—"), con caché TTL 30s
  (`liveCache`) + cancelación. `PositionCard` muestra Liquidez LP actual (o inicial si no hay vivo),
  Fees s/cobrar, pill in/out range, "PnL hedge", "Cuenta HL · colateral".

Verifica GO/NO-GO:
1. ¿La acción es estrictamente read-only y NO money-path? ¿`clearinghouseState` por Info API sin clientes
   con exchange/clave? ¿`hlInfoUrl()` (red backend) y no asunción de red desde el front?
2. Gate admin: ¿`ctx.runQuery(getCurrentAdminInternal)` aborta correctamente para no-admin antes de gastar
   RPC/Info? ¿alguna ruta que filtre datos a no-admin?
3. Fan-out/coste: secuencial + `MAX_LIVE_POSITIONS=8` + caché TTL cliente + cancelación. ¿Suficiente para
   evitar N+1 y ráfagas? ¿`scanPoolByTokenId`+`fetchPositionLiquidity` (2 reads/posición) aceptable?
4. ¿Propaga bien la auth a `ctx.runAction(api.actions.poolScanner.*)` (que hacen `requireAuth`)? ¿algún caso
   en que falle por identidad?
5. Robustez UI (lección pantalla en blanco): ¿el `useAction` en try/catch + estado por sección evita que un
   throw tumbe la vista? ¿`liveCache` module-level causa fugas o datos cruzados entre usuarios?
6. PnL por `coin`: mapear `pos.baseAsset` ↔ coin de HL, ¿correcto? ¿riesgo de atribuir PnL equivocado si la
   cuenta HL tiene varias posiciones o el baseAsset no coincide con el símbolo HL?
7. Enmascarado de dirección y que NO se exponga la clave/credencial. Multi-cuenta HL por usuario.
8. TS2589: ¿`Promise<any>` donde toca para no reintroducir la cascada del grafo internal.*/api.*?
