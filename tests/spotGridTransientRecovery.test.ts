import { describe, it, expect } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { makeConvexTest } from "./convexHarness";
import { seedBase, seedUser, seedCredential } from "./fixtures";
import {
  SPOT_GRID_MAX_TRANSIENT_FAILS, SPOT_GRID_MAX_ERROR_RECOVERIES,
  SPOT_GRID_TRANSIENT_BACKOFF_MS, SPOT_GRID_ERROR_RETRY_BACKOFF_MS,
  SPOT_GRID_RECOVERY_EXHAUSTED_MSG, SPOT_GRID_NO_RECOVER_STATUS_MSG,
} from "../convex/spotGridConstants";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// (JAV-122) Resiliencia a errores transitorios de HL (502/timeout/red). Tests money-path de las mutations
// que el motor orquesta: prevención (bumpSpotGridTransient/markSpotGridReconcileSuccess), recuperación
// (recover/bumpErrorRecovery), claim que espeja el predicate de la query, y limpieza de estado fantasma.

async function seedGridBot(ctx: MutationCtx, over: any = {}) {
  const base = await seedBase(ctx);
  const now = Date.now();
  const botId = await ctx.db.insert("spot_grid_bots", {
    userId: base.userId, hlAccountId: base.hlAccountId, symbol: "ETH", assetId: 10120,
    baseAsset: "UETH", quoteAsset: "USDC", minPrice: 2000, gridProfitPercent: 1, investmentAmount: 100,
    orderSize: 100, gridCount: 5, feeRate: 0.0004, status: "running", network: "testnet",
    generation: 1, createdAt: now, updatedAt: now, ...over,
  });
  return { ...base, botId };
}
const get = (t: any, botId: Id<"spot_grid_bots">) => t.run((ctx: MutationCtx) => ctx.db.get(botId));

describe("bumpSpotGridTransient — prevención (Parte 1)", () => {
  it("no escala bajo el tope: sube contador + backoff, NO toca status/errorMessage", async () => {
    const t = makeConvexTest();
    const startedAt = Date.now();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { transientFailCount: 2 }));
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    const r = await t.mutation(internal.spotGridBots.bumpSpotGridTransient, { botId, token: token!, message: "x" });
    expect(r.escalated).toBe(false);
    expect(r.count).toBe(3);
    const bot = await get(t, botId);
    expect(bot.status).toBe("running");
    expect(bot.errorMessage).toBeUndefined();
    expect(bot.transientFailCount).toBe(3);
    // (CodeRabbit) backoff EXACTO, no solo "futuro": protege SPOT_GRID_TRANSIENT_BACKOFF_MS.
    expect(bot.nextRetryAt).toBeGreaterThanOrEqual(startedAt + SPOT_GRID_TRANSIENT_BACKOFF_MS - 5_000);
  });

  it("escala al tope: error+errorKind:transient, captura recoverToStatus=running, resetea contadores, alerta UNA vez", async () => {
    const t = makeConvexTest();
    const { botId, userId } = await t.run((ctx) => seedGridBot(ctx, { transientFailCount: SPOT_GRID_MAX_TRANSIENT_FAILS - 1 }));
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    const r = await t.mutation(internal.spotGridBots.bumpSpotGridTransient, { botId, token: token!, message: "502 boom" });
    expect(r.escalated).toBe(true);
    const bot = await get(t, botId);
    expect(bot.status).toBe("error");
    expect(bot.errorKind).toBe("transient");
    expect(bot.recoverToStatus).toBe("running");
    expect(bot.transientFailCount).toBe(0);
    expect(bot.errorRecoveryAttempts).toBe(0);
    const alerts = await t.run((ctx: MutationCtx) => ctx.db.query("alert_history").collect());
    expect(alerts.filter((a: any) => a.userId === userId && a.alertType === "spot_grid_error").length).toBe(1);
  });

  it("escala desde paused → recoverToStatus=paused (preserva la pausa, Codex r4)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { status: "paused", transientFailCount: SPOT_GRID_MAX_TRANSIENT_FAILS - 1 }));
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    await t.mutation(internal.spotGridBots.bumpSpotGridTransient, { botId, token: token!, message: "boom" });
    const bot = await get(t, botId);
    expect(bot.status).toBe("error");
    expect(bot.recoverToStatus).toBe("paused");
  });

  it("fencing: token ajeno → no-op", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { transientFailCount: 1 }));
    await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    const r = await t.mutation(internal.spotGridBots.bumpSpotGridTransient, { botId, token: "intruso", message: "x" });
    expect(r.ok).toBe(false);
    expect((await get(t, botId)).transientFailCount).toBe(1);
  });
});

describe("markSpotGridReconcileSuccess — reset en TODA ronda OK (Codex r1)", () => {
  it("resetea transientFailCount+nextRetryAt sin tocar status", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { transientFailCount: 3, nextRetryAt: Date.now() - 1000 }));
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    await t.mutation(internal.spotGridBots.markSpotGridReconcileSuccess, { botId, token: token! });
    const bot = await get(t, botId);
    expect(bot.transientFailCount).toBe(0);
    expect(bot.nextRetryAt).toBe(0);
    expect(bot.status).toBe("running");
  });
});

