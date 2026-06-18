# Prompt de auditoría (Codex) — fixes panel Admin: Cobertura (cap) + Volumen 24h (JAV-84)

Audita el **código** (working tree, sin commit). Dos arreglos de datos del panel Admin que salían vacíos:

## 1) Cobertura (cap) = "—" → mostrar nocional REAL de la posición HL
`bot.hedgeNotionalUsd` es null por diseño (el motor dimensiona on-chain), así que la celda salía "—".
Ahora se muestra el nocional vivo de la posición HL.
- `convex/adminLive.ts`: en el bucle de `clearinghouseState`, además del PnL, se acumula
  `coverageByAccountCoin[acctId][coin] = Σ |positionValue|` (nocional de la posición). Se devuelve en el snapshot.
- `src/components/AdminView.jsx`: `PositionCard` usa `coverageLive` (positionValue por hlAccountId+coin) para
  "Cobertura (cap)"; fallback a `pos.hedgeNotionalUsd` (suele null) → "—" solo si no hay nada. Mapeo en UserRow
  por `pos.hlAccountId` + `pos.baseAsset` (igual que el PnL).

## 2) Volumen 24h = $0 → contar AMBOS motores
`trades_history` solo lo alimenta el motor IOC legacy; el motor automático (trigger_arms, JAV-44) NO escribe
ahí → con bots IL el volumen salía ~$0. Ahora `getSystemStats` calcula:
- `execution_requests` (IOC): `notional`, por índice `by_created` desde `prevSince`.
- `trigger_arms` (automático): nocional REAL del fill = `filledSize×entryPrice`. Sin índice global by_created
  → escaneo acotado `by_updated` desc `take(SCAN_CAP)` y filtro por `createdAt`.
- Ventana actual [since, now) y previa [prevSince, since) para el `volume24hDelta`. Sin doble conteo (cada
  motor su tabla). Helper `addVol(notional, ts)` ignora no-finitos/≤0.

## 3) Rango con demasiados decimales → formateo
`src/components/AdminView.jsx`: helper `fmtPrice` (2 decimales si |n|≥1; `toPrecision(4)` si <1) aplicado a
la celda "Rango" (`1636.04 – 1790.10` en vez del float crudo). Solo cosmético.

Responde GO/NO-GO:
1. ¿`positionValue` (abs) es la magnitud correcta para "Cobertura (cap)" (nocional del hedge)? ¿coherente con
   sumar por coin si la cuenta tiene varias posiciones del mismo coin? ¿unidades USD correctas?
2. ¿El mapeo coverage por `hlAccountId`+`baseAsset` evita cruzar cuentas (como el PnL ya corregido)?
3. Volumen: ¿`filledSize×entryPrice` es el nocional correcto del fill del arm? ¿algún doble conteo entre
   execution_requests y trigger_arms? ¿OCO/2 entradas inflan (¿contar solo la entrada que llenó)?
4. ¿El escaneo `trigger_arms by_updated take(SCAN_CAP)` puede PERDER arms creados en 24h si hay muchos
   actualizados recientemente y creados >2d? ¿Aceptable para beta o conviene un índice by_created?
5. ¿`execution_requests by_created gte(prevSince)` correcto y acotado? ¿`notional` siempre presente?
6. ¿Sigue siendo solo lectura/cache (queries sin red) y la acción adminLive read-only (no money-path)?
7. Bordes: posición cerrada (positionValue 0/ausente), arms sin fill (filledSize/entryPrice null) → no suman.
