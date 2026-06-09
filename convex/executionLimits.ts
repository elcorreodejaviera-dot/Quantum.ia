import type { QueryCtx, MutationCtx } from "./_generated/server";

// Defaults ÚNICOS de los límites de ejecución (compartidos por executions/systemConfig/hyperliquid
// para que el panel muestre los valores efectivos reales y no diverja del backend).
export const LIMIT_DEFAULTS = {
  maxNotionalPerOrder: 500,
  maxNotionalPerUserDaily: 2000,
  slBufferPct: 0.3,
} as const;

export type LimitKey = keyof typeof LIMIT_DEFAULTS;

// Valor efectivo: el de system_config si existe y es válido, si no el default.
// slBufferPct admite 0 (sin buffer); los límites de nocional exigen > 0.
export async function getLimit(ctx: QueryCtx | MutationCtx, key: LimitKey): Promise<number> {
  const row = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const val = typeof row?.value === "number" ? row.value : LIMIT_DEFAULTS[key];
  const valid = Number.isFinite(val) && (key === "slBufferPct" ? val >= 0 : val > 0);
  if (!valid) throw new Error(`${key} inválido`);
  return val;
}
