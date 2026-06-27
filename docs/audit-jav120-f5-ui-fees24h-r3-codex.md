# Auditoria Codex - JAV-120 F5 UI Fees 24h real r3

- Commit auditado: `6609c74` (`feat(jav120): F5 UI Fees 24h real (reemplaza estimacion pool-wide)`)
- Rama: `elcorreodejaviera/jav-120-fees-24h-real`
- Prompt: `docs/audit-prompt-jav120-f5-codigo.md`
- Alcance auditado: `src/components/BotPortal.jsx`
- Verificacion ejecutada: `npx vite build` OK
- Veredicto: **GO**

## Bloqueante

Sin hallazgos.

## Alto

Sin hallazgos.

## Medio

Sin hallazgos.

## Bajo

### 1. Caso mixto con valores desconocidos no explicita `acumulando` en el Summary

El selector de `Summary` ya corrige los dos NO-GO previos: no muestra `$0 Real` cuando no hay valores usables y no etiqueta como `Real + estimado` un agregado 100% estimado (`src/components/BotPortal.jsx:85-97`).

Queda una sutileza no bloqueante: si hay al mismo tiempo posiciones reales, estimadas y desconocidas, el subtitulo cae en `Real + estimado` sin mencionar que hay posiciones aun sin valor. El monto sigue siendo la suma de valores conocidos y no se presenta un estimado como real, por eso no lo considero bloqueante para F5. Como mejora de honestidad visual, podria usarse algo como `Real + estimado / acumulando` cuando `feesRealCount > 0 && feesEstCount > 0 && feesHasUnknown`.

`NetworkLiquidity` tiene una limitacion similar: muestra `-` si ninguna posicion de la red tiene valor usable, pero si hay algunos pools conocidos y otros desconocidos, muestra la suma conocida sin marcar parcialidad (`src/components/BotPortal.jsx:126-155`). Recomendacion menor: indicar `parcial` o `~` por red cuando `known.length < networkPools.length`.

## Checks positivos

- `poolFees24h(pool)` es la fuente unica para los fees 24h del usuario: real solo si `fees24hReal.status === 'ok'`; si no, fallback estimado concentrado con `fees1d * feeShareRatio`; `usd: null` si no hay base (`src/components/BotPortal.jsx:67-75`).
- `Summary` decide el subtitulo por conteo de reales/estimados/desconocidos. `Real` aparece solo con al menos una posicion medida y el caso 100% estimado queda como `Estimado` / `Estimado / acumulando` (`src/components/BotPortal.jsx:85-105`).
- `NetworkLiquidity` usa `poolFees24h` y ya no convierte ausencia total de dato en `$0` (`src/components/BotPortal.jsx:126-155`).
- No quedan referencias a `userFees1d`; el monto usuario `fees1d * (liquidity / tvl)` fue eliminado. El uso restante de `liquidity / tvl` es `userShare`, solo para subtitulo informativo, y el uso restante de `fees1d` en APR concentrado usa `feeShareRatio`, no prorrateo pool-wide (`src/components/BotPortal.jsx:445-467`).
- `PoolCard` etiqueta `Diario (real)` solo cuando `fees24h.real` es true; si no, muestra `Diario (est.)`, `~` en el valor estimado y proyecciones marcadas como `proy.` (`src/components/BotPortal.jsx:672-695`).
- `warming_up` comunica acumulacion de datos y muestra horas restantes cuando estan disponibles (`src/components/BotPortal.jsx:679-682`).
- El fetch de `getPoolFees24h` tiene TTL de 5 minutos, guarda por pool, borra el ref en `.catch` para reintentar, e inyecta `fees24hReal` con `fees24hData` incluido en dependencias del `useMemo` de `pools` (`src/components/BotPortal.jsx:3805-3840`, `src/components/BotPortal.jsx:3870-3921`).
- F5 no introduce cambios backend/engine/money-path; el cambio funcional auditado esta en `src/components/BotPortal.jsx`.

## Validacion

Comandos revisados/ejecutados:

- `git show --stat --oneline --decorate HEAD`
- `git diff HEAD^ HEAD -- src/components/BotPortal.jsx`
- `rg -n "function poolFees24h|feesRealCount|feesEstCount|feesHasUnknown|feesSub|userFees1d|fees1d \\*|liquidity / tvl|fees24hReal|getPoolFees24h|poolFees24h|Real \\(on-chain\\)|Real \\+ estimado|Estimado / acumulando|Sin datos" src/components/BotPortal.jsx`
- `npx vite build`

`npx vite build` finalizo correctamente. Solo aparecieron warnings conocidos de Rollup/dependencias sobre anotaciones `/*#__PURE__*/` y el chunk JS mayor a 500 kB.

## Veredicto final

**GO** para push/PR de F5. La observacion de severidad baja no bloquea la entrega; puede quedar como mejora de polish/claridad visual.
