import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, requireBotManager, requireTradeLive, getUserOrNull, writeAdminLog } from "./helpers";
import { elog } from "./log";

// (QSG / JAV-91) Spot Grid Live — persistencia + comandos backend. NON-node (convex-testable). NO envía
// órdenes a HL (eso es el motor de PR3). La resolución de activo/precio/balance vía RPC vive en la
// action `createSpotGridBot` (convex/spotGridActions.ts, "use node"), que PRIMERO corre el preflight
// (guards de DB, antes de tocar HL) y luego delega el persistido (re-valida todo, atómico con el insert).

const MAINNET_GATE_KEY = "mainnetSpotGridApproved";
// Espejo NON-node de la constante de hyperliquidSpot.ts (no se puede importar de un módulo "use node"
// sin contaminar este archivo). HL rechaza órdenes spot por debajo de ~$10.
const MIN_SPOT_NOTIONAL_USD = 10;

type GridInputs = {
  minPrice: number; gridProfitPercent: number; investmentAmount: number;
  orderSize: number; gridCount: number; feeRate: number;
};

// Validación PURA de parámetros del grid (sin red, sin balance). Reusada por preflight y persist.
// (Codex ALTO) El presupuesto total del grid = orderSize × gridCount NO puede superar investmentAmount.
// (Codex MEDIO) orderSize no puede caer bajo el mínimo notional de HL (~$10).
function validateGridInputs(a: GridInputs): void {
  for (const [k, val] of [["minPrice", a.minPrice], ["gridProfitPercent", a.gridProfitPercent],
    ["investmentAmount", a.investmentAmount], ["orderSize", a.orderSize]] as const) {
    if (!(val > 0)) throw new Error(`Parámetro inválido: ${k} debe ser > 0.`);
  }
  if (!(Number.isInteger(a.gridCount) && a.gridCount >= 1)) throw new Error("gridCount debe ser entero ≥ 1.");
  if (a.feeRate < 0) throw new Error("feeRate no puede ser negativo.");
  if (a.orderSize < MIN_SPOT_NOTIONAL_USD) {
    throw new Error(`orderSize ${a.orderSize} < mínimo notional de HL (${MIN_SPOT_NOTIONAL_USD} USDC).`);
  }
  if (a.orderSize * a.gridCount > a.investmentAmount) {
    throw new Error(`Presupuesto del grid (orderSize×gridCount = ${a.orderSize * a.gridCount}) supera investmentAmount (${a.investmentAmount}).`);
  }
}

async function getConfigBool(ctx: QueryCtx | MutationCtx, key: string): Promise<boolean> {
  const row = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", key)).first();
  return row?.value === true;
}

// Guards de DB compartidos por preflight (query, ANTES de la RPC) y persist (mutation, atómico con el
// insert): permisos (canManageBots + canTradeLive AMBOS), switches live-only, gate mainnet, ownership y
// exclusividad TOTAL de cuenta. Devuelve el user (manager) y la credencial. Funciona en Query y Mutation.
async function assertCreateGuards(
  ctx: QueryCtx | MutationCtx, hlAccountId: Id<"hl_api_credentials">, network: "mainnet" | "testnet",
) {
  // Crear infraestructura de bots = permiso de GESTIÓN; operar real = canTradeLive. AMBOS requeridos.
  const manager = await requireBotManager(ctx);
  await requireTradeLive(ctx);
  if (!(await getConfigBool(ctx, "tradingEnabled"))) throw new Error("Trading global deshabilitado (kill switch).");
  if (await getConfigBool(ctx, "simulationMode")) throw new Error("Modo simulación global activo: Spot Grid es live-only.");
  if (network === "mainnet") {
    const gate = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    if ((gate?.value as any)?.enabled !== true) throw new Error("Spot Grid en mainnet no aprobado por admin.");
  }
  const cred = await ctx.db.get(hlAccountId);
  if (!cred || cred.userId !== manager._id) throw new Error("Cuenta HL no encontrada o ajena.");
  // 🔑 Exclusividad TOTAL de cuenta (JAV-89/JAV-91): tradingAccountAddress (1:1 con la credencial,
  // unicidad global) NO la puede usar ningún bot IL/Trading ni otro spot grid vivo. En HL spot y perp
  // viven en la MISMA wallet → compartir cuenta mezclaría órdenes/balance.
  const perpBot = await ctx.db.query("bots")
    .withIndex("by_user_account", (q) => q.eq("userId", cred.userId).eq("hlAccountId", hlAccountId)).first();
  if (perpBot) throw new Error("Esa cuenta HL ya la usa un bot de cobertura/trading: usa una cuenta dedicada.");
  const otherGrid = (await ctx.db.query("spot_grid_bots")
    .withIndex("by_account", (q) => q.eq("hlAccountId", hlAccountId)).collect())
    .find((b) => b.status !== "stopped");
  if (otherGrid) throw new Error("Esa cuenta HL ya la usa otro Spot Grid activo: usa una cuenta dedicada.");
  return { manager, cred };
}