describe("recoverSpotGridFromError — recuperación (Parte 2)", () => {
  async function seedErrored(t: any, over: any = {}) {
    return (await t.run((ctx: MutationCtx) => seedGridBot(ctx, {
      status: "error", errorKind: "transient", errorMessage: "x", recoverToStatus: "running",
      errorRecoveryAttempts: 0, ...over,
    }))).botId;
  }

  it("restaura recoverToStatus=running y limpia errorKind/errorMessage/contadores", async () => {
    const t = makeConvexTest();
    const botId = await seedErrored(t);
    const { token, wasError } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    expect(wasError).toBe(true);
    const r = await t.mutation(internal.spotGridBots.recoverSpotGridFromError, { botId, token: token! });
    expect(r.restoredTo).toBe("running");
    const bot = await get(t, botId);
    expect(bot.status).toBe("running");
    expect(bot.errorKind).toBeUndefined();
    expect(bot.errorMessage).toBeUndefined();
    expect(bot.recoverToStatus).toBeUndefined();
    expect(bot.errorRecoveryAttempts).toBe(0);
  });

  it("preserva paused: recoverToStatus=paused → vuelve a paused (Codex r4)", async () => {
    const t = makeConvexTest();
    const botId = await seedErrored(t, { recoverToStatus: "paused" });
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    await t.mutation(internal.spotGridBots.recoverSpotGridFromError, { botId, token: token! });
    expect((await get(t, botId)).status).toBe("paused");
  });

  it("carrera: si una pausa concurrente cambió el bot, recover es no-op (Codex r3)", async () => {
    const t = makeConvexTest();
    const botId = await seedErrored(t);
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    // Transición concurrente DURANTE la ronda: el bot deja de ser error transitorio.
    await t.run((ctx: MutationCtx) => ctx.db.patch(botId, { status: "paused", errorKind: undefined }));
    const r = await t.mutation(internal.spotGridBots.recoverSpotGridFromError, { botId, token: token! });
    expect(r.ok).toBe(false);
    expect((await get(t, botId)).status).toBe("paused");   // no revivido a running
  });

  it("recoverToStatus ausente → TERMINALIZA a fatal accionable (Codex r5), no no-op silencioso", async () => {
    const t = makeConvexTest();
    const botId = await seedErrored(t, { recoverToStatus: undefined });
    // (CodeRabbit) El claim del cron lo RECHAZA (predicate sin recoverToStatus)...
    expect((await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId })).ok).toBe(false);
    // ...pero forzando la mutation bajo un lease válido (claim de stop, que admite error), debe TERMINALIZAR.
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcileForStop, { botId });
    const r = await t.mutation(internal.spotGridBots.recoverSpotGridFromError, { botId, token: token! });
    const bot = await get(t, botId);
    expect(r.terminalized).toBe(true);
    expect(bot.status).toBe("error");
    expect(bot.errorKind).toBe("fatal");
    expect(bot.errorMessage).toBe(SPOT_GRID_NO_RECOVER_STATUS_MSG);
  });
});

describe("bumpSpotGridErrorRecovery — backoff + tope (Parte 2)", () => {
  it("incrementa errorRecoveryAttempts y, al tope, deja errorMessage accionable", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, {
      status: "error", errorKind: "transient", recoverToStatus: "running",
      errorRecoveryAttempts: SPOT_GRID_MAX_ERROR_RECOVERIES - 1,
    }));
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    const r = await t.mutation(internal.spotGridBots.bumpSpotGridErrorRecovery, { botId, token: token! });
    expect(r.attempts).toBe(SPOT_GRID_MAX_ERROR_RECOVERIES);
    const bot = await get(t, botId);
    expect(bot.errorMessage).toBe(SPOT_GRID_RECOVERY_EXHAUSTED_MSG);
    expect(bot.nextRetryAt).toBeGreaterThan(Date.now() + SPOT_GRID_ERROR_RETRY_BACKOFF_MS - 5000);
  });

  it("no-op si el bot ya no es error transitorio", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "fatal" }));
    // claim del cron NO lo toma (fatal); usamos el claim de stop para obtener token y forzar la mutation.
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcileForStop, { botId });
    const r = await t.mutation(internal.spotGridBots.bumpSpotGridErrorRecovery, { botId, token: token! });
    expect(r.ok).toBe(false);
  });
});

