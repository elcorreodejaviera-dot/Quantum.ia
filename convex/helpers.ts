import { MutationCtx, QueryCtx } from "./_generated/server";

export async function requireAuth(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity;
}

export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const identity = await requireAuth(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .first();
  if (!user) throw new Error("User not found");
  return user;
}

export async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (user.role !== "admin") throw new Error("Forbidden");
  return user;
}

// Permite gestionar bots a admins o a usuarios con el permiso canManageBots vigente.
export async function requireBotManager(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (user.role === "admin") return user;
  const now = Date.now();
  // Evaluar TODAS las filas: puede haber una revocada y otra vigente (no asumir unicidad).
  const perms = await ctx.db
    .query("user_permissions")
    .withIndex("by_user_permission", (q) =>
      q.eq("userId", user._id).eq("permission", "canManageBots"))
    .collect();
  const ok = perms.some((p) => p.granted && (p.expiresAt === undefined || p.expiresAt > now));
  if (!ok) throw new Error("Forbidden: requiere permiso canManageBots");
  return user;
}
