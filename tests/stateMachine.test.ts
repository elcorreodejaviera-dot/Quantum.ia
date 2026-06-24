import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedBase, seedExecutionRequest, seedTriggerArm } from "./fixtures";

// (Fase 4 PR2) Invariantes de las state machines del motor, probados sobre las mutations REALES
// (settleExecution→applyTransition, settleArm) con convex-test. CONGELAN el contrato, no lo cambian.
// Acotado a settleArm + ejecuciones; sin rutas con scheduler/internal action (Codex).

describe("settleExecution / applyTransition — transiciones de ejecución", () => {
  it("válida: pending → entry_filled aplica", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedExecutionRequest(ctx, b, { status: "pending" })));
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "entry_filled" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("entry_filled");
  });

  it("terminal NO resucita: closed → cualquier estado = no-op", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedExecutionRequest(ctx, b, { status: "closed" })));
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "entry_filled" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("closed");
  });

  it("protected NO degrada: protected → sl_failed = no-op", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedExecutionRequest(ctx, b, { status: "protected" })));
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "sl_failed" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("protected");
  });

  it("protected → closed SÍ aplica (única salida permitida)", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedExecutionRequest(ctx, b, { status: "protected" })));
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "closed" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("closed");
  });

  it("transición inválida: entry_filled → unknown = no-op (no está en ALLOWED de entry_filled)", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedExecutionRequest(ctx, b, { status: "entry_filled" })));
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "unknown" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("entry_filled");
  });

  it("fencing: token ajeno = no-op (applyTransition exige ser dueño del claim)", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) =>
      seedExecutionRequest(ctx, b, { status: "entry_filled", reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 })));
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "protected", token: "intruso" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("entry_filled");
  });

  it("fencing: lease vencido = no-op", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) =>
      seedExecutionRequest(ctx, b, { status: "entry_filled", reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() - 1 })));
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "protected", token: "owner" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("entry_filled");
  });
});

describe("applyTransition — trades_history EXACTAMENTE una vez (Codex BAJO#4)", () => {
  const countHistory = (t: ReturnType<typeof makeConvexTest>) =>
    t.run((ctx) => ctx.db.query("trades_history").collect().then((r) => r.length));

  it("terminal inserta 1 fila y marca historyRecorded; repetir no duplica; no-terminal no inserta", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedExecutionRequest(ctx, b, { status: "entry_filled" })));

    // no-terminal: entry_filled → protected NO inserta historial
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "protected" });
    expect(await countHistory(t)).toBe(0);

    // terminal: protected → closed inserta 1 + historyRecorded=true
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "closed" });
    expect(await countHistory(t)).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(id)))?.historyRecorded).toBe(true);

    // repetir sobre el ya-terminal: no-op, NO duplica
    await t.mutation(internal.executions.settleExecution, { requestId: id, status: "failed" });
    expect(await countHistory(t)).toBe(1);
  });
});

describe("settleArm — transiciones de arm", () => {
  it("válida: filled → protecting aplica", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedTriggerArm(ctx, b, { status: "filled" })));
    await t.mutation(internal.triggerArms.settleArm, { armId: id, status: "protecting" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("protecting");
  });

  it("terminal NO resucita: closed → filled = no-op", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedTriggerArm(ctx, b, { status: "closed" })));
    await t.mutation(internal.triggerArms.settleArm, { armId: id, status: "filled" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("closed");
  });

  it("transición inválida: protected → armed = no-op (ALLOWED_ARM no lo permite)", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedTriggerArm(ctx, b, { status: "protected" })));
    await t.mutation(internal.triggerArms.settleArm, { armId: id, status: "armed" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("protected");
  });

  it("closeReason OBLIGATORIO: protected → closed CON closeReason aplica", async () => {
    const t = makeConvexTest();
    // submittedAt sin fijar → fuera de cuarentena N6 (que solo aplica a targets terminales recientes).
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedTriggerArm(ctx, b, { status: "protected" })));
    await t.mutation(internal.triggerArms.settleArm, { armId: id, status: "closed", closeReason: "sl" });
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.status).toBe("closed");
    expect(after?.closeReason).toBe("sl");
  });

  it("closeReason OBLIGATORIO: protected → closed SIN closeReason = no-op (Codex MEDIO#2)", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) => seedTriggerArm(ctx, b, { status: "protected" })));
    await t.mutation(internal.triggerArms.settleArm, { armId: id, status: "closed" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("protected");
  });

  it("fencing: token ajeno = no-op", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) =>
      seedTriggerArm(ctx, b, { status: "filled", reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 })));
    await t.mutation(internal.triggerArms.settleArm, { armId: id, status: "protecting", token: "intruso" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("filled");
  });

  it("fencing: lease vencido = no-op", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedBase(ctx).then((b) =>
      seedTriggerArm(ctx, b, { status: "filled", reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() - 1 })));
    await t.mutation(internal.triggerArms.settleArm, { armId: id, status: "protecting", token: "owner" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("filled");
  });
});

