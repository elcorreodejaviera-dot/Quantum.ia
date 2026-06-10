import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUser, requireBotManager, deriveBaseAsset, hasPermission } from "./helpers";
import { hasNonTerminalArmForBot, requestDisarmAndDeactivateImpl } from "./triggerArms";

function validateBotNumbers(fields: {
  capitalPerTrade?: number;
  leverage?: number;
  stop?: number;
}) {
  if (fields.capitalPerTrade !== undefined && fields.capitalPerTrade <= 0) {
    throw new Error("capitalPerTrade must be > 0");
  }
  if (fields.leverage !== undefined && fields.leverage <= 0) {
    throw new Error("leverage must be > 0");
  }
  if (fields.stop !== undefined && fields.stop <= 0) {
    throw new Error("stop must be > 0");
  }
}

// El pool vinculado debe existir y pertenecer al mismo usuario (o ser admin).
async function validatePoolOwnership(
  ctx: MutationCtx,
  user: { _id: Id<"users">; role: string },
  poolId: Id<"pools">,
) {
  const pool = await ctx.db.get(poolId);
  if (!pool) throw new Error("El pool vinculado no existe.");
  if (pool.userId !== user._id && user.role !== "admin") {
    throw new Error("El pool vinculado no te pertenece.");
  }
}

// Un bot solo puede quedar activo si protege un pool vinculado y abierto.
// Cubre createBot(active+poolId), updateBot(poolId en bot activo) y toggleBot.
async function assertActivatable(
  ctx: MutationCtx,
  poolId: Id<"pools"> | undefined,
) {
  if (!poolId) throw new Error("No se puede activar un bot sin pool vinculado.");
  const pool = await ctx.db.get(poolId);
  if (!pool) throw new Error("El pool vinculado no existe.");
  if (pool.closed) throw new Error("No se puede activar: el pool protegido está cerrado.");
}

export const listBots = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    // Multi-tenancy: cada usuario ve solo sus propios bots.
    return await ctx.db.query("bots").withIndex("by_user", q => q.eq("userId", user._id)).collect();
  },
});

export const createBot = mutation({
  args: {
    name: v.string(),
    action: v.string(),
    active: v.boolean(),
    mode: v.string(),
    trigger: v.string(),
    walletId: v.optional(v.string()),
    capitalPerTrade: v.number(),
    leverage: v.number(),
    stop: v.number(),
    simulationMode: v.boolean(),
    orderType: v.optional(v.string()),
    entryTrigger: v.optional(v.string()),
    triggerPrice: v.optional(v.number()),
    autoLeverage: v.optional(v.boolean()),
    collateral: v.optional(v.string()),
    poolId: v.optional(v.id("pools")),
  },
  handler: async (ctx, args) => {
    const user = await requireBotManager(ctx);
    validateBotNumbers(args);
    if (args.poolId !== undefined) await validatePoolOwnership(ctx, user, args.poolId);
    // Un bot nuevo no puede nacer activo sin un pool abierto que proteger.
    if (args.active) await assertActivatable(ctx, args.poolId);
    return await ctx.db.insert("bots", { ...args, userId: user._id });
  },
});

