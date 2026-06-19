import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (Fase 4 PR2, Codex BAJO#5) Helpers de sembrado con defaults VÁLIDOS de schema + overrides pequeños.
// Evita que un fixture ad-hoc mal formado haga pasar un test por la razón equivocada. Se usan dentro
// de t.run((ctx) => ...). Cada uno devuelve el id insertado.

type Ctx = MutationCtx;

export async function seedUser(ctx: Ctx, over: Partial<{ clerkId: string; role: "admin" | "viewer" }> = {}) {
  return await ctx.db.insert("users", { clerkId: over.clerkId ?? `clerk_${Math.random()}`, role: over.role ?? "viewer" });
}

export async function seedCredential(ctx: Ctx, userId: Id<"users">) {
  const now = Date.now();
  return await ctx.db.insert("hl_api_credentials", {
    userId, agentAddress: `0xagent${Math.random()}`, tradingAccountAddress: `0xacct${Math.random()}`,
    encryptedPrivateKey: "enc", iv: "iv", authTag: "tag", createdAt: now, updatedAt: now,
  });
}

export async function seedPool(ctx: Ctx) {
  return await ctx.db.insert("pools", { pair: "ETH/USDC", network: "testnet", minRange: 1, maxRange: 2, status: "open" });
}

export async function seedBot(ctx: Ctx, over: Partial<{ userId: Id<"users">; name: string; active: boolean; simulationMode: boolean }> = {}) {
  return await ctx.db.insert("bots", {
    name: over.name ?? "bot", active: over.active ?? true, simulationMode: over.simulationMode ?? false,
    ...(over.userId ? { userId: over.userId } : {}),
  });
}

// Entorno base reutilizable: user + credencial + pool + bot enlazados.
export async function seedBase(ctx: Ctx) {
  const userId = await seedUser(ctx);
  const hlAccountId = await seedCredential(ctx, userId);
  const poolId = await seedPool(ctx);
  const botId = await seedBot(ctx, { userId });
  return { userId, hlAccountId, poolId, botId };
}

type ExecStatus =
  | "pending" | "submitting" | "entry_filled" | "protected" | "sl_failed" | "closed" | "unknown" | "failed";

export async function seedExecutionRequest(
  ctx: Ctx,
  base: { userId: Id<"users">; botId: Id<"bots">; hlAccountId: Id<"hl_api_credentials"> },
  over: Partial<{ status: ExecStatus; notional: number; marginReserved: number; reconcileLeaseToken: string; reconcileLeaseUntil: number; historyRecorded: boolean }> = {},
): Promise<Id<"execution_requests">> {
  const now = Date.now();
  return await ctx.db.insert("execution_requests", {
    userId: base.userId, botId: base.botId, hlAccountId: base.hlAccountId,
    idempotencyKey: `idem_${Math.random()}`, asset: "ETH", stopLossPct: 5,
    requestedAmount: 100, notional: over.notional ?? 100,
    ...(over.marginReserved !== undefined ? { marginReserved: over.marginReserved } : {}),
    side: "Long", status: over.status ?? "pending", network: "testnet",
    entryCloid: "0xentry", slCloid: "0xsl",
    ...(over.reconcileLeaseToken ? { reconcileLeaseToken: over.reconcileLeaseToken } : {}),
    ...(over.reconcileLeaseUntil !== undefined ? { reconcileLeaseUntil: over.reconcileLeaseUntil } : {}),
    ...(over.historyRecorded !== undefined ? { historyRecorded: over.historyRecorded } : {}),
    createdAt: now, updatedAt: now,
  });
}

type ArmStatus =
  | "arming" | "submitting" | "armed" | "disarming" | "disarmed" | "filled"
  | "protecting" | "protected" | "armed_lower_only" | "closed" | "failed" | "unknown";

export async function seedTriggerArm(
  ctx: Ctx,
  base: { userId: Id<"users">; botId: Id<"bots">; hlAccountId: Id<"hl_api_credentials">; poolId: Id<"pools"> },
  over: Partial<{ status: ArmStatus; marginReserved: number; reservedNotional: number; submittedAt: number; reconcileLeaseToken: string; reconcileLeaseUntil: number; generation: number }> = {},
): Promise<Id<"trigger_arms">> {
  const now = Date.now();
  return await ctx.db.insert("trigger_arms", {
    botId: base.botId, userId: base.userId, hlAccountId: base.hlAccountId, poolId: base.poolId,
    asset: "ETH", network: "testnet", generation: over.generation ?? 1,
    status: over.status ?? "armed", desiredState: "armed", side: "Short",
    triggerPx: 1, size: 1, appliedLeverage: 10,
    reservedNotional: over.reservedNotional ?? 100, marginReserved: over.marginReserved ?? 10,
    lowerEdge: 1, stopLossPct: 5,
    ...(over.submittedAt !== undefined ? { submittedAt: over.submittedAt } : {}),
    ...(over.reconcileLeaseToken ? { reconcileLeaseToken: over.reconcileLeaseToken } : {}),
    ...(over.reconcileLeaseUntil !== undefined ? { reconcileLeaseUntil: over.reconcileLeaseUntil } : {}),
    createdAt: now, updatedAt: now,
  });
}
