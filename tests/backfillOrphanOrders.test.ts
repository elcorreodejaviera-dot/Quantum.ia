import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedBase, seedTriggerArm } from "./fixtures";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-98) Backfill del falso positivo orphan_orders: marca open/pending → canceled SOLO en arms
// TERMINALES. Congela: no toca arms vivos, no toca terminales reales (filled/triggered/canceled),
// idempotente, y el diagnóstico read-only lista exactamente lo que el backfill tocaría.

async function seedOrder(ctx: MutationCtx, armId: Id<"trigger_arms">, cloid: string, observedStatus: string) {
  const now = Date.now();
  return await ctx.db.insert("trigger_orders", {
    armId, role: "entry_lower", cloid, triggerPx: 1, size: 1, reduceOnly: false,
    observedStatus: observedStatus as any, createdAt: now, updatedAt: now,
  });
}
const obs = (t: any, id: Id<"trigger_orders">) => t.run((ctx: MutationCtx) => ctx.db.get(id)).then((o: any) => o?.observedStatus);

describe("backfillCanceledOrphanOrders (JAV-98)", () => {
  it("arm TERMINAL: open/pending → canceled; filled/triggered/canceled NO cambian", async () => {
    const t = makeConvexTest();
    const ids = await t.run(async (ctx: MutationCtx) => {
      const base = await seedBase(ctx);
      const closed = await seedTriggerArm(ctx, base, { status: "closed" });
      return {
        open: await seedOrder(ctx, closed, "0xopen", "open"),
        pending: await seedOrder(ctx, closed, "0xpending", "pending"),
        filled: await seedOrder(ctx, closed, "0xfilled", "filled"),
        triggered: await seedOrder(ctx, closed, "0xtrig", "triggered"),
      };
    });
    const r = await t.mutation(internal.migrations.backfillCanceledOrphanOrders, {});
    expect(r.patched).toBe(2);
    expect(await obs(t, ids.open)).toBe("canceled");
    expect(await obs(t, ids.pending)).toBe("canceled");
    expect(await obs(t, ids.filled)).toBe("filled");
    expect(await obs(t, ids.triggered)).toBe("triggered");
  });

  it("arm VIVO (armed / armed_lower_only): NO se toca", async () => {
    const t = makeConvexTest();
    const ids = await t.run(async (ctx: MutationCtx) => {
      const base = await seedBase(ctx);
      const armed = await seedTriggerArm(ctx, base, { status: "armed" });
      const lowerOnly = await seedTriggerArm(ctx, base, { status: "armed_lower_only", generation: 2 });
      return {
        a: await seedOrder(ctx, armed, "0xa", "open"),
        b: await seedOrder(ctx, lowerOnly, "0xb", "open"),
      };
    });
    const r = await t.mutation(internal.migrations.backfillCanceledOrphanOrders, {});
    expect(r.patched).toBe(0);
    expect(await obs(t, ids.a)).toBe("open");
    expect(await obs(t, ids.b)).toBe("open");
  });

  it("idempotente: segunda corrida no cambia nada", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx: MutationCtx) => {
      const base = await seedBase(ctx);
      const closed = await seedTriggerArm(ctx, base, { status: "closed" });
      await seedOrder(ctx, closed, "0xopen", "open");
    });
    expect((await t.mutation(internal.migrations.backfillCanceledOrphanOrders, {})).patched).toBe(1);
    expect((await t.mutation(internal.migrations.backfillCanceledOrphanOrders, {})).patched).toBe(0);
  });

  it("diagnoseOrphanOrders lista exactamente lo rancio (terminal + open/pending)", async () => {
    const t = makeConvexTest();
    await t.run(async (ctx: MutationCtx) => {
      const base = await seedBase(ctx);
      const closed = await seedTriggerArm(ctx, base, { status: "failed" });
      const armed = await seedTriggerArm(ctx, base, { status: "armed", generation: 2 });
      await seedOrder(ctx, closed, "0xstale", "open");
      await seedOrder(ctx, closed, "0xfilled", "filled");   // terminal real → no
      await seedOrder(ctx, armed, "0xlive", "open");        // arm vivo → no
    });
    const d = await t.query(internal.migrations.diagnoseOrphanOrders, {});
    expect(d.count).toBe(1);
    expect(d.stale[0].cloid).toBe("0xstale");
    expect(d.stale[0].armStatus).toBe("failed");
  });
});
