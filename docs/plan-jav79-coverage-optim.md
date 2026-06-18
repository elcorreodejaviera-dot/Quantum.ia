# JAV-79 — Optimizar `consumedCoverageByPool`: evitar `collect()` de todo el historial

## En una frase

Hoy, para sumar la cobertura "viva" de un usuario, el sistema trae TODAS sus filas
históricas y filtra las cerradas en memoria. Esto corre en el path crítico de reserva/envío
(money-path). JAV-79 = leer **solo las filas vivas** desde el índice, sin cargar el historial.

## Qué hace hoy (problema)

`convex/coverageUsage.ts:consumedCoverageByPool` (líneas 26-63):

```ts
const arms = await ctx.db.query("trigger_arms")
  .withIndex("by_user_created", (q) => q.eq("userId", userId))   // ← TODO el historial del user
  .collect();
for (const a of arms) { if (ARM_TERMINAL.has(a.status)) continue; ... }  // filtra en memoria

const execs = await ctx.db.query("execution_requests")
  .withIndex("by_user_created", (q) => q.eq("userId", userId))   // ← TODO el historial del user
  .collect();
for (const r of execs) { if (EXEC_TERMINAL.has(r.status)) continue; ... }
```

- `by_user_created` indexa solo por `userId` → el `collect()` trae arms y ejecuciones de TODA
  la vida del usuario (incluidas terminales), y se descartan en memoria.
- Corre en el path crítico: `reserveArm`/`reserveExecution` (reserva) y los gates de envío
  (`coverageAdmissible` en `markSubmitting`/`gateBeforeOrder` y equivalentes de arm). 6 call-sites
  + lectura admin (`admin.ts:168`).
- Con historial grande: más latencia y más abortos por contención OCC en una mutation money-path.

## Estados (fuente: schema.ts)

- **`trigger_arms`** (12 estados): terminales = `disarmed`, `closed`, `failed` → **9 vivos**:
  `arming, submitting, armed, disarming, filled, protecting, protected, armed_lower_only, unknown`.
- **`execution_requests`** (8 estados): terminales = `closed`, `failed` → **6 vivos**:
  `pending, submitting, entry_filled, protected, sl_failed, unknown`.

(Las listas de terminales viven en `ARM_TERMINAL`/`EXEC_TERMINAL` en coverageUsage.ts — fuente única.)

## Opciones

### ✅ Opción A (RECOMENDADA) — índice compuesto `(userId, status)` + leer solo estados vivos

Añadir al schema:
- `trigger_arms`: `.index("by_user_status", ["userId", "status"])`
- `execution_requests`: `.index("by_user_status", ["userId", "status"])`

En `consumedCoverageByPool`, en vez de un `collect()` + filtro en memoria, iterar los estados
VIVOS y consultar cada uno por índice, acumulando en el mismo `map`.

**`ARM_LIVE`/`EXEC_LIVE` NO se escriben a mano** (un olvido = infra-conteo = fail-OPEN money-path).
Se derivan de un array EXHAUSTIVO `ALL_STATUSES as const` blindado por un **assert de tipos en
compilación** contra el tipo del schema (`Doc<"...">["status"]`), de modo que si el schema añade un
estado y el array no se actualiza, **`npm run typecheck` FALLA**:

```ts
import type { Doc } from "./_generated/dataModel";

type ArmStatus = Doc<"trigger_arms">["status"];
// Lista COMPLETA de estados (orden irrelevante). `satisfies` garantiza que solo contiene estados válidos.
const ARM_ALL_STATUSES = [
  "arming","submitting","armed","disarming","disarmed","filled","protecting",
  "protected","armed_lower_only","closed","failed","unknown",
] as const satisfies readonly ArmStatus[];
// Guard de EXHAUSTIVIDAD: si el schema añade un estado no listado, esto NO compila.
type _ArmExhaustive = Exclude<ArmStatus, typeof ARM_ALL_STATUSES[number]> extends never ? true : never;
const _armCheck: _ArmExhaustive = true; void _armCheck;

// LIVE = ALL − TERMINAL (un estado nuevo cae por defecto en "vivo" = fail-CLOSED: contar de más bloquea).
const ARM_LIVE = ARM_ALL_STATUSES.filter((s) => !ARM_TERMINAL.has(s));

for (const st of ARM_LIVE) {
  const rows = await ctx.db.query("trigger_arms")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", st))
    .collect();
  for (const a of rows) { /* misma validación hedge + map.set(max) que hoy */ }
}
// idem execution_requests: EXEC_ALL_STATUSES + _ExecExhaustive + EXEC_LIVE (6).
```

Doble propiedad de seguridad: (a) el assert de tipos impide que un estado del schema quede fuera de
`ALL_STATUSES`; (b) `LIVE = ALL − TERMINAL` hace que cualquier estado no marcado terminal cuente como
vivo por defecto → si alguna vez se colara un estado nuevo, el lado que toca es el SEGURO
(sobre-conteo → bloquea), nunca el peligroso (infra-conteo → deja pasar sobre el cap).

**Ventajas:**
- Lee **solo filas vivas** (no el historial). El nº de queries es CONSTANTE (9 + 6 = 15),
  independiente del tamaño del historial; cada una indexada y pequeña.
