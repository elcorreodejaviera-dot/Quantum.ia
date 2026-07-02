import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedUser, seedCredential, seedPool } from "./fixtures";
import {
  netEntryFills, resolveOcoRaceResolution, revalidateTopology, classifyEntryIocStatus, pickCloseReason,
  positionSideFromSzi, decideSisterOutcome, decideDeadEntriesOutcome,
} from "../convex/tradingReconcileCore";
import type { MutationCtx } from "../convex/_generated/server";

// (JAV-179 / PR3) Máquina de estados + carreras money-path del motor de trading. Las DECISIONES de
// carrera viven en tradingReconcileCore (puras — cierre de JAV-176-P8): estos tests ejercitan la
// SECUENCIA real de cada carrera del plan, no solo invariantes sueltos.

// ============================== CARRERA P1: hermana tardía (3 modos) ==============================

describe("hermana tardía tras clasificar un fill (JAV-176-P1) — netEntryFills + rutina 3b", () => {
  it("long_short: fill parcial Long + hermana Short completa ⇒ el neto INVIERTE el lado (SL por signo)", () => {
    // Se clasificó entry_upper (BUY 0.4 parcial); la hermana (SELL 1.0) llenó tarde en la cancelación.
    const net = netEntryFills("long_short", {
      upper: { size: 0.4, avgPx: 2980 },
      lower: { size: 1.0, avgPx: 2020 },
    });
    expect(net).toMatchObject({ kind: "both", netSide: "Short", netSize: 0.6 });
    // Rutina 3b: residuo con dirección definida ⇒ proteger al TOTAL del lado del NETO + IOC total.
    const res = resolveOcoRaceResolution(net, 0.02);
    expect(res).toEqual({ action: "protect_and_close_total", side: "Short", size: 0.6 });
  });

  it("long_short: fills simétricos netean a flat ⇒ closed(oco_race) sin posición que proteger", () => {
    const net = netEntryFills("long_short", {
      upper: { size: 1.0, avgPx: 2980 },
      lower: { size: 1.0, avgPx: 2020 },
    });
    expect(net).toMatchObject({ kind: "both", netSide: null, netSize: 0 });
    expect(resolveOcoRaceResolution(net, 0.02)).toEqual({ action: "close_flat_oco_race" });
  });

  it("solo long: ambas patas BUY ⇒ exposición 2× del MISMO lado (SL al total + IOC total)", () => {
    const net = netEntryFills("long", {
      upper: { size: 1.0, avgPx: 2980 },
      lower: { size: 1.0, avgPx: 2020 },
    });
    expect(net).toMatchObject({ kind: "both", netSide: "Long", netSize: 2.0, grossSize: 2.0 });
    expect((net as any).entryPx).toBeCloseTo(2500, 6);   // ponderado por tamaño
    expect(resolveOcoRaceResolution(net, 0.02)).toEqual({ action: "protect_and_close_total", side: "Long", size: 2.0 });
  });

  it("solo short: espejo ⇒ 2× Short", () => {
    const net = netEntryFills("short", {
      upper: { size: 0.5, avgPx: 2980 },
      lower: { size: 0.5, avgPx: 2020 },
    });
    expect(net).toMatchObject({ kind: "both", netSide: "Short", netSize: 1.0 });
  });

  it("PRE-FILL ambos-llenos usa la MISMA rutina (punto de entrada nombrado del plan)", () => {
    // El plan exige que pre-clasificación y post-cancelación resuelvan idéntico: misma función pura.
    const preFill = netEntryFills("long_short", { upper: { size: 2, avgPx: 3000 }, lower: { size: 2, avgPx: 2000 } });
    expect(resolveOcoRaceResolution(preFill, 0.04)).toEqual({ action: "close_flat_oco_race" });
  });

  it("un solo fill NO es oco_race (la rutina 3b lo rechaza)", () => {
    const single = netEntryFills("long_short", { upper: { size: 1, avgPx: 3000 } });
    expect(single.kind).toBe("single");
    expect(() => resolveOcoRaceResolution(single, 0.02)).toThrow(/ambas entradas/);
  });
});

// ============ ORDEN de la reducción (P1): SOLO tras hermana muerta + relectura NEGATIVA ============

