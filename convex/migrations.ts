import { internalMutation } from "./_generated/server";

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
