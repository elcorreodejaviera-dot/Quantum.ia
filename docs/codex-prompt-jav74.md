# Prompt para Codex — JAV-74 (Pieza 1 de la épica JAV-73)

Revisa este PLAN de JAV-74 (Quantum.ia, portal DeFi/Hyperliquid, Convex + React) ANTES
de implementar. Es la Pieza 1 de la épica JAV-73 (sistema de planes de cobertura). Dame
GO / NO-GO y, si NO-GO, hallazgos priorizados (P0/P1/P2).

## Contexto de la épica (JAV-73)
Hoy los planes de cobertura son cosméticos: viven hardcodeados en el frontend
(`src/components/BotPortal.jsx:21` array SUBSCRIPTIONS; `:675` SubscriptionBar con
`const current = SUBSCRIPTIONS[2]` → Pro $50k fijo para TODOS). No hay enforcement.
La épica los convierte en reales: cada usuario tiene un plan con un tope de cobertura
total, asignado a mano por el admin (Stripe luego), y el backend (Pieza 4, money-path,
issue aparte) bloqueará armar bots que superen el tope.

Métrica del tope (decisión del usuario): cobertura consumida = suma de `totalNotional`
de todos los bots activos del usuario, donde `totalNotional = liquidez_pool ×
(1 + bufferPct/100)` (idéntico a triggerEngine.ts:220). Ejemplo: pool $50k + buffer 100%
= $100k consumidos.

Planes/topes: Betatester $5k (GRATIS) · Starter $10k · Growth $20k · Pro $50k ·
Prime $100k · Vault $500k · Institutional $1M.

## Alcance EXACTO de JAV-74 (esta pieza — SIN money-path, solo datos + lectura)
NO incluye UI admin (Pieza 2/JAV-75), barra (Pieza 3/JAV-76) ni enforcement
(Pieza 4/JAV-77). Solo:

1. Schema `convex/schema.ts`, tabla `users`: añadir DOS campos opcionales (retrocompat,
   no rompe filas existentes):
   - `subscriptionPlan: v.optional(v.union(literales betatester|starter|growth|pro|
     prime|vault|institutional))` — ausente = sin plan.
   - `suspended: v.optional(v.boolean())` — el admin puede detener a un usuario.

2. Nuevo `convex/subscriptions.ts` como FUENTE ÚNICA del catálogo de planes:
   - `export const PLANS` (id, label, coverageCapUsd, priceUsd; Betatester priceUsd=0).
   - `getPlan(id): Plan | null` (undefined/desconocido → null).
   - Helper `viewFor(user)` → { plan, label, coverageCapUsd (0 si sin plan), suspended }.
   - `listPlans` (query, sin auth — catálogo público de producto).
   - `getMySubscription` (query, usuario autenticado; null si no hay sesión/usuario).
   - `getSubscriptionForUserInternal(userId)` (internalQuery, para el enforcement sin
     identidad del auto-rearm en Pieza 4).

## Invariantes / decisiones a validar
- Campos opcionales para no romper usuarios existentes ni `getOrCreateUser`.
- "Sin plan" => coverageCapUsd = 0 (la Pieza 4 lo interpretará como "no puede armar").
  ¿Es correcto que sin plan el tope sea 0 y no un default? (Sí: beta cerrada, admin asigna).
- El catálogo en backend debe ser la única fuente; el frontend (Pieza 3) consumirá
  `listPlans`/`getMySubscription`, eliminando el array hardcodeado.
- `getMySubscription` no debe requerir un permiso especial (cualquier usuario logueado ve
  su propio plan). `getSubscriptionForUserInternal` es internal (no expuesta al cliente).
- No se toca money-path, sizing, ni los límites beta ($500/$2k) — eso es JAV-77.

## Preguntas para Codex
1. ¿El modelado (plan en `users` vs tabla `subscriptions` aparte) es adecuado para esta
   fase, dado que Stripe (JAV-78) luego añadirá stripeCustomerId/expiry? ¿Conviene ya la
   tabla aparte o el campo en `users` es suficiente y migrable?
2. ¿Falta algún índice? (no parece: se lee por el `by_clerk_id` ya existente y por id).
3. ¿`coverageCapUsd = 0` para "sin plan" es la representación correcta, o mejor null +
   manejo explícito aguas abajo?
4. ¿Algún riesgo de exponer `listPlans` sin auth (incluye priceUsd)?

Verificación prevista: `npm run typecheck`.
