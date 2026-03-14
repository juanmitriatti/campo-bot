import { describe, it, expect } from "vitest";
import { stripFillerPhrases } from "./text-normalizer.js";

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
