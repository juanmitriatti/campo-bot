import { describe, it, expect } from "vitest";
import { stripFillerPhrases, normalizeTranscript, correctSttDomainWords } from "./text-normalizer.js";

describe("normalizeTranscript — thousands separators in dictated amounts", () => {
  it.each([
    ["Vendí 100.000 dólares", "vendi 100000 dolares"],
    ["venta de 1.000.000 de pesos", "venta de 1000000 de pesos"],
    ["cobré 250.500 dolares", "cobre 250500 dolares"],
    ["100.000 y 250.500", "100000 y 250500"],
  ])("%s → %s (separator collapsed, not shattered)", (input, expected) => {
    expect(normalizeTranscript(input)).toBe(expected);
  });

  it("does not collapse a 2-digit group like a time (3.30)", () => {
    expect(normalizeTranscript("a las 3.30 pm")).toContain("3 30");
  });
});

describe("stripFillerPhrases", () => {
  describe("info/datos prefix stripping", () => {
    it.each([
      ["info de mis lotes", "mis lotes"],
      ["información de mis campos", "mis campos"],
      ["datos de mis lotes", "mis lotes"],
      ["info de mis campos", "mis campos"],
      ["info del lote norte", "info del lote norte"],
      ["dame info de mis lotes", "mis lotes"],
      ["mostrame info de mis campos", "mis campos"],
      ["la informacion de mis lotes", "mis lotes"],
    ])("%s → %s", (input, expected) => {
      expect(stripFillerPhrases(input)).toBe(expected);
    });
  });

  describe("politeness prefix stripping", () => {
    it.each([
      ["me podrias mostrar mis lotes", "mis lotes"],
      ["me podes decir el clima", "el clima"],
      ["me podrias decirme el resumen", "el resumen"],
    ])("%s → %s", (input, expected) => {
      expect(stripFillerPhrases(input)).toBe(expected);
    });
  });

  describe("quiero/necesito prefix stripping", () => {
    it.each([
      ["quiero ver mis campos", "mis campos"],
      ["quiero saber el clima", "el clima"],
      ["necesito ver mis lotes", "mis lotes"],
      ["quisiera conocer mis campos", "mis campos"],
    ])("%s → %s", (input, expected) => {
      expect(stripFillerPhrases(input)).toBe(expected);
    });
  });

  describe("ciudad/localidad/zona stripping", () => {
    it.each([
      ["esta en la ciudad de Bragado", "esta en Bragado"],
      ["queda en la localidad de Junin", "queda en Junin"],
      ["esta en la zona de Pergamino", "esta en Pergamino"],
    ])("%s → %s", (input, expected) => {
      expect(stripFillerPhrases(input)).toBe(expected);
    });
  });

  describe("por favor stripping", () => {
    it("mostrame mis lotes por favor → mis lotes", () => {
      expect(stripFillerPhrases("mostrame mis lotes por favor")).toBe("mis lotes");
    });
  });

  describe("passthrough — no filler detected", () => {
    it.each([
      ["mis lotes", "mis lotes"],
      ["agregar campo norte", "agregar campo norte"],
      ["gaste 50mil en gasoil", "gaste 50mil en gasoil"],
      ["clima", "clima"],
      ["resumen mes", "resumen mes"],
      ["hola", "hola"],
    ])("%s → %s (unchanged)", (input, expected) => {
      expect(stripFillerPhrases(input)).toBe(expected);
    });
  });
});

describe("correctSttDomainWords — manglings conocidos de Whisper", () => {
  it.each([
    ["compre 15 vacuiciones para el lote sur", "compre 15 vaquillonas para el lote sur"],
    ["las vaquillanas parieron", "las vaquillonas parieron"],
    ["vendi 10 navijas", "vendi 10 novillos"],
    ["fumigue con clifosato", "fumigue con glifosato"],
    ["desparasite con ibermectina", "desparasite con ivermectina"],
    ["vacune contra aftoza", "vacune contra aftosa"],
    ["pase los terneros al fidlot", "pase los terneros al feedlot"],
  ])("%s → %s", (input, expected) => {
    expect(correctSttDomainWords(input)).toBe(expected);
  });

  it("no toca palabras reales (cero falsos positivos)", () => {
    const real = "me valieron 500 las vacas de este lote y compre vaquillonas";
    expect(correctSttDomainWords(real)).toBe(real);
  });

  it("integrado en normalizeTranscript (audio end-to-end)", () => {
    expect(normalizeTranscript("Compré 15 vacuiciones para el lote Sur.")).toBe(
      "compre 15 vaquillonas para el lote sur"
    );
  });
});
