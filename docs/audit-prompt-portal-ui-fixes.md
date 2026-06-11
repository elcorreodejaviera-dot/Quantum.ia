# Prompt de auditoría Codex — Arreglos de UI del portal (JAV-UI)

Rama `feat/portal-ui-fixes` (base master). Cambios SIN commitear en el working tree.
Pega el bloque de abajo en Codex (en la otra terminal, dentro del repo).

---

Eres un auditor de código senior. Revisa los cambios SIN COMMITEAR en el working tree
del repo Quantum.ia (portal de bots de cobertura de liquidez en Hyperliquid mainnet, capital
real). Branch: feat/portal-ui-fixes, base master. Para ver el diff completo: `git diff` (y el
plan en docs/plan-portal-ui-fixes.md, untracked).

CONTEXTO CRÍTICO DEL PROYECTO:
- Es trading REAL en mainnet beta. Jamás se debe dejar una orden/posición huérfana en HL.
- El motor automático JAV-44 (trigger_arms/trigger_orders) ya está en producción. La regla de oro:
  un bot con un trigger_arm NO terminal tiene órdenes vivas en HL; pausarlo/borrarlo debe pasar
  SIEMPRE por requestDisarmAndDeactivateImpl (desarmado vía cron), nunca un active=false directo
  ni un delete directo.
- convex codegen NO type-checkea los cuerpos a fondo; el type-check real es `deploy`. Asume que
  el deploy se hará después; señala cualquier cosa que rompería en runtime.

SON 5 CAMBIOS (A–E). Audita cada uno por correctitud, seguridad, multi-tenancy y casos límite:

A) CSS .segmented: scroll horizontal en móvil (overflow-x:auto, flex-wrap:nowrap, botones
   flex:0 0 auto). Verifica que el override de la media query (quitar .segmented button del grupo
   flex:1) no rompe el layout del resto (toolbar select / ghost-btn siguen flex:1).

B) CSS .range-chart-price-line: etiqueta "Precio" reordenada a la izquierda con order:2 en ::before.
   Verifica que no tapa la línea de entrada (C) ni se solapa de forma ilegible (z-index price=2,
   entry=1).

C) Línea de "Entrada $X" automática. Revisa CON LUPA:
   - schema.ts: pools.entryPrice/entryPriceAt (opcionales).
   - pools.ts createPool: ahora acepta entryPrice y lo guarda (entryPrice/entryPriceAt) solo si >0.
   - pools.ts setPoolEntryPriceIfMissing (mutation PÚBLICA, llamada desde el cliente): valida
     requireUser + ownership (pool.userId === user._id || admin), idempotente (no pisa si
     entryPrice != null), price>0. ¿Es seguro exponer esta mutation al cliente? ¿Algún vector de
     abuso (un usuario fijando entryPrice arbitrario en SUS pools)? ¿Importa que sea manipulable?
   - BotPortal.jsx: efecto de backfill que recorre poolsFromDb y, por cada pool sin entryPrice con
     precio en vivo, llama setPoolEntryPriceIfMissing una vez (guardado por un useRef Set, con
     rollback del ref en catch). ¿Bucle de escrituras? ¿condición de carrera? ¿el ref se comporta
     bien con el cierre del efecto y las re-renders? ¿`normalizeAsset(p.pair.split('/')[0])` casa
     con la clave de `prices`?
   - Registro (ScanTokenIdModal): pasa entryPrice = result.currentPrice (slot0 al registrar).
   - Render: hasEntry exige entryPrice dentro de [min,max]; fórmula entryPos idéntica a la de
     precio. ¿División por cero si min==max? (mismo patrón que `pos` ya existente).

D) Botón "Eliminar bot" + mutation deletePoolBot. ESTE ES EL MÁS SENSIBLE:
   - bots.ts deletePoolBot(botId): requireBotManager, ownership (userId===user._id || admin),
     idempotente si no existe. Llama requestDisarmAndDeactivateImpl PRIMERO; solo borra
     (ctx.db.delete) si deactivated===true Y hasNonTerminalArmForBot===false; si no, devuelve
     {stopping:true}. ¿Garantiza esto que NUNCA se borra un bot con un arm/orden viva en HL?
     ¿Hay alguna ruta en la que deactivated sea true pero quede un arm vivo, o viceversa?
   - ¿Borrar el registro del bot deja referencias colgando en otras tablas (trigger_arms,
     trigger_orders, execution_requests, hl_api_credentials, índices by_user_account, etc.)?
     ¿Algún cron/reconcile que luego busque ese botId y falle, o que reviva órdenes? ¿Hay que
     limpiar arms terminales o desvincular la cuenta HL antes de borrar?
   - Flujo de 2 pasos (primer click detiene, segundo borra): ¿aceptable, o deja una ventana en la
     que el usuario cree que borró pero el bot sigue? La UI deshabilita "Eliminar" con
     bot.disarmPending mostrando "Deteniendo…". ¿Suficiente?

E) CSS modal: .modal-panel con max-height calc(100dvh-32px) + overflow-y:auto; .modal-overlay
   padding:16px. ¿Afecta negativamente a algún modal concreto (scan, test, confirmación)?

ENTREGA: por cada hallazgo, severidad (BLOCKER/ALTO/MEDIO/BAJO/NIT), archivo:línea, por qué es un
problema en producción real y la corrección concreta. Si todo está bien, dilo explícitamente con
GO. Presta especial atención a D (huérfanos en HL) y al efecto cliente de C (escrituras desde el
navegador).
