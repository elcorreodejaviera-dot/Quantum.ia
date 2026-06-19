# JAV-82 — Race de primer login: queries por-usuario lanzan "User not found"

## Problema (confirmado en código)

En el primer load de un usuario recién creado, las queries de lectura por-usuario
montan ANTES de que el `useEffect` de `DashboardWithClerk` (BotPortal.jsx:4111)
ejecute `getOrCreateUser`. Esas queries hacen `requireUser` (`convex/helpers.ts:20`),
que con identidad presente pero doc Convex ausente lanza `Uncaught Error: User not found`
→ Server Error en consola + posible parpadeo del ErrorBoundary.

Tras el cutover Clerk DEV→PROD (JAV-83) **todos** se re-registran, así que el primer
login afecta a todos los usuarios actuales → sube la prioridad.

## Alcance EXACTO (no money-path)

Solo **queries de lectura por-usuario** que montan en el portal y hoy lanzan vía
`requireUser`. Confirmadas con grep de `useQuery(...)` en `src/components/BotPortal.jsx`:

| Query Convex                         | Handler            | Devuelve si user ausente |
|--------------------------------------|--------------------|--------------------------|
| `hlCredentials.list`                 | hlCredentials.ts:12| `[]`                     |
| `bots.listBots`                      | bots.ts:51         | `[]`                     |
| `wallets.listMyWallets`              | wallets.ts:44      | `[]`                     |
| `triggerArms.listMyActiveArms`       | triggerArms.ts:839 | `[]`                     |
| `tradesHistory.listSignals`          | tradesHistory.ts:111| `[]`                    |
| `alerts.listAlerts`                  | alerts.ts:5        | `[]`                     |
| `alerts.listAlertHistory`            | alerts.ts:59       | `[]`                     |

Ya toleran user ausente (NO se tocan): `users.getUser`, `subscriptions.getMySubscription`,
`subscriptions.listPlans`.

### Queries por-usuario REVISADAS y EXCLUIDAS (montan al inicio pero NO sufren el race)

Documentadas para cerrar el alcance (auditoría Codex, hallazgo BAJO #2):

| Query                       | Por qué NO se toca                                                        |
|-----------------------------|--------------------------------------------------------------------------|
| `pools.listPools`           | Ya hace `if (!user) return []` (pools.ts:15) — sin doc → `[]`.            |
| `users.getUserPermissions`  | Ya hace `if (!user) return []` (users.ts:127) — sin doc → `[]`.          |
| `spot_positions.listMyPositions` | Indexa por `identity.subject` directo (spot_positions.ts:11), NO consulta el doc Convex → no toca el race. |
| `users.getUser` / `subscriptions.getMySubscription` / `subscriptions.listPlans` | Ya devuelven `null`/datos públicos sin doc user. |
| Queries admin (`requireAdmin`) | Un usuario recién creado no es admin; la pestaña Admin está gated.     |

## NO se toca

- **Todas las mutations** y money-path: siguen con `requireUser` ESTRICTO (debe fallar
  si no hay user). Crear bot, conectar cuenta, revocar, ejecutar, etc.
- **Queries admin** (`requireAdmin`): un usuario recién creado NO es admin; la pestaña
  Admin está gated. Sin cambios.
- `requireUser`/`requireAdmin`/`requireBotManager`/`hasPermission` siguen igual.

## Diseño

### 1. Helper nuevo en `convex/helpers.ts`

```ts
// Para LECTURAS por-usuario que montan en el primer login: si hay sesión Clerk pero el
// doc de Convex aún no existe (race con getOrCreateUser), devuelve null en vez de lanzar.
// Sigue exigiendo identidad (sin sesión → "Not authenticated", error real).
// SOLO QueryCtx: imposible de usar en mutations/money-path por tipo (ahí requireUser debe fallar).
export async function getUserOrNull(ctx: QueryCtx) {
  const identity = await requireAuth(ctx);
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .first();
}
```

Decisión (auditoría Codex, hallazgo MEDIO #1): el helper se tipa **`ctx: QueryCtx`**, NO
`QueryCtx | MutationCtx`. Es un helper de autorización compartido (`requireUser` respalda
`requireAdmin`/`requireBotManager`/`requireTradeLive`), así que la salvaguarda debe ser por
TIPO, no por comentario: el compilador rechaza usarlo en cualquier mutation. `requireAuth`
acepta `QueryCtx` (su firma es `QueryCtx | MutationCtx | ActionCtx`), así que compila.

Decisión: mantiene `requireAuth` (sin identidad sigue lanzando "Not authenticated"),
porque eso NO es el race: es ausencia de sesión, un error legítimo. El race es
identidad presente + doc ausente, único caso que pasa a devolver null.

### 2. Cada una de las 7 queries

Sustituir `const user = await requireUser(ctx);` por:

```ts
const user = await getUserOrNull(ctx);
if (!user) return [];   // race de primer login: aún sin doc Convex
```

El resto del handler (filtro `by_user` + `collect`/map) queda igual.

## Verificación

- `npm run typecheck` (solo cambian archivos en `convex/`).
- **Uso acotado del helper (auditoría Codex, hallazgo BAJO #3):** confirmar que
  `getUserOrNull` aparece SOLO en las 7 query handlers objetivo y NUNCA en
  mutations/actions/internal/money-path:
  ```bash
  grep -rn "getUserOrNull" convex/   # esperado: 1 definición en helpers.ts + 7 usos en
                                     # hlCredentials/bots/wallets/triggerArms/tradesHistory/alerts(×2)
  ```
  (La firma `ctx: QueryCtx` ya lo blinda por tipo; el grep es verificación redundante.)
- El front ya hace `?? []` en la mayoría de los consumos; devolver `[]` es compatible
  con todos (revisado: 67/319/771/2448/2629/2817/3592/3611/3612/3640/3643/3644).
- Deploy Convex tras GO.

## Riesgos

- Bajo. Solo cambia el comportamiento en el instante del race (antes: error; ahora:
  lista vacía que se rellena al re-ejecutarse la query cuando existe el user).
- No afecta multi-tenancy (el filtro `by_user` sigue intacto; user null → no hay datos
  que filtrar).

## Flujo

plan (este doc) → Codex GO plan → implementar → Codex GO código → PR → CodeRabbit → deploy.
