import { describe, it, expect } from 'vitest';
import { resolveFormInitialValues } from '../form-prefill.js';
import { buildWhatsAppFlowJson, isoToFlowDate, initKey, optionsKey } from '../whatsapp-flow-generator.js';
import { FORM_DEFINITIONS } from '../form-definitions.js';
import type { FormOptions } from '../form-options.js';

const HOY = '2026-08-22';

const OPTS: FormOptions = {
  plots: [
    { id: 7, name: 'Norte', fieldName: 'La Esperanza', activeCrop: null },
    { id: 9, name: 'Sur', fieldName: 'La Esperanza', activeCrop: 'soja' },
    { id: 12, name: 'Norte', fieldName: 'San Martín', activeCrop: null },
  ],
  crops: ['Soja', 'Maíz', 'Trigo'],
};

const UN_SOLO_LOTE: FormOptions = {
  plots: [{ id: 3, name: 'Único', fieldName: 'El Campo', activeCrop: null }],
  crops: ['Soja'],
};

describe('resolveFormInitialValues — lo que el usuario ya dijo NO se re-pregunta', () => {
  it('resuelve el lote nombrado a su id', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { plotName: 'Sur' }, options: OPTS, todayISO: HOY,
    });
    expect(v.plot_id).toBe('9');
  });

  it('desempata lotes homónimos usando el campo', () => {
    // "Norte" existe en dos campos: sin el campo se elegiría el primero.
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { plotName: 'Norte', fieldName: 'San Martín' }, options: OPTS, todayISO: HOY,
    });
    expect(v.plot_id).toBe('12');
  });

  it('matchea sin distinguir mayúsculas ni espacios', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { plotName: '  sUr  ' }, options: OPTS, todayISO: HOY,
    });
    expect(v.plot_id).toBe('9');
  });

  it('con UN solo lote lo elige aunque el usuario no lo haya nombrado', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: {}, options: UN_SOLO_LOTE, todayISO: HOY,
    });
    expect(v.plot_id).toBe('3');
  });

  it('con varios lotes y ninguno nombrado, NO adivina', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: {}, options: OPTS, todayISO: HOY,
    });
    expect(v.plot_id).toBeUndefined();
  });

  it('un lote que no existe entre las opciones no se prellena', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { plotName: 'Lote Fantasma' }, options: OPTS, todayISO: HOY,
    });
    expect(v.plot_id).toBeUndefined();
  });

  it('la fecha dicha por el usuario gana sobre hoy', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { eventDate: '2026-08-15' }, options: OPTS, todayISO: HOY,
    });
    expect(v.event_date).toBe('2026-08-15');
  });

  it('sin fecha dicha, arranca en hoy', () => {
    const v = resolveFormInitialValues({ action: 'sow_crop', prefill: {}, options: OPTS, todayISO: HOY });
    expect(v.event_date).toBe(HOY);
  });

  it('una fecha con formato inválido cae a hoy en vez de romper', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { eventDate: 'ayer' }, options: OPTS, todayISO: HOY,
    });
    expect(v.event_date).toBe(HOY);
  });

  it('prellena las hectáreas que el usuario mencionó', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { hectares: 20 }, options: OPTS, todayISO: HOY,
    });
    expect(v.hectares).toBe(20);
  });

  it('ignora números que no son válidos', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { hectares: 0 }, options: OPTS, todayISO: HOY,
    });
    expect(v.hectares).toBeUndefined();
  });
});

