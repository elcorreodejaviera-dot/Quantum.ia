# Plan JAV-105 — Portal: eliminar cifras DEMO al entrar (mostrar 0 hasta el dato real)

Rama: `elcorreodejaviera/jav-105-portal-...`. **No money-path** (solo display del portal Liquidity Hedge).
Decide GO / NO-GO con hallazgos (ALTO/MEDIO/BAJO).

## Problema (verificado en `master`)

Al entrar al portal con un usuario que tiene un pool real, las tarjetas de arriba muestran unos segundos
cifras **demo hardcodeadas** (`Liquidez monitoreada $33,680`, `APY 58.4%`, `Fees $58`) y luego, al
cargar la lectura on-chain, se reemplazan por las reales. Origen en `src/components/BotPortal.jsx`:

- Líneas **16-23**: tabla `POOLS` demo. ETH/USDC Base = `{ liquidity: 33680, fees24h: 58, apr: 58.4, ... }`.
- `useMemo` de `pools` (línea **3704**): por cada pool real de DB hace
  `const mock = POOLS.find(par+red) ?? {}` y mezcla `...mock` + fallbacks `apy: p.apy ?? mock.apr`,
  `fees24h: p.fees1d ?? mock.fees24h`.
- Los datos financieros reales (`positionData[p._id]`, lectura LP on-chain) empiezan en `{}` y llegan
  async (efecto en línea ~3654, TTL 30s). Mientras `pd == null`, `liquidity`/`apy`/`fees24h`/`exposure`
  caen al **mock** → el `Summary` (línea 68) los suma y se ven las cifras demo.

## Decisión del usuario

**Todo debe marcar 0 al entrar y luego cargar el valor real.** Nada de skeleton ni "—": los KPIs
financieros arrancan en 0 y se sustituyen cuando llega `positionData`.

## Cambios (`src/components/BotPortal.jsx`)

1. En el `useMemo` de `pools` (línea ~3704), **eliminar el uso de `mock`**:
   - Quitar `const mock = POOLS.find(...) ?? {}` y el spread `...mock`.
   - `apy: p.apy ?? mock.apr ?? 0` → `apy: p.apy ?? 0`.
   - `fees24h: p.fees1d ?? mock.fees24h ?? 0` → `fees24h: p.fees1d ?? 0`.
   - Los defaults ya existentes (`liquidity: 0, apr: 0, exposure: 0, ...`) se mantienen → quedan en 0
     hasta que `pd != null` los sobreescriba con los reales. `min/max/id/status` siguen viniendo de `p`
     y de las líneas explícitas (no dependían del mock).
2. **Eliminar la constante `POOLS`** (líneas 16-23): tras el cambio queda sin referencias (único uso era
   el `mock`). Verificar con grep que no se usa en ningún otro sitio antes de borrarla.

## Verificaciones para Codex

- ¿Algún campo que hoy salía del `mock` y NO lo aporta ni `p` ni `positionData` ni una línea explícita?
  (Repasar: `liquidity`, `apr`, `apy`, `fees24h`, `exposure`, `min`, `max`, `status`.)
- Pools **sin** `positionData` (p.ej. sin `tokenId`, línea 3658 hace `continue`): ¿quedan en 0 de forma
  aceptable, sin romper `Summary`/`PoolCard`/`NetworkLiquidity`/`RiskPanel`?
- `Summary` (línea 68): con `pools.length > 0` pero liquidez/fees/apy en 0, muestra `$0` / `0.0%`
  transitorio → coherente con la decisión "0 y luego real".
- Confirmar que `POOLS` no se importa/usa fuera de `BotPortal.jsx`.

## Comprobaciones

- `npm run typecheck` limpio.
- `npm test -- --run` verde.
- (Opcional) verificación manual: entrar al portal → KPIs en 0 → cargan reales sin pasar por $33,680.
