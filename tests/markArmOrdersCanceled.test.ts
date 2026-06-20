import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedBase, seedTriggerArm } from "./fixtures";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-96) markArmOrdersCanceled: marca canceled SOLO open/pending, por CLOID exacto, bajo fencing.
// Congela el invariante "terminal tras muerte confirmada ⇒ open/pending → canceled; filled/triggered/
// rejected/canceled NO cambian; nunca toca órdenes de otro arm ni cloids fuera de la lista".

type OrderOver = { role?: "entry_lower" | "entry_upper" | "sl_upper" | "tp" | "tp_final"; observedStatus?: string };
async function seedOrder(ctx: MutationCtx, armId: Id<"trigger_arms">, cloid: string, over: OrderOver = {}) {
  const now = Date.now();
  return await ctx.db.insert("trigger_orders", {
    armId, role: (over.role ?? "entry_lower") as any, cloid, triggerPx: 1, size: 1, reduceOnly: false,
    observedStatus: (over.observedStatus ?? "open") as any, createdAt: now, updatedAt: now,
  });
}

const LEASE = { reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 };
const obs = (t: any, id: Id<"trigger_orders">) => t.run((ctx: MutationCtx) => ctx.db.get(id)).then((o: any) => o?.observedStatus);

describe("markArmOrdersCanceled (JAV-96)", () => {
  it("open/pending → canceled; filled/triggered/rejected/canceled NO cambian; solo los cloids pasados", async () => {
    const t = makeConvexTest();
    const seeded = await t.run(async (ctx) => {
      const base = await seedBase(ctx);
      const armId = await seedTriggerArm(ctx, base, { status: "closed", ...LEASE });
      const oOpen = await seedOrder(ctx, armId, "0xopen", { role: "entry_lower", observedStatus: "open" });
      const oPending = await seedOrder(ctx, armId, "0xpending", { role: "entry_upper", observedStatus: "pending" });
      const oFilled = await seedOrder(ctx, armId, "0xfilled", { role: "sl_upper", observedStatus: "filled" });
      const oTriggered = await seedOrder(ctx, armId, "0xtrig", { role: "tp", observedStatus: "triggered" });
      const oRejected = await seedOrder(ctx, armId, "0xrej", { role: "tp_final", observedStatus: "rejected" });
      const oOther = await seedOrder(ctx, armId, "0xother", { role: "tp", observedStatus: "open" }); // NO en la lista
      return { armId, oOpen, oPending, oFilled, oTriggered, oRejected, oOther };
    });
    const { armId, oOpen, oPending, oFilled, oTriggered, oRejected, oOther } = seeded;
    const r = await t.mutation(internal.triggerArms.markArmOrdersCanceled, {
      armId, token: "owner", cloids: ["0xopen", "0xpending", "0xfilled", "0xtrig", "0xrej"],
    });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(2);                                  // solo open + pending
    expect(await obs(t, oOpen)).toBe("canceled");
    expect(await obs(t, oPending)).toBe("canceled");
    expect(await obs(t, oFilled)).toBe("filled");          // terminales reales intactos
    expect(await obs(t, oTriggered)).toBe("triggered");
    expect(await obs(t, oRejected)).toBe("rejected");
    expect(await obs(t, oOther)).toBe("open");             // cloid fuera de la lista NO se toca
  });

  it("fencing: token ajeno = no-op", async () => {
    const t = makeConvexTest();
    const { armId, oOpen } = await t.run(async (ctx) => {
      const base = await seedBase(ctx);
      const armId = await seedTriggerArm(ctx, base, { status: "closed", ...LEASE });
      const oOpen = await seedOrder(ctx, armId, "0xopen", { observedStatus: "open" });
      return { armId, oOpen };
    });
    const r = await t.mutation(internal.triggerArms.markArmOrdersCanceled, { armId, token: "intruso", cloids: ["0xopen"] });
    expect(r.ok).toBe(false);
    expect(await obs(t, oOpen)).toBe("open");
  });

  it("no toca órdenes de OTRO arm aunque el cloid exista", async () => {
    const t = makeConvexTest();
    const { armA, oB } = await t.run(async (ctx) => {
      const base = await seedBase(ctx);
      const armA = await seedTriggerArm(ctx, base, { status: "closed", ...LEASE });
      const armB = await seedTriggerArm(ctx, base, { status: "armed", generation: 2 });
      const oB = await seedOrder(ctx, armB, "0xb", { observedStatus: "open" });
      return { armA, oB };
    });
    // armA pide cancelar el cloid de armB → debe ignorarlo (order.armId !== armId).
    const r = await t.mutation(internal.triggerArms.markArmOrdersCanceled, { armId: armA, token: "owner", cloids: ["0xb"] });
    expect(r.n).toBe(0);
    expect(await obs(t, oB)).toBe("open");
  });
});
