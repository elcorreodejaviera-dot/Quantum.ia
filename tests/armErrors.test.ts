import { describe, it, expect } from "vitest";
import { armErrorKind } from "../convex/triggerRearm";

// (Fase 4) Tests que CONGELAN el contrato de armErrorKind: clasifica el [kind] del prefijo, tolera el
// wrapper "Uncaught Error:" (repetido, solo al inicio), y cae a "transient" (fail-safe) ante cualquier
// cosa no clasificada — un error técnico nunca debe abandonar el auto-rearm, solo reintentar.

describe("armErrorKind — prefijos reconocidos", () => {
  it.each([
    ["[transient] timeout de red", "transient"],
    ["[blocked_margin] sin colateral", "blocked_margin"],
    ["[blocked_config] pool sin tokenId", "blocked_config"],
    ["[retry_incompatible] orden residual", "retry_incompatible"],
    ["[cancel] bot pausado", "cancel"],
  ])("%s → %s", (msg, kind) => {
    expect(armErrorKind(msg)).toBe(kind);
  });
});

describe("armErrorKind — wrapper 'Uncaught Error:' (JAV-56)", () => {
  it("tolera un wrapper antes del token", () => {
    expect(armErrorKind("Uncaught Error: [blocked_config] x")).toBe("blocked_config");
  });

  it("tolera wrappers repetidos al inicio", () => {
    expect(armErrorKind("Uncaught Error: Uncaught Error: [transient] x")).toBe("transient");
  });
});

describe("armErrorKind — fail-safe a 'transient'", () => {
  it("string sin prefijo conocido → transient", () => {
    expect(armErrorKind("algo inesperado se rompió")).toBe("transient");
  });

  it("string vacío → transient", () => {
    expect(armErrorKind("")).toBe("transient");
  });

  it("prefijo EMBEBIDO (no al inicio, sin wrapper) NO matchea → transient", () => {
    expect(armErrorKind("contexto previo [blocked_margin] al final")).toBe("transient");
  });

  it("wrapper seguido de texto sin token → transient", () => {
    expect(armErrorKind("Uncaught Error: algo no clasificado")).toBe("transient");
  });
});
