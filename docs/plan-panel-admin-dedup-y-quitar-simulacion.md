# Plan — Quitar Panel Admin duplicado de la home + eliminar simulación de la UI

Dos cambios pedidos por el usuario, **ambos en un solo PR**. **Parte A** es UI sin riesgo. **Parte B toca
money-path adyacente** (creación de bots) → flujo completo: plan → GO Codex → PR → CodeRabbit → GO → deploy.

> **DECISIÓN (usuario, 2026-06-22):** hacer A + B juntas, **variante B1** (quitar simulación de toda la UI;
> el gate de backend queda como red de seguridad inerte). NO B2 (no se arranca el backend).

## Parte A — Panel Admin duplicado (UI, sin riesgo)

La home del portal (`Dashboard`, `src/components/BotPortal.jsx:~4069`) renderiza `<AdminPanel>` que
**duplica** el tab Admin (`AdminView.jsx`, "Panel de Administración"). El usuario lo confirmó por captura.

- **Quitar** el render de `<AdminPanel .../>` de `Dashboard` (BotPortal.jsx).
- **Mover** `ExecutionsObservabilityPanel` (lo ÚNICO no duplicado) al tab Admin (`AdminView.jsx`):
  exportarlo desde BotPortal e importarlo en AdminView, o mover su definición. Renderizarlo en AdminView.
- `BetaPermissionsPanel` (permisos) ya está cubierto por `UserControlRow` del tab → se elimina del inline.
- `AdminPanel` y `BetaPermissionsPanel` quedan sin uso → eliminar sus definiciones.

## Parte B — Eliminar simulación de la UI (money-path adyacente)

Decisión del usuario (repetida): **nunca operarán en simulación; el producto es solo real.**

`simulationMode` está entretejido: campo por-bot (`convex/bots.ts`), gates (`triggerEngine.ts`,
`hyperliquid.ts`, `executions.ts`, `spotGridBots.ts`), config global (`systemConfig.ts`), y mucha UI
(toggle global, `RealModeToggle` en creación, pills "Simulación", `SpotPositions`, `SpotProtectorBot`).

### B1 — quitar simulación de la PRESENTACIÓN; backend como red de seguridad inerte (AJUSTADO tras NO-GO de Codex)

**Condiciones bloqueantes de Codex (2026-06-22) — incorporadas:**
1. **El `simulationMode` global debe quedar `false` ANTES de ocultar el toggle.** Si no, un config global en
   `true` (o un default `?? true`) bloquearía el trading real sin control visible.
2. **La creación de bots debe BLOQUEARSE sin `canTradeLive`, NO caer a simulación silenciosa** (contrario a
   "nunca simulación").

**Cambios:**
- **Global sim → false y default seguro:**
  - Asegurar `system_config.simulationMode = false` (set explícito una vez; el kill-switch real sigue siendo
    `tradingEnabled`).
  - Cambiar los defaults `?? true` por `?? false` (frontend `BotPortal.jsx:~3597`; `seed.ts` no debe sembrar
    `simulationMode: true`). Backend `getConfigBool` ya devuelve `false` si ausente.
- **AdminView:** quitar el toggle "Activar/Desactivar SIM" y la pastilla "SIM ON/OFF" (y la lógica
  `disabled={simOn}` del toggle de trading) **solo después** de garantizar el punto anterior.
- **Creación de bots (modales IL/Trading):** quitar `RealModeToggle`; enviar **siempre** `simulationMode: false`
  (real). Si el usuario **no** tiene `canTradeLive`: **bloquear la creación** en la UI (botón deshabilitado +
  mensaje "necesitas permiso de trading real") — NO crear bot simulado. Defensa en profundidad: `bots.ts:312`
  ya rechaza real sin `canTradeLive` (el error de backend respalda el bloqueo de UI).
- **Pills/textos:** quitar "Simulación"/"sim" de status (`BotPortal.jsx` 1503-1504, 1831, 2290, 3323-3324,
  1872, etc.).
- **Backend:** NO se arranca el gate `simulationMode` (queda como barrera inerte; con global=false y creación
  siempre real, nunca se activa). Invisible → cumple "nunca en simulación".

### Alternativa — B2 (NO recomendada)
Rip-out total del backend (`simulationMode` fuera de bots/gates/config). Quita una barrera de seguridad
del money-path, es grande y arriesgado. Solo si el usuario lo exige explícitamente.

## Preguntas para Codex
1. ¿B1 (UI fuera, gate inerte) es aceptable como "quitar simulación", o el usuario quiere B2?
2. En creación, `simulationMode: !canTradeLive` → ¿correcto que un creador sin canTradeLive (canManageBots
   solo) genere bot en sim, o debe bloquearse la creación directamente?
3. ¿Mover `ExecutionsObservabilityPanel` a AdminView rompe algún hook/estilo (usa queries propias)?
4. ¿Algún consumidor del estado SIM en la home depende del `<AdminPanel>` que se elimina?

## Comprobaciones
- `npm run typecheck` + `npm test -- --run` verdes.
- `vite build` OK.
- Revisar que no quedan referencias muertas (AdminPanel, BetaPermissionsPanel, RealModeToggle, setSim).
