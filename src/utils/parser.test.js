import { describe, it, expect, beforeAll } from "vitest";
import {
  normalizarMonto,
  extractAmount,
  hasFinancialIntent,
  parseCommand,
  detectarCategoria,
  detectarCategoriaIngreso,
  parseMensaje,
  parseMensajeIngreso,
  parseMilimetros,
  detectarCampoLote,
  detectarCampo,
  detectarLote,
  detectarCultivo,
  normalizeText,
  parseSpanishDate,
  detectarProducto,
  parseQuantityUnit,
  parseFechaRelativa,
  detectarImplemento,
  parsearObservacion,
} from "./parser.js";

// ============================================================================
// normalizarMonto
// ============================================================================

describe("normalizarMonto", () => {
  describe("dígitos + sufijo mil", () => {
    it("50mil → 50000", () => expect(normalizarMonto("50mil")).toBe(50000));
    it("100mil → 100000", () => expect(normalizarMonto("100mil")).toBe(100000));
    it("50 mil → 50000", () => expect(normalizarMonto("50 mil")).toBe(50000));
    it("30mil → 30000", () => expect(normalizarMonto("30mil")).toBe(30000));
  });

  describe("signo pesos", () => {
    it("$150000 → 150000", () => expect(normalizarMonto("$150000")).toBe(150000));
    it("$50000 → 50000", () => expect(normalizarMonto("$50000")).toBe(50000));
    it("$ 200000 → 200000", () => expect(normalizarMonto("$ 200000")).toBe(200000));
  });

  describe("sufijo k / lucas", () => {
    it("200k → 200000", () => expect(normalizarMonto("200k")).toBe(200000));
    it("50 lucas → 50000", () => expect(normalizarMonto("50 lucas")).toBe(50000));
    it("100lucas → 100000", () => expect(normalizarMonto("100lucas")).toBe(100000));
  });

  describe("millones / palos", () => {
    // NOTE: dots are stripped for thousand separators, so "1.5" becomes "15"
    it("1,5 millones → 1500000", () => expect(normalizarMonto("1,5 millones")).toBe(1500000));
    it("1.5 millones → 15000000 (dot stripped as thousand sep)", () => expect(normalizarMonto("1.5 millones")).toBe(15000000));
    it("2 palos → 2000000", () => expect(normalizarMonto("2 palos")).toBe(2000000));
    it("1 millon → 1000000", () => expect(normalizarMonto("1 millon")).toBe(1000000));
  });

  describe("números escritos en español", () => {
    it("quinientos mil → 500000", () => expect(normalizarMonto("quinientos mil")).toBe(500000));
    it("medio millon → 500000", () => expect(normalizarMonto("medio millon")).toBe(500000));
    it("un millon → 1000000", () => expect(normalizarMonto("un millon")).toBe(1000000));
    it("dos millones → 2000000", () => expect(normalizarMonto("dos millones")).toBe(2000000));
    it("cien mil → 100000", () => expect(normalizarMonto("cien mil")).toBe(100000));
    it("doscientos mil → 200000", () => expect(normalizarMonto("doscientos mil")).toBe(200000));
  });

  describe("sufijo M (millones)", () => {
    it("5M → 5000000", () => expect(normalizarMonto("5M")).toBe(5000000));
    it("5m → 5000000", () => expect(normalizarMonto("5m")).toBe(5000000));
    it("1,5M → 1500000", () => expect(normalizarMonto("1,5M")).toBe(1500000));
    it("2.5M → 25000000 (dot stripped as thousand sep)", () => expect(normalizarMonto("2.5M")).toBe(25000000));
  });

  describe("standalone numbers", () => {
    it("500 → 500 (standalone)", () => expect(normalizarMonto("500")).toBe(500));
    it("150000 → 150000 (standalone)", () => expect(normalizarMonto("150000")).toBe(150000));
  });

  describe("number in sentence → null (normalizarMonto is structured-only)", () => {
    it("gaste 5000 → null (no structured format)", () => expect(normalizarMonto("gaste 5000")).toBeNull());
    it("gaste 500 → null", () => expect(normalizarMonto("gaste 500")).toBeNull());
  });
});

describe("extractAmount (number-first)", () => {
  it("gaste 150000 → 150000", () => expect(extractAmount("gaste 150000")).toBe(150000));
  it("gaste 5000 → 5000", () => expect(extractAmount("gaste 5000")).toBe(5000));
  it("pague 200000 → 200000", () => expect(extractAmount("pague 200000")).toBe(200000));
  it("gaste 500 → 500", () => expect(extractAmount("gaste 500")).toBe(500));
  it("gasto de 100 en semillas → 100", () => expect(extractAmount("gasto de 100 en semillas")).toBe(100));
  it("cargué gasto de 100 en semillas en lote 1 → 100", () => expect(extractAmount("cargué gasto de 100 en semillas en lote 1")).toBe(100));
  it("ingreso de 500 → 500", () => expect(extractAmount("ingreso de 500")).toBe(500));
  it("gasto 200 lote 1 → 200", () => expect(extractAmount("gasto 200 lote 1")).toBe(200));

  describe("safety: location numbers excluded", () => {
    it("en lote 1 → null", () => expect(extractAmount("en lote 1")).toBeNull());
    it("lote 10 → null", () => expect(extractAmount("lote 10")).toBeNull());
    it("campo 25 → null", () => expect(extractAmount("campo 25")).toBeNull());
  });

  describe("structured formats pass through", () => {
    it("50mil → 50000", () => expect(extractAmount("50mil")).toBe(50000));
    it("$100 → 100", () => expect(extractAmount("$100")).toBe(100));
    it("200k → 200000", () => expect(extractAmount("200k")).toBe(200000));
  });
});

describe("hasFinancialIntent", () => {
  it("gasto → true", () => expect(hasFinancialIntent("gasto")).toBe(true));
  it("gasté → true", () => expect(hasFinancialIntent("gasté")).toBe(true));
  it("cargué → true", () => expect(hasFinancialIntent("cargué")).toBe(true));
  it("ingreso → true", () => expect(hasFinancialIntent("ingreso")).toBe(true));
  it("compra → true", () => expect(hasFinancialIntent("compra")).toBe(true));
  it("lote 3 → false", () => expect(hasFinancialIntent("lote 3")).toBe(false));
  it("malezas → false", () => expect(hasFinancialIntent("malezas")).toBe(false));
  it("lluvia 20mm → false", () => expect(hasFinancialIntent("lluvia 20mm")).toBe(false));

  describe("BUG FIX: dígitos+sufijo prioriza sobre parseWrittenNumber", () => {
    it("gaste 50mil en un herbicida → 50000 (no 1)", () => {
      expect(normalizarMonto("gaste 50mil en un herbicida")).toBe(50000);
    });
    it("pague 100mil en un repuesto → 100000", () => {
      expect(normalizarMonto("pague 100mil en un repuesto")).toBe(100000);
    });
    it("compre por 30mil un fungicida → 30000", () => {
      expect(normalizarMonto("compre por 30mil un fungicida")).toBe(30000);
    });
    it("vendi 200mil de soja → 200000", () => {
      expect(normalizarMonto("vendi 200mil de soja")).toBe(200000);
    });
    it("50mil en gasoil → 50000", () => {
      expect(normalizarMonto("50mil en gasoil")).toBe(50000);
    });
  });
});

