import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Reconcilia solicitudes no-terminales con lease expirado (action muerta, timeout, sl_failed).
// Llama reconcileExecution una a una; un fallo no detiene al resto.
export const reconcileStaleExecutions = internalAction({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.runQuery(internal.executions.listReconcilableInternal, {});
    let ok = 0;
    for (const it of items) {
      try {
        await ctx.runAction(internal.hyperliquid.reconcileExecution, { requestId: it.requestId });
        ok++;
      } catch {
        // continuar con las demás solicitudes
      }
    }
    return { scanned: items.length, reconciled: ok };
  },
});
