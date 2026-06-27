// (JAV-122) Constantes compartidas de resiliencia a errores transitorios de HL para el Spot Grid.
// Módulo HOJA SIN "use node": lo importan tanto spotGridBots.ts (non-node, convex-testable, las usa en
// los bumps/escalada) como spotGridEngine.ts ("use node"). NO importar el SDK ni nada de node aquí, para
// no contaminar el módulo non-node. Espejo conceptual de los backoffs/topes de triggerRearm.ts (JAV-44).

// Backoff corto entre reintentos tras un transitorio con el bot ACTIVO. El cron corre 1/min, así que en la
// práctica es "próximo tick"; su rol es cerrar la ventana de re-claim inmediato dentro del mismo minuto.
export const SPOT_GRID_TRANSIENT_BACKOFF_MS = 60_000;
// Tope de transitorios CONSECUTIVOS con el bot activo: superado, se ESCALA a error+errorKind:"transient"
// (recuperable) con alerta. Con cron 1/min son ~12 min de 502 ininterrumpido antes de escalar.
export const SPOT_GRID_MAX_TRANSIENT_FAILS = 12;
// Backoff largo entre reintentos de RECUPERACIÓN desde `error` (Parte 2).
export const SPOT_GRID_ERROR_RETRY_BACKOFF_MS = 15 * 60_000;
// Tope de reintentos de recuperación; superado, el bot queda `error` terminal (la query deja de devolverlo).
export const SPOT_GRID_MAX_ERROR_RECOVERIES = 8;

// Mensajes LIMPIOS (nunca el cuerpo HTML de un 502). El transitorio NO se persiste en el bot mientras
// reintenta; este texto se usa solo en la escalada y en los catches de orden/actions.
export const SPOT_GRID_TRANSIENT_MSG = "Error transitorio de Hyperliquid (red/5xx/timeout); reintentando.";
// Terminal accionable al agotar los reintentos de recuperación (la UI muestra errorMessage).
export const SPOT_GRID_RECOVERY_EXHAUSTED_MSG =
  "Errores transitorios de HL persistentes: reintentos automáticos agotados; revisá o reiniciá el bot.";
// Defensa: recovery invocada sobre un error-transient sin estado de retorno (no debería pasar dado el
// filtro de la query). Terminaliza a fatal con este texto.
export const SPOT_GRID_NO_RECOVER_STATUS_MSG = "Estado de retorno desconocido; reiniciá el bot.";
