import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";
import { hlInfoUrl, hlNetwork } from "./hlNetwork";

// (JAV-84 Fase 2) Snapshot EN VIVO para el panel Admin de UN usuario. SOLO LECTURA:
// - posiciones LP: precio/estado (scanPoolByTokenId) + liquidez/fees s-cobrar (fetchPositionLiquidity).
// - estado HL: colateral (marginSummary.accountValue) + PnL no realizado por activo (clearinghouseState),
//   vía Info API (hlInfoUrl) — NUNCA exchange/clave privada. Dirección enmascarada.
// NO es money-path: no firma, no coloca/cancela órdenes, no toca reserva/arming/config.
// Validación admin en ACCIÓN: requireAdmin no vale en actions → se valida por runQuery (Codex r2 #1).
// Fan-out acotado (objetivos ya topados a MAX_LIVE_POSITIONS) y SECUENCIAL → sin ráfagas de RPC/Info.
// Cualquier fallo cae a null/flag, nunca lanza (la UI muestra "—"); el front además lo envuelve en try/catch.

const HL_TIMEOUT_MS = 10_000;

async function fetchClearinghouse(address: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HL_TIMEOUT_MS);
  try {
    const res = await fetch(hlInfoUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function maskAddr(a: string): string {
  return a && a.length >= 8 ? `${a.slice(0, 4)}..${a.slice(-2)}` : a;
}

export const getUserAdminLiveSnapshot = action({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<any> => {
    // Gate admin (en action no se puede requireAdmin directo).
    await ctx.runQuery(internal.users.getCurrentAdminInternal);

    const targets: any = await ctx.runQuery(internal.admin.getUserLiveTargetsInternal, { userId });
    let network: string | null = null;
    try { network = hlNetwork(); } catch { network = null; }

    // --- Posiciones LP (secuencial, cada una aislada) ---
    const positions: Record<string, any> = {};
    let positionsPartial = false;
    for (const t of targets.positions) {
      try {
        const scan: any = await ctx.runAction(api.actions.poolScanner.scanPoolByTokenId, {
          tokenId: t.tokenId, network: t.network,
        });
        let liquidityUsd: number | null = null;
        let feesUncollectedUsd: number | null = null;
        if (scan?.currentPrice != null && scan.currentPrice > 0) {
          const liq: any = await ctx.runAction(api.actions.poolScanner.fetchPositionLiquidity, {
            tokenId: t.tokenId, network: t.network, priceUsd: scan.currentPrice,
            poolAddress: t.poolAddress ?? undefined,
          });
          liquidityUsd = Number.isFinite(liq?.liquidityUsd) ? liq.liquidityUsd : null;
          feesUncollectedUsd = typeof liq?.feesUncollectedUsd === "number" ? liq.feesUncollectedUsd : null;
        }
        positions[t.botId] = {
          liquidityUsd, feesUncollectedUsd,
          currentPrice: scan?.currentPrice ?? null,
          inRange: scan?.status === "En rango" ? true : scan?.status === "Fuera de rango" ? false : null,
        };
      } catch {
        positionsPartial = true;
        positions[t.botId] = { liquidityUsd: null, feesUncollectedUsd: null, currentPrice: null, inRange: null };
      }
    }

    // --- Estado HL por cuenta (colateral + PnL por activo) ---
    // (Codex Fase 2 #1) PnL por CUENTA+coin, no agregado global: dos cuentas con el mismo coin no deben
    // sumarse; cada bot lee el PnL de SU hlAccountId. targets.hlAccounts ya viene topado (solo las
    // referenciadas por las posiciones visibles).
    const hlAccounts: any[] = [];
    const pnlByAccountCoin: Record<string, Record<string, number>> = {};
    let hlPartial = false;
    for (const acct of targets.hlAccounts) {
      const ch = await fetchClearinghouse(acct.tradingAccountAddress);
      if (!ch) {
        hlPartial = true;
        hlAccounts.push({ id: acct.id, addressMasked: maskAddr(acct.tradingAccountAddress), collateralUsd: null });
        continue;
      }
      const accountValue = Number(ch?.marginSummary?.accountValue);
      hlAccounts.push({
        id: acct.id,
        addressMasked: maskAddr(acct.tradingAccountAddress),
        collateralUsd: Number.isFinite(accountValue) ? accountValue : null,
      });
      const perCoin: Record<string, number> = {};
      for (const ap of ch?.assetPositions ?? []) {
        const coin = ap?.position?.coin;
        const upnl = Number(ap?.position?.unrealizedPnl);
        if (typeof coin === "string" && Number.isFinite(upnl)) {
          perCoin[coin] = (perCoin[coin] ?? 0) + upnl;
        }
      }
      pnlByAccountCoin[String(acct.id)] = perCoin;
    }

    return { network, positions, hlAccounts, pnlByAccountCoin, partial: { positions: positionsPartial, hl: hlPartial } };
  },
});
