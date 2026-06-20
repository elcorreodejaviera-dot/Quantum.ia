# Prompt de auditoría Codex — PLAN de JAV-93 (UI Spot Grid + tarjeta compartir + stats, QSG PR4)

Eres un auditor senior. Audita el **PLAN** (no código) de la UI del Quantum Spot Grid (PR4 de la épica
JAV-89). Mayormente frontend + una query read-only. Responde **GO / NO-GO** con hallazgos numerados.

## Documentos / contexto
- Plan: `docs/plan-jav93-ui-spot-grid.md`.
- Backend ya disponible (PR1/2/3): `createSpotGridBot`/`pauseSpotGridBot`/`stopSpotGridBot`/
  `listSpotGridBots`/`getSpotGridBot` (convex/spotGridBots.ts + spotGridActions.ts); tablas
  spot_grid_bots/orders/cycles con `netProfit`, `createdAt`, etc.
- Patrón UI: AdminView (JAV-80) tab/ruta; BotPortal componentes reusables (`HLAccountSelect`,
  `.config-field`, `.modal-panel`); hooks `src/hooks/useHyperliquid.js`.

## Verifica
1. **Confirmación LIVE no salteable.** ¿El plan garantiza que crear envía órdenes reales solo tras una
   confirmación explícita, con el flag al backend (que re-valida)? ¿Avisos de riesgo (downtrend/underperform)?
2. **Query de stats segura.** `getSpotGridDetail`: scoping por userId (otro usuario → null), solo escalares
   (sin claves/cuenta), acotada con `.take()`. ¿Coste de Σ cycles/orders aceptable? ¿Índices correctos
   (by_bot, by_bot_cycle, by_bot_status)?
3. **Tarjeta de compartir.** ¿Datos correctos (Σ netProfit, now-createdAt, nº ciclos)? ¿NO expone cuenta/
   claves? ¿La técnica de render a imagen es razonable sin añadir dependencias pesadas?
4. **Semántica pausa/stop en la UI.** ¿Deja claro que pausar NO cancela órdenes vivas y stop sí? ¿Stop con
   confirmación + expectedNetwork?
5. **Reuso.** ¿Reusa HLAccountSelect/hooks/CSS y NO duplica? ¿Solo añade `getSpotGridDetail` en backend?
6. **Alcance.** ¿Correcto dejar añadir-capital (JAV-100), retirar-ganancias (JAV-101) y hardening (JAV-94)
   fuera de esta PR?
7. **Dependencia.** ¿Correcto ramificar de master tras mergear JAV-92 (#99) para tener `stopSpotGridBot`?