// --- Gate mainnet: aprobación admin sellada (Codex #2-r3) -----------------------------------------
export const setMainnetSpotGridApproval = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const admin = await requireAdmin(ctx);
    const existing = await ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", MAINNET_GATE_KEY)).first();
    const value = { enabled, approvedAt: Date.now(), approvedBy: admin.clerkId };
    if (existing) await ctx.db.patch(existing._id, { value });
    else await ctx.db.insert("system_config", { key: MAINNET_GATE_KEY, value });
    await writeAdminLog(ctx, admin.clerkId, "set_mainnet_spot_grid_approval", { enabled });
    return { ok: true as const };
  },
});

// --- Preflight (Codex MEDIO #2): valida TODO lo que NO necesita HL (permisos, switches, gate, ownership,
// exclusividad, inputs) ANTES de cualquier RPC. La action lo corre primero; si falla, nunca toca HL.
// Devuelve la tradingAccountAddress para las lecturas públicas.
export const preflightCreateSpotGridBot = internalQuery({
  args: {
    hlAccountId: v.id("hl_api_credentials"),
    network: v.union(v.literal("mainnet"), v.literal("testnet")),
    minPrice: v.number(), gridProfitPercent: v.number(), investmentAmount: v.number(),
    orderSize: v.number(), gridCount: v.number(), feeRate: v.number(),
  },
  handler: async (ctx, a) => {
    const { cred } = await assertCreateGuards(ctx, a.hlAccountId, a.network);
    validateGridInputs(a);
    return { tradingAccountAddress: cred.tradingAccountAddress };
  },
});

// --- Persistir el bot: re-valida TODOS los guards + inputs + balance, atómico con el insert ---------
export const persistSpotGridBot = internalMutation({
  args: {
    hlAccountId: v.id("hl_api_credentials"),
    symbol: v.string(), assetId: v.number(), baseAsset: v.string(), quoteAsset: v.string(),
    minPrice: v.number(), gridProfitPercent: v.number(), investmentAmount: v.number(),
    orderSize: v.number(), gridCount: v.number(), feeRate: v.number(),
    currentPrice: v.number(), freeQuoteBalance: v.number(),
    network: v.union(v.literal("mainnet"), v.literal("testnet")),
  },
  handler: async (ctx, a) => {
    const { manager } = await assertCreateGuards(ctx, a.hlAccountId, a.network);
    validateGridInputs(a);
    if (!(a.currentPrice > 0)) throw new Error("Parámetro inválido: currentPrice debe ser > 0.");
    if (a.freeQuoteBalance < a.investmentAmount) {
      throw new Error(`Balance ${a.quoteAsset} insuficiente: ${a.freeQuoteBalance} < ${a.investmentAmount}.`);
    }
    const now = Date.now();
    const botId = await ctx.db.insert("spot_grid_bots", {
      userId: manager._id, hlAccountId: a.hlAccountId, symbol: a.symbol, assetId: a.assetId,
      baseAsset: a.baseAsset, quoteAsset: a.quoteAsset, minPrice: a.minPrice,
      gridProfitPercent: a.gridProfitPercent, investmentAmount: a.investmentAmount, orderSize: a.orderSize,
      gridCount: a.gridCount, feeRate: a.feeRate, currentPrice: a.currentPrice,
      status: "running", network: a.network, generation: 1,
      createdAt: now, updatedAt: now,
    });
    elog("spotgrid", "bot_created", { botId: String(botId), gridCount: a.gridCount });
    return { ok: true as const, botId };
  },
});

// --- Pausa (NO toca HL; el motor de PR3 deja de colocar) -------------------------------------------
export const pauseSpotGridBot = mutation({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) throw new Error("Bot no encontrado o ajeno.");
    if (bot.status === "stopped") throw new Error("El bot ya está detenido.");
    await ctx.db.patch(botId, { status: "paused", updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// --- Lecturas por-usuario --------------------------------------------------------------------------
export const listSpotGridBots = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUserOrNull(ctx);             // (JAV-82) tolera el race del primer login
    if (!user) return [];
    return await ctx.db.query("spot_grid_bots").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
  },
});

export const getSpotGridBot = query({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => {
    const user = await getUserOrNull(ctx);
    if (!user) return null;
    const bot = await ctx.db.get(botId);
    if (!bot || bot.userId !== user._id) return null;
    return bot;
  },
});

// --- Internal query para el motor (PR3) ------------------------------------------------------------
export const getSpotGridBotInternal = internalQuery({
  args: { botId: v.id("spot_grid_bots") },
  handler: async (ctx, { botId }) => ctx.db.get(botId),
});