describe("decideSisterOutcome — la reducción exige hermana MUERTA y relectura de fills NEGATIVA", () => {
  it("cancel no confirmado ⇒ wait (ni reducir ni clasificar)", () => {
    expect(decideSisterOutcome({ sisterDead: false, sisterFillSize: 0 })).toBe("wait");
    expect(decideSisterOutcome({ sisterDead: false, sisterFillSize: 1 })).toBe("wait");
  });

  it("muerta + fill tardío en la relectura ⇒ oco_race (JAMÁS reduce)", () => {
    expect(decideSisterOutcome({ sisterDead: true, sisterFillSize: 0.0001 })).toBe("oco_race");
  });

  it("muerta + relectura negativa ⇒ reduce (el ÚNICO camino a la reducción 2×→1×)", () => {
    expect(decideSisterOutcome({ sisterDead: true, sisterFillSize: 0 })).toBe("reduce");
  });
});

describe("positionSideFromSzi — el LADO del SL sale del SIGNO del szi real (P1)", () => {
  it("positivo ⇒ Long, negativo ⇒ Short", () => {
    expect(positionSideFromSzi(0.6)).toBe("Long");
    expect(positionSideFromSzi(-0.6)).toBe("Short");
  });
});

// ========= Muerte de entradas (pre-fill): prueba negativa con GRACE y VETO por szi ================

describe("decideDeadEntriesOutcome — failed SOLO con grace + flat + muertas + relectura negativa", () => {
  const base = { anyLiveOrFilling: false, graceElapsed: true, sziFlat: true, allDead: true, refilledNetKind: "none" as const };

  it("algo vivo/llenándose ⇒ wait; grace no vencido ⇒ wait; órdenes no confirmadas muertas ⇒ wait", () => {
    expect(decideDeadEntriesOutcome({ ...base, anyLiveOrFilling: true })).toBe("wait");
    expect(decideDeadEntriesOutcome({ ...base, graceElapsed: false })).toBe("wait");
    expect(decideDeadEntriesOutcome({ ...base, allDead: false })).toBe("wait");
  });

  it("VETO szi≠0: jamás failed con posición nuestra viva (posición sin SL en pleno breakout)", () => {
    expect(decideDeadEntriesOutcome({ ...base, sziFlat: false })).toBe("veto_position");
  });

  it("fill de último momento en la relectura ⇒ fill (a fase de posición, no failed)", () => {
    expect(decideDeadEntriesOutcome({ ...base, refilledNetKind: "single" })).toBe("fill");
    expect(decideDeadEntriesOutcome({ ...base, refilledNetKind: "both" })).toBe("fill");
  });

  it("todo negativo ⇒ fail (libera la reserva; el rearm durable reintenta)", () => {
    expect(decideDeadEntriesOutcome(base)).toBe("fail");
  });
});

// ====================== CARRERA V2-P1/V2-P5: topología STALE pre-RPC ==============================

describe("revalidación fresca pre-RPC (JAV-176-V2-P1) — mismatch ⇒ aborto sin RPC", () => {
  it("dentro→fuera: OCO reservado pero el mark salió ⇒ abort [transient] (reconstrucción market)", () => {
    const r = revalidateTopology({ kind: "oco" }, { kind: "market", side: "Short" });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/^\[transient\] topología stale.*salió del rango/);
  });

  it("fuera→dentro: market reservado pero el mark volvió ⇒ abort [transient] (reconstrucción OCO)", () => {
    const r = revalidateTopology({ kind: "market", side: "Long" }, { kind: "oco" });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/volvió DENTRO del rango/);
  });

  it("market con CAMBIO DE LADO (long_short cruzó el rango entero) ⇒ abort", () => {
    const r = revalidateTopology({ kind: "market", side: "Long" }, { kind: "market", side: "Short" });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/lado del breakout cambió/);
  });

  it("fallo de RELECTURA del mark ⇒ abort [transient] (jamás enviar a ciegas)", () => {
    const r = revalidateTopology({ kind: "oco" }, null);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/^\[transient\] mark fresco no disponible/);
  });

  it("topología COINCIDENTE ⇒ ok (OCO↔OCO y market mismo lado)", () => {
    expect(revalidateTopology({ kind: "oco" }, { kind: "oco" })).toEqual({ ok: true });
    expect(revalidateTopology({ kind: "market", side: "Short" }, { kind: "market", side: "Short" })).toEqual({ ok: true });
  });
});

