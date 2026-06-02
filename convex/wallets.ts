import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireAdmin, requireUser } from "./helpers";

export const listWallets = query({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    return await ctx.db.query("wallets").collect();
  },
});

export const addWallet = mutation({
  args: {
    label: v.string(),
    type: v.string(),
    address: v.string(),
    network: v.string(),
    ownerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db.insert("wallets", args);
  },
});

export const removeWallet = mutation({
  args: { id: v.id("wallets") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const wallet = await ctx.db.get(id);
    if (!wallet) throw new Error("Wallet not found");
    await ctx.db.delete(id);
  },
});

// ─── Wallets personales del usuario ───────────────────────────────────────

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const BTC_RE = /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/;

export const listMyWallets = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return await ctx.db
      .query("wallets")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id.toString()))
      .collect();
  },
});

export const addMyWallet = mutation({
  args: {
    label: v.string(),
    address: v.string(),
    network: v.string(),
  },
  handler: async (ctx, { label, address, network }) => {
    const user = await requireUser(ctx);
    const addr = address.trim();

    if (network === "Bitcoin") {
      if (!BTC_RE.test(addr)) throw new Error("Dirección Bitcoin inválida");
    } else {
      const normalized = addr.toLowerCase();
      if (!EVM_RE.test(normalized)) throw new Error("Dirección EVM inválida — debe ser 0x + 40 hex");
      return await ctx.db.insert("wallets", {
        label: label.trim() || network,
        address: normalized,
        network,
        type: "personal",
        ownerId: user._id.toString(),
      });
    }

    return await ctx.db.insert("wallets", {
      label: label.trim() || network,
      address: addr,
      network,
      type: "personal",
      ownerId: user._id.toString(),
    });
  },
});

export const removeMyWallet = mutation({
  args: { id: v.id("wallets") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const wallet = await ctx.db.get(id);
    if (!wallet || wallet.ownerId !== user._id.toString()) throw new Error("No encontrada");
    await ctx.db.delete(id);
  },
});
