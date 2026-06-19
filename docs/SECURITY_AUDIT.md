# SECURITY_AUDIT — Quantum.ia (Fase 5)

Auditoría de seguridad y permisos del backend (`convex/`). **Analysis-only: no se cambió código.**
Fecha: 2026-06-19. Alcance: queries/mutations/actions públicas, helpers de auth, money-path.

## Veredicto

**Postura SÓLIDA. No se hallaron P0 ni P1.** Los 7 puntos del checklist pasan. Solo observaciones P2
(mejoras/consistencia, sin riesgo de fuga ni bypass).

| Severidad | Definición | Hallazgos |
|---|---|---|
| **P0** | Fuga de secretos, bypass de ownership o escalada de privilegios explotable | **0** |
| **P1** | Control de acceso ausente/incorrecto en un path real | **0** |
| **P2** | Inconsistencia/endurecimiento recomendado, sin vulnerabilidad | **2** |

---

## Checklist (resultado por punto)

### 1. Queries públicas NO exponen `encryptedPrivateKey`/`iv`/`authTag` — ✅ OK
- `hlCredentials.list` (`hlCredentials.ts:13`): ownership-scoped (`by_user`, `user._id`) y el `.map`
  devuelve SOLO `id/label/agentAddress/tradingAccountAddress/updatedAt` — **excluye** la clave cifrada,
  iv y authTag. Las direcciones se exponen solo al DUEÑO de la cuenta.
- `admin.ts:241` y `executions.listRecentExecutions` (`executions.ts:506`) exponen `tradingAccountAddress`
  pero ambos bajo `requireAdmin`. `adminLive.ts` además **enmascara** la dirección (`maskAddr`).
- La clave descifrada (`decryptPrivateKey`) solo se usa dentro de actions del motor (`hyperliquid.ts`,
  `triggerEngine.ts`) y NUNCA se devuelve ni se loguea (ver OBS-3: `log.ts` prohíbe escalares sensibles).

### 2. Mutations/actions live exigen autenticación/permiso — ✅ OK
- `executePerpMarketOrder` (`hyperliquid.ts:403`): `assertTradeLiveInternal` + `confirmLive` +
  `tradingEnabled` + `simulationMode=false` + ownership del bot. Revalidado en `reserveExecution`/
  `markSubmitting`/`gateBeforeOrder`.
- `closeBotPosition` (`hyperliquid.ts:371`): user + `bot.userId !== user._id → throw` + `assertTradeLive`.
- `armPoolBotEntry` (`triggerEngine.ts:86`): `requireBotManager` + `canTradeLive` + `assertTradeLive`.
- `connectAccount` (`hlCredentialActions.ts:125`): autentica y guarda con `userId: user._id`.
- Mutations de `bots` (`createBot`/`updateBot`/`toggleBot`/`getOrCreatePoolBot`/`deletePoolBot`):
  todas `requireBotManager` + `validatePoolOwnership`.

### 3. Admin bypass documentado y acotado — ✅ OK
- Centralizado y explícito: `helpers.hasPermission` (`helpers.ts:66`, admin → true),
  `coverageUsage.assertWithinPlanCoverage` (`coverageUsage.ts:111`, admin sin tope),
  `executions.assertLiveAdmissible` (bypass de `canTradeLive` para admin). Comentado en cada sitio.
- La promoción a admin (`users.promoteToAdmin`, `users.ts:104`) es **`internalMutation`** → solo CLI
  (`npx convex run`), NO invocable desde el cliente. **Sin escalada de privilegios desde el frontend.**
- `grantPermission`/`revokePermission` (`users.ts:182/204`): `requireAdmin` + `writeAdminLog` (audit
  OBS-1). Los wrappers públicos `grant/revokeTradeLive`/`ManageBots` delegan en ellos.

### 4. Revocación de HL bloqueada con arm/ejecución viva — ✅ OK
- `hlCredentials.revokeById` (`hlCredentials.ts:36`): `requireUser` + ownership; **lanza** si hay
  ejecución no-terminal (`status` ∉ {closed,failed}) o `hasNonTerminalArmForAccount`. Evita perder la
  clave con una posición/SL viva.

