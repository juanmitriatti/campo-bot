import { describe, it, expect } from "vitest";
import {
  normalizarMonto,
  parseCommand,
  detectarCategoria,
  detectarCategoriaIngreso,
  parseMensaje,
  parseMensajeIngreso,
  parseMilimetros,
  detectarCampoLote,
  parseSpanishDate,
} from "./parser.js";

// ============================================================================
// 1. normalizarMonto
// ============================================================================

describe("normalizarMonto", () => {
  describe("digits with peso sign", () => {
    it.each([
      ["$50000", 50000],
      ["$150000", 150000],
      ["$ 200000", 200000],
      ["$1000", 1000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });

  describe("digits + mil suffix", () => {
    it.each([
      ["50mil", 50000],
      ["50 mil", 50000],
      ["100mil", 100000],
      ["200 mil", 200000],
      ["30mil", 30000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });

  describe("k suffix", () => {
    it.each([
      ["200k", 200000],
      ["50k", 50000],
      ["100k", 100000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });

  describe("lucas suffix (= mil)", () => {
    it.each([
      ["50 lucas", 50000],
      ["100lucas", 100000],
      ["80 lucas", 80000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });

  describe("millones / palos", () => {
    it.each([
      ["1,5 millones", 1500000],
      ["2 millones", 2000000],
      ["2 palos", 2000000],
      ["1 millon", 1000000],
      ["3 millon", 3000000],
      ["4 palos", 4000000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });

  describe("dot stripped as thousand separator (not decimal)", () => {
    // The parser strips ALL dots before processing, so "1.5 millones"
    // becomes "15 millones" = 15,000,000 (not 1,500,000).
    // Use comma for decimals: "1,5 millones"
    it("1.5 millones → 15000000 (dot stripped)", () => {
      expect(normalizarMonto("1.5 millones")).toBe(15000000);
    });
  });

  describe("written numbers in Spanish", () => {
    it.each([
      ["cincuenta mil", 50000],
      ["dos millones", 2000000],
      ["medio millon", 500000],
      ["cien mil", 100000],
      ["quinientos mil", 500000],
      ["doscientos mil", 200000],
      ["trescientos veinte mil", 320000],
      ["un millon", 1000000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });

  describe("ambiguous standalone words", () => {
    // "mil" and "millones" alone are treated as written numbers
    // (1 * multiplier) since parseWrittenNumber defaults current to 1
    it("mil → 1000", () => expect(normalizarMonto("mil")).toBe(1000));
    it("millones → 1000000", () => expect(normalizarMonto("millones")).toBe(1000000));
    it("pagué mil → 1000", () => expect(normalizarMonto("pagué mil")).toBe(1000));
    it("gasté cien → 100", () => expect(normalizarMonto("gasté cien")).toBe(100));
  });

  describe("digits with verb context (matchDirecto)", () => {
    it.each([
      ["gaste 150000", 150000],
      ["gaste 5000", 5000],
      ["pague 200000", 200000],
      ["vendi 50000", 50000],
      ["cobre 10000", 10000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });

  describe("standalone numbers without context → null", () => {
    // Raw numbers without verb prefix, $ sign, or suffix return null
    // to avoid false positives on non-financial messages
    it.each([
      ["50000"],
      ["150000"],
      ["50.000"],    // dots stripped → "50000", still no context
      ["1.500.000"], // dots stripped → "1500000", still no context
    ])("%s → null", (input) => {
      expect(normalizarMonto(input)).toBeNull();
    });
  });

  describe("small numbers without context → null", () => {
    it("gaste 500 → null (< 4 digits, no suffix)", () => {
      expect(normalizarMonto("gaste 500")).toBeNull();
    });
  });

  describe("non-numeric text → null", () => {
    it.each([
      ["hola"],
      ["gasoil"],
      ["mucho"],
      ["bastante"],
      ["buen dia"],
    ])("%s → null", (input) => {
      expect(normalizarMonto(input)).toBeNull();
    });
  });

  describe("regression: digit+suffix takes priority over parseWrittenNumber", () => {
    // "un" in "un herbicida" could be parsed as written number 1,
    // but digit+suffix (50mil) must win
    it.each([
      ["gaste 50mil en un herbicida", 50000],
      ["pague 100mil en un repuesto", 100000],
      ["compre por 30mil un fungicida", 30000],
      ["vendi 200mil de soja", 200000],
      ["50mil en gasoil", 50000],
    ])("%s → %i", (input, expected) => {
      expect(normalizarMonto(input)).toBe(expected);
    });
  });
});

// ============================================================================
// 2. parseMensaje (expense parser)
// ============================================================================

describe("parseMensaje", () => {
  describe("valid expenses", () => {
    it("metí 50 lucas en gasoil → expense 50000 Combustible", () => {
      const r = parseMensaje("metí 50 lucas en gasoil");
      expect(r).toMatchObject({ type: "expense", amount: 50000, category: "Combustible" });
    });

    it("se me fueron 200 mil en fertilizante → expense 200000 Fertilizantes", () => {
      const r = parseMensaje("se me fueron 200 mil en fertilizante");
      expect(r).toMatchObject({ type: "expense", amount: 200000, category: "Fertilizantes" });
    });

    it("le puse 100 mil al tractor → expense 100000 Maquinaria", () => {
      const r = parseMensaje("le puse 100 mil al tractor");
      expect(r).toMatchObject({ type: "expense", amount: 100000, category: "Maquinaria" });
    });

    it("largué 80 lucas en repuestos → expense 80000 Maquinaria", () => {
      const r = parseMensaje("largué 80 lucas en repuestos");
      expect(r).toMatchObject({ type: "expense", amount: 80000, category: "Maquinaria" });
    });

    it("200k en fertilizante → expense 200000 Fertilizantes", () => {
      const r = parseMensaje("200k en fertilizante");
      expect(r).toMatchObject({ type: "expense", amount: 200000, category: "Fertilizantes" });
    });

    it("$200000 en fertilizante → expense 200000 Fertilizantes", () => {
      const r = parseMensaje("$200000 en fertilizante");
      expect(r).toMatchObject({ type: "expense", amount: 200000, category: "Fertilizantes" });
    });

    it("quinientos mil en semillas → expense 500000 Semillas", () => {
      const r = parseMensaje("quinientos mil en semillas");
      expect(r).toMatchObject({ type: "expense", amount: 500000, category: "Semillas" });
    });

    it("gaste 50mil en gasoil → expense 50000 Combustible", () => {
      const r = parseMensaje("gaste 50mil en gasoil");
      expect(r).toMatchObject({ type: "expense", amount: 50000, category: "Combustible" });
    });

    it("pague 100mil en un herbicida → expense 100000 Agroquímicos", () => {
      const r = parseMensaje("pague 100mil en un herbicida");
      expect(r).toMatchObject({ type: "expense", amount: 100000, category: "Agroquímicos" });
    });
  });

  describe("always returns currency ARS", () => {
    it("expense currency is always ARS", () => {
      const r = parseMensaje("gaste 50mil en gasoil");
      expect(r.currency).toBe("ARS");
    });
  });

  describe("returns null when category is missing", () => {
    it.each([
      ["50 mil"],
      ["gaste 50mil"],
      ["200k"],
    ])("%s → null (no recognizable category)", (input) => {
      expect(parseMensaje(input)).toBeNull();
    });
  });

  describe("returns null when amount is missing", () => {
    it.each([
      ["gasoil"],
      ["compre gasoil"],
      ["fertilizante para el campo"],
    ])("%s → null (no amount)", (input) => {
      expect(parseMensaje(input)).toBeNull();
    });
  });

  describe("returns null for unrelated messages", () => {
    it.each([
      ["hola"],
      ["vendí soja"],
      ["llovió 30 mm"],
      ["buen dia"],
    ])("%s → null", (input) => {
      expect(parseMensaje(input)).toBeNull();
    });
  });

  describe("returns null for complex messages (esComplejo)", () => {
    it.each([
      ["50 bolsas a 100mil cada una"],
      ["10 litros a 5000 cada uno"],
      ["compre 20 unidades de gasoil"],
    ])("%s → null (complex, deferred to Claude)", (input) => {
      expect(parseMensaje(input)).toBeNull();
    });
  });

  describe("unrecognized category → null (not a false positive)", () => {
    // "arreglo" is not in CATEGORIAS_GASTO and doesn't fuzzy-match
    it("me salió 150 mil el arreglo → null", () => {
      expect(parseMensaje("me salió 150 mil el arreglo")).toBeNull();
    });
  });

  describe("does NOT parse income messages as expenses", () => {
    it("vendi 200mil de soja → null (soja not in expense categories)", () => {
      expect(parseMensaje("vendi 200mil de soja")).toBeNull();
    });

    it("cobre 1,5 millones de trigo → null", () => {
      expect(parseMensaje("cobre 1,5 millones de trigo")).toBeNull();
    });
  });
});

// ============================================================================
// 3. parseMensajeIngreso (income parser)
// ============================================================================

describe("parseMensajeIngreso", () => {
  describe("valid incomes with recognized verbs", () => {
    it("vendi soja por 200 mil → income 200000 Soja ARS", () => {
      const r = parseMensajeIngreso("vendi soja por 200 mil");
      expect(r).toMatchObject({ type: "income", amount: 200000, category: "Soja", currency: "ARS" });
    });

    // NOTE: "vendi soja 200 mil" triggers esComplejo because "soja 200"
    // matches the pricing pattern (a\s+\d+). Use "por" to separate.
    it("vendi soja 200 mil → null (esComplejo: 'soja 200' looks like unit pricing)", () => {
      expect(parseMensajeIngreso("vendi soja 200 mil")).toBeNull();
    });

    it("vendi 200mil de soja → income 200000 Soja", () => {
      const r = parseMensajeIngreso("vendi 200mil de soja");
      expect(r).toMatchObject({ type: "income", amount: 200000, category: "Soja" });
    });

    it("vendi 500mil de maiz → income 500000 Maíz", () => {
      const r = parseMensajeIngreso("vendi 500mil de maiz");
      expect(r).toMatchObject({ type: "income", amount: 500000, category: "Maíz" });
    });

    it("cobre 1,5 millones de trigo → income 1500000 Trigo", () => {
      const r = parseMensajeIngreso("cobre 1,5 millones de trigo");
      expect(r).toMatchObject({ type: "income", amount: 1500000, category: "Trigo" });
    });

    it("facturé 800 mil de girasol → income 800000 Girasol", () => {
      const r = parseMensajeIngreso("facturé 800 mil de girasol");
      expect(r).toMatchObject({ type: "income", amount: 800000, category: "Girasol" });
    });
  });

  describe("USD detection", () => {
    it("vendí soja por 200 mil dólares → USD", () => {
      const r = parseMensajeIngreso("vendí soja por 200 mil dólares");
      expect(r).not.toBeNull();
      expect(r.currency).toBe("USD");
      expect(r.amount).toBe(200000);
    });

    it("cobré 1000 usd → USD", () => {
      const r = parseMensajeIngreso("cobré 1000 usd");
      expect(r).not.toBeNull();
      expect(r.currency).toBe("USD");
      expect(r.amount).toBe(1000);
    });

    it("vendi soja en dolar 200mil → USD", () => {
      const r = parseMensajeIngreso("vendi soja en dolar 200mil");
      expect(r).not.toBeNull();
      expect(r.currency).toBe("USD");
    });
  });

  describe("defaults to ARS when no USD indicator", () => {
    it("vendi soja por 200 mil → ARS", () => {
      const r = parseMensajeIngreso("vendi soja por 200 mil");
      expect(r.currency).toBe("ARS");
    });
  });

  describe("defaults category to Otros when crop not recognized", () => {
    it("cobré 1000 usd → Otros (no crop in message)", () => {
      const r = parseMensajeIngreso("cobré 1000 usd");
      expect(r.category).toBe("Otros");
    });
  });

  describe("unrecognized verbs → null (deferred to Claude)", () => {
    // These verbs are natural Spanish but not in the parser's verb regex
    it.each([
      ["cerré soja por 2 palos"],
      ["me entraron 500 lucas de maiz"],
      ["liquidé trigo por 1,5 millones"],
    ])("%s → null (verb not recognized)", (input) => {
      expect(parseMensajeIngreso(input)).toBeNull();
    });
  });

  describe("returns null for missing amount", () => {
    it.each([
      ["vendi soja"],
      ["cobré trigo"],
    ])("%s → null (no amount)", (input) => {
      expect(parseMensajeIngreso(input)).toBeNull();
    });
  });

  describe("returns null for unrelated messages", () => {
    it.each([
      ["soja"],
      ["hola"],
      ["llovió 20"],
    ])("%s → null (no income verb)", (input) => {
      expect(parseMensajeIngreso(input)).toBeNull();
    });
  });

  describe("does NOT parse expense messages as income", () => {
    it("gaste 50mil en gasoil → null (no income verb)", () => {
      expect(parseMensajeIngreso("gaste 50mil en gasoil")).toBeNull();
    });

    it("gasoil 200 mil → null", () => {
      expect(parseMensajeIngreso("gasoil 200 mil")).toBeNull();
    });
  });

  describe("complex messages → null (esComplejo)", () => {
    it("vendi 30 tn de soja a 250 usd → null (has units + price)", () => {
      expect(parseMensajeIngreso("vendi 30 tn de soja a 250 usd")).toBeNull();
    });
  });
});

// ============================================================================
// 4. parseMilimetros (rainfall parser)
// ============================================================================

describe("parseMilimetros", () => {
  describe("valid mm with unit suffix", () => {
    it.each([
      ["30mm", 30],
      ["30 mm", 30],
      ["metió 30 mm", 30],
      ["hubo 40 mm", 40],
      ["lluvia de 25 mm", 25],
      ["cayeron 20mm", 20],
      ["15.5mm", 15.5],
      ["10.5 mm", 10.5],
    ])("%s → %s", (input, expected) => {
      expect(parseMilimetros(input)).toBe(expected);
    });
  });

  describe("comma as decimal separator", () => {
    it("cayeron 15,5 mm → 15.5", () => {
      expect(parseMilimetros("cayeron 15,5 mm")).toBe(15.5);
    });

    it("llovió 10,5 mm → 10.5", () => {
      expect(parseMilimetros("llovió 10,5 mm")).toBe(10.5);
    });
  });

  describe("verb-based extraction (no mm suffix needed)", () => {
    it.each([
      ["llovió 15.5", 15.5],
      ["llovio 20", 20],
      ["cayeron 30", 30],
      ["llovieron 12", 12],
      ["ayer cayeron 20", 20],
    ])("%s → %s", (input, expected) => {
      expect(parseMilimetros(input)).toBe(expected);
    });
  });

  describe("returns null for invalid input", () => {
    it.each([
      ["llovió"],     // verb but no number
      ["mucho"],      // no number, no verb
      ["20"],         // number alone, no mm suffix, no verb
      ["mm"],         // unit alone, no number
      ["hola"],       // unrelated
      ["llovió mucho"], // verb but no number
    ])("%s → null", (input) => {
      expect(parseMilimetros(input)).toBeNull();
    });
  });
});

// ============================================================================
// 5. detectarCategoria (expense category, fuzzy)
// ============================================================================

describe("detectarCategoria", () => {
  describe("exact matches", () => {
    it.each([
      ["gasoil", "Combustible"],
      ["diesel", "Combustible"],
      ["nafta", "Combustible"],
      ["combustible", "Combustible"],
      ["fertilizante", "Fertilizantes"],
      ["fertilizantes", "Fertilizantes"],
      ["urea", "Fertilizantes"],
      ["glifosato", "Fertilizantes"],
      ["semilla", "Semillas"],
      ["semillas", "Semillas"],
      ["agroquimico", "Agroquímicos"],
      ["herbicida", "Agroquímicos"],
      ["insecticida", "Agroquímicos"],
      ["fungicida", "Agroquímicos"],
      ["sueldo", "Sueldos"],
      ["sueldos", "Sueldos"],
      ["jornal", "Sueldos"],
      ["peon", "Sueldos"],
      ["repuesto", "Maquinaria"],
      ["repuestos", "Maquinaria"],
      ["tractor", "Maquinaria"],
      ["maquinaria", "Maquinaria"],
      ["cosechadora", "Maquinaria"],
      ["alquiler", "Arrendamiento"],
      ["arrendamiento", "Arrendamiento"],
      ["arriendo", "Arrendamiento"],
      ["impuesto", "Impuestos"],
      ["impuestos", "Impuestos"],
      ["inmobiliario", "Impuestos"],
      ["iibb", "Impuestos"],
    ])("%s → %s", (input, expected) => {
      expect(detectarCategoria(input)).toBe(expected);
    });
  });

  describe("fuzzy matching — typos (levenshtein ≤ 2)", () => {
    it.each([
      ["herbisida", "Agroquímicos"],  // s→c
      ["gasoill", "Combustible"],     // extra l
      ["fertlizante", "Fertilizantes"], // missing i
      ["naftaa", "Combustible"],      // extra a
      ["insecticid", "Agroquímicos"], // missing a
    ])("%s → %s", (input, expected) => {
      expect(detectarCategoria(input)).toBe(expected);
    });
  });

  describe("fuzzy matching — truncations (startsWith)", () => {
    it.each([
      ["gasoi", "Combustible"],       // gasoil prefix
      ["fertilizant", "Fertilizantes"], // fertilizante prefix
      ["herbicid", "Agroquímicos"],   // herbicida prefix
      ["repuest", "Maquinaria"],      // repuesto prefix
    ])("%s → %s", (input, expected) => {
      expect(detectarCategoria(input)).toBe(expected);
    });
  });

  describe("exact match in longer text", () => {
    it("50mil en gasoil → Combustible", () => {
      expect(detectarCategoria("50mil en gasoil")).toBe("Combustible");
    });

    it("pague la semilla → Semillas", () => {
      expect(detectarCategoria("pague la semilla")).toBe("Semillas");
    });
  });

  describe("returns null for unknown categories", () => {
    it.each([
      ["computadora"],
      ["internet"],
      ["algo random"],
      ["hola"],
      ["soja"],  // soja is income, not expense
      ["maiz"],  // maiz is income, not expense
    ])("%s → null", (input) => {
      expect(detectarCategoria(input)).toBeNull();
    });
  });
});

// ============================================================================
// 5b. detectarCategoriaIngreso (income category, fuzzy)
// ============================================================================

describe("detectarCategoriaIngreso", () => {
  describe("exact matches", () => {
    it.each([
      ["soja", "Soja"],
      ["soya", "Soja"],
      ["maiz", "Maíz"],
      ["trigo", "Trigo"],
      ["girasol", "Girasol"],
      ["sorgo", "Sorgo"],
      ["cebada", "Cebada"],
      ["hacienda", "Hacienda"],
      ["ganado", "Hacienda"],
      ["novillo", "Hacienda"],
      ["vaca", "Hacienda"],
      ["alquiler", "Arrendamiento"],
      ["arrendamiento", "Arrendamiento"],
    ])("%s → %s", (input, expected) => {
      expect(detectarCategoriaIngreso(input)).toBe(expected);
    });
  });

  describe("returns null for expense categories", () => {
    it.each([
      ["gasoil"],
      ["fertilizante"],
      ["herbicida"],
      ["tractor"],
    ])("%s → null (expense, not income)", (input) => {
      expect(detectarCategoriaIngreso(input)).toBeNull();
    });
  });

  describe("returns null for unknown", () => {
    it.each([
      ["algo random"],
      ["computadora"],
      ["internet"],
    ])("%s → null", (input) => {
      expect(detectarCategoriaIngreso(input)).toBeNull();
    });
  });
});

// ============================================================================
// 6. detectarCampoLote (field/lot detection)
// ============================================================================

describe("detectarCampoLote", () => {
  describe("valid field references", () => {
    it.each([
      ["lote 3", "3"],
      ["lote general", "general"],
      ["lote norte", "norte"],
      ["campo norte", "norte"],
      ["campo sur", "sur"],
      ["parcela 5", "5"],
      ["parcela sur", "sur"],
      ["el lote test tiene", "test"],
      ["gasoil lote 2", "2"],
      ["gaste 50mil en gasoil lote norte", "norte"],
    ])("%s → %s", (input, expected) => {
      expect(detectarCampoLote(input)).toBe(expected);
    });
  });

  describe("returns null for invalid input", () => {
    it.each([
      ["hola"],
      ["3"],           // number alone, no keyword
      ["norte"],       // name alone, no keyword
      ["el campo"],    // "campo" needs a word after it (\s+\w+)
    ])("%s → null", (input) => {
      expect(detectarCampoLote(input)).toBeNull();
    });
  });
});

// ============================================================================
// 7. parseSpanishDate
// ============================================================================

describe("parseSpanishDate", () => {
  const currentYear = new Date().getFullYear();

  describe("slash format (dd/mm)", () => {
    it.each([
      ["15/3", 15, 2],   // March 15
      ["1/12", 1, 11],   // December 1
      ["31/12", 31, 11], // December 31
      ["1/1", 1, 0],     // January 1
      ["28/2", 28, 1],   // February 28
    ])("%s → day %i, month %i", (input, day, month) => {
      const d = parseSpanishDate(input);
      expect(d).not.toBeNull();
      expect(d.getDate()).toBe(day);
      expect(d.getMonth()).toBe(month);
      expect(d.getFullYear()).toBe(currentYear);
    });
  });

  describe("text format with month name", () => {
    it.each([
      ["15 marzo", 15, 2],
      ["1 de marzo", 1, 2],
      ["25 diciembre", 25, 11],
      ["10 enero", 10, 0],
      ["5 de julio", 5, 6],
    ])("%s → day %i, month %i", (input, day, month) => {
      const d = parseSpanishDate(input);
      expect(d).not.toBeNull();
      expect(d.getDate()).toBe(day);
      expect(d.getMonth()).toBe(month);
      expect(d.getFullYear()).toBe(currentYear);
    });
  });

  describe("works when embedded in longer text", () => {
    it("desde el 1 de marzo → March 1", () => {
      const d = parseSpanishDate("desde el 1 de marzo");
      expect(d).not.toBeNull();
      expect(d.getDate()).toBe(1);
      expect(d.getMonth()).toBe(2);
    });
  });

  describe("alternative month spelling", () => {
    it("setiembre (alt spelling) → September", () => {
      const d = parseSpanishDate("15 setiembre");
      expect(d).not.toBeNull();
      expect(d.getMonth()).toBe(8);
    });
  });

  describe("returns null for invalid input", () => {
    it.each([
      ["marzo"],     // month name alone, no day
      ["ayer"],      // relative date, not supported
      ["hola"],      // unrelated
      ["hola mundo"],
    ])("%s → null", (input) => {
      expect(parseSpanishDate(input)).toBeNull();
    });
  });
});

// ============================================================================
// 8. parseCommand
// ============================================================================

describe("parseCommand", () => {
  // --- Confirmation ---
  describe("confirm / cancel", () => {
    it.each([
      ["si", "confirm"],
      ["confirmar", "confirm"],
      ["confirmo", "confirm"],
      ["dale", "confirm"],
      ["va", "confirm"],
    ])("%s → %s", (input, cmd) => {
      expect(parseCommand(input)).toMatchObject({ command: cmd });
    });

    it.each([
      ["no", "cancel"],
      ["cancelar", "cancel"],
      ["cancelo", "cancel"],
      ["nah", "cancel"],
    ])("%s → %s", (input, cmd) => {
      expect(parseCommand(input)).toMatchObject({ command: cmd });
    });
  });

  // --- Help ---
  describe("help", () => {
    it.each(["ayuda", "help", "comandos", "?"])("%s → help", (input) => {
      expect(parseCommand(input)).toMatchObject({ command: "help" });
    });
  });

  // --- Menu ---
  describe("menu", () => {
    it.each(["menu", "menú", "opciones"])("%s → menu", (input) => {
      expect(parseCommand(input)).toMatchObject({ command: "menu" });
    });
  });

  // --- Greeting / Thanks / Ack ---
  describe("greeting", () => {
    it.each(["hola", "buenas", "buen dia", "buenas tardes", "buenas noches", "hey", "que tal"])(
      "%s → greeting",
      (input) => {
        expect(parseCommand(input)).toMatchObject({ command: "greeting" });
      }
    );
  });

  describe("thanks", () => {
    it.each(["gracias", "genial", "joya"])("%s → thanks", (input) => {
      expect(parseCommand(input)).toMatchObject({ command: "thanks" });
    });
  });

  describe("ack", () => {
    it.each(["ok", "listo", "perfecto", "bien", "bueno", "entendido"])("%s → ack", (input) => {
      expect(parseCommand(input)).toMatchObject({ command: "ack" });
    });
  });

  // --- Dollar ---
  describe("dollar", () => {
    it.each(["dolar", "dolares", "cotizacion dolar", "dolar hoy"])("%s → dollar", (input) => {
      expect(parseCommand(input)).toMatchObject({ command: "dollar" });
    });
  });

  // --- Weather ---
  describe("weather", () => {
    it("clima → weather_full", () => {
      expect(parseCommand("clima")).toMatchObject({ command: "weather_full" });
    });

    it("clima mañana → weather_forecast days:1", () => {
      const r = parseCommand("clima mañana");
      expect(r.command).toBe("weather_forecast");
      expect(r.days).toBe(1);
    });

    it("clima semana → weather_forecast", () => {
      expect(parseCommand("clima semana")).toMatchObject({ command: "weather_forecast" });
    });

    it("clima esta semana → weather_forecast", () => {
      expect(parseCommand("clima esta semana")).toMatchObject({ command: "weather_forecast" });
    });

    it("clima en junin → weather_full city:junin", () => {
      const r = parseCommand("clima en junin");
      expect(r.command).toBe("weather_full");
      expect(r.city).toBe("junin");
    });

    it("va a llover mañana? → weather_forecast days:1", () => {
      const r = parseCommand("va a llover mañana?");
      expect(r.command).toBe("weather_forecast");
      expect(r.days).toBe(1);
    });

    it("va a llover en alberdi mañana? → weather_forecast city:alberdi", () => {
      const r = parseCommand("va a llover en alberdi mañana?");
      expect(r.command).toBe("weather_forecast");
      expect(r.city).toBe("alberdi");
    });
  });

  describe("weather_field", () => {
    it("clima lote 3 → weather_field fieldName:3", () => {
      expect(parseCommand("clima lote 3")).toMatchObject({ command: "weather_field", fieldName: "3" });
    });

    it("clima lote general → weather_field fieldName:general", () => {
      expect(parseCommand("clima lote general")).toMatchObject({ command: "weather_field", fieldName: "general" });
    });

    it("va a llover en el lote test → weather_field fieldName:test", () => {
      const r = parseCommand("va a llover en el lote test");
      expect(r).not.toBeNull();
      expect(r.fieldName).toBe("test");
    });
  });

  // --- Rain Log ---
  describe("log_rainfall", () => {
    it("llovió 25mm → log_rainfall mm:25", () => {
      expect(parseCommand("llovió 25mm")).toMatchObject({ command: "log_rainfall", mm: 25 });
    });

    it("llovio 30mm → log_rainfall mm:30", () => {
      expect(parseCommand("llovio 30mm")).toMatchObject({ command: "log_rainfall", mm: 30 });
    });

    it("cayeron 30 mm lote 3 → log_rainfall mm:30 plotName:3", () => {
      expect(parseCommand("cayeron 30 mm lote 3")).toMatchObject({
        command: "log_rainfall",
        mm: 30,
        plotName: "3",
      });
    });

    it("llovieron 20mm → log_rainfall mm:20", () => {
      expect(parseCommand("llovieron 20mm")).toMatchObject({ command: "log_rainfall", mm: 20 });
    });

    it("cayeron 15mm en lote general → log_rainfall plotName:general", () => {
      expect(parseCommand("cayeron 15mm en lote general")).toMatchObject({
        command: "log_rainfall",
        mm: 15,
        plotName: "general",
      });
    });
  });

  // --- Reports ---
  describe("reports", () => {
    it("resumen mes → monthly_report", () => {
      expect(parseCommand("resumen mes")).toMatchObject({ command: "monthly_report" });
    });

    it("resumen del mes → monthly_report", () => {
      expect(parseCommand("resumen del mes")).toMatchObject({ command: "monthly_report" });
    });

    it("resumen semana → weekly_report", () => {
      expect(parseCommand("resumen semana")).toMatchObject({ command: "weekly_report" });
    });

    it("resumen de la semana → weekly_report", () => {
      expect(parseCommand("resumen de la semana")).toMatchObject({ command: "weekly_report" });
    });

    it("resumen semanal → weekly_report", () => {
      expect(parseCommand("resumen semanal")).toMatchObject({ command: "weekly_report" });
    });

    it("resultado mes → monthly_result", () => {
      expect(parseCommand("resultado mes")).toMatchObject({ command: "monthly_result" });
    });

    it("resultado del mes → monthly_result", () => {
      expect(parseCommand("resultado del mes")).toMatchObject({ command: "monthly_result" });
    });

    it("rentabilidad → monthly_result", () => {
      expect(parseCommand("rentabilidad")).toMatchObject({ command: "monthly_result" });
    });

    it("balance → monthly_result", () => {
      expect(parseCommand("balance")).toMatchObject({ command: "monthly_result" });
    });

    it("resumen lote general → plot_report", () => {
      expect(parseCommand("resumen lote general")).toMatchObject({
        command: "plot_report",
        plotName: "general",
      });
    });
  });

  describe("compare months", () => {
    it("comparar marzo con febrero → compare_months", () => {
      const r = parseCommand("comparar marzo con febrero");
      expect(r.command).toBe("compare_months");
      expect(r.mes1).toBe(2);  // marzo
      expect(r.mes2).toBe(1);  // febrero
      expect(r.mes1Name).toBe("marzo");
      expect(r.mes2Name).toBe("febrero");
    });

    it("comparar enero con diciembre → compare_months", () => {
      const r = parseCommand("comparar enero con diciembre");
      expect(r.command).toBe("compare_months");
      expect(r.mes1).toBe(0);
      expect(r.mes2).toBe(11);
    });
  });

  // --- Budget ---
  describe("budget", () => {
    it("presupuesto combustible 500 mil → set_budget", () => {
      const r = parseCommand("presupuesto combustible 500 mil");
      expect(r).not.toBeNull();
      expect(r.command).toBe("set_budget");
      expect(r.category).toBe("Combustible");
      expect(r.amount).toBe(500000);
    });

    it("presupuesto combustible 500mil → set_budget 500000", () => {
      const r = parseCommand("presupuesto combustible 500mil");
      expect(r.command).toBe("set_budget");
      expect(r.amount).toBe(500000);
    });
  });

  // --- Edit ---
  describe("edit_last", () => {
    it("editar ultimo gasto a 250 mil → edit_last amount:250000", () => {
      expect(parseCommand("editar ultimo gasto a 250 mil")).toMatchObject({
        command: "edit_last",
        amount: 250000,
      });
    });

    it("editar ultimo gasto a 50mil → edit_last amount:50000", () => {
      expect(parseCommand("editar ultimo gasto a 50mil")).toMatchObject({
        command: "edit_last",
        amount: 50000,
      });
    });
  });

  // --- Delete ---
  describe("delete", () => {
    it("borrar ultimo gasto → delete_last", () => {
      expect(parseCommand("borrar ultimo gasto")).toMatchObject({ command: "delete_last" });
    });

    it("eliminar ultimo gasto → delete_last", () => {
      expect(parseCommand("eliminar ultimo gasto")).toMatchObject({ command: "delete_last" });
    });

    it("borrar ultimo ingreso → delete_last_income", () => {
      expect(parseCommand("borrar ultimo ingreso")).toMatchObject({ command: "delete_last_income" });
    });

    it("borrar ultima lluvia → delete_last_rainfall", () => {
      expect(parseCommand("borrar ultima lluvia")).toMatchObject({ command: "delete_last_rainfall" });
    });
  });

  // --- Export ---
  describe("export", () => {
    it.each([
      ["exportar mes", "export_csv"],
      ["exportar csv", "export_csv"],
      ["exportar gastos", "export_csv"],
    ])("%s → %s", (input, cmd) => {
      expect(parseCommand(input)).toMatchObject({ command: cmd });
    });
  });

  // --- Alerts ---
  describe("alerts", () => {
    it("mis alertas → show_alerts", () => {
      expect(parseCommand("mis alertas")).toMatchObject({ command: "show_alerts" });
    });

    it("ver alertas → show_alerts", () => {
      expect(parseCommand("ver alertas")).toMatchObject({ command: "show_alerts" });
    });

    it("alerta lluvia 15mm → set_rain_threshold mm:15", () => {
      expect(parseCommand("alerta lluvia 15mm")).toMatchObject({ command: "set_rain_threshold", mm: 15 });
    });
  });

  describe("toggle alerts", () => {
    it.each([
      ["activar lluvia", "enable_rain_alerts"],
      ["desactivar lluvia", "disable_rain_alerts"],
      ["activar presupuesto", "enable_budget_alerts"],
      ["desactivar presupuesto", "disable_budget_alerts"],
      ["activar resumen semanal", "enable_weekly_summary"],
      ["desactivar resumen semanal", "disable_weekly_summary"],
    ])("%s → %s", (input, cmd) => {
      expect(parseCommand(input)).toMatchObject({ command: cmd });
    });
  });

  // --- Rainfall queries ---
  describe("rainfall queries", () => {
    it("cuanto llovio esta semana? → rainfall_report week", () => {
      const r = parseCommand("cuanto llovio esta semana?");
      expect(r.command).toBe("rainfall_report");
      expect(r.period).toBe("week");
    });

    it("cuanto llovio ayer? → rainfall_range", () => {
      const r = parseCommand("cuanto llovio ayer?");
      expect(r.command).toBe("rainfall_range");
    });

    it("cuanto llovio este mes → rainfall_report month", () => {
      const r = parseCommand("cuanto llovio este mes");
      expect(r.command).toBe("rainfall_report");
      expect(r.period).toBe("month");
    });

    it("cuando llovio esta semana en el lote test → rainfall_report week plotName:test", () => {
      const r = parseCommand("cuando llovio esta semana en el lote test?");
      expect(r.command).toBe("rainfall_report");
      expect(r.period).toBe("week");
      expect(r.plotName).toBe("test");
    });
  });

  // --- Field management ---
  describe("field management", () => {
    it.each(["mis campos", "ver campos"])("%s → list_fields", (input) => {
      expect(parseCommand(input)).toMatchObject({ command: "list_fields" });
    });
    it.each(["mis lotes", "ver lotes"])("%s → list_plots", (input) => {
      expect(parseCommand(input)).toMatchObject({ command: "list_plots" });
    });

    it("que campos tengo? → list_fields", () => {
      expect(parseCommand("que campos tengo?")).toMatchObject({ command: "list_fields" });
    });

    it("mostrar lotes → list_fields", () => {
      expect(parseCommand("mostrar lotes")).toMatchObject({ command: "list_fields" });
    });

    it("borrar lote test → delete_field fieldName:test", () => {
      expect(parseCommand("borrar lote test")).toMatchObject({ command: "delete_field", fieldName: "test" });
    });

    it("eliminar campo norte → delete_field fieldName:norte", () => {
      expect(parseCommand("eliminar campo norte")).toMatchObject({ command: "delete_field", fieldName: "norte" });
    });

    it("agregar lote norte en junin → add_field", () => {
      const r = parseCommand("agregar lote norte en junin");
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("norte");
      expect(r.city).toBe("Junin");
    });

    it("agregar lote sur → add_field sin city", () => {
      const r = parseCommand("agregar lote sur");
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("sur");
      expect(r.city).toBeNull();
    });
  });

  describe("set_field_city", () => {
    it("el lote general esta en Vedia → set_field_city", () => {
      const r = parseCommand("el lote general esta en Vedia");
      expect(r.command).toBe("set_field_city");
      expect(r.fieldName).toBe("general");
      expect(r.city).toBe("Vedia");
    });

    it("el lote general esta ubicado en Vedia → set_field_city", () => {
      const r = parseCommand("el lote general esta ubicado en Vedia");
      expect(r.command).toBe("set_field_city");
      expect(r.fieldName).toBe("general");
    });
  });

  // --- User identity ---
  describe("set_name / set_city", () => {
    it("soy Juan → set_name", () => {
      expect(parseCommand("soy Juan")).toMatchObject({ command: "set_name", name: "Juan" });
    });

    it("me llamo Pedro → set_name", () => {
      expect(parseCommand("me llamo Pedro")).toMatchObject({ command: "set_name", name: "Pedro" });
    });

    it("mi ciudad es Vedia → set_city", () => {
      expect(parseCommand("mi ciudad es Vedia")).toMatchObject({ command: "set_city" });
    });

    it("estoy en Junin → set_city", () => {
      expect(parseCommand("estoy en Junin")).toMatchObject({ command: "set_city" });
    });
  });

  // --- Cuánto gasté ---
  describe("cuanto gaste variants", () => {
    it("cuanto gaste esta semana → weekly_report", () => {
      expect(parseCommand("cuanto gaste esta semana")).toMatchObject({ command: "weekly_report" });
    });

    it("cuanto gaste hoy → date_range_report", () => {
      expect(parseCommand("cuanto gaste hoy")).toMatchObject({ command: "date_range_report" });
    });

    it("cuanto gaste en los ultimos 7 dias → date_range_report with dates", () => {
      const r = parseCommand("cuanto gaste en los ultimos 7 dias");
      expect(r.command).toBe("date_range_report");
      expect(r.desde).toBeInstanceOf(Date);
      expect(r.hasta).toBeInstanceOf(Date);
    });
  });

  describe("result dispatch", () => {
    it("resultado lote general → field_result fieldName:general", () => {
      expect(parseCommand("resultado lote general")).toMatchObject({
        command: "field_result",
        fieldName: "general",
      });
    });

    it("resultado del mes en lote test → field_result fieldName:test", () => {
      const r = parseCommand("resultado del mes en lote test");
      expect(r.command).toBe("field_result");
      expect(r.fieldName).toBe("test");
    });
  });

  // --- Invalid commands → null ---
  describe("returns null for unrecognized input", () => {
    it.each([
      ["asdasdasd"],
      ["xyzzy"],
      [""],
    ])("'%s' → null", (input) => {
      expect(parseCommand(input)).toBeNull();
    });
  });

  // Note: "hola que tal estas" matches the greeting pattern (starts with "hola")
  describe("greeting catches messages starting with greeting words", () => {
    it("hola que tal estas → greeting (matches 'hola' at start)", () => {
      expect(parseCommand("hola que tal estas")).toMatchObject({ command: "greeting" });
    });
  });
});

// ============================================================================
// 9. Cross-contamination guards
// ============================================================================

describe("cross-contamination guards", () => {
  describe("expense parser ignores income messages", () => {
    it.each([
      ["vendi 200mil de soja"],
      ["cobre 1,5 millones de trigo"],
      ["facturé 800 mil de girasol"],
    ])("parseMensaje('%s') → null", (input) => {
      expect(parseMensaje(input)).toBeNull();
    });
  });

  describe("income parser ignores expense messages", () => {
    it.each([
      ["gaste 50mil en gasoil"],
      ["200k en fertilizante"],
      ["50 lucas en combustible"],
    ])("parseMensajeIngreso('%s') → null", (input) => {
      expect(parseMensajeIngreso(input)).toBeNull();
    });
  });

  describe("rainfall log does not trigger as expense or income", () => {
    it("llovió 30 mm → not an expense", () => {
      expect(parseMensaje("llovió 30 mm")).toBeNull();
    });
    it("llovió 30 mm → not an income", () => {
      expect(parseMensajeIngreso("llovió 30 mm")).toBeNull();
    });
  });

  describe("commands do not leak into expense parser", () => {
    it.each([
      ["resumen mes"],
      ["ayuda"],
      ["clima"],
      ["borrar ultimo gasto"],
    ])("parseMensaje('%s') → null", (input) => {
      expect(parseMensaje(input)).toBeNull();
    });
  });
});

// ============================================================================
// 10. Accent normalization
// ============================================================================

describe("accent normalization", () => {
  it("cuánto gasté esta semana → weekly_report (accents handled)", () => {
    expect(parseCommand("cuánto gasté esta semana")).toMatchObject({ command: "weekly_report" });
  });

  it("cuánto gasté → recognized (accents stripped)", () => {
    expect(parseCommand("cuánto gasté")).not.toBeNull();
  });

  it("vendí with accent → income verb matched", () => {
    const r = parseMensajeIngreso("vendí soja por 200 mil");
    expect(r).not.toBeNull();
    expect(r.amount).toBe(200000);
  });

  it("llovió with accent → rainfall verb matched", () => {
    expect(parseMilimetros("llovió 20")).toBe(20);
  });
});

// ============================================================================
// 11. Regression tests for known bugs
// ============================================================================

describe("regression: known bugs", () => {
  it("gaste 50mil en un herbicida → amount 50000, NOT 1", () => {
    // Previously parseWrittenNumber("un") could override digit-based parsing
    const r = parseMensaje("gaste 50mil en un herbicida");
    expect(r).not.toBeNull();
    expect(r.amount).toBe(50000);
    expect(r.amount).not.toBe(1);
    expect(r.category).toBe("Agroquímicos");
  });

  it("pague 100mil en un repuesto → 100000, not 1", () => {
    const r = parseMensaje("pague 100mil en un repuesto");
    expect(r.amount).toBe(100000);
    expect(r.category).toBe("Maquinaria");
  });

  it("va a llover en alberdi mañana → city is alberdi, not null", () => {
    const r = parseCommand("va a llover en alberdi mañana?");
    expect(r.city).toBe("alberdi");
  });

  it("cuanto llovio ayer → rainfall_range, not monthly default", () => {
    const r = parseCommand("cuanto llovio ayer?");
    expect(r.command).toBe("rainfall_range");
  });

  it("cuando llovio esta semana en lote test → week + plot, not month default", () => {
    const r = parseCommand("cuando llovio esta semana en el lote test?");
    expect(r.command).toBe("rainfall_report");
    expect(r.period).toBe("week");
    expect(r.plotName).toBe("test");
  });

  it("$50000 en gasoil → 50000 Combustible", () => {
    const r = parseMensaje("$50000 en gasoil");
    expect(r.amount).toBe(50000);
    expect(r.category).toBe("Combustible");
  });
});

// ============================================================================
// 12. Multi-word field names (audio transcription support)
// ============================================================================

describe("multi-word field names", () => {
  describe("add_field with multi-word names", () => {
    it("agregar campo la esperanza → fieldName: 'la esperanza'", () => {
      const r = parseCommand("agregar campo la esperanza");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("la esperanza");
    });

    it("agregar campo la esperanza en junin → fieldName + city", () => {
      const r = parseCommand("agregar campo la esperanza en junin");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("la esperanza");
      expect(r.city).toBe("Junin");
    });

    it("agregar lote san pedro → fieldName: 'san pedro'", () => {
      const r = parseCommand("agregar lote san pedro");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("san pedro");
    });

    it("single word still works: agregar lote norte → fieldName: 'norte'", () => {
      const r = parseCommand("agregar lote norte");
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("norte");
    });

    it("single word with city still works: agregar lote norte en junin", () => {
      const r = parseCommand("agregar lote norte en junin");
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("norte");
      expect(r.city).toBe("Junin");
    });

    it("4-word name: agregar campo la esperanza grande → fieldName: 'la esperanza grande'", () => {
      const r = parseCommand("agregar campo la esperanza grande");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("la esperanza grande");
    });
  });

  describe("set_field_city with multi-word names", () => {
    it("lote la esperanza esta en bragado → set_field_city", () => {
      const r = parseCommand("lote la esperanza esta en bragado");
      expect(r).not.toBeNull();
      expect(r.command).toBe("set_field_city");
      expect(r.fieldName).toBe("la esperanza");
      expect(r.city).toBe("Bragado");
    });

    it("campo san martin queda en junin → set_field_city", () => {
      const r = parseCommand("campo san martin queda en junin");
      expect(r).not.toBeNull();
      expect(r.command).toBe("set_field_city");
      expect(r.fieldName).toBe("san martin");
    });
  });

  describe("field_info with multi-word names", () => {
    it("info campo la esperanza → field_info", () => {
      const r = parseCommand("info campo la esperanza");
      expect(r).not.toBeNull();
      expect(r.command).toBe("field_info");
      expect(r.fieldName).toBe("la esperanza");
    });

    it("info lote san pedro → plot_info (lote = plot)", () => {
      const r = parseCommand("info lote san pedro");
      expect(r).not.toBeNull();
      expect(r.command).toBe("plot_info");
      expect(r.plotName).toBe("san");
    });

    it("info campo san pedro → field_info", () => {
      const r = parseCommand("info campo san pedro");
      expect(r).not.toBeNull();
      expect(r.command).toBe("field_info");
      expect(r.fieldName).toBe("san pedro");
    });
  });

  describe("delete_field with multi-word names", () => {
    it("borrar campo la esperanza → delete_field", () => {
      const r = parseCommand("borrar campo la esperanza");
      expect(r).not.toBeNull();
      expect(r.command).toBe("delete_field");
      expect(r.fieldName).toBe("la esperanza");
    });
  });

  describe("list_plots with multi-word field names", () => {
    it("lotes del campo la esperanza → list_plots", () => {
      const r = parseCommand("lotes del campo la esperanza");
      expect(r).not.toBeNull();
      expect(r.command).toBe("list_plots");
      expect(r.fieldName).toBe("la esperanza");
    });
  });

  describe("list_fields audio patterns", () => {
    it("info de mis lotes → list_fields", () => {
      expect(parseCommand("info de mis lotes")).toMatchObject({ command: "list_fields" });
    });

    it("informacion de mis campos → list_fields", () => {
      expect(parseCommand("informacion de mis campos")).toMatchObject({ command: "list_fields" });
    });

    it("datos de mis lotes → list_fields", () => {
      expect(parseCommand("datos de mis lotes")).toMatchObject({ command: "list_fields" });
    });
  });

  describe("field_report with multi-word names", () => {
    it("resumen campo la esperanza → field_report", () => {
      const r = parseCommand("resumen campo la esperanza");
      expect(r).not.toBeNull();
      expect(r.command).toBe("field_report");
      expect(r.fieldName).toBe("la esperanza");
    });
  });
});

// ============================================================================
// 13. entityKeyword — campo vs lote distinction
// ============================================================================

describe("entityKeyword — campo vs lote distinction", () => {
  describe("add_field tracks keyword", () => {
    it("agregar campo juan pablo → entityKeyword: 'campo'", () => {
      const r = parseCommand("agregar campo juan pablo");
      expect(r.command).toBe("add_field");
      expect(r.entityKeyword).toBe("campo");
      expect(r.fieldName).toBe("juan pablo");
    });

    it("agregar lote norte → entityKeyword: 'lote'", () => {
      const r = parseCommand("agregar lote norte");
      expect(r.command).toBe("add_field");
      expect(r.entityKeyword).toBe("lote");
    });

    it("agregar parcela sur → entityKeyword: 'parcela'", () => {
      const r = parseCommand("agregar parcela sur");
      expect(r.command).toBe("add_field");
      expect(r.entityKeyword).toBe("parcela");
    });
  });

  describe("set_field_city tracks keyword", () => {
    it("campo la esperanza esta en bragado → entityKeyword: 'campo'", () => {
      const r = parseCommand("campo la esperanza esta en bragado");
      expect(r.command).toBe("set_field_city");
      expect(r.entityKeyword).toBe("campo");
      expect(r.fieldName).toBe("la esperanza");
    });

    it("lote norte esta en junin → entityKeyword: 'lote'", () => {
      const r = parseCommand("lote norte esta en junin");
      expect(r.command).toBe("set_field_city");
      expect(r.entityKeyword).toBe("lote");
    });
  });

  describe("delete_field tracks keyword", () => {
    it("borrar campo la esperanza → entityKeyword: 'campo'", () => {
      const r = parseCommand("borrar campo la esperanza");
      expect(r.entityKeyword).toBe("campo");
    });

    it("eliminar lote norte → entityKeyword: 'lote'", () => {
      const r = parseCommand("eliminar lote norte");
      expect(r.entityKeyword).toBe("lote");
    });
  });

  describe("field_info tracks keyword", () => {
    it("info campo la esperanza → entityKeyword: 'campo'", () => {
      const r = parseCommand("info campo la esperanza");
      expect(r.entityKeyword).toBe("campo");
    });

    it("campo norte? → entityKeyword: 'campo'", () => {
      const r = parseCommand("campo norte?");
      expect(r.command).toBe("field_info");
      expect(r.entityKeyword).toBe("campo");
    });
  });

  describe("field_report tracks keyword", () => {
    it("resumen campo norte → entityKeyword: 'campo'", () => {
      const r = parseCommand("resumen campo norte");
      expect(r.entityKeyword).toBe("campo");
    });

    it("resumen lote norte → plot_report with plotName: 'norte'", () => {
      const r = parseCommand("resumen lote norte");
      expect(r.command).toBe("plot_report");
      expect(r.plotName).toBe("norte");
    });
  });
});

// ============================================================================
// 14. Mandatory test cases (from requirements)
// ============================================================================

describe("mandatory test cases", () => {
  it("TEST 1: agregar campo la esperanza → CREATE_FIELD, fieldName = 'la esperanza'", () => {
    const r = parseCommand("agregar campo la esperanza");
    expect(r).not.toBeNull();
    expect(r.command).toBe("add_field");
    expect(r.fieldName).toBe("la esperanza");
    expect(r.entityKeyword).toBe("campo");
  });

  it("TEST 2: agregar campo juan pablo → CREATE_FIELD, fieldName = 'juan pablo'", () => {
    const r = parseCommand("agregar campo juan pablo");
    expect(r).not.toBeNull();
    expect(r.command).toBe("add_field");
    expect(r.fieldName).toBe("juan pablo");
    expect(r.entityKeyword).toBe("campo");
  });

  it("TEST 3: info de mis lotes → LIST_FIELDS", () => {
    const r = parseCommand("info de mis lotes");
    expect(r).not.toBeNull();
    expect(r.command).toBe("list_fields");
  });

  it("TEST 4: lote la esperanza esta en bragado → SET_FIELD_CITY", () => {
    const r = parseCommand("lote la esperanza esta en bragado");
    expect(r).not.toBeNull();
    expect(r.command).toBe("set_field_city");
    expect(r.fieldName).toBe("la esperanza");
    expect(r.city).toBe("Bragado");
    expect(r.entityKeyword).toBe("lote");
  });
});

// ============================================================================
// 15. Backward compatibility
// ============================================================================

describe("backward compatibility — single word names still work", () => {
  it("agregar lote norte en junin → still works", () => {
    const r = parseCommand("agregar lote norte en junin");
    expect(r.command).toBe("add_field");
    expect(r.fieldName).toBe("norte");
    expect(r.city).toBe("Junin");
  });

  it("borrar lote test → still works", () => {
    const r = parseCommand("borrar lote test");
    expect(r.command).toBe("delete_field");
    expect(r.fieldName).toBe("test");
  });

  it("lote general esta en Vedia → still works", () => {
    const r = parseCommand("lote general esta en Vedia");
    expect(r.command).toBe("set_field_city");
    expect(r.fieldName).toBe("general");
  });

  it("gaste 50mil en gasoil → expense still works", () => {
    const r = parseMensaje("gaste 50mil en gasoil");
    expect(r).toMatchObject({ type: "expense", amount: 50000, category: "Combustible" });
  });
});
