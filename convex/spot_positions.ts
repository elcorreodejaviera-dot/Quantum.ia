import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listMyPositions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    return ctx.db
      .query("spot_positions")
      .withIndex("by_user_id", (q) => q.eq("userId", identity.subject))
      .collect();
  },
});

export const addPosition = mutation({
  args: {
    asset: v.string(),
    amount: v.number(),
    dca: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    if (args.amount <= 0) throw new Error("amount must be > 0");
    if (args.dca <= 0) throw new Error("dca must be > 0");

    const id = await ctx.db.insert("spot_positions", { ...args, userId: identity.subject });
    await ctx.db.insert("purchase_history", {
      userId: identity.subject,
      asset: args.asset,
      qty: args.amount,
      price: args.dca,
      dcaBefore: 0,
      dcaAfter: args.dca,
      amountBefore: 0,
      amountAfter: args.amount,
      timestamp: Date.now(),
    });
    return id;
  },
});

export const updatePosition = mutation({
  args: {
    id: v.id("spot_positions"),
    amount: v.optional(v.number()),
    dca: v.optional(v.number()),
  },
  handler: async (ctx, { id, amount, dca }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const pos = await ctx.db.get(id);
    if (!pos) throw new Error("Position not found");
    if (pos.userId !== identity.subject) throw new Error("Forbidden");
    const patch: { amount?: number; dca?: number } = {};
    if (amount !== undefined && amount > 0) patch.amount = amount;
    if (dca !== undefined && dca > 0) patch.dca = dca;
    if (Object.keys(patch).length > 0) await ctx.db.patch(id, patch);
  },
});

export const recordPurchase = mutation({
  args: {
    asset: v.string(),
    qty: v.number(),
    price: v.number(),
    dcaBefore: v.number(),
    dcaAfter: v.number(),
    amountBefore: v.number(),
    amountAfter: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    return ctx.db.insert("purchase_history", {
      ...args,
      userId: identity.subject,
      timestamp: Date.now(),
    });
  },
});

export const listPurchaseHistory = query({
  args: { asset: v.string() },
  handler: async (ctx, { asset }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    return ctx.db
      .query("purchase_history")
      .withIndex("by_user_asset_time", (q) =>
        q.eq("userId", identity.subject).eq("asset", asset)
      )
      .order("desc")
      .take(30);
  },
});

// (JAV-107 4c, Codex ALTO) Estados terminales de un arm de defensa: sin arm vivo en ninguno de estos.
const SD_ARM_TERMINAL = new Set(["disarmed", "closed", "failed"]);

export const removePosition = mutation({
  args: { id: v.id("spot_positions") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const pos = await ctx.db.get(id);
    if (!pos) throw new Error("Position not found");
    if (pos.userId !== identity.subject) throw new Error("Forbidden");
    // (Codex 4c ALTO) NO borrar la posición si tiene una defensa spot viva: dejaría el bot/short/órdenes
    // huérfanos (sin posición que matchee → sin tarjeta ni controles en la UI). Se exige pausar/detener
    // la defensa primero (la pausa cancela/cierra en HL y deja el bot stopped + arm terminal). Se busca por
    // spotPositionId (índice dedicado) porque spot_positions.userId=clerkId ≠ spot_defense_bots.userId.
    const defenseBots = await ctx.db.query("spot_defense_bots")
      .withIndex("by_position", (q) => q.eq("spotPositionId", id)).collect();
    for (const bot of defenseBots) {
      const liveArm = (await ctx.db.query("spot_defense_arms")
        .withIndex("by_bot_generation", (q) => q.eq("botId", bot._id)).collect())
        .find((a) => !SD_ARM_TERMINAL.has(a.status));
      if (bot.active || bot.status !== "stopped" || bot.disarmPending || liveArm) {
        throw new Error("Esta posición tiene una defensa spot activa. Pausa/detén la defensa antes de eliminar la posición.");
      }
    }
    await ctx.db.delete(id);
  },
});
