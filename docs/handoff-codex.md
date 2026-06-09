# Handoff para Codex — Estado de los bots de cobertura (Quantum.ia)

> Documento de contexto para auditorías. Resume dónde está el sistema, qué está aprobado,
> qué falta, y los puntos de atención. Dinero real → nada de ejecución va a mainnet sin tu OK.

## 1. En producción (mainnet) — Fase 1 (JAV-41, Done)
- PR #17 mergeado a `master` + 2 hotfixes. `portal-quantum.com` operativo.
- Backend Convex = deployment `strong-sandpiper-848`. `HL_NETWORK=mainnet`, `VITE_HL_NETWORK=mainnet`.
- Switches: `simulationMode=false`, `tradingEnabled=true` (LIVE). `maxNotionalPerOrder=1500`, daily=2000.
- Motor de ejecución **IOC** (entrada al instante) con gates ya auditados por ti:
  cuenta unified (`userAbstraction`), reserva de margen atómica por cuenta, sin doble conteo
  (solo USDC spot libre), leverage aplicado consistente, dedupe validado, isolated.
- Modelo de cuentas: wallets EVM (MetaMask/Rabby) independientes vinculadas a HL; 1 cuenta = 1 bot.
- Estado real: cuenta "Protector" conectada (unified, saldo en SPOT ~998 USDC, 0 en perp). Bot
  "IL ETH Base" creado, activo, modo real (leverage 20x, SL 0.8%), pool ETH/USDC Base
  (tokenId 5301573, rango 1636–1737). El bot NO dispara solo (Fase 1 = ejecución manual).

## 2. JAV-43 — Fix ejecución IOC (URGENTE, rama `feat/exec-market-orders`, sin push)
Bug en prod: 3 órdenes manuales quedaron `unknown` sin abrir posición — la IOC usaba `markPx`
exacto → "could not immediately match against any resting orders".
Fix base hecho: entrada market (IOC slippage agresivo) + SL stop-market.
**Tu última auditoría NO aprobó el despliegue — 4 correcciones pendientes:**
1. **Crítico**: el SL stop-market usa la tolerancia del **10%** de HL, no 3%. Decidir: stop-market
   (límite adverso oficial 10%) o stop-limit 3% (puede no llenarse). Quitar "garantizar llenado".
2. **Alto**: reservar el PEOR nocional de la entrada → `entryLimitPx` ajustado; `size = floor(amount/entryLimitPx)`;
   `reservedNotional = size×entryLimitPx` (que el fill no exceda el nocional/límite autorizado).
3. **Alto**: `slBufferPct` quedó obsoleto con stop-market — corregir UI/runbook/panel admin.
4. **Medio**: manejar `waitingForTrigger` como aceptación pendiente (reconciliar por CLOID), no `sl_failed`.
Aprobado por ti: IOC agresiva, reduceOnly cierre, SL tras fill, CLOID/reconciliación/timeout.
→ Tras los 4 fixes: prueba manual mínima ($15/orden, $50/día), confirmar por API que llega a `protected`.

## 3. JAV-44 — Motor de cobertura AUTOMÁTICA (órdenes trigger) — TESTNET por etapas
Objetivo del usuario: que el Bot de IL "actúe solo". Tu veredicto: construir en **testnet** por etapas,
no improvisar en mainnet. Diseño objetivo (tuyo): modelo `trigger_arms`/`trigger_orders`, CLOID como
identidad primaria, OCO entre las dos entradas, pausa no atómica (`active→cancel_requested→canceling→paused`),
margen para UNA entrada, `grouping` validado por API, salida asimétrica.

### Evidencia EN VIVO (capturada de la plataforma de referencia del usuario; ETH cayó bajo el rango)
Valida tu diseño punto por punto:
- Al cruzar el borde inferior → **short abierto** (entry 1635.8, 20x isolated). Trigger de entrada "Desarmado".
- Órdenes de salida colocadas **después del fill** (Opción B), todas `reduceOnly` Close Short:
  - **SL = Stop Market**, trigger "Price ABOVE 1652.3" (+1%), size total.
  - **TP1 = Take Profit Market**, "Price BELOW 1627.5" (−0.5%), 40%.
  - **TP2 = Take Profit Market**, "Price BELOW 1611.2" (−1.5%), 60%.
- Usan **CLOID** (entry `0x9758d9…`) y **"versión de armado v2"** (= generation).
- Pausa: textual "la pausa cancela este trigger en HL antes de cambiar el estado" (tu #2).
- TPs parciales + SL del total (tu punto a probar en testnet).

### Etapas en testnet
1. Un trigger inferior, sin TPs · 2. Cancelación/reconciliación · 3. SL Stop Market arriba ·
4. Segundo trigger + OCO · 5. TPs parciales (Take Profit Market) + auto-rearm.

## 4. Flujo de trabajo
Implementar → auditar con **Codex** (diffs en `audit-*.diff`, en .gitignore) → PR + **CodeRabbit** →
merge → deploy. **No push/deploy de ejecución de dinero sin OK de Codex.** Validar con
`node node_modules/convex/bin/main.js codegen` + `vite build --outDir dist-check` (dist/ tiene permisos root).

## 5. Próximo paso
JAV-43 primero (cobertura manual segura), luego JAV-44 en testnet por etapas.
