import { internalMutation, internalQuery } from "./_generated/server";

// Estados terminales de un arm (espejo de triggerArms.ts ARM_TERMINAL). Un arm terminal NO debería
// tener trigger_orders vivas en HL (el motor cancela antes de cerrar).
const ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);

// Backfill de userId en bots existentes (Fase 1 de JAV-35).
//
// Históricamente la tabla `bots` no tenía userId y solo el admin podía crear
// bots (createBot/seed usan requireAdmin), por lo que los registros previos
// pertenecen al admin. Esta migración los asigna al primer admin encontrado.
//
// Idempotente: solo toca bots sin userId. Segura de re-ejecutar.
// Llamar una vez desde el Convex dashboard: internal.migrations.backfillBotsUserId
export const backfillBotsUserId = internalMutation({
  args: {},
  handler: async (ctx) => {
    const admin = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("role"), "admin"))
      .first();

    if (!admin) {
      return { skipped: true, reason: "no admin user found" };
    }

    const bots = await ctx.db.query("bots").collect();
    let patched = 0;
    let paused = 0;
    for (const bot of bots) {
      const patch: { userId?: typeof admin._id; active?: boolean } = {};
      if (bot.userId === undefined) patch.userId = admin._id;
      // Con el filtrado estricto por poolId, un bot activo sin pool quedaría inerte.
      // Pausarlo evita el estado engañoso "activo pero no protege nada" tras el deploy.
      if (bot.active && !bot.poolId) { patch.active = false; paused++; }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(bot._id, patch);
        if (patch.userId !== undefined) patched++;
      }
    }

    return { patched, paused, total: bots.length, adminId: admin._id };
  },
});

// Backfill de autoRearm en bots de protección IL existentes.
//
// El motor solo programa el re-armado post-SL si bot.autoRearm === true
// (triggerArms.ts closeArmAndScheduleRearm). Los bots IL creados antes de exponer el campo lo tienen
// `undefined` y por eso no reponían la cobertura tras un stop loss. Esta migración los pasa a `true`
// para honrar "siempre protegido".
//
// Acotada y segura: SOLO toca bots kind === "il" con autoRearm === undefined. Un `false` explícito
// del usuario se respeta (no se pisa). NO modifica estado operacional (rearmStatus/nextRearmAt/arms)
// ni abre posiciones: solo habilita el re-armado FUTURO. Idempotente (segunda corrida → patched: 0).
// Llamar una vez desde el Convex dashboard: internal.migrations.backfillIlAutoRearm
export const backfillIlAutoRearm = internalMutation({
  args: {},
  handler: async (ctx) => {
    const bots = await ctx.db.query("bots").collect();
    let patched = 0;
    let eligible = 0;
    for (const bot of bots) {
      if (bot.kind !== "il" || bot.autoRearm !== undefined) continue;
      eligible++;
      await ctx.db.patch(bot._id, { autoRearm: true });
      patched++;
    }
    return { patched, eligible, total: bots.length };
  },
});

// (JAV-98) Diagnóstico READ-ONLY del falso positivo orphan_orders: lista las trigger_orders con
// observedStatus open/pending cuyo arm está TERMINAL (dato rancio que JAV-96 ya no produce hacia
// adelante, pero quedó de antes del deploy). Correr ANTES del backfill para inspeccionar:
//   npx convex run migrations:diagnoseOrphanOrders
export const diagnoseOrphanOrders = internalQuery({
  args: {},
  handler: async (ctx) => {
    const orders = await ctx.db.query("trigger_orders").collect();
    const armCache = new Map<string, any>();
    const stale: Array<{ armId: string; botId: string; armStatus: string; role: string; cloid: string; observedStatus: string }> = [];
    for (const o of orders) {
      if (o.observedStatus !== "open" && o.observedStatus !== "pending") continue;
      let arm = armCache.get(o.armId);
      if (arm === undefined) { arm = await ctx.db.get(o.armId); armCache.set(o.armId, arm); }
      if (!arm || !ARM_TERMINAL.has(arm.status)) continue;
      stale.push({ armId: String(o.armId), botId: String(arm.botId), armStatus: arm.status, role: o.role, cloid: o.cloid, observedStatus: o.observedStatus });
    }
    return { count: stale.length, stale };
  },
});

// (JAV-98) Backfill: marca observedStatus open/pending → canceled SOLO en trigger_orders de arms
// TERMINALES (nunca toca un arm vivo). Normaliza el dato rancio que el panel de auditoría leía como
// orphan_orders. NO toca HL, NO envía/cancela órdenes: solo el campo de display. Idempotente.
//   npx convex run migrations:backfillCanceledOrphanOrders
export const backfillCanceledOrphanOrders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orders = await ctx.db.query("trigger_orders").collect();
    const armCache = new Map<string, any>();
    const now = Date.now();
    let scanned = 0, patched = 0;
    const byStatus: Record<string, number> = {};
    for (const o of orders) {
      if (o.observedStatus !== "open" && o.observedStatus !== "pending") continue;
      scanned++;
      let arm = armCache.get(o.armId);
      if (arm === undefined) { arm = await ctx.db.get(o.armId); armCache.set(o.armId, arm); }
      if (!arm || !ARM_TERMINAL.has(arm.status)) continue;   // SOLO arms terminales
      byStatus[o.observedStatus] = (byStatus[o.observedStatus] ?? 0) + 1;
      await ctx.db.patch(o._id, { observedStatus: "canceled", updatedAt: now });
      patched++;
    }
    return { scanned, patched, byStatus };
  },
});
