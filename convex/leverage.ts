// --- Autoleverage: resolución de apalancamiento + margen (única fuente de verdad) ---
//
// Función PURA usada por las dos mutations de reserva (reserveExecution JAV-43 y reserveArm
// JAV-44) para decidir el leverage entero y el margen requerido JUNTOS, de forma que ninguna
// mutation recalcule el margen por su cuenta (Codex). El leverage enviado a HL (updateLeverage)
// debe ser SIEMPRE el devuelto aquí, el mismo con el que se dimensiona el margen.
//
// Semántica de autoLeverage (función de seguridad acordada con el usuario): proteger al menos el
// nocional del pool aunque el colateral sea pequeño. Base = 10x; si a 10x no cabe, SUBE solo lo
// justo hasta el tope de 20x (y nunca por encima del maxLeverage del activo). Si ni al tope cabe
// → [blocked_margin] (no abre una cobertura infradimensionada en silencio).

export const STANDARD_AUTO_LEVERAGE = 10;   // base cuando autoLeverage está activo
export const AUTO_LEVERAGE_CAP = 20;        // tope duro de autoLeverage (decisión del usuario)
export const MANUAL_LEVERAGE_MIN = 1;
export const MANUAL_LEVERAGE_MAX = 25;      // tope del modo manual (paridad con el gate runtime previo)

// Buffer de seguridad sobre el colateral disponible. FUENTE ÚNICA: el gate de margen de
// executions.ts (reserveExecution) y triggerArms.ts (reserveArm) importa esta MISMA constante, para
// que el `usableReal` con el que dimensionamos el leverage use el MISMO denominador que el gate.
export const MARGIN_SAFETY_BUFFER = 0.10;

export type LeverageResolution = { appliedLeverage: number; marginRequired: number };

/**
 * Resuelve el leverage entero aplicado y el margen requerido coherente con él.
 *
 * @throws Error con prefijo:
 *   - `[blocked_config]` si los argumentos o la metadata son inválidos (NaN/Infinity, maxLeverage
 *     no entero en modo auto, manualLeverage fuera de rango, o manual > maxActivo cuando la metadata
 *     es fiable).
 *   - `[blocked_margin]` si ni siquiera al tope de leverage el nocional cabe en el colateral usable.
 */
