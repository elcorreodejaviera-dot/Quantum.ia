# Auditoría de CÓDIGO — JAV-102: exclusividad de cuenta HL (cobertura por par + Spot Grid dedicado 1:1)

Eres un auditor senior de código **money-path** en Hyperliquid. El PLAN ya pasó 3 rondas de tu
auditoría (GO al diseño; hallazgos r1/r2 incorporados). Ahora audita el **CÓDIGO YA IMPLEMENTADO**
en la rama `elcorreodejaviera/jav-102-exclusividad-de-cuenta-hl-cobertura-por-par-spot-grid`
(checkout hecho). Emite **GO / NO-GO** por hallazgo con severidad (ALTO / MEDIO / BAJO). No reescribas;
señala fallos de corrección, huecos y riesgos. Verde local: **180/180 tests** (`npx vitest run`) y
`npm run typecheck` limpio.

## Regla implementada (FIJADA por el usuario 2026-06-21)

| Abrir…    | cuenta que ya tiene…                | ¿Permitir? |
|-----------|-------------------------------------|------------|
| Cobertura | cobertura del **mismo par**         | ❌ No      |
| Cobertura | cobertura de **otro par**           | ✅ Sí      |
| Cobertura | un **grid** (cualquier estado vivo) | ❌ No      |
| Grid      | otro **grid** vivo                  | ❌ No      |
| Grid      | una **cobertura / trading**         | ❌ No      |

- **Cuenta de Spot Grid = exclusiva TOTAL** (1 cuenta = 1 grid; nada más).
- **Cuenta de cobertura = compartible SOLO entre pares distintos** (BTC/USDC + ETH/USDC en la misma
  cuenta), nunca el mismo par dos veces, nunca con un grid.

En HL **spot y perp comparten la misma wallet** (`tradingAccountAddress`). `baseAsset` se normaliza en
backend vía `deriveBaseAsset(pool.pair)` (WETH→ETH / WBTC→BTC), nunca llega del cliente. El quote es
siempre USDC. `spot_grid_bots.status` es un enum cerrado `running | paused | stopped | error` →
único terminal = `stopped`; el filtro `status !== "stopped"` cubre los tres estados vivos.

## Cambios a auditar (diff vs master)

### 1. Cobertura — `convex/bots.ts` (`getOrCreatePoolBot`, líneas ~316-360)

`baseAsset` calculado en :299. Se computa `resultingHlAccountId = hlAccountId ?? existingBot?.hlAccountId`
en :320 **antes** del guard (cierre Codex r2: un update que omite `hlAccountId` pero conserva la cuenta
también valida). El guard corre `if (resultingHlAccountId)` (:329):

- **Ownership** (:332-337): solo re-valida `cred.userId === user._id` cuando el arg `hlAccountId` viene
  explícito; una cuenta ya persistida en `existingBot` no se re-comprueba.
- **Mismo par** (:338-350): `bots.by_user_account(user._id, resultingHlAccountId).collect()`; rechaza si
  algún `b._id !== existingBot?._id && b.baseAsset === baseAsset`. Mensaje con `${baseAsset}/USDC`.
- **Grid vivo** (:351-359): `spot_grid_bots.by_account(resultingHlAccountId).collect()`,
  `.find(g => g.status !== "stopped")`; si hay → rechazo.

El bloque vive DENTRO de la mutation que persiste/patcha el bot (:373-384), no en un preflight.

### 2. Grid — `convex/spotGridBots.ts` (`assertCreateGuards`, :96-102)

Lógica intacta (ya correcta del diseño). Solo se cambiaron los textos de error (perp en la cuenta :98;
otro grid vivo :102). `assertCreateGuards` se invoca en `persistSpotGridBot` (:146) y en la otra ruta
(:171).

### 3. Revocación — `convex/hlCredentials.ts` (`revokeById`, :56-65) — cierre ALTO r1

