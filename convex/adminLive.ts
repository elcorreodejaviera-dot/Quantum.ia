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

// POST genérico al endpoint Info de HL (público). Devuelve el JSON parseado o null ante error/timeout.
async function hlInfoPost(type: string, address: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HL_TIMEOUT_MS);
  try {
    const res = await fetch(hlInfoUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, user: address }),
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

async function fetchClearinghouse(address: string): Promise<any | null> {
  return hlInfoPost("clearinghouseState", address);
}

function maskAddr(a: string): string {
  return a && a.length >= 8 ? `${a.slice(0, 4)}..${a.slice(-2)}` : a;
}

// (JAV-115) USDC libre en spot (modo unified): cuenta como colateral igual que en el portal (JAV-58),
// donde se expone POR SEPARADO del perp (no se suman: el backend valida haircuts al operar). free =
// total − hold de los balances USDC del spot. null si la lectura HL falla.
async function fetchSpotUsdcFree(address: string): Promise<number | null> {
  const d: any = await hlInfoPost("spotClearinghouseState", address);
  if (!d) return null;
  const free = (d?.balances ?? [])
    .filter((b: any) => b?.coin === "USDC")
    .reduce((s: number, b: any) => s + (parseFloat(b?.total ?? "0") - parseFloat(b?.hold ?? "0")), 0);
  return Number.isFinite(free) ? free : null;
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
        let feesLifetimeUsd: number | null = null;   // (JAV-117) total generado (cobrado + sin cobrar)
        // (Fase 4) Revert Finance Lend (de la MISMA llamada). leverageRevert = LTV% (no multiplicador).
        let revertLtv: number | null = null, healthFactor: number | null = null, borrowHealth: number | null = null;
        let revertVaultActive = false, revertLoanKnown = false;
        if (scan?.currentPrice != null && scan.currentPrice > 0) {
          const liq: any = await ctx.runAction(api.actions.poolScanner.fetchPositionLiquidity, {
            tokenId: t.tokenId, network: t.network, priceUsd: scan.currentPrice,
            poolAddress: t.poolAddress ?? undefined,
            // (JAV-117) agregados cacheados → feesLifetimeUsd en vivo (valuación a spot).
            feesCollectedRaw0: t.feesCollectedRaw0 ?? undefined, feesCollectedRaw1: t.feesCollectedRaw1 ?? undefined,
            principalDebt0: t.principalDebt0 ?? undefined, principalDebt1: t.principalDebt1 ?? undefined,
          });
          liquidityUsd = Number.isFinite(liq?.liquidityUsd) ? liq.liquidityUsd : null;
          feesUncollectedUsd = typeof liq?.feesUncollectedUsd === "number" ? liq.feesUncollectedUsd : null;
          feesLifetimeUsd = typeof liq?.feesLifetimeUsd === "number" ? liq.feesLifetimeUsd : null;
          revertLtv = Number.isFinite(liq?.leverageRevert) ? liq.leverageRevert : null;
          healthFactor = Number.isFinite(liq?.healthFactor) ? liq.healthFactor : null;
          borrowHealth = Number.isFinite(liq?.borrowHealth) ? liq.borrowHealth : null;
          revertVaultActive = liq?.revertVaultActive === true;
          revertLoanKnown = liq?.revertLoanKnown === true;
        }
        positions[t.botId] = {
          liquidityUsd, feesUncollectedUsd, feesLifetimeUsd, revertLtv, healthFactor, borrowHealth,
          revertVaultActive, revertLoanKnown,
          feesLifetimeStatus: t.feesLifetimeStatus ?? null,
          currentPrice: scan?.currentPrice ?? null,
          inRange: scan?.status === "En rango" ? true : scan?.status === "Fuera de rango" ? false : null,
        };
      } catch {
        positionsPartial = true;
        positions[t.botId] = { liquidityUsd: null, feesUncollectedUsd: null, feesLifetimeUsd: null, currentPrice: null, inRange: null };
      }
    }

    // --- Estado HL por cuenta (colateral + PnL por activo) ---
    // (Codex Fase 2 #1) PnL por CUENTA+coin, no agregado global: dos cuentas con el mismo coin no deben
    // sumarse; cada bot lee el PnL de SU hlAccountId. targets.hlAccounts ya viene topado (solo las
    // referenciadas por las posiciones visibles).
    const hlAccounts: any[] = [];
    const pnlByAccountCoin: Record<string, Record<string, number>> = {};
    // (Fix Cobertura) Nocional REAL de la posición HL por cuenta+coin = cobertura activa. bot.hedgeNotionalUsd
    // es null por diseño (el motor dimensiona on-chain), así que la "Cobertura (cap)" se lee de aquí.
    const coverageByAccountCoin: Record<string, Record<string, number>> = {};
    // (JAV-114) Detalle de la posición HL por cuenta+coin para el panel admin: tamaño (szi), entry,
    // precio de liquidación y leverage → permite VER la posición y compararla con la exposición del LP.
    const positionByAccountCoin: Record<string, Record<string, any>> = {};
    let hlPartial = false;
    for (const acct of targets.hlAccounts) {
      // (JAV-115) perp + spot en paralelo (lecturas independientes) → menos latencia por cuenta.
      // El USDC de spot (modo unified) también respalda el hedge.
      const [ch, spotUsdcFree] = await Promise.all([
        fetchClearinghouse(acct.tradingAccountAddress),
        fetchSpotUsdcFree(acct.tradingAccountAddress),
      ]);
      if (!ch) {
        hlPartial = true;
        hlAccounts.push({ id: acct.id, addressMasked: maskAddr(acct.tradingAccountAddress), collateralUsd: null, spotUsdcFree });
        continue;
      }
      const accountValue = Number(ch?.marginSummary?.accountValue);
      hlAccounts.push({
        id: acct.id,
        addressMasked: maskAddr(acct.tradingAccountAddress),
        collateralUsd: Number.isFinite(accountValue) ? accountValue : null,
        spotUsdcFree,
      });
      const perCoin: Record<string, number> = {};
      const covCoin: Record<string, number> = {};
      const posCoin: Record<string, any> = {};
      for (const ap of ch?.assetPositions ?? []) {
        const coin = ap?.position?.coin;
        const upnl = Number(ap?.position?.unrealizedPnl);
        if (typeof coin === "string" && Number.isFinite(upnl)) {
          perCoin[coin] = (perCoin[coin] ?? 0) + upnl;
        }
        const posValue = Math.abs(Number(ap?.position?.positionValue));
        if (typeof coin === "string" && Number.isFinite(posValue) && posValue > 0) {
          covCoin[coin] = (covCoin[coin] ?? 0) + posValue;
        }
        // (JAV-114) Detalle de la posición real (HL netea por coin → 1 posición por coin/cuenta).
        const szi = Number(ap?.position?.szi);
        if (typeof coin === "string" && Number.isFinite(szi) && szi !== 0) {
          const entryPx = Number(ap?.position?.entryPx);
          const liqPx = Number(ap?.position?.liquidationPx);
          const lev = Number(ap?.position?.leverage?.value);
          posCoin[coin] = {
            szi,
            notional: Number.isFinite(posValue) ? posValue : null,
            entryPx: Number.isFinite(entryPx) ? entryPx : null,
            liqPx: Number.isFinite(liqPx) ? liqPx : null,
            leverage: Number.isFinite(lev) ? lev : null,
            upnl: Number.isFinite(upnl) ? upnl : null,
          };
        }
      }
      pnlByAccountCoin[String(acct.id)] = perCoin;
      coverageByAccountCoin[String(acct.id)] = covCoin;
      positionByAccountCoin[String(acct.id)] = posCoin;
    }

    return { network, positions, hlAccounts, pnlByAccountCoin, coverageByAccountCoin, positionByAccountCoin, partial: { positions: positionsPartial, hl: hlPartial } };
  },
});
