# Prompt de auditoría Codex — JAV-82 CÓDIGO (race de primer login, NO money-path)

Eres un auditor senior. Audita la **IMPLEMENTACIÓN** de JAV-82 (el plan ya recibió tu GO en
`docs/plan-jav82-race-login.md`). Revisa el diff de la rama `elcorreodejaviera/jav-82-race-primer-login`
(8 archivos en `convex/`), por ejemplo con:

```bash
git -C /home/bicho/Escritorio/Quantum.ia/Quantum.ia diff master...elcorreodejaviera/jav-82-race-primer-login -- convex/
```

Contexto: Quantum.ia, portal de bots de cobertura sobre Hyperliquid. Stack React+Vite (front),
Clerk (auth), Convex (backend). Cambio **NO money-path** (solo lecturas), pero toca un helper de
autorización compartido → vigila que NO se debilite el control de acceso en ninguna ruta.

## Qué se implementó

1. **`convex/helpers.ts`** — helper nuevo `getUserOrNull(ctx: QueryCtx)`: hace `requireAuth`
   (sin identidad sigue lanzando "Not authenticated") y devuelve el doc de `users` por
   `by_clerk_id` o `null` si aún no existe (race con `getOrCreateUser`, que corre en un
   `useEffect` posterior en `src/components/BotPortal.jsx:4111`). Tipado **SOLO `QueryCtx`** a
   propósito: imposible usarlo en mutations/actions por tipo.

2. **7 query handlers de lectura por-usuario** — sustituyen `const user = await requireUser(ctx);`
   por `const user = await getUserOrNull(ctx); if (!user) return [];` antes de cualquier
   `collect()`/`take()`:
   `hlCredentials.list`, `bots.listBots`, `wallets.listMyWallets`, `triggerArms.listMyActiveArms`,
   `tradesHistory.listSignals`, `alerts.listAlerts`, `alerts.listAlertHistory`.

Verificación ya hecha por el implementador: `npm run typecheck` (tsc -p convex/tsconfig.json) EXIT 0;
`grep -rn getUserOrNull convex/` = 1 definición + 7 usos, todos dentro de bloques `query({`
(ninguno en mutation/action).

## Responde GO / NO-GO con hallazgos numerados (ALTO/MEDIO/BAJO). Presiona en:

1. **Conformidad con el plan aprobado:** ¿el código implementa EXACTAMENTE lo acordado (helper
   `QueryCtx`-only, las 7 queries y solo esas, early-return `[]`)? ¿Algún desvío respecto al plan?

2. **Helper de autorización:** ¿`getUserOrNull` es correcto? ¿`requireAuth(ctx)` con `ctx: QueryCtx`
   compila y conserva la semántica "sin identidad → lanza"? ¿La firma `QueryCtx` realmente impide
   por tipo su uso en cualquier mutation/action (no hay forma de colarlo)? ¿`requireUser`/
   `requireAdmin`/`requireBotManager`/`requireTradeLive` quedan INTACTOS y estrictos?

3. **Multi-tenancy / fail-closed:** en cada una de las 7 queries, ¿el `if (!user) return []` corta
   ANTES de cualquier acceso a datos y NO hay ningún camino que llegue al `collect`/`take`/`map`
   sin el filtro `by_user`/`userId === user._id`? Revisa especialmente `listMyActiveArms` (que
   además filtra `arm.userId === user._id`) y `wallets.listMyWallets` (`ownerId = user._id.toString()`).

4. **Contrato de retorno con el front:** devolver `[]` — ¿es compatible con TODOS los consumos en
   `BotPortal.jsx`? ¿Algún consumidor distingue `undefined` (cargando) de `[]` (vacío) y se
   comportaría mal al recibir `[]` durante el race? ¿`listSignals` (que hacía `.take`) y
   `listMyActiveArms` (que arma un array tipado) mantienen un tipo de retorno consistente con `[]`?

5. **Que NO se haya tocado de más:** ¿alguna mutation o ruta money-path quedó accidentalmente con
   `getUserOrNull` o perdió su `requireUser`? ¿Los imports añadidos no rompen nada ni dejan
   `requireUser` sin usar (cada archivo lo sigue usando en sus mutations)?

6. **Regresión sutil:** ¿algún efecto en `coverageUsage`/enforcement, crons, o auto-rearm que lea
   estas queries indirectamente? (No deberían: son queries públicas de UI; el enforcement usa
   helpers internos por `userId`.) Confírmalo.

Cita archivo:línea del diff. Si NO-GO, lista EXACTAMENTE qué cambiar para el GO. Si GO, dilo
explícitamente para proceder a commit → PR → CodeRabbit → deploy.