### 5. Borrado/pausa de bots sin órdenes huérfanas — ✅ OK
- `deletePoolBot` (`bots.ts:397`): `requireBotManager` + parada segura PRIMERO (cancela arm/órdenes vía
  cron, `hasNonTerminalArmForBot`) antes de borrar.
- `updateBot`/reconfiguración (`bots.ts:343`): bloquea si hay arm vivo (evita trigger huérfano/incoherente).

### 6. Sin queries globales de wallets/pools para usuarios normales — ✅ OK
- `wallets.listWallets` → `requireAdmin`; `wallets.listMyWallets` → scoped por usuario.
- `pools.listPools` → scoped (`by_user`, `user._id`). El catálogo global (`listPoolsInternal`) es
  `internalQuery`.
- `engineEvents.listEngineEvents`, `tradesHistory.listAllSignals`, `users.listUsersWithTradeLive`,
  `adminLive.*` → `requireAdmin`.
- `systemConfig.getConfig` → `requireAuth` + **allowlist** `PUBLIC_CONFIG_KEYS` (solo claves públicas).

### 7. `.env.example` sin valores reales — ✅ OK
- Todas las variables están VACÍAS (placeholders/comentarios). No hay secretos commiteados.

---

## Observaciones P2 (sin vulnerabilidad)

- **P2-1 — Esquema de id inconsistente en `spot_positions`.** `spot_positions`/`purchase_history` usan
  `identity.subject` (clerkId) como `userId`, mientras el resto del backend usa el `Id<"users">` de
  Convex. Está correctamente scoped (sin fuga), pero la inconsistencia puede confundir y dificultar
  joins. Recomendación: unificar al `Id<"users">` en una migración futura.
- **P2-2 — Cuentas admin = alto valor.** El admin bypassa permisos, tope de cobertura y suspensión.
  Es por diseño, pero implica que comprometer un admin compromete el portal. Recomendación: documentar
  que las cuentas admin deben tener MFA en Clerk y revisar `admin_logs` periódicamente (ya existe el
  audit trail de OBS-1).
_(Nota: el inicial P2-3 sobre `connectAccount`/`fetchUserRole` quedó RESUELTO tras verificación — ver abajo.)_

## Verificado en profundidad — `connectAccount` es FAIL-CLOSED (no es hallazgo)

`connectAccount` (`hlCredentialActions.ts:131`) valida el rol en Hyperliquid vía `fetchUserRole`
(`:105`) ANTES de insertar la credencial. Es fail-closed:
- `fetchUserRole` tiene timeout 10s; lanza si `!res.ok` y propaga cualquier error de `fetch`/abort
  (el `try/finally` solo limpia el timer, no captura) → **lanza ante cualquier fallo**.
- En `connectAccount` los `await fetchUserRole(...)` van ANTES de `encryptPrivateKey`/
  `insertAccountInternal`. Un fallo de red, un 5xx, o un 200 con JSON malformado (`role` undefined ≠
  "agent" → throw) ABORTAN sin insertar nada.
- Las validaciones exigen `agentRole.role === "agent"` Y `agentRole.data.user === tradingAddr` (HL
  confirma a quién pertenece el agente → no puedes atar la cuenta de otro) y `acctRole.role === "user"`.
- `insertAccountInternal` deduplica por `by_agent`/`by_trading_account` (unicidad global).

**Conclusión:** no se puede registrar una cuenta sin validar el rol en HL. Sin hallazgo.

---

## Notas de método
- Auditadas las 27 queries públicas, las mutations de `bots`/`users`/`hlCredentials`/`subscriptions`,
  y las 5 actions del motor. Auth verificada call-site por call-site.
- `connectAccount`/`fetchUserRole` SÍ verificado a fondo (fail-closed, arriba).
- Lo que NO se auditó en profundidad (candidato a fase posterior): el flujo de cifrado/rotación de
  claves (`hlCredentialActions.encryptPrivateKey`/`reencryptCredentials`/keyring) — la corrección
  criptográfica (modo AES-GCM, manejo de iv/authTag, rotación) merece una pasada dedicada.
