# Auditoria Codex - JAV-120 F5 UI Fees 24h real

- Commit auditado: `a4f1297` (`feat(jav120): F5 UI Fees 24h real (reemplaza estimacion pool-wide)`)
- Prompt: `docs/audit-prompt-jav120-f5-codigo.md`
- Alcance revisado: `src/components/BotPortal.jsx`
- Verificacion ejecutada: `npx vite build` OK
- Veredicto: **NO-GO**

## Alto

### 1. El resumen puede mostrar `$0` como `Real (on-chain)` cuando no hay dato real ni estimado

`poolFees24h(pool)` devuelve correctamente `{ usd: null, real: false, status: 'unavailable' }` cuando todavia no hay lectura backend `ok` ni base para estimar por `feeShareRatio` (`src/components/BotPortal.jsx:67-75`). El problema aparece en el agregado de `Summary`: si `f.usd == null`, el pool se ignora y no marca `anyEstimate` (`src/components/BotPortal.jsx:84-90`). Luego el subtitulo se decide solo con `anyEstimate`, por lo que el caso "todos los pools sin dato" termina en `formatUsd(0)` + `Real (on-chain)` (`src/components/BotPortal.jsx:98`).

Escenario reproducible por lectura de codigo:

1. `poolsFromDb` ya tiene pools.
2. `fees24hData[p._id]` aun es `null` o el backend devuelve `warming_up` / `unavailable`.
3. `positionData[p._id]` aun no llego, o `feeShareRatio` es `null` por `out_of_range` / dato no disponible.
4. `poolFees24h(pool)` devuelve `usd: null`.
5. `Summary` suma `0` y muestra `Real (on-chain)`.

Esto viola el requisito central de F5: la UI no debe presentar datos estimados, incompletos o ausentes como reales. Tambien puede inducir una lectura financiera incorrecta: el usuario ve `$0` real cuando en realidad el sistema no pudo medir ni estimar los fees 24h.

La misma raiz existe en `NetworkLiquidity`, que colapsa `null` a `0` con `(f.usd ?? 0)` (`src/components/BotPortal.jsx:123-127`). Aunque ahi no aparece el subtitulo `Real (on-chain)`, sigue mostrando cero para redes con datos desconocidos.

Correccion esperada:

- Separar tres estados agregados: `allReal`, `mixedEstimated`, `unknown`.
- Marcar como no-real tambien los pools con `usd == null`.
- Si no hay ningun valor usable, mostrar `-` / `Sin datos` / `Acumulando`, no `$0 Real (on-chain)`.
- En redes, evitar convertir `null` a `0` sin estado visible.

Ejemplo de criterio:

```js
const parts = pools.map(poolFees24h);
const known = parts.filter((f) => f.usd != null);
const fees = known.reduce((sum, f) => sum + f.usd, 0);
const hasUnknown = known.length < parts.length;
const allReal = parts.length > 0 && parts.every((f) => f.real);
const sub = allReal ? 'Real (on-chain)' : hasUnknown ? 'Parcial / acumulando' : 'Real + estimado';
```

## Medio

Sin hallazgos adicionales.

## Bajo

Sin hallazgos adicionales.

## Checks positivos

- `PoolCard` usa `poolFees24h(pool)` y etiqueta la base diaria como `real on-chain` solo cuando `fees24h.real` viene de `status === 'ok'` (`src/components/BotPortal.jsx:447-448`, `src/components/BotPortal.jsx:670-683`).
- No queda el calculo legacy `userFees1d`.
- No encontre el prorrateo pool-wide de usuario `fees1d * (liquidity / tvl)` para Fees 24h; `userShare` queda solo como subtitulo informativo (`src/components/BotPortal.jsx:442-444`, `src/components/BotPortal.jsx:670-671`).
- El fetch de `getPoolFees24h` esta cableado con TTL de 5 minutos y guarda el resultado por pool (`src/components/BotPortal.jsx:3799-3833`, `src/components/BotPortal.jsx:3883-3884`).
- El commit no introduce cambios backend en F5; el cambio funcional esta en `src/components/BotPortal.jsx`.

## Validacion

`npx vite build` finalizo correctamente. Solo aparecieron warnings existentes/de empaquetado sobre anotaciones `/*#__PURE__*/` en dependencias `ox` y el chunk JS mayor a 500 kB.

## Veredicto final

**NO-GO** para push/PR de F5 hasta corregir el estado agregado de `Fees 24h (tu parte)` y `Liquidez diaria por red` para que datos ausentes/parciales nunca se muestren como `$0 Real (on-chain)`.
