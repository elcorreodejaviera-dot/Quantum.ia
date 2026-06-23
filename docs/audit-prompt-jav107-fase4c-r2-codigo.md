# Re-auditoría JAV-107 Fase 4c r2 — fixes del NO-GO

Audita el **CÓDIGO** del commit `474e0e7` (fixes del NO-GO de 4c sobre `d326dd1`). Emite **GO / NO-GO**
por hallazgo. Rama `feat/jav107-spot-defense`. Fases 1–4b con GO; 4c original NO-GO (4 hallazgos).

## Hallazgos del NO-GO y su fix (a verificar)

1. **ALTO — borrar la posición dejaba el bot huérfano.** Fix:
   - `convex/schema.ts`: nuevo índice `by_position` (`["spotPositionId"]`) en `spot_defense_bots`.
   - `convex/spot_positions.ts` `removePosition`: tras el check de ownership, busca por `by_position` los
     bots de defensa de esa posición; por cada uno mira si hay arm NO terminal (`!{disarmed,closed,failed}`)
     vía `by_bot_generation`. Si `bot.active || bot.status!=="stopped" || bot.disarmPending || liveArm` →
     `throw "defensa spot activa..."`. (Se busca por spotPositionId porque `spot_positions.userId`=clerkId
     ≠ `spot_defense_bots.userId`=users._id.)
   - UI (`BotPortal.jsx`): botón Eliminar `disabled` + `title` explicativo si la defensa está viva.
2. **MEDIO — pausa no visible.** Fix: en `DefensaSpotViva` el orden de estado pone `bot.disarmPending`
   ANTES de `arm` → "Deteniéndose" (amber) aunque el arm siga vivo hasta que el reconcile lo cierre.
3. **BAJO — botones sin gate cliente.** Fix: `canTradeLive` se pasa a `DefensaSpotViva`; "Reintentar
   armado" y "Pausar defensa" se ocultan sin permiso (backend sigue siendo autoridad).
4. **BAJO — `lastRearmErrorKind` no persistido.** Fix: `settleSpotDefenseRearm` clasifica el prefijo
   `[blocked_margin]`/`[blocked_config]`/`[retry_incompatible]`/else `transient` y persiste
   `lastRearmErrorKind` (la tarjeta ya lo mostraba).

## Preguntas

1. **Guard de borrado completo:** ¿cubre todos los caminos de orfandad? (bot active, bot no-stopped,
   disarmPending en curso, arm no terminal). ¿El backend es la autoridad y la UI solo lo anticipa? ¿Algún
   caso donde un bot stopped con arm terminal SÍ debería poder borrarse — y se permite?
2. **Índice `by_position`:** ¿es correcto buscar por spotPositionId sin userId (la posición ya pasó el
   ownership; spotPositionId es un id global único)? ¿Se filtra/expone algo ajeno?
3. **Prioridad de `disarmPending`:** ¿el reordenamiento es correcto y no rompe los otros estados
   (failed/manual_intervention/armed/sin-armar/pausado)?
4. **Clasificación del kind:** ¿el `errorKind` derivado coincide con el del motor de pools y con la
   política de `processSpotDefenseRearms`? El fallback a `transient` sin prefijo, ¿es razonable?
5. **Tests:** se añadió `spot_positions.ts` al allowlist mutation-safe del harness y 5 tests (4 del guard
   de removePosition + 1 de lastRearmErrorKind). ¿Cobertura suficiente? ¿Falta algún caso?

## Verificación

`npm run typecheck` EXIT 0; `npm test` **248/248**; `npx vite build` aislado OK.
Devuelve hallazgos + veredicto **GO / NO-GO** para 4c r2 (y si cierra JAV-107 de cara al PR).
