import { describe, it, expect } from "vitest";
import {
  fixCommonTypos,
  expandNumbers,
  normalizeText,
  normalizarMonto,
  detectarCategoria,
  parseMensaje,
  parseMensajeIngreso,
  fuzzyLookupDetailed,
} from "./parser.js";
import { applySynonyms } from "./synonyms.js";

// ============================================================================
// fixCommonTypos
// ============================================================================

describe("fixCommonTypos", () => {
  it("corrects gsoil → gasoil", () => {
    expect(fixCommonTypos("gsoil")).toBe("gasoil");
  });

  it("corrects nabta → nafta", () => {
    expect(fixCommonTypos("nabta")).toBe("nafta");
  });

  it("corrects ferzilizante → fertilizante", () => {
    expect(fixCommonTypos("ferzilizante")).toBe("fertilizante");
  });

  it("corrects agroqumico → agroquimico", () => {
    expect(fixCommonTypos("agroqumico")).toBe("agroquimico");
  });

  it("corrects combutible → combustible", () => {
    expect(fixCommonTypos("combutible")).toBe("combustible");
  });

  it("corrects presupeusto → presupuesto", () => {
    expect(fixCommonTypos("presupeusto")).toBe("presupuesto");
  });

  it("leaves correct words unchanged", () => {
    expect(fixCommonTypos("gasoil nafta fertilizante")).toBe("gasoil nafta fertilizante");
  });

  it("corrects multiple typos in one string", () => {
    expect(fixCommonTypos("gsoil y nabta")).toBe("gasoil y nafta");
  });
});

// ============================================================================
// expandNumbers
// ============================================================================

describe("expandNumbers", () => {
  it("200k → 200mil", () => {
    expect(expandNumbers("200k")).toBe("200mil");
  });

  it("1kk → 1 millones", () => {
    expect(expandNumbers("1kk")).toBe("1 millones");
  });

  it("50k → 50mil", () => {
    expect(expandNumbers("50k")).toBe("50mil");
  });

  it("leaves normal numbers unchanged", () => {
    expect(expandNumbers("50mil")).toBe("50mil");
  });

  it("handles k in sentence", () => {
    expect(expandNumbers("pague 100k en gasoil")).toBe("pague 100mil en gasoil");
  });
});

// ============================================================================
// normalizeText — emoji stripping
// ============================================================================

describe("normalizeText emoji stripping", () => {
  it("strips emoji from text", () => {
    const result = normalizeText("Pagué 50mil en gasoil 🚛");
    expect(result).not.toContain("🚛");
    expect(result).toContain("50mil");
    expect(result).toContain("gasoil");
  });

  it("strips multiple emojis", () => {
    const result = normalizeText("💰 vendí soja 🌱");
    expect(result).not.toContain("💰");
    expect(result).not.toContain("🌱");
    expect(result).toContain("soja");
  });

  it("collapses excessive whitespace", () => {
    const result = normalizeText("pague   50mil   en   gasoil");
    expect(result).toBe("pague 50mil en gasoil");
  });
});

// ============================================================================
// applySynonyms
// ============================================================================

describe("applySynonyms", () => {
  it("replaces 'diesel' → 'gasoil'", () => {
    expect(applySynonyms("diesel")).toBe("gasoil");
  });

  it("replaces 'gas oil' → 'gasoil'", () => {
    expect(applySynonyms("gas oil")).toBe("gasoil");
  });

  it("replaces 'choclo' → 'maiz'", () => {
    expect(applySynonyms("choclo")).toBe("maiz");
  });

  it("replaces activity verbs", () => {
    expect(applySynonyms("fumigar")).toBe("fumigacion");
  });

  it("replaces unit variants", () => {
    expect(applySynonyms("toneladas")).toBe("tn");
  });

  it("leaves unknown words unchanged", () => {
    expect(applySynonyms("pague 50mil en gasoil")).toBe("pague 50mil en gasoil");
  });
});

// ============================================================================
// fuzzyLookupDetailed
// ============================================================================

describe("fuzzyLookupDetailed", () => {
  const testDict = {
    gasoil: "Combustible",
    nafta: "Combustible",
    fertilizante: "Fertilizantes",
  };

  it("returns exact match type for exact includes", () => {
    const result = fuzzyLookupDetailed("compre gasoil", testDict);
    expect(result).toEqual({ value: "Combustible", matchType: "exact" });
  });

  it("returns starts match type for startsWith", () => {
    const result = fuzzyLookupDetailed("fertil", testDict);
    expect(result).toEqual({ value: "Fertilizantes", matchType: "starts" });
  });

  it("returns fuzzy match type for Levenshtein", () => {
    const result = fuzzyLookupDetailed("naftt", testDict);
    expect(result).toEqual({ value: "Combustible", matchType: "fuzzy" });
  });

  it("returns null for no match", () => {
    expect(fuzzyLookupDetailed("xyz", testDict)).toBeNull();
  });
});

// ============================================================================
// Full pipeline integration — typo + synonym + parse
// ============================================================================

describe("full pipeline integration", () => {
  function preprocess(text) {
    let result = normalizeText(text);
    result = fixCommonTypos(result);
    result = expandNumbers(result);
    result = applySynonyms(result);
    return result;
  }

  it("parses 'pague gsoil 50mil' after typo correction", () => {
    const processed = preprocess("pagué gsoil 50mil");
    // After preprocessing: "pague gasoil 50mil"
    expect(processed).toContain("gasoil");
    const cat = detectarCategoria(processed);
    expect(cat).toBe("Combustible");
    const result = parseMensaje(processed);
    expect(result).not.toBeNull();
    expect(result.amount).toBe(50000);
    expect(result.category).toBe("Combustible");
  });

  it("parses 'diesel 100mil' via synonym expansion", () => {
    const processed = preprocess("gasté diesel 100mil");
    // "diesel" → "gasoil" via synonyms
    const cat = detectarCategoria(processed);
    expect(cat).toBe("Combustible");
  });

  it("parses 'gasto 200k en nafta' with number expansion", () => {
    const processed = preprocess("gasté 200k en nafta");
    const amount = normalizarMonto(processed);
    expect(amount).toBe(200000);
    const result = parseMensaje(processed);
    expect(result).not.toBeNull();
    expect(result.amount).toBe(200000);
    expect(result.category).toBe("Combustible");
  });

  it("parses message with emojis", () => {
    const processed = preprocess("Pagué 50mil en gasoil 🚛💸");
    const result = parseMensaje(processed);
    expect(result).not.toBeNull();
    expect(result.amount).toBe(50000);
    expect(result.category).toBe("Combustible");
  });

  it("handles audio transcription error: 'gas oil'", () => {
    const processed = preprocess("gasté 100mil en gas oil");
    expect(processed).toContain("gasoil");
    const result = parseMensaje(processed);
    expect(result).not.toBeNull();
    expect(result.category).toBe("Combustible");
  });

  it("handles common verb typo 'nabta' → nafta", () => {
    const processed = preprocess("gasté 30mil en nabta");
    expect(processed).toContain("nafta");
    const result = parseMensaje(processed);
    expect(result).not.toBeNull();
    expect(result.category).toBe("Combustible");
  });
});
