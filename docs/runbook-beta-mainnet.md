# Runbook — Beta mainnet (ejecución HL real)

> ⚠️ **Dinero real.** Cada usuario opera con su propia cuenta HL (su capital). El SL es una orden
> trigger **stop-market** con banda de slippage fija (1%): si el mercado **atraviesa la banda** en
> un gap brusco, puede activarse y **no llenarse** → posición sin cortar. No garantiza el cierre.

## 0. Pre-requisitos (configuración)

**Convex (env vars):**
- `HL_NETWORK=mainnet` — **obligatoria**; sin ella las acciones HL fallan (deploy mal configurado no opera).
- `HL_CREDENTIALS_ENCRYPTION_KEY` — clave AES-256 de las API wallets. **Verificar que está configurada** (era pendiente histórico de JAV-27). Sin ella, `connectAccount`/ejecución fallan.

**Frontend (Vite/Railway):**
- `VITE_HL_NETWORK=mainnet` — **obligatoria**; el botón "Probar ejecución" se deshabilita si falta.

**Auditoría de permisos (seguridad por diseño):**
- `canTradeLive` es un permiso **nuevo** → arranca vacío: **ningún usuario no-admin** puede operar real. El **admin tiene bypass implícito**.
- `canManageBots` **NO** habilita trading real (permiso separado). No hace falta revocar concesiones existentes.

## 1. Secuencia de activación (gradual — innegociable)

> Recomendación de la auditoría: idealmente probar en **testnet** completo primero (`HL_NETWORK=testnet`). Si se omite, la gradación de abajo es el mínimo.

1. **Admin fija límites mínimos** (Panel Admin → Límites de ejecución): `maxNotionalPerOrder = 15`, `maxNotionalPerUserDaily = 50`. (El SL ya no tiene buffer configurable: es stop-market con banda fija del 1%.)
2. **Admin enciende el master switch**: Panel Admin → *Desactivar SIM* + *Activar LIVE* (`simulationMode=false`, `tradingEnabled=true`).
3. **Admin (solo él)** conecta su cuenta HL, crea un bot, lo pone en **Modo real** (toggle del modal), y usa **"Probar ejecución"** con nocional mínimo (~$10–12).
4. **Verificar** en *Panel Admin → Ejecuciones recientes* que la fila avanza `submitting → entry_filled → protected`, y confirmar el SL en `app.hyperliquid.xyz`.
5. **Solo entonces** conceder `canTradeLive` a un usuario beta (Panel Admin → Trading real). Subir límites gradualmente con más tráfico.

## 2. Tabla de diagnóstico (Panel Admin → Ejecuciones recientes)

El estado + `error` de cada fila dice **dónde y por qué falla**.

| `status` | Significado | Acción / qué mirar |
|----------|-------------|--------------------|
| `pending` | Reservado, entrada aún no enviada | Transitorio. Si persiste → el cron lo reconcilia (lease). |
| `submitting` | Enviando la entrada a HL | Transitorio (≤30s, timeout). Si persiste → reconciliación por cloid. |
| `entry_filled` | Entró; SL aún no colocado | Transitorio; el SL se coloca a continuación (o el cron). |
| `protected` ✅ | Entró + SL colocado | OK. Posición abierta con SL resting en HL. |
| `sl_failed` ⚠️ | Entró pero el SL falló | **Posición SIN protección.** El cron reintenta el SL cada 1 min. Revisar `error` y la cuenta en HL. |
| `closed` | El SL se ejecutó (posición cerrada) | Ciclo completo. |
| `unknown` | Resultado HL incierto (timeout/ambiguo) | El cron reconcilia por cloid. No libera reserva. |
| `failed` | Sin posición (no entró / rechazo) | Reserva liberada. Ver `error`. |

**`error` strings frecuentes:**
- `blocked at submit (switch/permiso)` — se revocó `canTradeLive` o se apagó el switch entre reserva y envío. Esperado tras una parada.
- `entry <canceled|rejected|iocCancelRejected|minTradeNtlRejected>` — HL rechazó la entrada (no cruzó el book a precio límite, o nocional bajo el mínimo de HL ~$10).
- `entry unknownOid (grace)` — la entrada nunca llegó a HL; cerrada tras el grace.
- `filled sin datos de fill aún` — `orderStatus` dice filled pero `userFills` no lo refleja aún; se reintenta (no se pierde).
- `fill inválido (size/price)` — datos de fill no fiables; queda `unknown` para reintentar.
- `Respuesta de SL ambigua` — el SL no devolvió resting/filled; el cron lo reintenta con nuevo cloid.
- `Nocional … supera el máximo por orden` / `Volumen diario excedido` — límites; ajustar en el panel o esperar.
- `Conflicto de idempotencia` — misma idempotencyKey con otros parámetros (no debería con el flujo del portal).

## 3. Parada de emergencia

- **Kill switch / `tradingEnabled=false`** (Panel Admin → DETENER TODO): **bloquea entradas nuevas al instante** (revalidado en `reserveExecution` y `markSubmitting`).
- **Ventana irreducible:** una orden cuyo `exchange.order` ya está en vuelo **no se cancela** retroactivamente (milisegundos).
- **La reconciliación y el SL de posiciones abiertas SIGUEN** (el cron protege lo ya abierto — es lo correcto).
- **Revocar `canTradeLive`** a un usuario tiene el mismo efecto de bloqueo para ese usuario; sus posiciones abiertas se siguen reconciliando.
- **No revocar una cuenta HL** con ejecuciones abiertas: el backend lo impide (se perdería la clave para gestionar el SL).
