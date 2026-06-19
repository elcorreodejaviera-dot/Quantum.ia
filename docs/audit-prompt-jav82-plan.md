# Prompt de auditoría Codex — JAV-82 PLAN (race de primer login, NO money-path)

Eres un auditor senior. Audita el **PLAN** `docs/plan-jav82-race-login.md` (aún NO hay código).
Contexto: Quantum.ia, portal de bots de cobertura sobre Hyperliquid. Stack: React + Vite (front),
Clerk (auth), Convex (backend/DB/queries). Este cambio es **NO money-path** (solo lecturas), pero
toca un helper de autorización compartido, así que hay que vigilar que no se debilite el control de
acceso en ninguna ruta.

**Problema:** en el primer load de un usuario recién creado, las queries de lectura por-usuario montan
ANTES de que el `useEffect` de `DashboardWithClerk` (`src/components/BotPortal.jsx:4111`) ejecute
`getOrCreateUser`. Esas queries llaman `requireUser` (`convex/helpers.ts:20`), que con identidad Clerk
presente pero doc Convex aún ausente lanza `Uncaught Error: User not found` → Server Error + posible
parpadeo del ErrorBoundary. Se auto-resuelve al re-ejecutarse la query cuando existe el user. Tras el
cutover Clerk DEV→PROD (JAV-83) **todos** se re-registran → afecta el primer login de todos.

**Tesis del plan:** distinguir dos estados que hoy `requireUser` colapsa en un solo throw:
(a) **sin identidad** = error legítimo ("Not authenticated"), debe seguir lanzando; (b) **identidad
presente, doc Convex ausente** = el race transitorio, sólo en LECTURAS debe devolver vacío en vez de
lanzar. Se introduce `getUserOrNull(ctx)` (mantiene `requireAuth`, devuelve `null` sólo en el caso b)
y se aplica `if (!user) return []` a las 7 queries de lectura por-usuario que montan en el portal:
`hlCredentials.list`, `bots.listBots`, `wallets.listMyWallets`, `triggerArms.listMyActiveArms`,
`tradesHistory.listSignals`, `alerts.listAlerts`, `alerts.listAlertHistory`. **Todas las mutations y
el money-path conservan `requireUser` ESTRICTO.** Las queries admin (`requireAdmin`) NO se tocan.

Archivos clave existentes: `convex/helpers.ts` (`requireAuth`, `requireUser`, `requireAdmin`,
`requireBotManager`, `hasPermission`), `convex/hlCredentials.ts`, `convex/bots.ts`, `convex/wallets.ts`,
`convex/triggerArms.ts`, `convex/tradesHistory.ts`, `convex/alerts.ts`, y los consumos en
`src/components/BotPortal.jsx` (líneas 67/319/771/2448/2629/2817/3592/3611/3612/3640/3643/3644).

Responde **GO / NO-GO** con hallazgos numerados (ALTO/MEDIO/BAJO). Presiona especialmente:

1. **Fuga de autorización:** ¿el listado de 7 queries es EXHAUSTIVO y CORRECTO? ¿Alguna de ellas, pese
   a "ser de lectura", expone datos sensibles donde devolver `[]` en el race sea peor que el error
   (p.ej. enmascarar un fallo real de auth)? ¿Falta alguna query por-usuario que también monte al inicio
   y siga lanzando (revisar todo `requireUser` en queries vs mutations)?

2. **`getUserOrNull` no debe relajar mutations ni money-path:** ¿hay riesgo de que alguien reutilice el
   helper en una mutation y un user `null` derive en una escritura sin dueño o un bypass de
   multi-tenancy? ¿Conviene una salvaguarda (naming, comentario, o tipo) para que `getUserOrNull` sólo
   se use en reads? ¿`requireUser`/`requireAdmin`/`requireBotManager` quedan intactos?

3. **Multi-tenancy:** con `user === null` y `return []`, ¿se garantiza que NUNCA se devuelven datos de
   otro usuario? (El filtro `by_user` desaparece al cortar antes; confirmar que el early-return es la
   única salida y no hay camino que siga al `collect` sin filtro.)

4. **Semántica de "no autenticado":** mantener `requireAuth` dentro de `getUserOrNull` (sin identidad →
   sigue lanzando "Not authenticated"). ¿Es lo correcto, o alguna de estas queries debería tolerar
   también la ausencia total de sesión? ¿El front gatea ya por `useConvexAuth` de modo que el caso sin
   identidad no se da en estas 7? ¿Riesgo de enmascarar tokens caducados como "race"?

5. **Contrato con el front:** devolver `[]` (lista vacía) — ¿es compatible con TODOS los consumos
   (varios usan `?? []`, otros no)? ¿Algún consumidor distingue `undefined` (cargando) de `[]` (vacío)
   y rompería al recibir `[]` antes de tiempo? ¿`triggerArms.listMyActiveArms`/`tradesHistory.listSignals`
   devuelven array en todos sus paths actuales (que `[]` no choque con una forma de retorno distinta)?

6. **Alternativa Opción B (front `'skip'`):** ¿es preferible gatear en el front con `'skip'` hasta que
   `useQuery(api.users.getUser)` exista, en vez de tocar el backend? Compara: superficie de cambio,
   robustez ante nuevas queries, y si deja el backend aún lanzando para otros clientes. Recomienda.

7. **Alcance / CLAUDE.md:** ¿el plan respeta "no mezclar refactor amplio con lógica de trading" y toca
   sólo lo necesario? ¿`getUserOrNull` es la mínima superficie, o hay un patrón más simple?

Cita líneas del plan. Si NO-GO, lista EXACTAMENTE qué cambiar para el GO.
