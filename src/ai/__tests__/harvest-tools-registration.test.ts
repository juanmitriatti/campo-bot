import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../tool-definitions.js';
import { classifyDomain } from '../../domain/router.js';
import { FeatureGate } from '../../domain/billing/feature-gate.js';
import { AgentResponseMapper } from '../agent-response-mapper.js';

/**
 * Invariante 2 para las tools de cosecha comercial (migración 120): schema +
 * set del router + feature gate + mapeo explícito de los campos snake_case que
 * el copiador genérico no cubre. Si falta uno, la tool falla en silencio.
 */
const HARVEST_TOOLS = ['log_harvest_costs', 'edit_harvest_load', 'set_expected_yield', 'log_grain_withdrawal'] as const;

describe('cosecha comercial — registros (invariante 2)', () => {
  it.each(HARVEST_TOOLS)('%s tiene schema en TOOL_DEFINITIONS', (name) => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
    expect(tool, `falta el schema de ${name}`).toBeDefined();
    expect(tool!.description.length).toBeGreaterThan(40);
    expect(TOOL_NAMES.has(name)).toBe(true);
  });

  it.each(HARVEST_TOOLS)('%s rutea al dominio agronomy', (name) => {
    expect(classifyDomain(name)).toBe('agronomy');
  });

  it.each(HARVEST_TOOLS)('%s está gateado por el feature agronomy', (name) => {
    expect(FeatureGate.commandToFeature(name)).toBe('agronomy');
  });

  it('harvest_crop acepta hectares y los campos comerciales por camión; query_harvest_loads tiene view balance y without_ctg', () => {
    const harvest = TOOL_DEFINITIONS.find((t) => t.name === 'harvest_crop')!;
    const props = harvest.input_schema.properties as Record<string, { properties?: Record<string, unknown> }>;
    expect(props.hectares).toBeDefined();
    const loadProps = (props.loads as { items: { properties: Record<string, unknown> } }).items.properties;
    for (const k of ['gross_weight_kg', 'tare_kg', 'acopio_weight_kg', 'carta_porte', 'ctg']) expect(loadProps[k], k).toBeDefined();

    const query = TOOL_DEFINITIONS.find((t) => t.name === 'query_harvest_loads')!;
    const qprops = query.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(qprops.view.enum).toContain('balance');
    expect(qprops.without_ctg).toBeDefined();

    const income = TOOL_DEFINITIONS.find((t) => t.name === 'log_income')!;
    const iprops = income.input_schema.properties as Record<string, unknown>;
    expect(iprops.buyer).toBeDefined();
    expect(iprops.price_status).toBeDefined();
  });

  describe('mapeo de campos que el copiador genérico no cubre', () => {
    const mapper = new AgentResponseMapper();
    const mapOne = (toolName: string, toolInput: Record<string, unknown>) => {
      const [result] = mapper.mapToParseResults(
        { toolCalls: [{ toolName, toolInput }], text: null, truncated: false } as never,
        `texto original ${Object.values(toolInput).flat().join(' ')}`,
        {},
        null,
        { validate: false } as never,
      );
      return result;
    };

    it('log_harvest_costs → contractorPct/PerHa/Total, freightPerTn/Total', () => {
      const r = mapOne('log_harvest_costs', { plot: 'Norte', contractor_pct: 8, freight_per_tn: 18000, currency: 'ARS' });
      expect(r.intent.type).toBe('command');
      const d = (r.intent as { data: Record<string, unknown> }).data;
      expect(d.contractorPct).toBe(8);
      expect(d.freightPerTn).toBe(18000);
      const r2 = mapOne('log_harvest_costs', { contractor_per_ha: 45000, contractor_total: 100, freight_total: 900000 });
      const d2 = (r2.intent as { data: Record<string, unknown> }).data;
      expect(d2.contractorPerHa).toBe(45000);
      expect(d2.contractorTotal).toBe(100);
      expect(d2.freightTotal).toBe(900000);
    });

    it('edit_harvest_load → driverName, weightKg, humidityPct, ctg, cartaPorte, acopioWeightKg, truckPlate', () => {
      const r = mapOne('edit_harvest_load', { driver_name: 'Pérez', weight_kg: 30320, humidity_pct: 15, ctg: '123', carta_porte: 'CP9', acopio_weight_kg: 30100, truck_plate: 'AB123CD', destinatario: 'ACA' });
      const d = (r.intent as { data: Record<string, unknown> }).data;
      expect(d.driverName).toBe('Pérez');
      expect(d.weightKg).toBe(30320);
      expect(d.humidityPct).toBe(15);
      expect(d.ctg).toBe('123');
      expect(d.cartaPorte).toBe('CP9');
      expect(d.acopioWeightKg).toBe(30100);
      expect(d.truckPlate).toBe('AB123CD');
      expect(d.destinatario).toBe('ACA');
    });

    it('set_expected_yield → kgPerHa; query_harvest_loads without_ctg → withoutCtg', () => {
      const r = mapOne('set_expected_yield', { plot: 'Norte', kg_per_ha: 4000 });
      expect((r.intent as { data: Record<string, unknown> }).data.kgPerHa).toBe(4000);
      const q = mapOne('query_harvest_loads', { without_ctg: true, view: 'detail' });
      expect((q.intent as { data: Record<string, unknown> }).data.withoutCtg).toBe(true);
    });

    it('log_income → buyer y price_status llegan al ParsedIncome', () => {
      const r = mapOne('log_income', { amount: 15000000, category: 'Soja', description: 'venta', quantity: 50, unit: 'tn', buyer: 'Cargill', price_status: 'a_fijar' });
      expect(r.intent.type).toBe('income');
      const d = (r.intent as { data: Record<string, unknown> }).data;
      expect(d.buyer).toBe('Cargill');
      expect(d.price_status).toBe('a_fijar');
    });
  });
});