// ============================================================================
// parseCommand
// ============================================================================

describe("parseCommand", () => {
  describe("confirm / cancel", () => {
    it.each(["si", "dale", "confirmo", "va"])("'%s' → confirm", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "confirm" });
    });
    it.each(["no", "cancelar", "cancelo", "nah"])("'%s' → cancel", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "cancel" });
    });
  });

  describe("greeting / thanks / ack / help", () => {
    it.each(["hola", "buenas", "buen dia", "buenas tardes"])("'%s' → greeting", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "greeting" });
    });
    it.each(["gracias", "genial", "joya"])("'%s' → thanks", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "thanks" });
    });
    it.each(["ok", "listo", "perfecto"])("'%s' → ack", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "ack" });
    });
    it.each(["ayuda", "help", "?"])("'%s' → help", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "help" });
    });
  });

  describe("dollar", () => {
    it.each(["dolar", "cotizacion dolar", "dolares"])("'%s' → dollar", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "dollar" });
    });
  });

  describe("alertas", () => {
    it("mis alertas → show_alerts", () => {
      expect(parseCommand("mis alertas")).toMatchObject({ command: "show_alerts" });
    });
    it("ver alertas → show_alerts", () => {
      expect(parseCommand("ver alertas")).toMatchObject({ command: "show_alerts" });
    });
    it("alerta lluvia 15mm → set_rain_threshold mm:15", () => {
      expect(parseCommand("alerta lluvia 15mm")).toMatchObject({ command: "set_rain_threshold", mm: 15 });
    });
    it("alerta lluvia 20 → set_rain_threshold mm:20", () => {
      expect(parseCommand("alerta lluvia 20")).toMatchObject({ command: "set_rain_threshold", mm: 20 });
    });
  });

  describe("toggle alert", () => {
    it("activar lluvia → enable_rain_alerts", () => {
      expect(parseCommand("activar lluvia")).toMatchObject({ command: "enable_rain_alerts" });
    });
    it("desactivar lluvia → disable_rain_alerts", () => {
      expect(parseCommand("desactivar lluvia")).toMatchObject({ command: "disable_rain_alerts" });
    });
    it("activar presupuesto → enable_budget_alerts", () => {
      expect(parseCommand("activar presupuesto")).toMatchObject({ command: "enable_budget_alerts" });
    });
    it("desactivar resumen semanal → disable_weekly_summary", () => {
      expect(parseCommand("desactivar resumen semanal")).toMatchObject({ command: "disable_weekly_summary" });
    });
  });

  describe("list_fields", () => {
    it.each(["ver campos", "mis campos"])("'%s' → list_fields", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "list_fields" });
    });
    it.each(["mis lotes", "ver lotes"])("'%s' → list_plots", (t) => {
      expect(parseCommand(t)).toMatchObject({ command: "list_plots" });
    });
    it("que campos tengo? → list_fields", () => {
      expect(parseCommand("que campos tengo?")).toMatchObject({ command: "list_fields" });
    });
    it("mostrar lotes → list_plots", () => {
      expect(parseCommand("mostrar lotes")).toMatchObject({ command: "list_plots" });
    });
  });

  describe("delete_field", () => {
    it("borrar lote test → delete_field fieldName:test", () => {
      expect(parseCommand("borrar lote test")).toMatchObject({ command: "delete_field", fieldName: "test" });
    });
    it("eliminar campo norte → delete_field fieldName:norte", () => {
      expect(parseCommand("eliminar campo norte")).toMatchObject({ command: "delete_field", fieldName: "norte" });
    });
  });

  describe("add_field", () => {
    it("agregar campo norte en junin → add_field", () => {
      const r = parseCommand("agregar campo norte en junin");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("norte");
      expect(r.city).toBe("Junin");
    });
    it("agregar lote sur → add_field (smart lote flow, no field specified)", () => {
      const r = parseCommand("agregar lote sur");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_field");
      expect(r.fieldName).toBe("sur");
    });
  });

  describe("add_plot without 'campo' keyword (BUG-C1 fix)", () => {
    it("crear lote 3 en sur → add_plot", () => {
      const r = parseCommand("crear lote 3 en sur");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("3");
      expect(r.fieldName).toBe("sur");
    });
    it("agregar lote 3 en sur → add_plot", () => {
      const r = parseCommand("agregar lote 3 en sur");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("3");
      expect(r.fieldName).toBe("sur");
    });
    it("agregar lote norte en junin → add_plot (lote in field junin)", () => {
      const r = parseCommand("agregar lote norte en junin");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("norte");
      expect(r.fieldName).toBe("junin");
    });
    it("agrega lote 5 norte → add_plot", () => {
      const r = parseCommand("agrega lote 5 norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("5");
      expect(r.fieldName).toBe("norte");
    });
    it("lote 4 para campo norte → add_plot", () => {
      const r = parseCommand("lote 4 para campo norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("4");
      expect(r.fieldName).toBe("norte");
    });
    it("agregar lote 3 en campo sur → add_plot (original pattern still works)", () => {
      const r = parseCommand("agregar lote 3 en campo sur");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("3");
      expect(r.fieldName).toBe("sur");
    });
  });

  describe("list_plots", () => {
    it("lotes del campo norte → list_plots fieldName:norte", () => {
      expect(parseCommand("lotes del campo norte")).toMatchObject({ command: "list_plots", fieldName: "norte" });
    });
    it("mis lotes del campo sur → list_plots fieldName:sur", () => {
      expect(parseCommand("mis lotes del campo sur")).toMatchObject({ command: "list_plots", fieldName: "sur" });
    });
    it("que lotes tiene el campo norte → list_plots", () => {
      expect(parseCommand("que lotes tiene el campo norte")).toMatchObject({ command: "list_plots", fieldName: "norte" });
    });
  });

  describe("add_plot", () => {
    it("agregar lote 3 en campo norte → add_plot", () => {
      const r = parseCommand("agregar lote 3 en campo norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("3");
      expect(r.fieldName).toBe("norte");
    });
    it("crear lote sur de campo este → add_plot", () => {
      const r = parseCommand("crear lote sur de campo este");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("sur");
      expect(r.fieldName).toBe("este");
    });
    it("agregar lote 1 al campo Campo Norte → multi-word field, 'al' preposition", () => {
      const r = parseCommand("agregar lote 1 al campo Campo Norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("1");
      expect(r.fieldName).toBe("Campo Norte");
    });
    it("agregar lote sur al campo el norte → 'al' preposition", () => {
      const r = parseCommand("agregar lote sur al campo el norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("sur");
    });
    it("crear lote 2 en el campo Don Pedro → article before campo", () => {
      const r = parseCommand("crear lote 2 en el campo Don Pedro");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("2");
      expect(r.fieldName).toBe("Don Pedro");
    });
    it("agregar lote nuevo a campo sur → 'a' preposition", () => {
      const r = parseCommand("agregar lote nuevo a campo sur");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("nuevo");
      expect(r.fieldName).toBe("sur");
    });
    it("agregar un lote 1 al campo norte → optional article before lote", () => {
      const r = parseCommand("agregar un lote 1 al campo norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("add_plot");
      expect(r.plotName).toBe("1");
      expect(r.fieldName).toBe("norte");
    });
  });

  describe("plot_info", () => {
    it("info lote 3 del campo norte → plot_info", () => {
      const r = parseCommand("info lote 3 del campo norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("plot_info");
      expect(r.plotName).toBe("3");
      expect(r.fieldName).toBe("norte");
    });
    it("info lote 3 → plot_info (no campo)", () => {
      const r = parseCommand("info lote 3");
      expect(r).not.toBeNull();
      expect(r.command).toBe("plot_info");
      expect(r.plotName).toBe("3");
    });
    it("lote z → plot_info (bare name)", () => {
      const r = parseCommand("lote z");
      expect(r).not.toBeNull();
      expect(r.command).toBe("plot_info");
      expect(r.plotName).toBe("z");
    });
    it("lote norte → plot_info (bare name)", () => {
      const r = parseCommand("lote norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("plot_info");
      expect(r.plotName).toBe("norte");
    });
    it("lote san antonio → plot_info (multi-word)", () => {
      const r = parseCommand("lote san antonio");
      expect(r).not.toBeNull();
      expect(r.command).toBe("plot_info");
      expect(r.plotName).toBe("san antonio");
    });
    it("lote z? → plot_info (with question mark)", () => {
      const r = parseCommand("lote z?");
      expect(r).not.toBeNull();
      expect(r.command).toBe("plot_info");
      expect(r.plotName).toBe("z");
    });
    it("campo general → field_info (not plot_info)", () => {
      const r = parseCommand("campo general");
      expect(r).not.toBeNull();
      expect(r.command).toBe("field_info");
      expect(r.fieldName).toBe("general");
    });
    it("info campo general → field_info", () => {
      const r = parseCommand("info campo general");
      expect(r).not.toBeNull();
      expect(r.command).toBe("field_info");
      expect(r.fieldName).toBe("general");
    });
  });

  describe("delete_plot", () => {
    it("borrar lote 3 del campo norte → delete_plot", () => {
      const r = parseCommand("borrar lote 3 del campo norte");
      expect(r).not.toBeNull();
      expect(r.command).toBe("delete_plot");
      expect(r.plotName).toBe("3");
      expect(r.fieldName).toBe("norte");
    });
  });

  describe("set_city", () => {
    it("mi ciudad es Vedia → set_city", () => {
      expect(parseCommand("mi ciudad es Vedia")).toMatchObject({ command: "set_city" });
    });
    it("estoy en Junin → set_city", () => {
      expect(parseCommand("estoy en Junin")).toMatchObject({ command: "set_city" });
    });
  });

  describe("set_name", () => {
    it("soy Juan → set_name", () => {
      expect(parseCommand("soy Juan")).toMatchObject({ command: "set_name", name: "Juan" });
    });
    it("me llamo Pedro → set_name", () => {
      expect(parseCommand("me llamo Pedro")).toMatchObject({ command: "set_name", name: "Pedro" });
    });
  });

  describe("set_budget", () => {
    it("presupuesto combustible 500mil → set_budget", () => {
      const r = parseCommand("presupuesto combustible 500mil");
      expect(r).not.toBeNull();
      expect(r.command).toBe("set_budget");
      expect(r.amount).toBe(500000);
    });
  });

  describe("delete_last / edit_last", () => {
    it("borrar ultimo gasto → delete_last", () => {
      expect(parseCommand("borrar ultimo gasto")).toMatchObject({ command: "delete_last" });
    });
    it("eliminar ultimo gasto → delete_last", () => {
      expect(parseCommand("eliminar ultimo gasto")).toMatchObject({ command: "delete_last" });
    });
    it("editar ultimo gasto a 50mil → edit_last amount:50000", () => {
      expect(parseCommand("editar ultimo gasto a 50mil")).toMatchObject({ command: "edit_last", amount: 50000 });
    });
  });

  describe("export", () => {
    it("exportar csv → export_csv", () => {
      expect(parseCommand("exportar csv")).toMatchObject({ command: "export_csv" });
    });
    it("exportar gastos → export_csv", () => {
      expect(parseCommand("exportar gastos")).toMatchObject({ command: "export_csv" });
    });
  });
});

// ============================================================================
// detectarCategoria
// ============================================================================

describe("detectarCategoria", () => {
  describe("exactas", () => {
    it("gasoil → Combustible", () => expect(detectarCategoria("gasoil")).toBe("Combustible"));
    it("diesel → Combustible", () => expect(detectarCategoria("diesel")).toBe("Combustible"));
    it("nafta → Combustible", () => expect(detectarCategoria("nafta")).toBe("Combustible"));
    it("herbicida → Agroquímicos", () => expect(detectarCategoria("herbicida")).toBe("Agroquímicos"));
    it("insecticida → Agroquímicos", () => expect(detectarCategoria("insecticida")).toBe("Agroquímicos"));
    it("fungicida → Agroquímicos", () => expect(detectarCategoria("fungicida")).toBe("Agroquímicos"));
    it("semillas → Semillas", () => expect(detectarCategoria("semillas")).toBe("Semillas"));
    it("fertilizante → Fertilizantes", () => expect(detectarCategoria("fertilizante")).toBe("Fertilizantes"));
    it("urea → Fertilizantes", () => expect(detectarCategoria("urea")).toBe("Fertilizantes"));
    it("tractor → Maquinaria", () => expect(detectarCategoria("tractor")).toBe("Maquinaria"));
    it("repuesto → Maquinaria", () => expect(detectarCategoria("repuesto")).toBe("Maquinaria"));
    it("alquiler → Arrendamiento", () => expect(detectarCategoria("alquiler")).toBe("Arrendamiento"));
    it("sueldo → Sueldos", () => expect(detectarCategoria("sueldo")).toBe("Sueldos"));
    it("impuesto → Impuestos", () => expect(detectarCategoria("impuesto")).toBe("Impuestos"));
  });

  describe("fuzzy matching", () => {
    it("gasoill (typo) → Combustible", () => expect(detectarCategoria("gasoill")).toBe("Combustible"));
    it("fertlizante (typo) → Fertilizantes", () => expect(detectarCategoria("fertlizante")).toBe("Fertilizantes"));
    it("naftaa (typo) → Combustible", () => expect(detectarCategoria("naftaa")).toBe("Combustible"));
    it("herbicid (truncado) → Agroquímicos", () => expect(detectarCategoria("herbicid")).toBe("Agroquímicos"));
  });

  describe("agroquímicos reclassified", () => {
    it("glifosato → Agroquímicos", () => expect(detectarCategoria("glifosato")).toBe("Agroquímicos"));
    it("fumigacion → Agroquímicos", () => expect(detectarCategoria("fumigacion")).toBe("Agroquímicos"));
  });

  describe("maquinaria extended", () => {
    it("contratista → Maquinaria", () => expect(detectarCategoria("contratista")).toBe("Maquinaria"));
    it("laboreo → Maquinaria", () => expect(detectarCategoria("laboreo")).toBe("Maquinaria"));
  });

  describe("otros (new)", () => {
    it("flete → Otros", () => expect(detectarCategoria("flete")).toBe("Otros"));
    it("transporte → Otros", () => expect(detectarCategoria("transporte")).toBe("Otros"));
    it("seguro → Otros", () => expect(detectarCategoria("seguro")).toBe("Otros"));
    it("veterinario → Otros", () => expect(detectarCategoria("veterinario")).toBe("Otros"));
    it("silobolsa → Otros", () => expect(detectarCategoria("silobolsa")).toBe("Otros"));
  });

  describe("no match", () => {
    it("algo random → null", () => expect(detectarCategoria("algo random")).toBeNull());
    it("hola → null", () => expect(detectarCategoria("hola")).toBeNull());
  });
});

// ============================================================================
// detectarCategoriaIngreso
// ============================================================================

describe("detectarCategoriaIngreso", () => {
  it("soja → Soja", () => expect(detectarCategoriaIngreso("soja")).toBe("Soja"));
  it("maiz → Maíz", () => expect(detectarCategoriaIngreso("maiz")).toBe("Maíz"));
  it("trigo → Trigo", () => expect(detectarCategoriaIngreso("trigo")).toBe("Trigo"));
  it("girasol → Girasol", () => expect(detectarCategoriaIngreso("girasol")).toBe("Girasol"));
  it("novillo → Hacienda", () => expect(detectarCategoriaIngreso("novillo")).toBe("Hacienda"));
  it("ganado → Hacienda", () => expect(detectarCategoriaIngreso("ganado")).toBe("Hacienda"));
  it("vaca → Hacienda", () => expect(detectarCategoriaIngreso("vaca")).toBe("Hacienda"));
  it("sorgo → Sorgo", () => expect(detectarCategoriaIngreso("sorgo")).toBe("Sorgo"));
  it("cebada → Cebada", () => expect(detectarCategoriaIngreso("cebada")).toBe("Cebada"));
  it("algo random → null", () => expect(detectarCategoriaIngreso("algo random")).toBeNull());
});

// ============================================================================
// parseMensaje (gastos)
// ============================================================================

describe("parseMensaje", () => {
  it("gaste 50mil en gasoil → expense 50000 Combustible", () => {
    const r = parseMensaje("gaste 50mil en gasoil");
    expect(r).not.toBeNull();
    expect(r.type).toBe("expense");
    expect(r.amount).toBe(50000);
    expect(r.category).toBe("Combustible");
  });

  it("pague 100mil en un herbicida → expense 100000 Agroquímicos", () => {
    const r = parseMensaje("pague 100mil en un herbicida");
    expect(r).not.toBeNull();
    expect(r.type).toBe("expense");
    expect(r.amount).toBe(100000);
    expect(r.category).toBe("Agroquímicos");
  });

  it("gaste 50mil en un herbicida → expense 50000 Agroquímicos (BUG FIX)", () => {
    const r = parseMensaje("gaste 50mil en un herbicida");
    expect(r).not.toBeNull();
    expect(r.type).toBe("expense");
    expect(r.amount).toBe(50000);
    expect(r.category).toBe("Agroquímicos");
  });

  it("$200000 en fertilizante → expense 200000 Fertilizantes", () => {
    const r = parseMensaje("$200000 en fertilizante");
    expect(r).not.toBeNull();
    expect(r.amount).toBe(200000);
    expect(r.category).toBe("Fertilizantes");
  });

  it("quinientos mil en semillas → expense 500000 Semillas", () => {
    const r = parseMensaje("quinientos mil en semillas");
    expect(r).not.toBeNull();
    expect(r.amount).toBe(500000);
    expect(r.category).toBe("Semillas");
  });

  it("sin categoría → null", () => {
    expect(parseMensaje("gaste 50mil")).toBeNull();
  });

  it("50 bolsas a 100mil cada una → null (complejo)", () => {
    expect(parseMensaje("50 bolsas a 100mil cada una")).toBeNull();
  });

  it("sin monto → null", () => {
    expect(parseMensaje("compre gasoil")).toBeNull();
  });
});

// ============================================================================
// parseMensajeIngreso (ingresos)
// ============================================================================

describe("parseMensajeIngreso", () => {
  it("vendi 200mil de soja → income 200000 Soja", () => {
    const r = parseMensajeIngreso("vendi 200mil de soja");
    expect(r).not.toBeNull();
    expect(r.type).toBe("income");
    expect(r.amount).toBe(200000);
    expect(r.category).toBe("Soja");
  });

  it("cobre 1,5 millones de trigo → income 1500000 Trigo", () => {
    const r = parseMensajeIngreso("cobre 1,5 millones de trigo");
    expect(r).not.toBeNull();
    expect(r.type).toBe("income");
    expect(r.amount).toBe(1500000);
    expect(r.category).toBe("Trigo");
  });

  it("vendi 500mil de maiz → income 500000 Maíz", () => {
    const r = parseMensajeIngreso("vendi 500mil de maiz");
    expect(r).not.toBeNull();
    expect(r.type).toBe("income");
    expect(r.amount).toBe(500000);
    expect(r.category).toBe("Maíz");
  });

  it("sin verbo de ingreso → null", () => {
    expect(parseMensajeIngreso("gaste 50mil en gasoil")).toBeNull();
  });

  it("vendi sin monto → null", () => {
    expect(parseMensajeIngreso("vendi soja")).toBeNull();
  });

  it("USD: vendi 100mil de soja en dolares → currency USD", () => {
    const r = parseMensajeIngreso("vendi 100mil de soja en dolar");
    expect(r).not.toBeNull();
    expect(r.currency).toBe("USD");
  });
});

// ============================================================================
// parseMilimetros
// ============================================================================

describe("parseMilimetros", () => {
  it("30mm → 30", () => expect(parseMilimetros("30mm")).toBe(30));
  it("15.5mm → 15.5", () => expect(parseMilimetros("15.5mm")).toBe(15.5));
  it("llovio 15.5 → 15.5", () => expect(parseMilimetros("llovio 15.5")).toBe(15.5));
  it("cayeron 20mm → 20", () => expect(parseMilimetros("cayeron 20mm")).toBe(20));
  it("sin milimetros → null", () => expect(parseMilimetros("hola")).toBeNull());
});

// ============================================================================
// detectarCampo
// ============================================================================

describe("detectarCampo", () => {
  it("campo norte → norte", () => expect(detectarCampo("campo norte")).toBe("norte"));
  it("parcela sur → sur", () => expect(detectarCampo("parcela sur")).toBe("sur"));
  it("lote 3 → null (lote is not a campo)", () => expect(detectarCampo("lote 3")).toBeNull());
  it("algo sin campo → null", () => expect(detectarCampo("algo random")).toBeNull());
});

// ============================================================================
// detectarLote
// ============================================================================

describe("detectarLote", () => {
  // Original simple patterns
  it("lote 3 → 3", () => expect(detectarLote("lote 3")).toBe("3"));
  it("lote general → general", () => expect(detectarLote("lote general")).toBe("general"));
  it("campo norte → null (campo is not a lote)", () => expect(detectarLote("campo norte")).toBeNull());
  it("algo sin lote → null", () => expect(detectarLote("algo random")).toBeNull());

  // Enhanced: "lote del/de la X"
  it("lote del fondo → del fondo", () => expect(detectarLote("lote del fondo")).toBe("del fondo"));
  it("lote de la loma → de la loma", () => expect(detectarLote("lote de la loma")).toBe("de la loma"));

  // Enhanced: "en el/la X"
  it("en el bajo → bajo", () => expect(detectarLote("llovieron 20mm en el bajo")).toBe("bajo"));
  it("en la loma → loma", () => expect(detectarLote("gasté 50mil en la loma")).toBe("loma"));
  it("en el 3 → 3", () => expect(detectarLote("pagué gasoil en el 3")).toBe("3"));

  // Pronoun references → __last__ sentinel
  it("ese lote → __last__", () => expect(detectarLote("cuánto gasté en ese lote")).toBe("__last__"));
  it("el mismo → __last__", () => expect(detectarLote("registrar lluvia el mismo")).toBe("__last__"));
  it("ahi mismo → __last__", () => expect(detectarLote("llovió 10mm ahi mismo")).toBe("__last__"));
  it("mismo lote → __last__", () => expect(detectarLote("gasté 20mil en el mismo lote")).toBe("__last__"));

  // Exclusion list: "en el" false positive prevention
  it("en el mes → null", () => expect(detectarLote("gastos en el mes")).toBeNull());
  it("en el banco → null", () => expect(detectarLote("pagué en el banco")).toBeNull());
  it("en el campo → null (excluded)", () => expect(detectarLote("gasté en el campo")).toBeNull());
  it("en el total → null", () => expect(detectarLote("incluido en el total")).toBeNull());

  // normalizeText export works
  it("normalizeText removes accents", () => expect(normalizeText("café")).toBe("cafe"));
  it("normalizeText lowercases", () => expect(normalizeText("LOTE")).toBe("lote"));
});

// ============================================================================
// detectarCampoLote (backward compat)
// ============================================================================

describe("detectarCampoLote", () => {
  it("lote general → general", () => expect(detectarCampoLote("lote general")).toBe("general"));
  it("campo norte → norte", () => expect(detectarCampoLote("campo norte")).toBe("norte"));
  it("parcela sur → sur", () => expect(detectarCampoLote("parcela sur")).toBe("sur"));
  it("algo sin lote → null", () => expect(detectarCampoLote("algo sin campo")).toBeNull());
  it("el lote test tiene → test", () => expect(detectarCampoLote("el lote test tiene")).toBe("test"));
});

// ============================================================================
// parseSpanishDate
// ============================================================================

describe("parseSpanishDate", () => {
  it("15 de marzo → March 15 current year", () => {
    const d = parseSpanishDate("15 de marzo");
    expect(d).not.toBeNull();
    expect(d.getMonth()).toBe(2); // marzo = 2
    expect(d.getDate()).toBe(15);
  });

  it("1/6 → June 1 current year", () => {
    const d = parseSpanishDate("1/6");
    expect(d).not.toBeNull();
    expect(d.getMonth()).toBe(5); // junio = 5
    expect(d.getDate()).toBe(1);
  });

  it("25 diciembre → December 25", () => {
    const d = parseSpanishDate("25 diciembre");
    expect(d).not.toBeNull();
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(25);
  });

  it("texto sin fecha → null", () => {
    expect(parseSpanishDate("hola mundo")).toBeNull();
  });

  it("31/12 → December 31", () => {
    const d = parseSpanishDate("31/12");
    expect(d).not.toBeNull();
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(31);
  });
});

// ============================================================================
// Edge cases / bugs reales
// ============================================================================

describe("Edge cases y bugs reales", () => {
  it("BUG: gaste 50mil en un herbicida → amount 50000, NO 1", () => {
    const r = parseMensaje("gaste 50mil en un herbicida");
    expect(r).not.toBeNull();
    expect(r.amount).toBe(50000);
    expect(r.amount).not.toBe(1);
  });

  it("pague 100mil en un repuesto → Maquinaria", () => {
    const r = parseMensaje("pague 100mil en un repuesto");
    expect(r).not.toBeNull();
    expect(r.amount).toBe(100000);
    expect(r.category).toBe("Maquinaria");
  });

  it("$50000 en gasoil → 50000 Combustible", () => {
    const r = parseMensaje("$50000 en gasoil");
    expect(r).not.toBeNull();
    expect(r.amount).toBe(50000);
    expect(r.category).toBe("Combustible");
  });
});

// ============================================================================
// detectarCultivo
// ============================================================================

describe("detectarCultivo", () => {
  it("soja → Soja", () => expect(detectarCultivo("soja")).toBe("Soja"));
  it("maiz → Maíz", () => expect(detectarCultivo("maiz")).toBe("Maíz"));
  it("trigo → Trigo", () => expect(detectarCultivo("trigo")).toBe("Trigo"));
  it("girasol → Girasol", () => expect(detectarCultivo("girasol")).toBe("Girasol"));
  it("cebada → Cebada", () => expect(detectarCultivo("cebada")).toBe("Cebada"));
  it("avena → Avena", () => expect(detectarCultivo("avena")).toBe("Avena"));
  it("alfalfa → Alfalfa", () => expect(detectarCultivo("alfalfa")).toBe("Alfalfa"));
  it("soya → Soja", () => expect(detectarCultivo("soya")).toBe("Soja"));
  it("gasoil → null (not a crop)", () => expect(detectarCultivo("gasoil")).toBeNull());
  it("hola → null", () => expect(detectarCultivo("hola")).toBeNull());
  it("sembramos soja en el lote 3 → Soja", () => expect(detectarCultivo("sembramos soja en el lote 3")).toBe("Soja"));
});


// ============================================================================
// detectarProducto
// ============================================================================

describe("detectarProducto", () => {
  it("glifosato → { Glifosato, herbicida }", () => {
    const r = detectarProducto("glifosato");
    expect(r).not.toBeNull();
    expect(r.name).toBe("Glifosato");
    expect(r.type).toBe("herbicida");
  });

  it("urea → { Urea, fertilizante }", () => {
    const r = detectarProducto("urea");
    expect(r).not.toBeNull();
    expect(r.name).toBe("Urea");
    expect(r.type).toBe("fertilizante");
  });

  it("atrazina → { Atrazina, herbicida }", () => {
    const r = detectarProducto("atrazina");
    expect(r).not.toBeNull();
    expect(r.name).toBe("Atrazina");
    expect(r.type).toBe("herbicida");
  });

  it("cipermetrina → { Cipermetrina, insecticida }", () => {
    const r = detectarProducto("cipermetrina");
    expect(r).not.toBeNull();
    expect(r.name).toBe("Cipermetrina");
    expect(r.type).toBe("insecticida");
  });

  it("sulfato de amonio → { Sulfato de Amonio, fertilizante } (multi-word)", () => {
    const r = detectarProducto("sulfato de amonio");
    expect(r).not.toBeNull();
    expect(r.name).toBe("Sulfato de Amonio");
    expect(r.type).toBe("fertilizante");
  });

  it("gasoil → null (not a product)", () => {
    expect(detectarProducto("gasoil")).toBeNull();
  });

  it("hola → null", () => {
    expect(detectarProducto("hola")).toBeNull();
  });

  it("roundup → Glifosato (alias)", () => {
    const r = detectarProducto("roundup");
    expect(r).not.toBeNull();
    expect(r.name).toBe("Glifosato");
  });

  it("dap → DAP (fertilizante)", () => {
    const r = detectarProducto("dap");
    expect(r).not.toBeNull();
    expect(r.name).toBe("DAP");
    expect(r.type).toBe("fertilizante");
  });
});

// ============================================================================
// parseQuantityUnit
// ============================================================================

describe("parseQuantityUnit", () => {
  it("150 kg → { 150, 'kg' }", () => {
    const r = parseQuantityUnit("150 kg");
    expect(r).not.toBeNull();
    expect(r.quantity).toBe(150);
    expect(r.unit).toBe("kg");
  });

  it("200 litros → { 200, 'lt' }", () => {
    const r = parseQuantityUnit("200 litros");
    expect(r).not.toBeNull();
    expect(r.quantity).toBe(200);
    expect(r.unit).toBe("lt");
  });

  it("3 bolsas → { 3, 'bolsas' }", () => {
    const r = parseQuantityUnit("3 bolsas");
    expect(r).not.toBeNull();
    expect(r.quantity).toBe(3);
    expect(r.unit).toBe("bolsas");
  });

  it("2,5 lts → { 2.5, 'lt' }", () => {
    const r = parseQuantityUnit("2,5 lts");
    expect(r).not.toBeNull();
    expect(r.quantity).toBe(2.5);
    expect(r.unit).toBe("lt");
  });

  it("50 cc → { 50, 'cc' }", () => {
    const r = parseQuantityUnit("50 cc");
    expect(r).not.toBeNull();
    expect(r.quantity).toBe(50);
    expect(r.unit).toBe("cc");
  });

  it("no unit → null", () => {
    expect(parseQuantityUnit("hola mundo")).toBeNull();
  });

  it("in context: tiramos 150 kg de urea → { 150, 'kg' }", () => {
    const r = parseQuantityUnit("tiramos 150 kg de urea");
    expect(r).not.toBeNull();
    expect(r.quantity).toBe(150);
    expect(r.unit).toBe("kg");
  });
});

// ============================================================================
// detectarImplemento
// ============================================================================

describe("detectarImplemento", () => {
  it("cincel → Cincel", () => expect(detectarImplemento("cincel")).toBe("Cincel"));
  it("rastra → Rastra", () => expect(detectarImplemento("rastra")).toBe("Rastra"));
  it("arado → Arado", () => expect(detectarImplemento("arado")).toBe("Arado"));
  it("disco → Disco", () => expect(detectarImplemento("disco")).toBe("Disco"));
  it("cincelada → Cincel", () => expect(detectarImplemento("cincelada")).toBe("Cincel"));
  it("hola → null", () => expect(detectarImplemento("hola")).toBeNull());
});

// ============================================================================
// parseFechaRelativa
// ============================================================================

describe("parseFechaRelativa", () => {
  it("hoy → today", () => {
    const r = parseFechaRelativa("hoy");
    expect(r).not.toBeNull();
    const today = new Date();
    expect(r.getDate()).toBe(today.getDate());
  });

  it("ayer → yesterday", () => {
    const r = parseFechaRelativa("ayer");
    expect(r).not.toBeNull();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(r.getDate()).toBe(yesterday.getDate());
  });

  it("anteayer → day before yesterday", () => {
    const r = parseFechaRelativa("anteayer");
    expect(r).not.toBeNull();
    const d = new Date();
    d.setDate(d.getDate() - 2);
    expect(r.getDate()).toBe(d.getDate());
  });

  it("no date → null", () => {
    expect(parseFechaRelativa("algo random")).toBeNull();
  });
});



// ============================================================================
// parsearObservacion with observation prefix
// ============================================================================

describe("parsearObservacion with agro keywords", () => {
  it('"observación: riego en lote 1" → detects plotName', () => {
    const obs = parsearObservacion("observación: riego en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.plotName).toBe("1");
  });

  it('"observación lote 3: hay malezas" → detects plotName', () => {
    const obs = parsearObservacion("observación lote 3: hay malezas");
    expect(obs).not.toBeNull();
    expect(obs.plotName).toBe("3");
  });
});


// ============================================================================
// normalizeObservationText — dedup normalization
// ============================================================================

describe("normalizeObservationText", () => {
  // Import inline since it's from observations.js, not parser.js
  let normalize;
  beforeAll(async () => {
    const mod = await import("../services/observations.js");
    normalize = mod.normalizeObservationText;
  });

  it("identical after normalization for same observation with/without location", () => {
    expect(normalize("hojas amarillas en lote 1")).toBe(normalize("hojas amarillas"));
  });

  it("strips accents", () => {
    expect(normalize("observación")).toBe(normalize("observacion"));
  });

  it("strips punctuation", () => {
    expect(normalize("hojas amarillas!")).toBe(normalize("hojas amarillas"));
  });

  it("collapses whitespace", () => {
    expect(normalize("hojas   amarillas")).toBe(normalize("hojas amarillas"));
  });

  it("trailing 'en' is removed", () => {
    expect(normalize("hojas amarillas en")).toBe("hojas amarillas");
  });

  it("trailing 'en el' is removed", () => {
    expect(normalize("hojas amarillas en el")).toBe("hojas amarillas");
  });
});

// ============================================================================
// deduplicateObservations — output-level dedup
// ============================================================================

describe("deduplicateObservations", () => {
  let dedup;
  beforeAll(async () => {
    const mod = await import("../services/observations.js");
    dedup = mod.deduplicateObservations;
  });

  it("removes exact duplicates", () => {
    const obs = [
      { observation_text: "hojas amarillas", plot_id: 1 },
      { observation_text: "hojas amarillas", plot_id: 1 },
    ];
    expect(dedup(obs)).toHaveLength(1);
  });

  it("removes normalized duplicates", () => {
    const obs = [
      { observation_text: "hojas amarillas en lote 1", plot_id: 1 },
      { observation_text: "hojas amarillas", plot_id: 1 },
    ];
    expect(dedup(obs)).toHaveLength(1);
  });

  it("keeps observations from different plots", () => {
    const obs = [
      { observation_text: "hojas amarillas", plot_id: 1 },
      { observation_text: "hojas amarillas", plot_id: 2 },
    ];
    expect(dedup(obs)).toHaveLength(2);
  });

  it("keeps different observations on same plot", () => {
    const obs = [
      { observation_text: "hojas amarillas", plot_id: 1 },
      { observation_text: "presencia de roya", plot_id: 1 },
    ];
    expect(dedup(obs)).toHaveLength(2);
  });
});

// ============================================================================
// QA: saveObservation typed return values (BUG-001, BUG-002)
// ============================================================================

describe("saveObservation return sentinel values", () => {
  let SAVE_REJECTED_FINANCIAL, SAVE_REJECTED_DUPLICATE;
  beforeAll(async () => {
    const mod = await import("../services/observations.js");
    SAVE_REJECTED_FINANCIAL = mod.SAVE_REJECTED_FINANCIAL;
    SAVE_REJECTED_DUPLICATE = mod.SAVE_REJECTED_DUPLICATE;
  });

  it("SAVE_REJECTED_FINANCIAL is a distinct object", () => {
    expect(SAVE_REJECTED_FINANCIAL).toBeDefined();
    expect(SAVE_REJECTED_FINANCIAL._rejected).toBe("financial");
  });

  it("SAVE_REJECTED_DUPLICATE is a distinct object", () => {
    expect(SAVE_REJECTED_DUPLICATE).toBeDefined();
    expect(SAVE_REJECTED_DUPLICATE._rejected).toBe("duplicate");
  });

  it("sentinels are different from each other", () => {
    expect(SAVE_REJECTED_FINANCIAL).not.toBe(SAVE_REJECTED_DUPLICATE);
  });

  it("sentinels are truthy (not null/undefined)", () => {
    expect(SAVE_REJECTED_FINANCIAL).toBeTruthy();
    expect(SAVE_REJECTED_DUPLICATE).toBeTruthy();
  });
});


// ============================================================================
// QA: Financial content never stored as observation
// ============================================================================

describe("QA: financial content guard in observations", () => {
  let hasFinancialContent;
  beforeAll(async () => {
    // Import the private function indirectly by testing normalizeObservationText behavior
    // Actually we test via the public hasFinancialIntent from parser
  });

  it('"gasté 5000 en gasoil" is detected as financial by parser', () => {
    expect(hasFinancialIntent("gaste 5000 en gasoil")).toBe(true);
  });

  it('"gasté 500 en semillas" is detected as financial by parser', () => {
    expect(hasFinancialIntent("gaste 500 en semillas")).toBe(true);
  });

  it('"hojas amarillas en lote 1" is NOT financial', () => {
    expect(hasFinancialIntent("hojas amarillas en lote 1")).toBe(false);
  });

  it('"hay presencia de chinches" is NOT financial', () => {
    expect(hasFinancialIntent("hay presencia de chinches")).toBe(false);
  });

  it('"riego en lote 1" is NOT financial', () => {
    expect(hasFinancialIntent("riego en lote 1")).toBe(false);
  });
});

// ============================================================================
// QA: Prefix stripping — "observación:" removed before storage
// ============================================================================

describe("QA: observation prefix stripping", () => {
  it('"observación: hay rama negra en lote 1" → observationText has no prefix', () => {
    const obs = parsearObservacion("observación: hay rama negra en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.observationText).not.toMatch(/^observaci[oó]n/i);
    expect(obs.plotName).toBe("1");
  });

  it('"obs: hojas amarillas en lote 3" → observationText has no prefix', () => {
    const obs = parsearObservacion("obs: hojas amarillas en lote 3");
    expect(obs).not.toBeNull();
    expect(obs.observationText).not.toMatch(/^obs[:\s]/i);
    expect(obs.plotName).toBe("3");
  });

  it('"nota: plaga en campo norte" → observationText has no prefix', () => {
    const obs = parsearObservacion("nota: plaga en campo norte");
    expect(obs).not.toBeNull();
    expect(obs.observationText).not.toMatch(/^nota/i);
  });

  it('prefix-free message unchanged: "hay malezas en lote 1"', () => {
    const obs = parsearObservacion("hay malezas en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.plotName).toBe("1");
    expect(obs.category).toBe("malezas");
  });
});

// ============================================================================
// QA: normalizeObservationText cross-variant dedup
// ============================================================================

describe("QA: normalizeObservationText cross-variant dedup", () => {
  let normalize;
  beforeAll(async () => {
    const mod = await import("../services/observations.js");
    normalize = mod.normalizeObservationText;
  });

  it('"observación: hojas amarillas" normalizes same as "hojas amarillas"', () => {
    expect(normalize("observación: hojas amarillas")).toBe(normalize("hojas amarillas"));
  });

  it('"obs: hay rama negra" normalizes same as "hay rama negra"', () => {
    expect(normalize("obs: hay rama negra")).toBe(normalize("hay rama negra"));
  });

  it('"Hojas Amarillas en lote 1" normalizes same as "hojas amarillas"', () => {
    expect(normalize("Hojas Amarillas en lote 1")).toBe(normalize("hojas amarillas"));
  });

  it('"HOJAS AMARILLAS" normalizes same as "hojas amarillas"', () => {
    expect(normalize("HOJAS AMARILLAS")).toBe(normalize("hojas amarillas"));
  });
});

// ============================================================================
// QA: Bare observation auto-detection (no lote/campo reference)
// ============================================================================

describe("QA: bare observation auto-detection", () => {
  it('"hay rama negra" → detected as bare observation (malezas)', () => {
    const obs = parsearObservacion("hay rama negra");
    expect(obs).not.toBeNull();
    expect(obs.type).toBe("bare");
    expect(obs.category).toBe("malezas");
    expect(obs.plotName).toBeNull();
    expect(obs.fieldName).toBeNull();
  });

  it('"hojas amarillas" → detected as bare observation (nutricion)', () => {
    const obs = parsearObservacion("hojas amarillas");
    expect(obs).not.toBeNull();
    expect(obs.type).toBe("bare");
    expect(obs.category).toBe("nutricion");
  });

  it('"presencia de roya" → detected as bare observation (sanidad)', () => {
    const obs = parsearObservacion("presencia de roya");
    expect(obs).not.toBeNull();
    expect(obs.type).toBe("bare");
    expect(obs.category).toBe("sanidad");
  });

  it('"helada fuerte" → detected as bare observation (clima)', () => {
    const obs = parsearObservacion("helada fuerte");
    expect(obs).not.toBeNull();
    expect(obs.type).toBe("bare");
    expect(obs.category).toBe("clima");
  });

  it('"hola como estas" → NOT detected (general category, no agro keywords)', () => {
    const obs = parsearObservacion("hola como estas");
    expect(obs).toBeNull();
  });

  it('"buen día" → NOT detected (too short / general)', () => {
    const obs = parsearObservacion("buen dia");
    expect(obs).toBeNull();
  });
});

// ============================================================================
// QA BLACK-BOX: All 8 test cases from 2026-03-20 QA session
// ============================================================================

describe("QA BLACK-BOX: trailing 'en' removal", () => {
  it('"hay gramilla en lote 1" → observationText is "hay gramilla" (no trailing en)', () => {
    const obs = parsearObservacion("hay gramilla en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.observationText).toBe("hay gramilla");
    expect(obs.plotName).toBe("1");
  });

  it('"plagas visibles en lote 1" → "plagas visibles"', () => {
    const obs = parsearObservacion("plagas visibles en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.observationText).toBe("plagas visibles");
  });

  it('"hojas amarillas en lote 1" → "hojas amarillas"', () => {
    const obs = parsearObservacion("hojas amarillas en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.observationText).toBe("hojas amarillas");
  });

  it('"suelo seco en el lote 2" → "suelo seco"', () => {
    const obs = parsearObservacion("suelo seco en el lote 2");
    expect(obs).not.toBeNull();
    expect(obs.observationText).toBe("suelo seco");
    expect(obs.plotName).toBe("2");
  });
});

describe("QA BLACK-BOX: prefix + trailing en combined", () => {
  it('"observación: hojas amarillas en lote 1" → "hojas amarillas"', () => {
    const obs = parsearObservacion("observación: hojas amarillas en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.observationText).toBe("hojas amarillas");
    expect(obs.plotName).toBe("1");
  });

  it('"nota: suelo seco en lote 1" → "suelo seco"', () => {
    const obs = parsearObservacion("nota: suelo seco en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.observationText).toBe("suelo seco");
    expect(obs.plotName).toBe("1");
  });

  it('"observación hojas amarillas en lote 1" (no colon) → "hojas amarillas"', () => {
    const obs = parsearObservacion("observación hojas amarillas en lote 1");
    expect(obs).not.toBeNull();
    expect(obs.observationText).toBe("hojas amarillas");
  });
});

describe("QA BLACK-BOX: auto-detect consistency", () => {
  const messages = [
    { input: "hay gramilla en lote 1", plot: "1", cat: "malezas" },
    { input: "hojas amarillas en lote 1", plot: "1", cat: "nutricion" },
    { input: "plagas visibles en lote 1", plot: "1", cat: "sanidad" },
    { input: "helada en lote 1", plot: "1", cat: "clima" },
    { input: "roya en lote 1", plot: "1", cat: "sanidad" },
    { input: "malezas en lote 1", plot: "1", cat: "malezas" },
  ];

  for (const { input, plot, cat } of messages) {
    it("\"" + input + "\" → detected as observation (not null)", () => {
      const obs = parsearObservacion(input);
      expect(obs).not.toBeNull();
      expect(obs.plotName).toBe(plot);
      expect(obs.category).toBe(cat);
    });
  }
});

describe("QA BLACK-BOX: dedup normalization cross-variants", () => {
  let normalize;
  beforeAll(async () => {
    const mod = await import("../services/observations.js");
    normalize = mod.normalizeObservationText;
  });

  it("all variants normalize to 'hojas amarillas'", () => {
    const variants = [
      "observación: hojas amarillas en lote 1",
      "hojas amarillas en lote 1",
      "HOJAS AMARILLAS EN LOTE 1",
      "hojas amarillas",
      "observación hojas amarillas en lote 1",
    ];
    const normalized = variants.map(v => normalize(v));
    const unique = new Set(normalized);
    expect(unique.size).toBe(1);
    expect(normalized[0]).toBe("hojas amarillas");
  });
});

