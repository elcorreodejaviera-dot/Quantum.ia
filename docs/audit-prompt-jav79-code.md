# Prompt de auditoría Codex — JAV-79 CÓDIGO (optimizar consumedCoverageByPool, MONEY-PATH)

Eres un auditor senior de código money-path. Audita la **IMPLEMENTACIÓN** de JAV-79 (el plan ya
recibió tu GO en `docs/plan-jav79-coverage-optim.md`). Revisa el diff de la rama
`elcorreodejaviera/jav-79-coverage-optim` (2 archivos en `convex/`), por ejemplo con:

```bash
git -C /home/bicho/Escritorio/Quantum.ia/Quantum.ia diff master...elcorreodejaviera/jav-79-coverage-optim -- convex/
```

Contexto: Quantum.ia, portal de bots de cobertura sobre Hyperliquid; capital real (mainnet beta).
`consumedCoverageByPool` decide si una nueva reserva/orden cabe en el tope de cobertura del plan →
correctitud = dinero. La optimización NO debe cambiar el resultado, solo cómo se obtiene.

## Qué se implementó

1. **`convex/schema.ts`** — índice nuevo `by_user_status` = `["userId","status"]` en `trigger_arms`
   y en `execution_requests` (los demás índices intactos).

2. **`convex/coverageUsage.ts`**:
   - `import type { Doc, Id }` (antes solo `Id`).
   - `ARM_ALL_STATUSES`/`EXEC_ALL_STATUSES` `as const satisfies readonly Doc<...>["status"][]` con
     **guards de exhaustividad por tipos** (`type _ArmExhaustive = Exclude<ArmStatus, …[number]>
     extends never ? true : never; const _armCheck: _ArmExhaustive = true; void _armCheck;` e idem
     exec). Probado: añadir un estado al schema sin listarlo → `typecheck` FALLA
     (`coverageUsage.ts: Type 'boolean' is not assignable to type 'never'`).
   - `ARM_LIVE`/`EXEC_LIVE = ALL.filter(s => !TERMINAL.has(s))` (derivados, nunca a mano).
   - `consumedCoverageByPool`: en vez de `collect()` de todo el historial por `by_user_created` +
     filtro en memoria, ahora itera `ARM_LIVE`/`EXEC_LIVE` y consulta cada estado por
     `by_user_status` (`q.eq("userId",userId).eq("status",st)`), acumulando en el mismo
     `Map<string,number>`. Validación de `hedge` (finito > 0), check de `poolId` en execs, y
     `map.set(key, max(...))` quedan IDÉNTICOS, igual que los throws `[blocked_config]`.
   - `assertWithinPlanCoverage` y `coverageAdmissible` NO se tocaron.

Verificación hecha por el implementador: `npm run typecheck` EXIT 0; prueba activa del guard
(estado ficticio → falla; revertido → pasa). 2 archivos, +62/−28.

## Responde GO / NO-GO con hallazgos numerados (ALTO/MEDIO/BAJO). Presiona en:

1. **Equivalencia EXACTA del resultado:** ¿el `Map` que produce la nueva implementación es idéntico
   al del algoritmo anterior para TODO caso? Recorre: ¿`ARM_LIVE`/`EXEC_LIVE` cubren EXACTAMENTE los
   no-terminales? ¿`unknown` (vivo en ambas) se incluye? ¿Alguna fila contada dos veces o ninguna
   (un arm no puede tener dos status a la vez → no hay solape entre queries por-estado)?

2. **Guard de exhaustividad:** ¿el patrón `as const satisfies readonly Doc<...>["status"][]` +
   `Exclude<...> extends never` realmente rompe el build si el schema añade un estado no listado?
   ¿Cubre AMBAS direcciones que importan (estado del schema ausente del array)? ¿El `void _armCheck`
   evita el warning de "variable sin usar" sin desactivar el chequeo? ¿`Doc<>` resuelve al union del
   schema (no a `string`)?

3. **Fail-closed de LIVE = ALL − TERMINAL:** confirma que un estado nuevo (listado en ALL pero no en
   TERMINAL) cae en LIVE por defecto → sobre-conteo (bloquea), nunca infra-conteo (dejar pasar sobre
   el cap). ¿`ARM_TERMINAL`/`EXEC_TERMINAL` siguen siendo la fuente única de "terminal"?

4. **Índice y consistencia:** ¿`by_user_status` está bien declarado y es el que usan las queries?
   ¿Dentro de la mutation las |LIVE| lecturas ven un snapshot consistente (sin doble/cero conteo de
   una fila a mitad de transición entre queries)? ¿El nuevo índice agrava la contención OCC de
   escritura en `trigger_arms`/`execution_requests` (más rangos tocados al patch de status)?

5. **Idempotencia del gate preservada:** `assertWithinPlanCoverage` (línea ~85) sigue haciendo
   `post.set(key, max(existente, hedge))`. ¿La semántica idempotente del gate de envío se mantiene
   intacta con el nuevo conteo?

6. **Nada de más:** ¿se tocó SOLO `coverageUsage.ts` + 2 índices? ¿Algún call-site, cron o lectura
   admin (`admin.ts:168`) afectado por el cambio de firma/comportamiento? (No debería: el contrato
   `Map` no cambia.) ¿El `import` de `Doc` no rompe nada?

7. **Rendimiento real:** ¿15 queries indexadas pequeñas son efectivamente mejores que 2 collects de
   historial en el caso que motiva la tarea (historial grande)? ¿Algún patológico (usuario con miles
   de filas vivas en un mismo estado) que siga siendo costoso? (Aceptable como diferible, pero
   señálalo.)

Cita archivo:línea del diff. Si NO-GO, lista EXACTAMENTE qué cambiar. Si GO, dilo explícitamente para
proceder a commit → PR → CodeRabbit → deploy.