describe('resolveFormInitialValues — no inventa el cultivo (invariante 13)', () => {
  it('prellena el cultivo sólo si el usuario lo nombró', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { crop: 'soja' }, options: OPTS, todayISO: HOY,
    });
    expect(v.crop).toBe('Soja'); // normalizado al valor de la opción
  });

  it('sin cultivo dicho, queda vacío para que lo pregunte', () => {
    const v = resolveFormInitialValues({ action: 'sow_crop', prefill: {}, options: OPTS, todayISO: HOY });
    expect(v.crop).toBeUndefined();
  });

  it('un cultivo que el usuario no tiene cargado no se prellena', () => {
    const v = resolveFormInitialValues({
      action: 'sow_crop', prefill: { crop: 'quinoa' }, options: OPTS, todayISO: HOY,
    });
    expect(v.crop).toBeUndefined();
  });
});

describe('resolveFormInitialValues — sólo claves del form pedido', () => {
  it('cosecha no recibe claves de siembra', () => {
    const v = resolveFormInitialValues({
      action: 'harvest_crop',
      prefill: { plotName: 'Sur', hectares: 20, crop: 'Soja' },
      options: OPTS, todayISO: HOY,
    });
    expect(v.plot_id).toBe('9');
    expect(v.hectares).toBeUndefined(); // cosecha no tiene ese campo
    expect(v.crop).toBeUndefined();
  });
});

describe('Flow JSON — prellenado y esquema de data', () => {
  const sow = buildWhatsAppFlowJson(FORM_DEFINITIONS.sow_crop) as {
    screens: Array<{ data: Record<string, unknown>; layout: { children: Array<Record<string, unknown>> } }>;
  };

  it('cada componente declara init-value', () => {
    const inputs = sow.screens[0].layout.children.filter(c => c.type !== 'Footer');
    expect(inputs.length).toBeGreaterThan(0);
    for (const c of inputs) {
      expect(c['init-value'], `${String(c.name)} sin init-value`).toBe(`\${data.${initKey(String(c.name))}}`);
    }
  });

  it('la pantalla declara en data TODA clave referenciada — sin esto el Flow no valida en Meta', () => {
    const schema = sow.screens[0].data;
    const json = JSON.stringify(sow.screens[0].layout);
    const refs = [...json.matchAll(/\$\{data\.([a-zA-Z0-9_]+)\}/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(schema[r], `falta "${r}" en el esquema de data`).toBeDefined();
    }
  });

  it('cada entrada del esquema trae __example__ (lo exige Flows)', () => {
    for (const [k, v] of Object.entries(sow.screens[0].data)) {
      expect((v as Record<string, unknown>).__example__, `"${k}" sin __example__`).toBeDefined();
    }
  });

  it('los selects mantienen su data-source de opciones', () => {
    const dd = sow.screens[0].layout.children.find(c => c.type === 'Dropdown') as Record<string, string>;
    expect(dd['data-source']).toBe(`\${data.${optionsKey(dd.name)}}`);
  });

  it('cosecha expande el grupo de cargas a slots fijos', () => {
    const harvest = buildWhatsAppFlowJson(FORM_DEFINITIONS.harvest_crop) as {
      screens: Array<{ data: Record<string, unknown>; layout: { children: Array<Record<string, unknown>> } }>;
    };
    const names = harvest.screens[0].layout.children.map(c => String(c.name ?? ''));
    expect(names).toContain('loads_1_driver_name');
    expect(names).toContain('loads_5_weight_kg');
    expect(names).not.toContain('loads_6_driver_name'); // tope de 5
    // y sus init también están declarados
    expect(harvest.screens[0].data[initKey('loads_1_driver_name')]).toBeDefined();
  });
});

describe('isoToFlowDate — el DatePicker de Flows toma epoch en ms', () => {
  it('convierte ISO a milisegundos como string', () => {
    // Mandar "2026-08-22" directo deja el campo vacío sin dar error.
    expect(isoToFlowDate('2026-08-22')).toBe(String(Date.parse('2026-08-22T00:00:00Z')));
  });

  it('rechaza lo que no sea ISO', () => {
    expect(isoToFlowDate('22/08/2026')).toBeNull();
    expect(isoToFlowDate('ayer')).toBeNull();
    expect(isoToFlowDate('')).toBeNull();
  });
});
