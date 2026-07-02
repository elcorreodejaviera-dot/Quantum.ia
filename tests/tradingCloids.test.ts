import { describe, it, expect } from "vitest";
import { toHlCloid, tradingCloidInput, spotDefenseCloidInput, spotGridCloidInput } from "../convex/cloids";

// (JAV-177) Cloid del bot de trading: namespace `trading:` disjunto de los otros motores,
// determinista, y único por generation / rol / tpIndex / attempt para que un re-arm o una
// recolocación de SL/TP/close nunca colisione por by_cloid con órdenes del arm anterior.
describe("tradingCloidInput", () => {
  it("prefija el namespace trading (disjunto de spot-defense y grid)", () => {
    expect(tradingCloidInput("arm1", 1, "entry_upper")).toBe("trading:arm1:1:entry_upper:0");
    expect(tradingCloidInput("arm1", 1, "entry_upper")).not.toBe(spotDefenseCloidInput("arm1", 1, "entry"));
    expect(tradingCloidInput("arm1", 1, "sl")).not.toBe(spotGridCloidInput("arm1", 1, 1, 1, "sell"));
  });

  it("es determinista para el mismo input", () => {
    const a = tradingCloidInput("arm1", 3, "sl", 2);
    const b = tradingCloidInput("arm1", 3, "sl", 2);
    expect(a).toBe(b);
  });

  it("distingue rol, generation, attempt y tpIndex (incluye entry_market y close)", () => {
    const inputs = [
      tradingCloidInput("arm1", 1, "entry_upper"),
      tradingCloidInput("arm1", 1, "entry_lower"),
      tradingCloidInput("arm1", 1, "entry_market"),   // decisión 6
      tradingCloidInput("arm1", 2, "entry_upper"),    // otra generation
      tradingCloidInput("arm1", 1, "sl"),
      tradingCloidInput("arm1", 1, "sl", 1),          // rotación (slPendingCloid)
      tradingCloidInput("arm1", 1, "close"),          // cierre IOC determinista
      tradingCloidInput("arm1", 1, "close", 1),
      tradingCloidInput("arm1", 1, "tp", 0, 0),
      tradingCloidInput("arm1", 1, "tp", 0, 1),
    ];
    expect(new Set(inputs).size).toBe(inputs.length);
  });

  it("incluye tpIndex en role tp", () => {
    expect(tradingCloidInput("arm1", 1, "tp", 0, 5)).toBe("trading:arm1:1:tp:5:0");
  });

  it("endurece TPs: role tp sin tpIndex (o inválido) lanza", () => {
    expect(() => tradingCloidInput("arm1", 1, "tp")).toThrow(/requiere tpIndex/);
    expect(() => tradingCloidInput("arm1", 1, "tp", 0, -1)).toThrow(/requiere tpIndex/);
    expect(() => tradingCloidInput("arm1", 1, "tp", 0, 1.5)).toThrow(/requiere tpIndex/);
  });

  it("tpIndex en un rol no-TP lanza (no se ignora en silencio)", () => {
    expect(() => tradingCloidInput("arm1", 1, "entry_upper", 0, 5)).toThrow(/solo aplica a role/);
    expect(() => tradingCloidInput("arm1", 1, "close", 0, 0)).toThrow(/solo aplica a role/);
  });

  it("generation/attempt deben ser enteros >= 0", () => {
    expect(() => tradingCloidInput("arm1", -1, "entry_upper")).toThrow(/generation/);
    expect(() => tradingCloidInput("arm1", 1, "entry_upper", -1)).toThrow(/attempt/);
    expect(() => tradingCloidInput("arm1", 1.5, "entry_upper")).toThrow(/generation/);
  });

  it("produce un cloid HL válido (0x + 32 hex)", async () => {
    const cloid = await toHlCloid(tradingCloidInput("arm1", 1, "entry_market"));
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });
});
