import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS, validateFormPayload } from '../form-definitions.js';

const TODAY = '2026-08-03';

describe('FORM_DEFINITIONS', () => {
  it('siembra: plot_id y crop y event_date obligatorios; hectares y variety no', () => {
    const def = FORM_DEFINITIONS.sow_crop;
    const req = def.fields.filter(f => f.required).map(f => f.key);
    expect(req).toEqual(['plot_id', 'crop', 'event_date']);
    const opt = def.fields.filter(f => !f.required).map(f => f.key);
    expect(opt).toEqual(['hectares', 'variety']);
  });

  it('cosecha: incluye grupo repetible loads con driver_name y weight_kg obligatorios', () => {
    const loads = FORM_DEFINITIONS.harvest_crop.fields.find(f => f.key === 'loads');
    expect(loads?.type).toBe('group');
    const req = loads!.fields!.filter(f => f.required).map(f => f.key);
    expect(req).toEqual(['driver_name', 'weight_kg']);
  });
});

describe('validateFormPayload — siembra', () => {
  const def = FORM_DEFINITIONS.sow_crop;

  it('acepta payload completo y normaliza tipos', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, crop: 'soja', event_date: '2026-08-01', hectares: 50, variety: 'DM 4670',
    }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.hectares).toBe(50);
  });

  it('rechaza sin cultivo', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: TODAY }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('Cultivo');
  });

  it('rechaza fecha futura (plan futuro ≠ registro)', () => {
    const r = validateFormPayload(def, { plot_id: 7, crop: 'soja', event_date: '2026-08-04' }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('futura');
  });

  it('rechaza hectáreas <= 0', () => {
    const r = validateFormPayload(def, { plot_id: 7, crop: 'soja', event_date: TODAY, hectares: 0 }, TODAY);
    expect(r.ok).toBe(false);
  });

  it('rechaza peso (kg) menor a 1 con mensaje correcto', () => {
    const r = validateFormPayload(def, { plot_id: 7, crop: 'soja', event_date: TODAY, hectares: 0.5 }, TODAY);
    expect(r.ok).toBe(true);
  });

});

describe('validateFormPayload — cosecha', () => {
  const def = FORM_DEFINITIONS.harvest_crop;

  it('acepta solo con lote y fecha (sin rinde ni cargas)', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: TODAY }, TODAY);
    expect(r.ok).toBe(true);
  });

  it('rechaza yield_kg y yield_kg_per_ha juntos (excluyentes)', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, event_date: TODAY, yield_kg: 100000, yield_kg_per_ha: 3200,
    }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('rinde');
  });

  it('rechaza humedad fuera de 0-50', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: TODAY, humidity_pct: 80 }, TODAY);
    expect(r.ok).toBe(false);
  });

  it('valida cargas: chofer y peso obligatorios por ítem', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, event_date: TODAY,
      loads: [{ driver_name: 'Juan', weight_kg: 28500 }, { driver_name: '', weight_kg: 100 }],
    }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('Carga 2');
  });

  it('acepta cargas válidas con opcionales', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, event_date: TODAY,
      loads: [{ driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill', humidity_pct: 14 }],
    }, TODAY);
    expect(r.ok).toBe(true);
  });

  it('rechaza fecha inválida: 2026-13-01 (mes fuera de rango)', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: '2026-13-01' }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('inválida');
  });

  it('rechaza fecha inválida: 2026-02-30 (febrero 30)', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: '2026-02-30' }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('inválida');
  });

  it('peso 0 en carga: error con mensaje "al menos 1" (no mayor a 0)', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, event_date: TODAY,
      loads: [{ driver_name: 'Juan', weight_kg: 0 }],
    }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('al menos 1');
  });
});
