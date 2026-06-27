# Auditoria Codex - JAV-120 F5 UI Fees 24h real r2

- Commit auditado: `ac1e33f` (`feat(jav120): F5 UI Fees 24h real (reemplaza estimacion pool-wide)`)
- Rama: `elcorreodejaviera/jav-120-fees-24h-real`
- Prompt: `docs/audit-prompt-jav120-f5-codigo.md`
- Alcance auditado: `src/components/BotPortal.jsx`
- Verificacion ejecutada: `npx vite build` OK
- Veredicto: **NO-GO**

## Bloqueante

Sin hallazgos.

## Alto

### 1. Summary aun puede etiquetar como `Real + estimado` un agregado 100% estimado

El NO-GO previo de `$0 Real (on-chain)` esta corregido: si no hay ningun valor usable, `Summary` muestra `-` / `Sin datos aun` (`src/components/BotPortal.jsx:85-94`), y `NetworkLiquidity` ya no colapsa el caso "ningun dato" a `$0` (`src/components/BotPortal.jsx:129-152`).

Pero el nuevo selector de subtitulo no distingue entre "mezcla real + estimado" y "todo estimado":

```js
const feesSub = feesKnown.length === 0 ? 'Sin datos aun'
  : feesAllReal ? 'Real (on-chain)'
  : feesHasUnknown ? 'Parcial / acumulando'
  : 'Real + estimado';
```

Evidencia:

- `poolFees24h(pool)` devuelve `real: false` con `usd` estimado cuando no hay backend `ok` pero si hay `feeShareRatio` y `fees1d` (`src/components/BotPortal.jsx:67-75`).
- Si todas las posiciones estan en ese estado estimado, entonces `feesKnown.length > 0`, `feesAllReal === false` y `feesHasUnknown === false` (`src/components/BotPortal.jsx:85-94`).
- Resultado: `Summary` muestra un valor compuesto solo por estimaciones bajo el subtitulo `Real + estimado`.

Ese escenario es probable durante el rollout con `<24h` de snapshots: cada `PoolCard` puede estar en `Diario (est.)` por `warming_up`, pero el resumen superior pasa a decir `Real + estimado` aunque no exista ningun componente real. Esto viola el criterio de honestidad de labels: un valor estimado no debe presentarse como real ni como mezcla con real si no hay ningun valor real.

Correccion esperada:

- Calcular tambien `feesHasReal = feesKnown.some((f) => f.real)` y `feesHasEstimate = feesKnown.some((f) => !f.real)`.
- Usar `Real + estimado` solo si `feesHasReal && feesHasEstimate`.
- Usar `Estimado` / `Estimado concentrado` cuando `feesHasEstimate && !feesHasReal && !feesHasUnknown`.
- Mantener `Parcial / acumulando` cuando haya desconocidas.

Ejemplo de criterio:

```js
const feesHasReal = feesKnown.some((f) => f.real);
const feesHasEstimate = feesKnown.some((f) => !f.real);
const feesSub = feesKnown.length === 0 ? 'Sin datos aun'
  : feesAllReal ? 'Real (on-chain)'
  : feesHasUnknown ? 'Parcial / acumulando'
  : feesHasReal && feesHasEstimate ? 'Real + estimado'
  : 'Estimado';
```

## Medio

### 1. NetworkLiquidity sigue mostrando sumas parciales sin estado visible

`NetworkLiquidity` ya evita mostrar `$0` cuando una red no tiene ningun fee usable, pero si una red tiene algunos pools con `usd != null` y otros desconocidos, suma solo los conocidos y muestra `Fees diarios $X` sin indicar que es parcial (`src/components/BotPortal.jsx:123-152`). No lo marco como bloqueante porque no dice "real", pero puede subestimar visualmente una red en estado `warming_up`/`unavailable`.

Correccion sugerida: calcular por red un estado equivalente a `known/allReal/hasUnknown/hasEstimate` y mostrar al menos `parcial` o `~` cuando no represente el total de todos los pools de esa red.

## Bajo

Sin hallazgos.

## Checks positivos

- Se elimino el calculo legacy de usuario `fees1d * (liquidity / tvl)` para `Fees 24h`; `userFees1d` no tiene referencias.
- `PoolCard` usa `poolFees24h(pool)` como fuente unica y etiqueta `Diario (real)` solo cuando `fees24h.real === true` (`src/components/BotPortal.jsx:450-451`, `src/components/BotPortal.jsx:672-686`).
- Las proyecciones semanal/mensual/anual usan `~` y estan marcadas como `proy.` (`src/components/BotPortal.jsx:687-692`).
- El fetch de `getPoolFees24h` usa TTL de 5 minutos, guarda por pool, reintenta si falla borrando el ref, e inyecta `fees24hReal` en el `useMemo` de `pools` con `fees24hData` en dependencias (`src/components/BotPortal.jsx:3802-3837`, `src/components/BotPortal.jsx:3867-3921`).
- F5 no modifica backend/engine/money-path; el cambio funcional auditado esta en `src/components/BotPortal.jsx`.

## Validacion

Comandos revisados/ejecutados:

- `git show --stat --oneline --decorate HEAD`
- `git diff HEAD^ HEAD -- src/components/BotPortal.jsx`
- `rg -n "function poolFees24h|userFees1d|fees1d \\*|liquidity / tvl|fees24hReal|getPoolFees24h|poolFees24h|Real \\(on-chain\\)|Real \\+ estimado|Parcial / acumulando|Sin datos aun|formatUsdCompact" src/components/BotPortal.jsx`
- `npx vite build`

`npx vite build` finalizo correctamente. Solo aparecieron warnings de Rollup/dependencias sobre anotaciones `/*#__PURE__*/` y el chunk JS mayor a 500 kB.

## Veredicto final

**NO-GO** para push/PR de F5 hasta corregir el subtitulo agregado de `Summary` para el caso "100% estimado" y, recomendado, marcar estado parcial en `NetworkLiquidity`.