// ====================== Decisión 6: clasificación de la IOC market-entry ==========================

describe("classifyEntryIocStatus — incierto ⇒ unknown, JAMÁS failed el mismo tick", () => {
  it("fill (incl. PARCIAL): el filledSize REAL gobierna", () => {
    expect(classifyEntryIocStatus({ filled: { oid: 1, totalSz: "0.35", avgPx: "1900" } }, false))
      .toEqual({ kind: "filled", size: 0.35, avgPx: 1900 });
  });

  it("rechazo determinista ⇒ rejected (candidato a failed SOLO tras prueba negativa con grace)", () => {
    expect(classifyEntryIocStatus({ error: "Insufficient margin" }, false))
      .toEqual({ kind: "rejected", error: "Insufficient margin" });
  });

  it("transporte incierto ⇒ unknown (una IOC abortada pudo llenar: posición sin SL si se marcara failed)", () => {
    expect(classifyEntryIocStatus(undefined, true)).toEqual({ kind: "unknown" });
  });

  it("respuestas ambiguas ⇒ unknown (filled sin datos, forma desconocida)", () => {
    expect(classifyEntryIocStatus({ filled: { oid: 1, totalSz: "0", avgPx: "0" } }, false)).toEqual({ kind: "unknown" });
    expect(classifyEntryIocStatus({ something: true }, false)).toEqual({ kind: "unknown" });
  });
});

// ====================== Prioridad de closeReason (plan PR3 paso 6) ================================

describe("pickCloseReason — emergencia > oco_race > disarm > sl > tp > manual", () => {
  const base = { emergencyClosing: undefined, bothEntriesFilled: false, wantDisarm: false, slConfirmed: false, tpClosedAll: false };

  it("cada nivel de prioridad manda sobre los de abajo", () => {
    expect(pickCloseReason({ ...base, emergencyClosing: "emergency", bothEntriesFilled: true, wantDisarm: true, slConfirmed: true, tpClosedAll: true })).toBe("emergency");
    expect(pickCloseReason({ ...base, bothEntriesFilled: true, wantDisarm: true, slConfirmed: true, tpClosedAll: true })).toBe("oco_race");
    expect(pickCloseReason({ ...base, wantDisarm: true, slConfirmed: true, tpClosedAll: true })).toBe("disarm");
    expect(pickCloseReason({ ...base, emergencyClosing: "disarm", slConfirmed: true })).toBe("disarm");
    expect(pickCloseReason({ ...base, slConfirmed: true, tpClosedAll: true })).toBe("sl");
    expect(pickCloseReason({ ...base, tpClosedAll: true })).toBe("tp");
    expect(pickCloseReason(base)).toBe("manual");
  });
});

// ====================== Transiciones de la máquina (mutations, fencing) ===========================

async function seedLiveConfig(ctx: MutationCtx) {
  await ctx.db.insert("system_config", { key: "tradingEnabled", value: true });
  await ctx.db.insert("system_config", { key: "simulationMode", value: false });
}

async function seedArmAt(ctx: MutationCtx, status: string, over: any = {}) {
  await seedLiveConfig(ctx);
  const userId = await seedUser(ctx, { role: "admin" });
  const hlAccountId = await seedCredential(ctx, userId);
  const poolId = await seedPool(ctx);
  const botId = await ctx.db.insert("bots", {
    name: "Trading ETH", userId, poolId, hlAccountId, kind: "trading", baseAsset: "ETH",
    direction: "long_short", leverage: 10, capitalPct: 100, stopLossPct: 1, autoRearm: true,
    active: true, simulationMode: false,
  });
  const now = Date.now();
  const armId = await ctx.db.insert("trading_arms", {
    botId, userId, hlAccountId, poolId, asset: "ETH", network: "testnet", generation: 1,
    status: status as any, desiredState: "armed", direction: "long_short",
    lowerEdge: 2000, upperEdge: 3000, size: 2, appliedLeverage: 10, legsFactor: 1,
    reservedNotional: 5000, marginReserved: 500, effectiveNotionalUsd: 5000, coverageNotionalUsd: 5000,
    stopLossPct: 1, submittedAt: now - 10 * 60_000,
    reconcileLeaseToken: "lease-1", reconcileLeaseUntil: now + 60_000,
    createdAt: now, updatedAt: now, ...over,
  });
  return { botId, armId };
}