export const updateBot = mutation({
  args: {
    id: v.id("bots"),
    name: v.optional(v.string()),
    action: v.optional(v.string()),
    mode: v.optional(v.string()),
    trigger: v.optional(v.string()),
    walletId: v.optional(v.string()),
    capitalPerTrade: v.optional(v.number()),
    leverage: v.optional(v.number()),
    stop: v.optional(v.number()),
    simulationMode: v.optional(v.boolean()),
    orderType: v.optional(v.string()),
    entryTrigger: v.optional(v.string()),
    triggerPrice: v.optional(v.number()),
    autoLeverage: v.optional(v.boolean()),
    collateral: v.optional(v.string()),
    // null = desvincular el pool; un Id = vincular; ausente = no tocar.
    poolId: v.optional(v.union(v.id("pools"), v.null())),
  },
  handler: async (ctx, { id, poolId, ...fields }) => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(id);
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id && user.role !== "admin") {
      throw new Error("Sin permiso para modificar este bot.");
    }
    // Los pool-bots (con kind) tienen config canónica: no se editan por la ruta legacy,
    // que no aplica los rangos ni el vínculo de cuenta. Usar getOrCreatePoolBot.
    if (bot.kind) throw new Error("Los bots por pool se gestionan con getOrCreatePoolBot.");
    validateBotNumbers(fields);

    // Resolver el poolId resultante. updateBot NO cambia `active` (eso es toggleBot).
    let resultingPoolId = bot.poolId;
    if (poolId === null) resultingPoolId = undefined;        // desvincular
    else if (poolId !== undefined) {
      await validatePoolOwnership(ctx, user, poolId);
      resultingPoolId = poolId;                              // vincular
    }
    // Un bot activo no puede quedar sin pool válido y abierto: pausar primero.
    if (bot.active && resultingPoolId !== bot.poolId) {
      await assertActivatable(ctx, resultingPoolId);
    }

    const patch: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    // En Convex, patch con `undefined` elimina el campo (desvincular).
    if (poolId !== undefined) patch.poolId = resultingPoolId;
    await ctx.db.patch(id, patch);
  },
});

export const toggleBot = mutation({
  args: { id: v.id("bots"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    const user = await requireBotManager(ctx);
    const bot = await ctx.db.get(id);
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== user._id && user.role !== "admin") {
      throw new Error("Sin permiso para modificar este bot.");
    }
    // Los pool-bots se activan/pausan por getOrCreatePoolBot, que exige cuenta HL vinculada.
    // toggleBot legacy no valida la cuenta → activaría un pool-bot sin cuenta.
    if (bot.kind) throw new Error("Los bots por pool se gestionan con getOrCreatePoolBot.");
    // Solo se puede activar si protege un pool vinculado y abierto.
    if (active) await assertActivatable(ctx, bot.poolId);
    await ctx.db.patch(id, { active });
  },
});

// --- Bots por pool (Fase 1, Parte B) ---

type PoolBotKind = "il" | "trading";
type PoolBotDirection = "long_short" | "long" | "short";

interface PoolBotConfig {
  direction: PoolBotDirection;
  leverage?: number;
  autoLeverage?: boolean;
  capitalPct?: number;
  bufferPct?: number;
  stopLossPct?: number;
  breakevenPct?: number;
  trailingStop?: boolean;
  trailingPct?: number;
  preTriggerPct?: number;
  allowReentryFromAbove?: boolean;
  autoRearm?: boolean;
  tps?: { gainPct: number; closePct: number }[];
  hedgeNotionalUsd?: number;   // JAV-44: nocional de cobertura explícito (fuente backend del motor)
}

// Convex v.number() admite NaN/Infinity y `NaN < 1` es false → evadiría los rangos.
// Exigir finitud antes de comparar.
function assertFinite(name: string, val: number | undefined) {
  if (val !== undefined && !Number.isFinite(val)) {
    throw new Error(`${name} debe ser un número finito.`);
  }
}

