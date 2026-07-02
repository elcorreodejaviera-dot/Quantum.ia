// (Fase 6-D) Helpers COMPARTIDOS de la vista del arm: usados por CoberturaViva (tiles) y por
// explainBot (frases en lenguaje simple), para que NO diverjan (Codex BAJO#4). Funciones PURAS,
// sin React. `arm` aporta estado/órdenes; `bot` aporta config (stopLossPct/autoRearm/etc.).

// Capital por posición. Tras el OCO el backend ya hizo reservedNotional/2 dejando upperEdge intacto →
// si reservationReduced, NO dividir de nuevo. allowReentryFromAbove marca el OCO de 2 entradas.
export function capitalPerPosition(arm) {
  if (!arm) return null;
  const twoEntries = arm.allowReentryFromAbove === true;
  return arm.reservationReduced ? arm.reservedNotional : arm.reservedNotional / (twoEntries ? 2 : 1);
}

// Leverage EFECTIVO: con autoLeverage y arm vivo → "Auto · Nx"; autoLeverage sin arm → "Auto";
// manual → "Nx". '' si no se conoce.
export function leverageText(bot, arm) {
  const lev = arm?.appliedLeverage ?? bot?.leverage ?? null;
  if (lev == null) return '';
  if (bot?.autoLeverage) return arm?.appliedLeverage != null ? `Auto · ${lev}x` : 'Auto';
  return `${lev}x`;
}

// SL vigente = la orden SL ABIERTA real (nunca inferido desde entryPrice). Hoy el role persistido es
// 'sl_upper'; 'sl' se acepta por forward-compat/legacy.
export function slOrderOpen(arm) {
  return arm?.orders?.find((o) => (o.role === 'sl' || o.role === 'sl_upper') && o.observedStatus === 'open') ?? null;
}

// Estado break-even: 'be' si el SL abierto ya está en break-even (≤ entry·1.001), 'be_pending' si
// beMoved pero el SL sigue arriba (rotando), null si !beMoved.
export function beState(arm, slOrder) {
  if (!arm?.beMoved) return null;
  return (slOrder && arm.entryPrice != null && slOrder.triggerPx <= arm.entryPrice * 1.001) ? 'be' : 'be_pending';
}

// Formateo simple y auto-contenido para las frases (no depende de los formatters de la app: explainBot
// queda puro/testeable). Aproximado ("≈"), suficiente para una explicación en lenguaje natural.
const money = (v) => (v == null || !Number.isFinite(v) ? null : `$${Math.round(v).toLocaleString('en-US')}`);
const px = (v) => (v == null || !Number.isFinite(v) ? null : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

// (JAV-178) Etiqueta legible del lastRearmErrorKind. Solo se traduce blocked_cap ("tope del plan",
// JAV-176-P6 — el usuario debe distinguir cap de plan de margen HL); el resto conserva el kind crudo
// (los textos existentes de la UI/tests dependen de él).
export function rearmKindLabel(kind) {
  return kind === 'blocked_cap' ? 'tope del plan' : kind;
}

// (Fase 6-D) Explica en lenguaje simple qué está haciendo el bot. Devuelve un array de frases (string[]).
// Deriva 1:1 del estado del backend; NUNCA inventa estado ni SL teórico; no maquilla blocked/failed.
export function explainBot(bot, arm, pool, hlBalance) {
  if (!bot) return [];
  const lines = [];
  const asset = bot.baseAsset ?? 'el activo';
  const free = hlBalance?.spotUsdcFree;

  if (arm) {
    const st = arm.status;
    if (st === 'arming' || st === 'submitting') {
      lines.push(`Armando la cobertura de ${asset}…`);
    } else if (st === 'armed' || st === 'armed_lower_only') {
      const lo = px(arm.lowerEdge);
      const up = arm.upperEdge != null ? px(arm.upperEdge) : null;
      if (lo) lines.push(up ? `Esperando a que ${asset} toque ${lo} o ${up}.` : `Esperando a que ${asset} toque ${lo}.`);
      const cap = money(capitalPerPosition(arm));
      if (cap) lines.push(`Si perfora abajo, cubro un short de ≈${cap}${leverageText(bot, arm) ? ` (${leverageText(bot, arm)})` : ''}.`);
    } else if (st === 'filled' || st === 'protecting' || st === 'protected') {
      const entry = px(arm.entryPrice);
      if (entry) lines.push(`Short de ${asset} abierto en ≈${entry}.`);
      const sl = slOrderOpen(arm);
      if (sl) {
        lines.push(`Protección en ≈${px(sl.triggerPx)}${beState(arm, sl) === 'be' ? ' (movido a break-even)' : ''}.`);
      } else if (st === 'protecting') {
        lines.push('Colocando la protección…');
      }
    } else if (st === 'disarming') {
      lines.push('Deteniendo la cobertura…');
    } else if (st === 'unknown') {
      lines.push('Verificando la cobertura…');
    } else if (st === 'failed') {
      // (CodeRabbit) `failed` es EXCLUSIVO: un arm fallido no tiene cobertura viva → solo el mensaje de
      // fallo, sin capital ni nota de auto-rearm (que ya estaba excluida).
      lines.push('El último armado falló.');
      return lines;
    }
    // (Codex MEDIO#1) Es CAPITAL por posición (deriva de reservedNotional), NO margen (marginReserved no
    // se expone en listMyActiveArms). `disponible` = saldo HL libre.
    const cap = money(capitalPerPosition(arm));
    if (cap) lines.push(`Capital por posición: ${cap}${money(free) ? ` · disponible ${money(free)}` : ''}.`);
    if (bot.autoRearm && st !== 'failed') lines.push('Si cierra por SL, reintento la cobertura en ~5 min.');
  } else if (bot.disarmPending) {
    lines.push('Deteniéndose…');
  } else if (bot.rearmStatus === 'blocked') {
    lines.push(`Bloqueado${bot.lastRearmErrorKind ? `: ${rearmKindLabel(bot.lastRearmErrorKind)}` : ''}. Revisa margen o plan.`);
  } else if (bot.rearmStatus === 'pending' || bot.rearmStatus === 'running') {
    lines.push('Reabriendo la cobertura tras un cierre…');
  } else if (!bot.active) {
    lines.push('Pausado.');
  } else {
    lines.push('Esperando para armar la cobertura.');
  }
  return lines;
}