// (Codex Alto-2) failArmEntryRejected: rechazo EXPLÍCITO del IOC inmediato terminaliza SIN cuarentena.
describe("failArmEntryRejected — rechazo explícito de entrada (Codex Alto-2)", () => {
  async function seedArmWithEntry(
    ctx: Parameters<Parameters<ReturnType<typeof makeConvexTest>["run"]>[0]>[0],
    armOver: Parameters<typeof seedTriggerArm>[2],
    orderOver: Partial<{ observedStatus: "pending" | "open" | "rejected"; oid: string; submittedAt: number }>,
  ) {
    const b = await seedBase(ctx);
    const armId = await seedTriggerArm(ctx, b, armOver);
    const now = Date.now();
    await ctx.db.insert("trigger_orders", {
      armId, role: "entry_lower", cloid: "c-lower", triggerPx: 1, size: 1, reduceOnly: false,
      observedStatus: orderOver.observedStatus ?? "rejected",
      ...(orderOver.oid !== undefined ? { oid: orderOver.oid } : {}),
      ...(orderOver.submittedAt !== undefined ? { submittedAt: orderOver.submittedAt } : {}),
      createdAt: now, updatedAt: now,
    });
    return armId;
  }

  it("rechazo explícito (submitting + entrada rejected, sin oid) → failed YA, pese a submittedAt reciente", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedArmWithEntry(ctx,
      { status: "submitting", submittedAt: Date.now(), reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 },
      { observedStatus: "rejected" }));
    const r = await t.mutation(internal.triggerArms.failArmEntryRejected, { armId: id, token: "owner", error: "[blocked_config] sin liquidez" });
    expect(r.ok).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("failed");
  });

  it("guard: entrada con oid (algo salió vivo) → ok:false y el arm sigue submitting", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedArmWithEntry(ctx,
      { status: "submitting", submittedAt: Date.now(), reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 },
      { observedStatus: "open", oid: "999" }));
    const r = await t.mutation(internal.triggerArms.failArmEntryRejected, { armId: id, token: "owner", error: "x" });
    expect(r.ok).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("submitting");
  });

  // (CodeRabbit Major) failArmPreOrder admite "immediate_recheck_failed" (rebote/mark fresco no disponible
  // ANTES del IOC, sin petición HL en vuelo) → terminaliza pre-orden con entrada aún pending.
  it("failArmPreOrder immediate_recheck_failed: submitting + entrada pending → failed YA", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedArmWithEntry(ctx,
      { status: "submitting", submittedAt: Date.now(), reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 },
      { observedStatus: "pending" }));
    const r = await t.mutation(internal.triggerArms.failArmPreOrder, {
      armId: id, token: "owner", reason: "immediate_recheck_failed",
      error: "[transient] precio rebotó sobre el borde antes del envío (reintento con topología completa)",
    });
    expect(r.ok).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("failed");
  });

  it("guard: sin rechazo explícito (entrada solo pending) → ok:false (deja la vía normal)", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedArmWithEntry(ctx,
      { status: "submitting", submittedAt: Date.now(), reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 },
      { observedStatus: "pending" }));
    const r = await t.mutation(internal.triggerArms.failArmEntryRejected, { armId: id, token: "owner", error: "x" });
    expect(r.ok).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("submitting");
  });

  it("fencing: token ajeno → no-op", async () => {
    const t = makeConvexTest();
    const id = await t.run((ctx) => seedArmWithEntry(ctx,
      { status: "submitting", submittedAt: Date.now(), reconcileLeaseToken: "owner", reconcileLeaseUntil: Date.now() + 60_000 },
      { observedStatus: "rejected" }));
    const r = await t.mutation(internal.triggerArms.failArmEntryRejected, { armId: id, token: "intruso", error: "x" });
    expect(r.ok).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("submitting");
  });
});
