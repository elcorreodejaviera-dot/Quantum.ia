# Regla de exclusividad de cuentas Hyperliquid (JAV-102)

> Fijada por Javier el 2026-06-21. Aplica a la **vinculación de cuentas HL** al crear
> bots de cobertura (IL/protección/trading — perp) y Spot Grids (spot).
> Es **money-path**: requiere doble auditoría (Codex + CodeRabbit) antes de mergear.

## Por qué existe

En Hyperliquid **spot y perp viven en la misma wallet**. Si dos servicios operan
desde la misma cuenta sobre el **mismo mercado**, comparten order book / posición y
se interfieren: cancelaciones cruzadas, fills ambiguos, doble exposición y conflictos
de balance/margen. La regla separa el uso de cada cuenta para evitarlo, manteniendo
eficiencia de capital donde es seguro (cobertura de pares distintos).

## La regla

| Querés abrir... | con una cuenta que ya tiene... | ¿Se puede? |
|---|---|---|
| **Cobertura** | cobertura del **mismo par** | ❌ No |
| **Cobertura** | cobertura de **otro par** | ✅ Sí |
| **Cobertura** | un **grid** | ❌ No |
| **Grid** | otro **grid** | ❌ No |
| **Grid** | una **cobertura o trading** | ❌ No |

En palabras:

- **Cuenta de Spot Grid = exclusiva TOTAL.** 1 cuenta = 1 grid; no comparte con nada.
  Para abrir otro grid hay que vincular **otra cuenta** (o detener el grid actual, que
  libera la cuenta cuando queda en estado `stopped`).
- **Cuenta de cobertura = se comparte SOLO entre pares distintos.** La misma cuenta
  puede cubrir BTC/USDC y ETH/USDC a la vez, pero **nunca el mismo par dos veces**, y
  **nunca** junto con un grid.

## Mensajes al usuario (deben ser entendibles)

- Cobertura sobre cuenta con cobertura del mismo par:
  > "Esta cuenta de Hyperliquid ya tiene una cobertura para [PAR]. Para cubrir este par
  > usá otra cuenta; para esta cuenta podés cubrir un par distinto."
- Cobertura sobre cuenta de un grid:
  > "Esta cuenta está vinculada a un Spot Grid. Para una cobertura, usá una cuenta distinta."
- Grid sobre cuenta con cobertura/trading:
  > "Esta cuenta ya la usa un bot de cobertura/trading. El Spot Grid necesita una cuenta dedicada."
- Grid sobre cuenta con otro grid:
  > "Esta cuenta ya está vinculada a un Spot Grid. Para abrir otro grid, vinculá otra cuenta."

## Estado del código (verificado 2026-06-21)

- **Cobertura** — `convex/bots.ts:316-328` (`getOrCreatePoolBot`): hoy exclusividad
  **TOTAL** ("1 cuenta = 1 bot", índice `by_user_account`, sin mirar el par).
  - ⚠️ **Hay que cambiar** a unicidad por `(user, cuenta, par normalizado)`.
  - ⚠️ **Falta** que la cobertura verifique que la cuenta no esté usada por un Spot Grid
    (hoy `bots.ts` NO consulta `spot_grid_bots` → asimetría).
- **Grid** — `convex/spotGridBots.ts:96-102` (`assertCreateGuards`): ya bloquea si la
  cuenta la usa cualquier bot perp (cobertura/trading) **o** cualquier grid activo
  (estado distinto de `stopped`). Es la dedicación total que queremos → **mantener**,
  solo mejorar el texto del error.
- **Revocación** — `convex/hlCredentials.ts:32` (`revokeById`): hoy bloquea revocar con
  ejecuciones abiertas / arms no terminales y desvincula bots perp, pero **NO consulta
  `spot_grid_bots`** (ALTO money-path, NO-GO Codex r1). → **Añadir guard**: rechazar revocar
  si hay un grid no-`stopped` en la cuenta ("La cuenta tiene un Spot Grid activo; deténlo
  antes de revocar."), perderíamos la clave privada para cancelar/reconciliar sus órdenes.

## A verificar antes de implementar

- Confirmar con Codex que aislar la cobertura **por par** no genera conflicto de
  balance/margen en HL cuando hay varios pares en la misma cuenta (spot y perp comparten
  wallet). El grid queda siempre aparte, así que no se mezcla spot+perp.
- Reusar la normalización de par existente (WETH→ETH / WBTC→BTC) para comparar pares.
