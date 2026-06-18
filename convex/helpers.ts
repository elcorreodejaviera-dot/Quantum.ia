import { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// Normaliza símbolos wrapped → activo base de HL. Espejo (no-node) del map de
// convex/actions/poolScanner.ts y BotPortal.jsx. Deriva el baseAsset de un par "WETH/USDC".
const NORMALIZE_ASSET: Record<string, string> = { WETH: "ETH", WBTC: "BTC" };
export function deriveBaseAsset(pair: string): string {
  const sym = (pair.split("/")[0] ?? "").trim().toUpperCase();
  return NORMALIZE_ASSET[sym] ?? sym;
}

// (JAV-38 #8) Acepta también ActionCtx: solo usa ctx.auth, presente en los tres contextos.
// Permite exigir auth en actions públicas (p.ej. scanPoolByTokenId / fetchPositionLiquidity).
export async function requireAuth(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity;
}

// (JAV-82) Para LECTURAS por-usuario que montan en el primer login: si hay sesión Clerk pero el
// doc de Convex aún no existe (race con getOrCreateUser, que corre en un useEffect posterior),
// devuelve null en vez de lanzar "User not found". Sigue exigiendo identidad (sin sesión →
// "Not authenticated", error legítimo). SOLO QueryCtx: imposible de usar en mutations/money-path
// por tipo (ahí requireUser DEBE fallar). NO añadir MutationCtx a esta firma.
export async function getUserOrNull(ctx: QueryCtx) {
  const identity = await requireAuth(ctx);
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .first();
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

// ¿El usuario es admin o tiene un permiso vigente? Evalúa TODAS las filas (el esquema permite
// duplicados): basta una granted y no expirada. Admin tiene bypass implícito.
export async function hasPermission(
  ctx: QueryCtx | MutationCtx,
  user: { _id: Id<"users">; role: string },
  permission: string,
): Promise<boolean> {
  if (user.role === "admin") return true;
  const now = Date.now();
  const perms = await ctx.db
    .query("user_permissions")
    .withIndex("by_user_permission", (q) =>
      q.eq("userId", user._id).eq("permission", permission))
    .collect();
  return perms.some((p) => p.granted && (p.expiresAt === undefined || p.expiresAt > now));
}

// Permite gestionar bots a admins o a usuarios con el permiso canManageBots vigente.
export async function requireBotManager(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (!(await hasPermission(ctx, user, "canManageBots"))) {
    throw new Error("Forbidden: requiere permiso canManageBots");
  }
  return user;
}

// Autorización de trading real (separada de canManageBots). Admin tiene bypass.
export async function requireTradeLive(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (!(await hasPermission(ctx, user, "canTradeLive"))) {
    throw new Error("Forbidden: requiere permiso canTradeLive");
  }
  return user;
}