describe("claimSpotGridReconcile — espeja el predicate de la query (Codex r6)", () => {
  it("claima un error recuperable y devuelve wasError=true", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "transient", recoverToStatus: "running" }));
    const r = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    expect(r.ok).toBe(true);
    expect(r.wasError).toBe(true);
  });

  it("NO claima error sin recoverToStatus", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "transient" }));
    expect((await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId })).ok).toBe(false);
  });

  it("NO claima error que superó el tope de recuperación", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, {
      status: "error", errorKind: "transient", recoverToStatus: "running", errorRecoveryAttempts: SPOT_GRID_MAX_ERROR_RECOVERIES,
    }));
    expect((await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId })).ok).toBe(false);
  });

  it("NO claima error fatal", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "fatal", recoverToStatus: "running" }));
    expect((await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId })).ok).toBe(false);
  });

  it("respeta el backoff (nextRetryAt en el futuro → no claima)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { nextRetryAt: Date.now() + 60_000 }));
    expect((await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId })).ok).toBe(false);
  });

  it("claima un activo normal con wasError=false", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx));
    const r = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    expect(r.ok).toBe(true);
    expect(r.wasError).toBe(false);
  });
});

describe("listRecoverableErrorSpotGridBotsInternal — solo recuperables", () => {
  it("devuelve error-transient recuperable; excluye fatal, sin recoverToStatus, sobre tope y con backoff", async () => {
    const t = makeConvexTest();
    const ok = (await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "transient", recoverToStatus: "running" }))).botId;
    await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "fatal", recoverToStatus: "running" }));
    await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "transient" }));   // sin recoverToStatus
    await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "transient", recoverToStatus: "running", errorRecoveryAttempts: SPOT_GRID_MAX_ERROR_RECOVERIES }));
    await t.run((ctx) => seedGridBot(ctx, { status: "error", errorKind: "transient", recoverToStatus: "running", nextRetryAt: Date.now() + 60_000 }));
    const list = await t.query(internal.spotGridBots.listRecoverableErrorSpotGridBotsInternal, {});
    expect(list.map((b: any) => String(b._id))).toEqual([String(ok)]);
  });
});

describe("setSpotGridStatus — errorKind explícito + limpieza de recovery (Codex r5/r6)", () => {
  it("status=error sin errorKind → fatal y limpia recovery (path de stop)", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, {
      errorKind: "transient", recoverToStatus: "running", transientFailCount: 5, errorRecoveryAttempts: 2,
    }));
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    await t.mutation(internal.spotGridBots.setSpotGridStatus, { botId, token: token!, status: "error", errorMessage: "stop incompleto" });
    const bot = await get(t, botId);
    expect(bot.errorKind).toBe("fatal");   // nunca conserva el transient previo
    expect(bot.recoverToStatus).toBeUndefined();
    expect(bot.transientFailCount).toBe(0);
    expect(bot.errorRecoveryAttempts).toBe(0);
    expect(bot.nextRetryAt).toBe(0);
  });

  it("status=paused (gate.policy) → limpia errorKind y recovery", async () => {
    const t = makeConvexTest();
    const { botId } = await t.run((ctx) => seedGridBot(ctx, { errorKind: "transient", recoverToStatus: "running", transientFailCount: 4 }));
    const { token } = await t.mutation(internal.spotGridBots.claimSpotGridReconcile, { botId });
    await t.mutation(internal.spotGridBots.setSpotGridStatus, { botId, token: token!, status: "paused", errorMessage: "gate" });
    const bot = await get(t, botId);
    expect(bot.status).toBe("paused");
    expect(bot.errorKind).toBeUndefined();
    expect(bot.recoverToStatus).toBeUndefined();
    expect(bot.transientFailCount).toBe(0);
  });
});

describe("pauseSpotGridBot — limpia estado de recovery (Codex r5)", () => {
  const CLERK = "owner-jav122";
  it("pausa un bot en error transitorio → paused limpio, sin estado fantasma", async () => {
    const t = makeConvexTest();
    const botId = await t.run(async (ctx: MutationCtx) => {
      const userId = await seedUser(ctx, { clerkId: CLERK });
      await ctx.db.insert("user_permissions", { userId, permission: "canManageBots", granted: true, grantedAt: Date.now() });
      const hlAccountId = await seedCredential(ctx, userId);
      const now = Date.now();
      return await ctx.db.insert("spot_grid_bots", {
        userId, hlAccountId, symbol: "ETH", assetId: 10120, baseAsset: "UETH", quoteAsset: "USDC",
        minPrice: 2000, gridProfitPercent: 1, investmentAmount: 100, orderSize: 100, gridCount: 5,
        feeRate: 0.0004, status: "error", errorKind: "transient", errorMessage: "boom",
        recoverToStatus: "running", transientFailCount: 0, errorRecoveryAttempts: 3, nextRetryAt: now + 1000,
        network: "testnet", generation: 1, createdAt: now, updatedAt: now,
      });
    });
    await t.withIdentity({ subject: CLERK }).mutation(api.spotGridBots.pauseSpotGridBot, { botId });
    const bot = await get(t, botId);
    expect(bot.status).toBe("paused");
    expect(bot.errorKind).toBeUndefined();
    expect(bot.errorMessage).toBeUndefined();
    expect(bot.recoverToStatus).toBeUndefined();
    expect(bot.errorRecoveryAttempts).toBe(0);
    expect(bot.nextRetryAt).toBe(0);
  });
});
