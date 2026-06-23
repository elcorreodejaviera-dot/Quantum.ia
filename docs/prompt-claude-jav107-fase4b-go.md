# JAV-107 Fase 4b - Auditoria Codex - GO

Claude: Codex audito el commit `97e2694` en `feat/jav107-spot-defense`.

Contexto:
- Commit auditado: `97e2694` (`SpotDefenseBotModal`, modal real de defensa spot).
- Archivo de codigo auditado: `src/components/BotPortal.jsx`.
- Verificacion local: `npm run typecheck` OK; `npm test` OK (`243/243`); `npx vite build` OK.
- `npx vite build` solo dejo artefactos en `dist/`, que esta ignorado por git.
- No se modifico codigo durante esta auditoria.

## Veredicto

**GO** para JAV-107 Fase 4b.

## Hallazgos

No encontre hallazgos bloqueantes ni riesgos money-path nuevos que impidan avanzar a 4c.

## Puntos validados

1. `persist -> arm` no atomico.
- El modal persiste y luego llama `armSpotDefenseBot`.
- Si el armado falla, el modal NO cierra y muestra el error, lo que permite reintentar.
- Queda posible que el usuario cierre el modal con un bot persistido `active:true` pero sin arm; no abre posicion ni orden, pero 4c debe mostrar claramente el estado sin arm / error y ofrecer reintento.
- Severidad: **MEDIO no bloqueante** para 4b por estar aun sin cablear y porque no hay riesgo de orden duplicada ni exposicion abierta.

2. Nocional y cobertura estimada.
- `requestedNotionalUsd = amount * trigger * (1 + buffer)` coincide con la intencion del backend.
- La cobertura cliente esta etiquetada como estimacion/techo y el backend sigue siendo la autoridad: recorta por margen real, otros bots, plan y `minCoveragePct`.
- Residual: si la estimacion cliente da 100% pero el backend recorta por margen comprometido/plan a algo >= `minCoveragePct`, el arm puede continuar sin marcar `acceptPartial`; esto queda cubierto por el input "Cobertura minima aceptable". No bloqueante.

3. Guard de trigger.
- El pre-check `effTriggerPrice >= currentPrice` bloquea el caso obvio de trigger nacido disparado.
- Si `currentPrice` es `null` o stale, el backend revalida con mark fresco y tick-normalizado (`markPx > triggerPxNorm`), por lo que el cliente no es fuente de verdad.

4. Cobertura parcial / `minCoveragePct`.
- El modal exige aceptar cobertura parcial cuando la estimacion es <100%.
- El backend valida autoritativamente `minCoveragePct` y acota rangos, asi que inputs fuera de rango no abren money-path.

5. Reconfiguracion.
- Si existe un arm no terminal, `persistSpotDefenseBot` rechaza el patch; el modal captura el error y no cierra.
- No queda orden nueva ni arm parcial desde el cliente.

6. Solo real / permisos.
- `canTradeLive` bloquea el submit en cliente.
- El backend vuelve a exigir `canTradeLive`, `canManageBots`, ownership, red esperada y gates live en `armSpotDefenseBot`/internal.
- No encontre camino que llame persist/arm saltando esos gates desde este modal.

7. Secretos / datos sensibles.
- El modal no expone claves ni payloads sensibles.
- `HLAccountSelect` muestra address parcial y balances; eso ya es el patron existente.
- `pruneUndefined` evita enviar `undefined` a Convex.

8. Estado sin cablear.
- Aceptable como staging incremental: 4b define el modal y compila; 4c debe cablear render, tarjeta viva y retiro del camino simulado.

## Checks ejecutados

- `npm run typecheck`: OK.
- `npm test`: OK (`243/243`).
- `npx vite build`: OK.

Resultado final: **GO**.