describe("máquina de estados (settle bajo lease)", () => {
  it("carrera disarming→filled: el fill GANA al disarm (con emergencyClosing gobernando el cierre)", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run((ctx) => seedArmAt(ctx, "disarming"));
    const r = await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "filled", token: "lease-1",
      filledSize: 2, entryPrice: 2020, filledEntryRole: "entry_lower", filledSide: "Short",
    });
    expect(r.ok).toBe(true);
    const arm = await t.run((ctx) => ctx.db.get(armId));
    expect(arm!.status).toBe("filled");
    expect(arm!.filledAt).toBeTruthy();
  });

  it("protected→protecting: el SL desapareció y hay que recolocar (permitido)", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run((ctx) => seedArmAt(ctx, "protected"));
    const r = await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "protecting", token: "lease-1" });
    expect(r.ok).toBe(true);
  });

  it("arming NO avanza por settle (armed/filled saltarían el CAS): solo cancelar/fallar", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run((ctx) => seedArmAt(ctx, "arming", { submittedAt: undefined }));
    for (const status of ["armed", "filled", "protected"] as const) {
      const r = await t.mutation(internal.tradingBots.settleTradingArm, { armId, status, token: "lease-1" });
      expect(r.ok).toBe(false);
    }
    const ok = await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "failed", token: "lease-1", error: "x" });
    expect(ok.ok).toBe(true);
  });

  it("camino market-entry: submitting→unknown→filled (sin `armed`; el incierto se resuelve por fills)", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run((ctx) => seedArmAt(ctx, "submitting", { ocoConfirmed: true }));
    expect((await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "unknown", token: "lease-1", error: "[transient] IOC incierta" })).ok).toBe(true);
    expect((await t.mutation(internal.tradingBots.settleTradingArm, {
      armId, status: "filled", token: "lease-1", filledSize: 1.5, entryPrice: 1900,
      filledEntryRole: "entry_market", filledSide: "Long",
    })).ok).toBe(true);
    const arm = await t.run((ctx) => ctx.db.get(armId));
    expect(arm!.filledEntryRole).toBe("entry_market");
    expect(arm!.filledSize).toBe(1.5);   // fill PARCIAL: el real gobierna
  });

  it("cuarentena post-submit: terminal dentro de los 90s se rechaza; después pasa", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run((ctx) => seedArmAt(ctx, "armed", { submittedAt: Date.now() - 10_000 }));
    const r1 = await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "disarmed", token: "lease-1" });
    expect(r1).toMatchObject({ ok: false, quarantined: true });
    await t.run(async (ctx) => { await ctx.db.patch(armId, { submittedAt: Date.now() - 10 * 60_000 }); });
    const r2 = await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "disarmed", token: "lease-1" });
    expect(r2.ok).toBe(true);
  });

  it("fencing: token equivocado o lease vencido ⇒ no-op", async () => {
    const t = makeConvexTest();
    const { armId } = await t.run((ctx) => seedArmAt(ctx, "protected"));
    expect((await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "protecting", token: "WRONG" })).ok).toBe(false);
    await t.run(async (ctx) => { await ctx.db.patch(armId, { reconcileLeaseUntil: Date.now() - 1 }); });
    expect((await t.mutation(internal.tradingBots.settleTradingArm, { armId, status: "protecting", token: "lease-1" })).ok).toBe(false);
  });

  it("anti-loop del rearm: con arm vivo, clearTradingRearmIfArmedInternal limpia el pending obsoleto", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run(async (ctx) => {
      const seeded = await seedArmAt(ctx, "armed");
      await ctx.db.patch(seeded.botId, { rearmStatus: "pending", nextRearmAt: Date.now() - 1000 });
      return seeded;
    });
    const r = await t.mutation(internal.tradingBots.clearTradingRearmIfArmedInternal, { botId });
    expect(r.ok).toBe(true);
    const bot = await t.run((ctx) => ctx.db.get(botId));
    expect(bot!.rearmStatus).toBeUndefined();
  });
});
