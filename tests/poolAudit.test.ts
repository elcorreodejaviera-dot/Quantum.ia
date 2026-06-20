import { describe, it, expect } from "vitest";
// @ts-expect-error — módulo JS sin tipos
import { auditPool, auditUserPools, verdictOf, hlCoin, HEDGE_BAND } from "../src/lib/poolAudit";

// (Fase 6-C) Congela los checks de auditoría de pool. Puros: cruzan config DB + live, devuelven
// findings warn/unknown; NUNCA un falso ✅.

const pool = (over: any = {}) => ({ poolId: "p", pair: "ETH/USDC", network: "testnet", tokenId: 1, minRange: 1000, maxRange: 2000, closed: false, ...over });
const bot = (over: any = {}) => ({ botId: "b", active: true, hlAccountId: "acc", baseAsset: "ETH", pool: pool(), arms: [], ...over });
const liveArm = (over: any = {}) => ({ status: "armed", network: "testnet", generation: 1, triggerPx: 1000, lowerEdge: 1000, upperEdge: 2000, orders: [], ...over });
const codes = (f: any[]) => f.map((x) => x.code);

describe("checks DB-only", () => {
  it("pool_closed_with_live_arm", () => {
    const f = auditPool(bot({ pool: pool({ closed: true }), arms: [liveArm()] }), null, {});
    expect(codes(f)).toContain("pool_closed_with_live_arm");
  });
  it("account_unlinked", () => {
    expect(codes(auditPool(bot({ hlAccountId: null }), null, {}))).toContain("account_unlinked");
  });
  it("pool_no_tokenid", () => {
    expect(codes(auditPool(bot({ pool: pool({ tokenId: null }) }), null, {}))).toContain("pool_no_tokenid");
  });
  it("arm_network_mismatch: red HL del arm != red HL actual", () => {
    const f = auditPool(bot({ arms: [liveArm({ network: "mainnet" })] }), null, {}, "testnet");
    expect(codes(f)).toContain("arm_network_mismatch");
  });
  it("arm_network_mismatch: misma red HL → no warn (la chain del pool NO es comparable)", () => {
    // pool.network es la chain de la LP (p.ej. "Base"), distinta al entorno HL: no debe disparar mismatch.
    const f = auditPool(bot({ pool: pool({ network: "Base" }), arms: [liveArm({ network: "testnet" })] }), null, {}, "testnet");
    expect(codes(f)).not.toContain("arm_network_mismatch");
  });
  it("arm_network_mismatch: red HL actual desconocida → no warn", () => {
    const f = auditPool(bot({ arms: [liveArm({ network: "mainnet" })] }), null, {}, null);
    expect(codes(f)).not.toContain("arm_network_mismatch");
  });
  it("base_asset_unmappable", () => {
    expect(codes(auditPool(bot({ baseAsset: null }), null, {}))).toContain("base_asset_unmappable");
  });
  it("triggers_vs_edges: drift relativo > 0.5%", () => {
    const f = auditPool(bot({ arms: [liveArm({ lowerEdge: 1050 })] }), null, {}); // 5% drift
    expect(codes(f)).toContain("triggers_vs_edges");
  });
  it("triggers_vs_edges: dentro de tolerancia → no warn", () => {
    const f = auditPool(bot({ arms: [liveArm({ lowerEdge: 1003 })] }), null, {}); // 0.3% < 0.5%
    expect(codes(f)).not.toContain("triggers_vs_edges");
  });
  it("orphan_orders: orden open en arm terminal", () => {
    const f = auditPool(bot({ arms: [{ status: "closed", network: "testnet", orders: [{ role: "sl_upper", observedStatus: "open", triggerPx: 1 }] }] }), null, {});
    expect(codes(f)).toContain("orphan_orders");
  });
});

describe("checks con snapshot live", () => {
  it("uncovered_in_range: en rango, activo, sin arm vivo", () => {
    const f = auditPool(bot({ arms: [] }), { present: true, inRange: true }, {});
    expect(codes(f)).toContain("uncovered_in_range");
  });
  it("hedge_vs_exposure: hedge menor → warn", () => {
    const f = auditPool(bot({ arms: [liveArm()] }), { present: true, inRange: true, liquidityUsd: 1000, coverageUsd: 500 }, { "acc|ETH": 1 });
    expect(codes(f)).toContain("hedge_vs_exposure");
    expect(f.find((x: any) => x.code === "hedge_vs_exposure").level).toBe("warn");
  });
  it("hedge_vs_exposure: dentro de banda → sin finding", () => {
    const f = auditPool(bot({ arms: [liveArm()] }), { present: true, inRange: true, liquidityUsd: 1000, coverageUsd: 1100 }, { "acc|ETH": 1 });
    expect(codes(f)).not.toContain("hedge_vs_exposure");
  });
  it("hedge_vs_exposure: cuenta+coin ambigua → unknown", () => {
    const f = auditPool(bot({ arms: [liveArm()] }), { present: true, inRange: true, liquidityUsd: 1000, coverageUsd: 100 }, { "acc|ETH": 2 });
    expect(f.find((x: any) => x.code === "hedge_vs_exposure").level).toBe("unknown");
  });
  it("hedge_vs_exposure: sin datos live → unknown", () => {
    const f = auditPool(bot({ arms: [liveArm()] }), null, { "acc|ETH": 1 });
    expect(f.find((x: any) => x.code === "hedge_vs_exposure").level).toBe("unknown");
  });
});

describe("verdict + agregado", () => {
  it("verdictOf: warn > unknown > ok", () => {
    expect(verdictOf([{ level: "warn" }, { level: "unknown" }])).toBe("warn");
    expect(verdictOf([{ level: "unknown" }])).toBe("unknown");
    expect(verdictOf([])).toBe("ok");
  });
  it("auditUserPools: detecta duplicados cuenta+coin desde la data DB", () => {
    const data = [
      bot({ botId: "b1", arms: [liveArm()] }),
      bot({ botId: "b2", arms: [liveArm()] }),  // misma acc+ETH → ambiguo
    ];
    const live = { b1: { present: true, inRange: true, liquidityUsd: 1000, coverageUsd: 100 },
                   b2: { present: true, inRange: true, liquidityUsd: 1000, coverageUsd: 100 } };
    const res = auditUserPools(data, live);
    for (const r of res) {
      expect(r.findings.find((x: any) => x.code === "hedge_vs_exposure").level).toBe("unknown");
    }
  });
  it("hlCoin normaliza WETH/WBTC", () => {
    expect(hlCoin("WETH")).toBe("ETH");
    expect(hlCoin("WBTC")).toBe("BTC");
    expect(hlCoin("ETH")).toBe("ETH");
  });
});