// Validación semántica de la config canónica (fuente única). Lanza con mensaje claro.
function validatePoolBotConfig(kind: PoolBotKind, c: PoolBotConfig) {
  // El bot de IL es cobertura: siempre short. Trading admite los tres sentidos.
  if (kind === "il" && c.direction !== "short") {
    throw new Error("El bot de IL solo admite dirección short (cobertura).");
  }
  assertFinite("leverage", c.leverage);
  assertFinite("capitalPct", c.capitalPct);
  assertFinite("bufferPct", c.bufferPct);
  assertFinite("stopLossPct", c.stopLossPct);
  assertFinite("breakevenPct", c.breakevenPct);
  assertFinite("trailingPct", c.trailingPct);
  assertFinite("preTriggerPct", c.preTriggerPct);
  assertFinite("hedgeNotionalUsd", c.hedgeNotionalUsd);
  if (c.hedgeNotionalUsd !== undefined && c.hedgeNotionalUsd <= 0) {
    throw new Error("hedgeNotionalUsd debe ser > 0.");
  }
  // Apalancamiento: fuente única; si autoLeverage está activo se ignora el valor manual.
  if (!c.autoLeverage && c.leverage !== undefined && (c.leverage < 1 || c.leverage > 20)) {
    throw new Error("leverage debe estar entre 1 y 20.");
  }
  if (c.capitalPct !== undefined && (c.capitalPct < 50 || c.capitalPct > 200)) {
    throw new Error("capitalPct debe estar entre 50 y 200.");
  }
  if (c.bufferPct !== undefined && (c.bufferPct < 0 || c.bufferPct > 100)) {
    throw new Error("bufferPct debe estar entre 0 y 100.");
  }
  if (c.stopLossPct !== undefined && (c.stopLossPct <= 0 || c.stopLossPct >= 100)) {
    throw new Error("stopLossPct debe estar entre 0 y 100 (exclusivo).");
  }
  for (const [name, val] of [
    ["breakevenPct", c.breakevenPct],
    ["trailingPct", c.trailingPct],
    ["preTriggerPct", c.preTriggerPct],
  ] as const) {
    if (val !== undefined && val < 0) throw new Error(`${name} no puede ser negativo.`);
  }
  if (c.tps) {
    let sum = 0;
    for (const tp of c.tps) {
      assertFinite("tp.gainPct", tp.gainPct);
      assertFinite("tp.closePct", tp.closePct);
      if (tp.gainPct <= 0) throw new Error("Cada take-profit requiere gainPct > 0.");
      if (tp.closePct <= 0) throw new Error("Cada take-profit requiere closePct > 0.");
      sum += tp.closePct;
    }
    if (sum > 100) throw new Error("La suma de closePct de los take-profits no puede superar 100.");
  }
}

// Un pool-bot solo puede quedar activo con pool abierto Y cuenta HL del usuario vinculada.
async function assertActivatablePoolBot(
  ctx: MutationCtx,
  poolId: Id<"pools">,
  hlAccountId: Id<"hl_api_credentials"> | undefined,
  userId: Id<"users">,
) {
  const pool = await ctx.db.get(poolId);
  if (!pool) throw new Error("El pool vinculado no existe.");
  if (pool.closed) throw new Error("No se puede activar: el pool protegido está cerrado.");
  if (!hlAccountId) throw new Error("No se puede activar un bot sin cuenta Hyperliquid vinculada.");
  const cred = await ctx.db.get(hlAccountId);
  if (!cred || cred.userId !== userId) {
    throw new Error("La cuenta Hyperliquid vinculada no es válida.");
  }
}