Antes de `ctx.db.delete(id)` (:73): tras los guards de `execution_requests` abiertas (:41-50) y
`trigger_arm` no terminal (:51-55), nuevo guard `spot_grid_bots.by_account(id)` con grid no-`stopped`
(:58-65) → rechazo "La cuenta tiene un Spot Grid activo; deténlo antes de revocar." Orden:
ejecuciones → arms → **grid** → desvincular perp (:66-72) → delete (:73).

### 4. Comentarios / invariantes — `convex/schema.ts:163`, `convex/hyperliquid.ts:379-383`

Actualizados los comentarios "1 cuenta = 1 bot" obsoletos. `closeBotPosition` (`hyperliquid.ts`) sigue
aplanando toda la posición del activo: el comentario nuevo justifica que sigue siendo seguro porque
`getOrCreatePoolBot` garantiza UN bot por `(cuenta, baseAsset)`.

### 5. UI — `src/components/BotPortal.jsx` (ProtectionBotModal + TradingBotModal)

Aviso de margen cross compartido entre pares + "Un Spot Grid necesita cuenta dedicada".

### 6. Tests — `tests/poolBotExclusivity.test.ts` (nuevo), harness, regex de `spotGridBots.test.ts`

Cobertura: mismo par→rechazo, otro par→OK, grid vivo→rechazo, grid stopped→OK, upsert del mismo
bot→no se rechaza. Revocación: grid vivo→rechazo (credencial intacta), grid stopped→borra.

## PREGUNTAS QUE LA AUDITORÍA DEBE RESPONDER (money-path)

1. **CLAVE (riesgo del usuario):** ¿el aislamiento por `baseAsset` sobre una wallet HL compartida
   (spot+perp) es correcto y suficiente en el CÓDIGO, o queda algún camino de fills ambiguos /
   cancelaciones cruzadas / doble exposición entre pares distintos? ¿El riesgo de **collateral cross
   compartido** (una pérdida en un par merma el margen del otro) queda bien acotado y avisado?
2. ¿`baseAsset` es la clave de unicidad correcta y suficiente? ¿Falta considerar quote (siempre USDC)
   o red? El comentario afirma "1 credencial = 1 red" → ¿es cierto en el schema/datos (no hay forma de
   que la misma `hl_api_credentials` cubra mainnet y testnet)? Si fuera falso, dos pools con mismo
   `baseAsset` en redes distintas colisionarían incorrectamente.
3. ¿Hay **carreras** (dos `getOrCreatePoolBot` concurrentes sobre la misma cuenta) que burlen el check?
   ¿El patrón collect+comprobación dentro de la mutation basta con la OCC de Convex, o falta algo?
4. ¿El filtro `status !== "stopped"` cubre TODOS los estados vivos en las TRES ubicaciones
   (`bots.ts`, `spotGridBots.ts`, `hlCredentials.ts`)? ¿Algún transitorio se escapa?
5. **Simetría bidireccional:** tras el cambio, crear cobertura mira grids y crear grid mira cobertura.
   ¿Hay alguna ruta que cree un bot perp (trading/il) SIN pasar por `getOrCreatePoolBot` y que por tanto
   se salte el guard? ¿Y alguna ruta que cree un grid sin pasar por `assertCreateGuards`?
6. **Regresión:** ¿algún call-site de `getOrCreatePoolBot` que pase `hlAccountId` y se rompa con el
   nuevo rechazo por par en flujos legítimos de un solo par (p.ej. re-config del mismo bot, cambio de
   cuenta)? ¿El caso `existingBot` se excluye correctamente de su propia comparación en TODOS los
   escenarios (mismo pool/kind, distinto pool mismo baseAsset, etc.)?
7. **Ownership/seguridad:** ¿es correcto NO re-validar ownership de la cuenta persistida en `existingBot`
   cuando el arg viene vacío? ¿Puede un bot quedar con una `hlAccountId` que ya no pertenece al usuario?

Devuelve: lista de hallazgos (severidad + descripción + fix sugerido) y veredicto **GO / NO-GO**.
Si es GO, indícalo explícitamente para habilitar push + PR (+ pase por CodeRabbit, money-path).
