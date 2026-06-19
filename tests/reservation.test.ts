import { describe, it, expect } from "vitest";
import { makeConvexTest } from "./convexHarness";
import { committedMarginForAccount } from "../convex/executions";
import { seedBase, seedCredential, seedExecutionRequest, seedTriggerArm } from "./fixtures";

// (Fase 4 PR2) Invariante del margen comprometido: suma ejecuciones + arms vivos de UNA cuenta, sin
// doble gasto del colateral. committedMarginForAccount recibe ctx → se invoca vía t.run (test-only, sin
// wrapper productivo desplegable; Codex MEDIO#3).

describe("committedMarginForAccount", () => {
  it("suma SOLO estados con margen vivo; ignora terminales", async () => {
    const t = makeConvexTest();
    const acc = await t.run(async (ctx) => {
      const b = await seedBase(ctx);
      await seedExecutionRequest(ctx, b, { status: "pending", marginReserved: 50 });   // vivo
      await seedExecutionRequest(ctx, b, { status: "closed", marginReserved: 999 });    // terminal → ignora
      await seedExecutionRequest(ctx, b, { status: "failed", marginReserved: 999 });     // terminal → ignora
      return b.hlAccountId;
    });
    const total = await t.run((ctx) => committedMarginForAccount(ctx, acc));
    expect(total).toBe(50);
  });

  it("exec sin marginReserved usa el fallback `?? notional`", async () => {
    const t = makeConvexTest();
    const acc = await t.run(async (ctx) => {
      const b = await seedBase(ctx);
      await seedExecutionRequest(ctx, b, { status: "submitting", notional: 30 });  // sin marginReserved
      return b.hlAccountId;
    });
    expect(await t.run((ctx) => committedMarginForAccount(ctx, acc))).toBe(30);
  });

  it("armed_lower_only SÍ cuenta como margen comprometido (JAV-85 #1)", async () => {
    const t = makeConvexTest();
    const acc = await t.run(async (ctx) => {
      const b = await seedBase(ctx);
      await seedTriggerArm(ctx, b, { status: "armed_lower_only", marginReserved: 15 });
      await seedTriggerArm(ctx, b, { status: "disarmed", marginReserved: 999, generation: 2 });  // terminal → ignora
      return b.hlAccountId;
    });
    expect(await t.run((ctx) => committedMarginForAccount(ctx, acc))).toBe(15);
  });

  it("suma AMBOS motores (ejecuciones + arms) en la misma cuenta", async () => {
    const t = makeConvexTest();
    const acc = await t.run(async (ctx) => {
      const b = await seedBase(ctx);
      await seedExecutionRequest(ctx, b, { status: "entry_filled", marginReserved: 50 });
      await seedTriggerArm(ctx, b, { status: "armed", marginReserved: 20 });
      return b.hlAccountId;
    });
    expect(await t.run((ctx) => committedMarginForAccount(ctx, acc))).toBe(70);
  });

  it("aislamiento por cuenta: filas de OTRA hlAccountId no entran en la suma", async () => {
    const t = makeConvexTest();
    const { accA } = await t.run(async (ctx) => {
      const a = await seedBase(ctx);
      await seedExecutionRequest(ctx, a, { status: "pending", marginReserved: 50 });
      // Otra cuenta del mismo user, con margen propio que NO debe contarse para A.
      const accB = await seedCredential(ctx, a.userId);
      await seedExecutionRequest(ctx, { ...a, hlAccountId: accB }, { status: "pending", marginReserved: 777 });
      await seedTriggerArm(ctx, { ...a, hlAccountId: accB }, { status: "armed", marginReserved: 888 });
      return { accA: a.hlAccountId };
    });
    expect(await t.run((ctx) => committedMarginForAccount(ctx, accA))).toBe(50);
  });
});