// Crea o reconfigura (upsert de estado completo) el bot único por (usuario, pool, kind).
// Atómico: el check de unicidad/exclusividad y el insert/patch ocurren en la misma mutation (OCC).
export const getOrCreatePoolBot = mutation({
  args: {
    poolId: v.id("pools"),
    kind: v.union(v.literal("il"), v.literal("trading")),
    hlAccountId: v.optional(v.id("hl_api_credentials")),
    direction: v.union(v.literal("long_short"), v.literal("long"), v.literal("short")),
    leverage: v.optional(v.number()),
    autoLeverage: v.optional(v.boolean()),
    capitalPct: v.optional(v.number()),
    bufferPct: v.optional(v.number()),
    stopLossPct: v.optional(v.number()),
    breakevenPct: v.optional(v.number()),
    trailingStop: v.optional(v.boolean()),
    trailingPct: v.optional(v.number()),
    preTriggerPct: v.optional(v.number()),
    allowReentryFromAbove: v.optional(v.boolean()),
    autoRearm: v.optional(v.boolean()),
    tps: v.optional(v.array(v.object({ gainPct: v.number(), closePct: v.number() }))),
    hedgeNotionalUsd: v.optional(v.number()),
    active: v.optional(v.boolean()),
    simulationMode: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireBotManager(ctx);
    await validatePoolOwnership(ctx, user, args.poolId);
    const pool = await ctx.db.get(args.poolId);
    if (!pool) throw new Error("El pool vinculado no existe.");

    const { poolId, kind, hlAccountId, active, simulationMode, ...config } = args;
    validatePoolBotConfig(kind, config);
    const baseAsset = deriveBaseAsset(pool.pair);   // derivado backend, nunca del cliente

    // Modo de operación: nuevo → simulación por defecto; update → conserva el existente.
    // Pasar a modo real (ejecución en vivo) es sensible: solo admin. La ejecución real sigue
    // con doble bloqueo global (tradingEnabled/simulationMode en system_config) + JAV-37.
    const existingBot = await ctx.db
      .query("bots")
      .withIndex("by_user_pool_kind", (q) =>
        q.eq("userId", user._id).eq("poolId", poolId).eq("kind", kind))
      .first();
    // Gestionar el bot exige canManageBots (requireBotManager, arriba). Pasarlo a modo REAL exige
    // ADEMÁS canTradeLive (autorización de trading real, separada). Admin tiene bypass en ambos.
    const resultMode = simulationMode ?? existingBot?.simulationMode ?? true;
    if (resultMode === false && !(await hasPermission(ctx, user, "canTradeLive"))) {
      throw new Error("Pasar un bot a modo real requiere el permiso canTradeLive.");
    }

    // Exclusividad de cuenta: 1 cuenta = 1 bot (ownership + ningún otro bot la usa).
    if (hlAccountId) {
      const cred = await ctx.db.get(hlAccountId);
      if (!cred || cred.userId !== user._id) {
        throw new Error("La cuenta Hyperliquid no existe o no te pertenece.");
      }
      const usingAccount = await ctx.db
        .query("bots")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", user._id).eq("hlAccountId", hlAccountId))
        .collect();
      if (usingAccount.some((b) => b._id !== existingBot?._id)) {
        throw new Error("Esa cuenta ya está asignada a otro bot.");
      }
    }

    // Estado resultante (upsert de estado completo): la cuenta resultante es la del arg.
    const willBeActive = active ?? existingBot?.active ?? false;
    if (willBeActive) await assertActivatablePoolBot(ctx, poolId, hlAccountId, user._id);
    // JAV-44: no reactivar mientras se está cancelando un trigger (pausa en curso).
    if (willBeActive && existingBot?.disarmPending) {
      throw new Error("El bot se está pausando (cancelando su trigger); espera a que termine.");
    }

    if (existingBot) {
      // JAV-44 (H1/N2): pausar un bot con un trigger_arm vivo NO desactiva de golpe — pasa por
      // desarmado confirmado (disarmPending + cron) para no dejar un trigger huérfano en HL.
      const pausingActive = existingBot.active && !willBeActive;
      await ctx.db.patch(existingBot._id, {
        ...config, hlAccountId, baseAsset, simulationMode: resultMode,
        ...(pausingActive ? {} : { active: willBeActive }),
      });
      if (pausingActive) {
        await requestDisarmAndDeactivateImpl(ctx, existingBot._id);
      } else if (willBeActive && existingBot.disarmPending) {
        await ctx.db.patch(existingBot._id, { disarmPending: false });
      }
      return existingBot._id;
    }
    const name = `${kind === "il" ? "IL" : "Trading"} ${baseAsset} ${pool.network}`;
    return await ctx.db.insert("bots", {
      name,
      userId: user._id,
      poolId,
      kind,
      hlAccountId,
      baseAsset,
      simulationMode: resultMode,
      active: willBeActive,
      ...config,
    });
  },
});

// Carga un bot por ID para la ejecución (valida ownership en el llamador).
export const getBotByIdInternal = internalQuery({
  args: { id: v.id("bots") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});
