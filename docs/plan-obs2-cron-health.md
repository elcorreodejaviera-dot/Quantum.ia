# OBS-2 — Health/heartbeat de los crons

## En una frase

Hoy si un cron (incluida la reconciliación money-path cada minuto) empieza a fallar, nadie se
entera. OBS-2 = que cada cron registre cuándo corrió, si tuvo éxito y el último error, visible en
el panel admin.

## Problema (verificado)

6 crons en `crons.ts`, ninguno registra estado:
- `fetch DeFiLlama APY` (5 min), `fetch Uniswap V3 subgraph` (30 min), `check pool closures` (10 min)
- `reconcile HL executions` (1 min) — **money-path**
- `reconcile pool arms` (1 min) — **money-path**
- `process bot rearms` (1 min) — **money-path**

`grep lastRun/lastError/heartbeat` en `convex/` → 0 resultados. No hay observabilidad de fallos.
Si `reconcileStaleExecutions`/`reconcileStaleArms` empieza a lanzar, el margen colgado o los arms
sin reconciliar se acumulan sin señal hasta un fallo visible.

## Alcance (NO money-path; additivo)

Tabla de salud + registro inicio/fin/error por cron + lectura en el panel admin. No cambia la
lógica de ningún cron, solo lo envuelve para observar.

## Diseño

### 1. Tabla `cron_health` (schema.ts)

```ts
cron_health: defineTable({
  name: v.string(),                 // nombre del cron
  lastStartedAt: v.optional(v.number()),
  lastSuccessAt: v.optional(v.number()),
  lastErrorAt: v.optional(v.number()),
  lastError: v.optional(v.string()),// mensaje (truncado), SIN datos sensibles
  lastDurationMs: v.optional(v.number()),
  consecutiveFailures: v.optional(v.number()),
}).index("by_name", ["name"]),
```

### 2. Mutations internas de registro

```ts
// internal: upsert por name
recordCronStart(name)            // setea lastStartedAt
recordCronSuccess(name, durMs)   // lastSuccessAt + lastDurationMs + consecutiveFailures=0
recordCronError(name, durMs, msg)// lastErrorAt + lastError + consecutiveFailures++
```

### 3. Instrumentar cada cron target — HEALTH BEST-EFFORT (auditoría Codex, hallazgo ALTO #1)

⚠️ **La salud NUNCA debe poder romper un cron money-path.** Los 3 reconciliadores corren a 1/min y
mueven la convergencia del motor: si la escritura en `cron_health` fallara y abortara el cron, sería
PEOR que no tener observabilidad. Por eso cada escritura de health va envuelta en su propio try/catch
y **se ignora si falla** (solo `console.warn`); y el error REAL del cuerpo siempre se re-lanza intacto.

Los 6 targets actuales son **internal actions** (`reconcileStaleExecutions`, `reconcileStaleArms`,
`processRearms`, `fetchAndUpdateApys`, `fetchUniswapSubgraphData`, `checkAllPoolClosures`). Se
instrumentan **dentro de cada action** (no se añade una capa de wrapper que cambie la firma que
`crons.ts` referencia). Patrón:

```ts
// helper best-effort: nunca lanza
async function safeHealth(ctx, fn: () => Promise<void>) {
  try { await fn(); } catch (e) { console.warn("[cron_health] write failed", String(e).slice(0,200)); }
}

const t0 = Date.now();
await safeHealth(ctx, () => ctx.runMutation(internal.cronHealth.recordCronStart, { name }));
try {
  const result = /* ... cuerpo actual del cron, SIN cambios ... */;
  await safeHealth(ctx, () => ctx.runMutation(internal.cronHealth.recordCronSuccess, { name, durMs: Date.now()-t0 }));
  return result;  // conservar el retorno del body si lo hubiera
} catch (e) {
  await safeHealth(ctx, () => ctx.runMutation(internal.cronHealth.recordCronError, { name, durMs: Date.now()-t0, msg: String(e).slice(0,300) }));
  throw e;  // SIEMPRE re-lanzar el error ORIGINAL: no enmascarar el fallo, solo registrarlo best-effort
}
```

Reglas (Codex):
- **start/success/error son best-effort:** si falla la escritura de health, `console.warn` y continuar.
  Un cron que tuvo éxito NUNCA se convierte en fallo por culpa del health.
- **El error del cuerpo siempre se re-lanza** (intacto), tras intentar `recordCronError` best-effort.
- Se **conserva el retorno** del cuerpo si lo tiene.

**Variante elegida (Codex permitió ambas): WRAPPERS, no cirugía en los reconciliadores.** En vez de
operar dentro de cada uno de los 6 internal actions money-path, `crons.ts` apunta a **6 wrapper
internalActions** en `cronHealth.ts`; cada wrapper aplica `withCronHealth(ctx, name, () =>
ctx.runAction(internal.<real>, {}))`. Ventaja: los cuerpos money-path (`reconcileStaleExecutions`,
`reconcileStaleArms`, `processRearms`, etc.) quedan **INTACTOS** (menor riesgo); el health vive
centralizado en un solo módulo. `withCronHealth` aplica el patrón best-effort de arriba y re-lanza el
error original; conserva el valor de retorno del cron real.

### 4. Lectura en panel admin

Query admin-only `listCronHealth` (todas las filas) + tarjeta en AdminView: por cron, último éxito
(hace cuánto), si está "atrasado" (lastSuccessAt > 2× su intervalo → ⚠️), fallos consecutivos y
último error. Base para una alerta futura.

## Verificación

- `npm run typecheck`.
- Tras un ciclo: `cron_health` tiene una fila por cron con `lastSuccessAt` reciente.
- Forzar un error en un cron de prueba → `lastError`/`consecutiveFailures` se actualizan y la
  excepción se sigue propagando (el cron sigue "fallando" de verdad, solo que ahora visible).

## Riesgos

- Bajo. Cada cron hace 2 escrituras extra (start/end) — coste despreciable a 1/min.
- **La salud es best-effort y NUNCA bloquea el cron** (Codex ALTO #1): un fallo escribiendo
  `cron_health` se traga con `console.warn`; el cuerpo del cron y su error real son intocables.
- No tragar el error DEL CUERPO (re-throw siempre) para no ocultar fallos reales del motor.
- Tabla `cron_health` distinta de las money-path → sin contención OCC con el cuerpo del cron.

## Flujo

plan → Codex GO → implementar → Codex GO código → PR → CodeRabbit → deploy. Prioridad MEDIA.
