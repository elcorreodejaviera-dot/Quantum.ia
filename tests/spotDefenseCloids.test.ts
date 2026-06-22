import { describe, it, expect } from "vitest";
import { toHlCloid, spotDefenseCloidInput } from "../convex/cloids";

// (JAV-107) Cloid del bot de defensa spot: namespace disjunto del grid/pool, determinista,
// y único por generation / rol / tpIndex / attempt para que un re-arm o una recolocación de
// SL/TP nunca colisione por by_cloid con órdenes del arm anterior.
describe("spotDefenseCloidInput", () => {
  it("prefija el namespace spot-defense (disjunto del grid)", () => {
    expect(spotDefenseCloidInput("bot1", 1, "entry")).toMatch(/^spot-defense:bot1:1:entry:0$/);
  });

  it("es determinista para el mismo input", () => {
    const a = spotDefenseCloidInput("bot1", 3, "sl", 2);
    const b = spotDefenseCloidInput("bot1", 3, "sl", 2);
    expect(a).toBe(b);
  });

  it("distingue rol, generation, attempt y tpIndex", () => {
    const inputs = [
      spotDefenseCloidInput("bot1", 1, "entry"),
      spotDefenseCloidInput("bot1", 2, "entry"),        // otra generation
      spotDefenseCloidInput("bot1", 1, "sl"),           // otro rol
      spotDefenseCloidInput("bot1", 1, "sl", 1),        // otro attempt
      spotDefenseCloidInput("bot1", 1, "tp", 0, 0),     // tp #0
      spotDefenseCloidInput("bot1", 1, "tp", 0, 1),     // tp #1
    ];
    expect(new Set(inputs).size).toBe(inputs.length);
  });

  it("solo incluye tpIndex en role tp", () => {
    expect(spotDefenseCloidInput("bot1", 1, "entry", 0, 5)).toBe("spot-defense:bot1:1:entry:0");
    expect(spotDefenseCloidInput("bot1", 1, "tp", 0, 5)).toBe("spot-defense:bot1:1:tp:5:0");
  });

  it("produce un cloid HL válido (0x + 32 hex)", async () => {
    const cloid = await toHlCloid(spotDefenseCloidInput("bot1", 1, "entry"));
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });
});
