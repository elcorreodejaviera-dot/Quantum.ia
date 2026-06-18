# Prompt de auditoría (Codex) — cleanups JAV-85 (#5-#10)

Audita el código (working tree). Cleanups de calidad/eficiencia, NO trading-logic. Archivos:
convex/executions.ts, convex/admin.ts, convex/schema.ts, convex/bugReports.ts, src/components/AdminView.jsx.

Cambios:
- **#7** `executions.ts`: `OPEN_MARGIN_STATES` y `ARM_OPEN_MARGIN_STATES` ahora `export const` (solo se añade
  `export`, sin cambiar valores/lógica). `admin.ts` los IMPORTA y se eliminaron las copias `EXEC_OPEN`/`ARM_OPEN`
  → fuente única (evita la divergencia que causó el bug #1).
- **#8** `admin.ts getSystemStats`: los escaneos por-estado (exec y arm) ahora con `Promise.all` (independientes)
  en vez de secuenciales. `status as any` en el `eq` porque el Set es `Set<string>` y el índice quiere el literal.
- **#5** `schema.ts`: nuevo índice `trigger_arms.by_filledAt = ["filledAt"]`. `admin.ts` volume de arms ahora usa
  `by_filledAt gte(prevSince)` (la ventana del escaneo coincide con la clave de imputación) en vez de `by_updated`
  desc + filtro; se descarta `filledAt==null`.
- **#9** `bugReports.countBugReportsByStatus`: `.collect()` → `.take(COUNT_CAP=1000)`; devuelve `{...counts, capped}`;
  el badge en AdminView muestra "N+" si capped.
- **#10b** `bugReports.setBugStatus`: lee el doc y fija `resolvedAt` SOLO al resolver por 1ª vez (no lo borra al
  reabrir ni lo pisa al re-resolver).
- **#10a** `AdminView.usd()`: signo antes del `$` ("-$1.5k").
- **#6** `AdminView`: `hlCoin(baseAsset)` (WETH→ETH, WBTC→BTC) antes de buscar PnL/cobertura por coin.

Responde GO/NO-GO:
1. ¿`export` de los Set + import en admin.ts es seguro (no arrastra lógica money-path) y los loops con
   `Promise.all` acumulan igual que antes? ¿`status as any` aceptable?
2. ¿El índice `by_filledAt` sobre un campo OPCIONAL es válido en Convex y `gte(prevSince)` excluye correctamente
   los arms sin `filledAt`? ¿El volume de arms queda igual o mejor que antes (sin perder fills en ventana)?
3. ¿`countBugReportsByStatus` con `take(1000)` + `capped` rompe algún consumidor? (AdminView usa `bugCounts.new`).
4. ¿`setBugStatus` preserva bien el histórico y no rompe ningún flujo (sigue permitiendo cambiar de estado)?
5. ¿`usd()` con signo y `hlCoin()` correctos? ¿algún caso donde baseAsset legítimo != coin HL no cubierto?
6. ¿Algún cambio toca inadvertidamente el money-path (reserva/arming/margen)? (No debería: executions.ts solo
   añade `export`.)
