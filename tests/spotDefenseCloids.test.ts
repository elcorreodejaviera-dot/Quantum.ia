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

  it("incluye tpIndex en role tp", () => {
    expect(spotDefenseCloidInput("bot1", 1, "tp", 0, 5)).toBe("spot-defense:bot1:1:tp:5:0");
  });

  it("(Codex) endurece TPs: role tp sin tpIndex lanza", () => {
    expect(() => spotDefenseCloidInput("bot1", 1, "tp")).toThrow(/requiere tpIndex/);
    expect(() => spotDefenseCloidInput("bot1", 1, "tp", 0, -1)).toThrow(/requiere tpIndex/);
    expect(() => spotDefenseCloidInput("bot1", 1, "tp", 0, 1.5)).toThrow(/requiere tpIndex/);
  });

  it("(Codex) tpIndex en un rol no-TP lanza (no se ignora en silencio)", () => {
    expect(() => spotDefenseCloidInput("bot1", 1, "entry", 0, 5)).toThrow(/solo aplica a role/);
    expect(() => spotDefenseCloidInput("bot1", 1, "sl", 0, 0)).toThrow(/solo aplica a role/);
  });

  it("(Codex) generation/attempt deben ser enteros >= 0", () => {
    expect(() => spotDefenseCloidInput("bot1", -1, "entry")).toThrow(/generation/);
    expect(() => spotDefenseCloidInput("bot1", 1, "entry", -1)).toThrow(/attempt/);
  });

  it("produce un cloid HL válido (0x + 32 hex)", async () => {
    const cloid = await toHlCloid(spotDefenseCloidInput("bot1", 1, "entry"));
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });
});