export function resolveLeverage(args: {
  autoLeverage: boolean;
  manualLeverage?: number;     // bot.leverage cuando autoLeverage = false
  reservedNotional: number;    // worst-case (2× en OCO de dos entradas)
  availableCollateral: number;
  marginCommitted: number;
  assetMaxLeverage: number;
}): LeverageResolution {
  const { autoLeverage, manualLeverage, reservedNotional, availableCollateral, marginCommitted, assetMaxLeverage } = args;

  // reservedNotional se usa en AMBOS modos (dimensiona el margen) → validación global.
  if (!Number.isFinite(reservedNotional) || reservedNotional <= 0) {
    throw new Error("[blocked_config] reservedNotional debe ser un número finito > 0");
  }

  if (!autoLeverage) {
    // Modo manual. PARIDAD EXACTA con el código previo (auditada por Codex, NO cambiar): se valida
    // el valor CRUDO recibido en el rango [1,25] y DESPUÉS se redondea — igual que antes
    // (effectiveLeverage validado en [1,25] → Math.round). Por eso un 25.4 o un 0.6 se rechazan aquí
    // (como en producción hoy), en vez de redondear-y-luego-validar (lo que CAMBIARÍA ese contrato).
    // (Codex #1) La validación ESTRICTA de assetMaxLeverage NO corre aquí: si HL omite o cambia esa
    // metadata, el modo manual —que no la necesita— no debe bloquearse.
    if (manualLeverage === undefined || !Number.isFinite(manualLeverage)
      || manualLeverage < MANUAL_LEVERAGE_MIN || manualLeverage > MANUAL_LEVERAGE_MAX) {
      throw new Error(`[blocked_config] leverage manual debe estar entre ${MANUAL_LEVERAGE_MIN} y ${MANUAL_LEVERAGE_MAX}`);
    }
    // HL solo acepta leverage entero; el margen se calcula con el MISMO valor aplicado.
    const appliedLeverage = Math.round(manualLeverage);
    // (Codex #2) Rechazar ANTES de reservar un leverage manual > maxActivo: si no, updateLeverage
    // lo rechazaría en HL DESPUÉS de la reserva, dejando la ejecución/arm colgando hasta que el
    // reconciliador la libere (consume margen y muestra estado ambiguo). Solo se aplica cuando la
    // metadata del activo es fiable (entero ≥ 1); si HL la omite (Codex #1), se conserva el
    // comportamiento previo y HL queda como autoridad final, sin bloquear por metadata ausente.
    if (Number.isInteger(assetMaxLeverage) && assetMaxLeverage >= 1 && appliedLeverage > assetMaxLeverage) {
      throw new Error(`[blocked_config] leverage manual ${appliedLeverage}x supera el máximo del activo (${assetMaxLeverage}x)`);
    }
    const marginRequired = reservedNotional / appliedLeverage;
    return { appliedLeverage, marginRequired };
  }

  // Modo auto: aquí SÍ se exige colateral y metadata válidos (los usa el dimensionado del leverage).
  if (!Number.isFinite(availableCollateral) || availableCollateral < 0) {
    throw new Error("[blocked_config] availableCollateral debe ser un número finito >= 0");
  }
  if (!Number.isFinite(marginCommitted) || marginCommitted < 0) {
    throw new Error("[blocked_config] marginCommitted debe ser un número finito >= 0");
  }
  // assetMaxLeverage estrictamente entero ≥ 1: un 20.9 inesperado se RECHAZA (no se trunca).
  if (!Number.isInteger(assetMaxLeverage) || assetMaxLeverage < 1) {
    throw new Error("[blocked_config] assetMaxLeverage inválido (metadata del activo no fiable)");
  }

  // Subir solo lo justo desde el PISO hasta el tope para que el margen quepa.
  const usableReal = availableCollateral * (1 - MARGIN_SAFETY_BUFFER) - marginCommitted;
  if (!(usableReal > 0)) {
    throw new Error("[blocked_margin] Sin colateral usable para abrir la cobertura (fondea la wallet).");
  }
  const hardCap = Math.min(AUTO_LEVERAGE_CAP, assetMaxLeverage);   // ambos enteros
  const needed = Math.ceil(reservedNotional / usableReal);         // mín. leverage entero que cabe
  if (needed > hardCap) {
    throw new Error(
      `[blocked_margin] El colateral no cubre el pool ni al tope de leverage (${hardCap}x): ` +
      `requiere ${needed}x. Fondea la wallet.`);
  }
  // (JAV-68) El PISO del modo auto es el leverage que eligió el usuario en el slider (manualLeverage):
  // autoLeverage SOLO SUBE desde ahí hacia el tope cuando el colateral no alcanza, nunca baja del valor
  // elegido. Si el slider no llega (undefined/inválido en auto), se conserva el fallback histórico
  // STANDARD_AUTO_LEVERAGE (10) para no bloquear el armado por metadata ausente. Un floor mayor que el
  // tope (slider > AUTO_LEVERAGE_CAP/assetMax) queda acotado por el Math.min(hardCap, …) de abajo.
  const floor = (Number.isFinite(manualLeverage) && (manualLeverage as number) >= MANUAL_LEVERAGE_MIN)
    ? Math.round(manualLeverage as number)
    : STANDARD_AUTO_LEVERAGE;
  const appliedLeverage = Math.min(hardCap, Math.max(floor, needed));
  const marginRequired = reservedNotional / appliedLeverage;
  return { appliedLeverage, marginRequired };
}