- **`status` sigue siendo la única fuente de verdad** → CERO estado derivado que mantener,
  CERO riesgo de desincronización. Es lo más seguro para money-path.
- Cambio contenido: solo `coverageUsage.ts` + 2 índices nuevos. No toca call-sites ni transiciones.

**Coste:** 2 índices nuevos (se backfillean solos, sin migración de datos) y derivar las listas
`ARM_LIVE`/`EXEC_LIVE` como complemento EXACTO de los terminales (defensa: que sea la unión del
schema menos los terminales, para que añadir un estado nuevo no se olvide → ver §Riesgos).

### Opción B — flag booleano `coverageLive` + índice `(userId, coverageLive)`

1 sola query por tabla, pero exige **mantener el flag en CADA transición de estado** (muchos
call-sites money-path). Si una transición olvida voltearlo → cuenta de menos/más cobertura =
riesgo de dinero (drift). **Descartada como primaria:** introduce estado derivado frágil donde
hoy no lo hay. Solo valdría la pena con volúmenes muy altos y un cron de reconciliación.

### Opción C — snapshot materializado `coverage_by_pool` por (userId, poolId)

Actualizar un agregado en cada transición. Aún más invasivo que B y mismo riesgo de drift.
Descartada salvo escala muy grande.

## Diseño detallado (Opción A)

1. **schema.ts:** añadir `by_user_status` a `trigger_arms` y `execution_requests`.
2. **coverageUsage.ts:**
   - Definir `ARM_ALL_STATUSES`/`EXEC_ALL_STATUSES` `as const satisfies readonly Doc<...>["status"][]`,
     cada uno con su **guard de exhaustividad por tipos** (`Exclude<Status, …[number]> extends never`)
     que rompe `typecheck` si el schema añade un estado no listado. Mantener `ARM_TERMINAL`/`EXEC_TERMINAL`
     como hoy y derivar `ARM_LIVE`/`EXEC_LIVE = ALL.filter(s => !TERMINAL.has(s))` (NUNCA arrays a mano).
   - Sustituir cada `collect()` de historial por el bucle de queries por estado vivo. La validación
     (`hedge` finito > 0; `poolId` presente en execs) y `map.set(key, max(...))` quedan IDÉNTICAS.
   - El throw `[blocked_config]` ante fila viva no cuantificable se mantiene (mismo fail-closed).
3. **Sin cambios** en `assertWithinPlanCoverage`/`coverageAdmissible` ni en los 6 call-sites:
   el contrato (Map<poolId, hedgeMax>) no cambia.

## Equivalencia de comportamiento (clave para money-path)

El resultado de `consumedCoverageByPool` debe ser **idéntico** al actual para cualquier estado:
mismas filas consideradas (las no-terminales), misma agregación (max por pool), mismos throws.
Solo cambia CÓMO se obtienen (índice por estado vs. collect+filtro). No cambia el cap ni la
admisión.

## Verificación

- `npm run typecheck` (tsc -p convex/tsconfig.json) — DEBE incluir compilar los guards de
  exhaustividad `_ArmExhaustive`/`_ExecExhaustive`. Verificación activa: añadir temporalmente un
  estado ficticio al `v.union` del schema y comprobar que `typecheck` FALLA (luego revertir) →
  prueba de que el guard realmente protege contra estados sin clasificar.
- Prueba de equivalencia: para un usuario con filas en varios estados (vivos y terminales), el `Map`
  resultante de la nueva implementación coincide EXACTAMENTE con el del algoritmo viejo
  (collect+filtro). Hacerlo comparando ambas en un script de QA antes de retirar la vieja.
- Deploy Convex (los índices se construyen automáticamente).

## Riesgos

- **Estado nuevo sin clasificar (ALTO si se descuida) — MITIGADO por diseño:** si el futuro añade un
  estado a `trigger_arms`/`execution_requests` y no se lista, la query por-estado no lo leería →
  cobertura infra-contada (fail-OPEN: dejaría pasar reservas sobre el cap). Doble defensa OBLIGATORIA
  (auditoría Codex, hallazgos ALTO #1 / MEDIO #2): (1) **guard de exhaustividad por tipos** sobre
  `ALL_STATUSES as const satisfies readonly Doc<...>["status"][]` → añadir un estado al schema sin
  listarlo rompe `typecheck` (no se puede desplegar el olvido); (2) **`LIVE = ALL − TERMINAL`** →
  un estado nuevo listado pero no clasificado como terminal cuenta como vivo por defecto (fail-CLOSED:
  sobre-conteo bloquea, nunca infra-conteo). Sin estos dos guards la Opción A NO es admisible en
  money-path.
- Nº de queries constante (15) — aceptable; si se quisiera reducir, agrupar por rangos contiguos del
  índice no es trivial en Convex (status es categórico), así que se deja en 15 reads pequeñas.

## Flujo

plan (este doc) → Codex GO plan → implementar → Codex GO código → PR → CodeRabbit → deploy.
NO urgente (Low): en beta el coste actual es mínimo y Codex ya dio GO al enfoque vigente; esto es
para cuando el volumen lo justifique.
