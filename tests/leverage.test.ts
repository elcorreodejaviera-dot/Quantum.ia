import { describe, it, expect } from "vitest";
import {
  resolveLeverage,
  STANDARD_AUTO_LEVERAGE,
  AUTO_LEVERAGE_CAP,
  MARGIN_SAFETY_BUFFER,
} from "../convex/leverage";

// (Fase 4) Tests que CONGELAN el contrato YA AUDITADO de resolveLeverage (no lo rediseñan). Si un
// test "falla", se corrige el TEST salvo que revele un bug real. resolveLeverage es un módulo PURO
// (sin red ni Convex) → import directo.

// Base reutilizable; cada test sobreescribe lo que necesita.
const base = {
  autoLeverage: false as boolean,
  manualLeverage: undefined as number | undefined,
  reservedNotional: 1000,
  availableCollateral: 0,
  marginCommitted: 0,
  assetMaxLeverage: 50,
};

describe("resolveLeverage — modo manual", () => {
  it("aplica el manual válido y deriva el margen = notional/leverage", () => {
    const r = resolveLeverage({ ...base, manualLeverage: 5, reservedNotional: 1000 });
    expect(r.appliedLeverage).toBe(5);
    expect(r.marginRequired).toBeCloseTo(1000 / 5, 9);
  });

  it("valida el valor CRUDO antes de redondear: 25.4 se RECHAZA (>25)", () => {
    expect(() => resolveLeverage({ ...base, manualLeverage: 25.4 })).toThrow(/\[blocked_config\]/);
  });

  it("valida crudo: 0.6 se RECHAZA (<1)", () => {
    expect(() => resolveLeverage({ ...base, manualLeverage: 0.6 })).toThrow(/\[blocked_config\]/);
  });

  it("24.6 es válido (≤25 crudo) y se aplica redondeado a 25", () => {
    const r = resolveLeverage({ ...base, manualLeverage: 24.6, assetMaxLeverage: 50 });
    expect(r.appliedLeverage).toBe(25);
  });

  it("20.6 con assetMaxLeverage=20 se RECHAZA tras redondear a 21 (>max activo)", () => {
    expect(() => resolveLeverage({ ...base, manualLeverage: 20.6, assetMaxLeverage: 20 }))
      .toThrow(/\[blocked_config\]/);
  });

  it("con assetMaxLeverage NO fiable (no entero) NO bloquea por max (HL = autoridad final)", () => {
    // Contrato congelado: el chequeo manual>max solo corre si la metadata es entero ≥1.
    const r = resolveLeverage({ ...base, manualLeverage: 25, assetMaxLeverage: 20.5 });
    expect(r.appliedLeverage).toBe(25);
  });

  it("manualLeverage undefined → [blocked_config]", () => {
    expect(() => resolveLeverage({ ...base, manualLeverage: undefined })).toThrow(/\[blocked_config\]/);
  });
});

describe("resolveLeverage — modo auto", () => {
  const auto = { ...base, autoLeverage: true };

  it("piso 10× (STANDARD_AUTO_LEVERAGE) cuando el slider no llega y el colateral sobra", () => {
    const r = resolveLeverage({ ...auto, reservedNotional: 1000, availableCollateral: 10_000 });
    expect(r.appliedLeverage).toBe(STANDARD_AUTO_LEVERAGE);
    expect(r.appliedLeverage).toBe(10);
  });

  it("el slider del usuario es el PISO (no baja de él)", () => {
    const r = resolveLeverage({ ...auto, manualLeverage: 15, reservedNotional: 1000, availableCollateral: 10_000 });
    expect(r.appliedLeverage).toBe(15);
  });

  it("sube SOLO lo justo por encima del piso hasta que el margen quepa (needed)", () => {
    // usableReal = 1000*0.9 = 900; needed = ceil(15000/900) = 17 (>piso 10) → aplica 17, no más.
    const r = resolveLeverage({ ...auto, reservedNotional: 15_000, availableCollateral: 1000 });
    expect(r.appliedLeverage).toBe(17);
    expect(r.marginRequired).toBeCloseTo(15_000 / 17, 9);
  });

  it("needed === hardCap → abre EXACTAMENTE al cap (20×)", () => {
    // usableReal=900; needed=ceil(18000/900)=20 === hardCap(20)
    const r = resolveLeverage({ ...auto, reservedNotional: 18_000, availableCollateral: 1000 });
    expect(r.appliedLeverage).toBe(AUTO_LEVERAGE_CAP);
    expect(r.appliedLeverage).toBe(20);
  });

  it("needed === hardCap + 1 → [blocked_margin]", () => {
    // usableReal=900; needed=ceil(18001/900)=21 > hardCap(20)
    expect(() => resolveLeverage({ ...auto, reservedNotional: 18_001, availableCollateral: 1000 }))
      .toThrow(/\[blocked_margin\]/);
  });

  it("usableReal === 0 → [blocked_margin]", () => {
    // 1000*0.9 - 900 = 0
    expect(() => resolveLeverage({ ...auto, availableCollateral: 1000, marginCommitted: 900 }))
      .toThrow(/\[blocked_margin\]/);
  });

  it("usableReal < 0 → [blocked_margin]", () => {
    expect(() => resolveLeverage({ ...auto, availableCollateral: 1000, marginCommitted: 1000 }))
      .toThrow(/\[blocked_margin\]/);
  });

  it("slider > AUTO_LEVERAGE_CAP queda capado a 20 (no aplica el slider crudo)", () => {
    const r = resolveLeverage({ ...auto, manualLeverage: 30, reservedNotional: 1000, availableCollateral: 10_000 });
    expect(r.appliedLeverage).toBe(20);
  });

  it("slider > assetMaxLeverage queda capado al max del activo", () => {
    const r = resolveLeverage({ ...auto, manualLeverage: 15, assetMaxLeverage: 12, reservedNotional: 1000, availableCollateral: 10_000 });
    expect(r.appliedLeverage).toBe(12);
  });

  it("assetMaxLeverage no entero → [blocked_config]", () => {
    expect(() => resolveLeverage({ ...auto, assetMaxLeverage: 20.5, availableCollateral: 10_000 }))
      .toThrow(/\[blocked_config\]/);
  });

  it("assetMaxLeverage < 1 → [blocked_config]", () => {
    expect(() => resolveLeverage({ ...auto, assetMaxLeverage: 0, availableCollateral: 10_000 }))
      .toThrow(/\[blocked_config\]/);
  });

  it("availableCollateral negativo → [blocked_config]", () => {
    expect(() => resolveLeverage({ ...auto, availableCollateral: -1 })).toThrow(/\[blocked_config\]/);
  });

  it("marginCommitted negativo → [blocked_config]", () => {
    expect(() => resolveLeverage({ ...auto, availableCollateral: 10_000, marginCommitted: -1 }))
      .toThrow(/\[blocked_config\]/);
  });
});

describe("resolveLeverage — validaciones globales (ambos modos)", () => {
  it("reservedNotional <= 0 → [blocked_config] (manual)", () => {
    expect(() => resolveLeverage({ ...base, manualLeverage: 5, reservedNotional: 0 }))
      .toThrow(/\[blocked_config\]/);
  });

  it("reservedNotional no finito → [blocked_config] (auto)", () => {
    expect(() => resolveLeverage({ ...base, autoLeverage: true, reservedNotional: Number.NaN, availableCollateral: 10_000 }))
      .toThrow(/\[blocked_config\]/);
  });

  it("el buffer de margen es el documentado (10%) — ancla del usableReal", () => {
    expect(MARGIN_SAFETY_BUFFER).toBe(0.10);
  });
});
