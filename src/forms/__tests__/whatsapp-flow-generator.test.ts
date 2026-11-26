// src/forms/__tests__/whatsapp-flow-generator.test.ts
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS } from '../form-definitions.js';
import { buildWhatsAppFlowJson, unflattenFlowPayload, isoToFlowDate, expectedFlowDataKeys, validateFlowData, fitFlowOptions, FLOW_LIMITS, OTHER_OPTION, flowStateData } from '../whatsapp-flow-generator.js';

describe('límites de Meta para Flows', () => {
  type Child = { type: string; label: string; 'data-source'?: string | Array<{ title: string }> };

  it('los 6 formularios respetan etiquetas, opciones fijas y cantidad de componentes', () => {
    for (const def of Object.values(FORM_DEFINITIONS)) {
      const flow = buildWhatsAppFlowJson(def) as { screens: Array<{ layout: { children: Child[] } }> };
      const children = flow.screens[0].layout.children;
      expect(children.length, def.action).toBeLessThanOrEqual(FLOW_LIMITS.componentsPerScreen);
      for (const c of children.filter(x => x.type !== 'Footer')) {
        const max = c.type === 'DatePicker' ? FLOW_LIMITS.dateLabel : FLOW_LIMITS.textLabel;
        expect(c.label.length, `${def.action}: "${c.label}"`).toBeLessThanOrEqual(max);
        if (Array.isArray(c['data-source'])) {
          for (const o of c['data-source']) expect(o.title.length, o.title).toBeLessThanOrEqual(FLOW_LIMITS.optionTitle);
        }
      }
    }
  });

  it('fitFlowOptions recorta títulos, respeta el tope y suma "otro"', () => {
    const long = Array.from({ length: 250 }, (_, i) => ({ id: String(i), title: `Lote del bajo grande (La Barrida) · soja ${i}` }));
    const r = fitFlowOptions(long, true);
    expect(r.options).toHaveLength(FLOW_LIMITS.maxOptions);
    expect(r.options.at(-1)).toEqual(OTHER_OPTION);
    expect(r.options.every(o => o.title.length <= FLOW_LIMITS.optionTitle)).toBe(true);
    expect(r.options[0].id).toBe('0');
    expect(r.dropped).toBe(51);
    expect(r.truncated).toBe(199);
    expect(fitFlowOptions([{ id: 'a', title: 'Norte' }], false)).toEqual({ options: [{ id: 'a', title: 'Norte' }], truncated: 0, dropped: 0 });
  });
});

describe('buildWhatsAppFlowJson', () => {
  it('siembra: un screen con los 5 campos mapeados a componentes de Flow', () => {
    const flow = buildWhatsAppFlowJson(FORM_DEFINITIONS.sow_crop) as {
      version: string; screens: Array<{ id: string; layout: { children: Array<{ type: string; name?: string }> } }>;
    };
    expect(flow.version).toBe('7.2');
    expect(flow.screens).toHaveLength(1);
    const names = flow.screens[0].layout.children.filter(c => 'name' in c).map(c => c.name);
    expect(names).toContain('plot_id');
    expect(names).toContain('crop');
    expect(names).toContain('event_date');
  });

  it('cosecha: el grupo loads se expande a 5 slots fijos opcionales', () => {
    const flow = buildWhatsAppFlowJson(FORM_DEFINITIONS.harvest_crop) as {
      screens: Array<{ layout: { children: Array<{ name?: string }> } }>;
    };
    const names = flow.screens[0].layout.children.map(c => c.name).filter(Boolean);
    expect(names).toContain('loads_1_driver_name');
    expect(names).toContain('loads_5_weight_kg');
    expect(names).not.toContain('loads_6_driver_name');
  });
});

describe('buildWhatsAppFlowJson — lo que vuelve por nfm_reply', () => {
  type Flow = { screens: Array<{ layout: { children: Array<Record<string, unknown>> } }> };
  const footerPayload = (flow: Flow) => {
    const footer = flow.screens[0].layout.children.find(c => c.type === 'Footer')!;
    return (footer['on-click-action'] as { name: string; payload: Record<string, string> });
  };

  it('el complete lleva ${form.x} por CADA componente (sin esto el submit recibe un form vacío)', () => {
    for (const def of Object.values(FORM_DEFINITIONS)) {
      const flow = buildWhatsAppFlowJson(def) as Flow;
      const names = flow.screens[0].layout.children.filter(c => 'name' in c).map(c => c.name as string);
      const action = footerPayload(flow);
      expect(action.name).toBe('complete');
      expect(Object.keys(action.payload).sort()).toEqual([...names].sort());
      for (const n of names) expect(action.payload[n]).toBe('${form.' + n + '}');
    }
  });

  it('el DatePicker declara la fecha como YYYY-MM-DD (Flow JSON >=5.0), no epoch', () => {
    const flow = buildWhatsAppFlowJson(FORM_DEFINITIONS.sow_crop) as { screens: Array<{ data: Record<string, { __example__: string }> }> };
    expect(flow.screens[0].data.event_date_init.__example__).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoToFlowDate('2026-08-22')).toBe('2026-08-22');
  });
});

describe('unflattenFlowPayload — inversa de los 5 slots', () => {
  it('re-arma loads[] desde loads_N_* y descarta slots vacíos y claves ajenas', () => {
    const out = unflattenFlowPayload(FORM_DEFINITIONS.harvest_crop, {
      flow_token: 'abc',
      plot_id: '7', event_date: '2026-04-10', yield_kg_per_ha: '3200', yield_kg: '', humidity_pct: '',
      loads_1_driver_name: 'Juan', loads_1_weight_kg: '28000', loads_1_destinatario: 'Cargill', loads_1_humidity_pct: '',
      loads_2_driver_name: '', loads_2_weight_kg: '', loads_2_destinatario: '', loads_2_humidity_pct: '',
      loads_3_driver_name: 'Pedro', loads_3_weight_kg: '30500', loads_3_destinatario: '', loads_3_humidity_pct: '14',
      loads_4_driver_name: '', loads_4_weight_kg: '', loads_5_driver_name: '', loads_5_weight_kg: '',
    });
    expect(out.flow_token).toBeUndefined();
    expect(out.loads_1_driver_name).toBeUndefined();
    expect(out.plot_id).toBe('7');
    expect(out.loads).toEqual([
      { driver_name: 'Juan', weight_kg: '28000', destinatario: 'Cargill' },
      { driver_name: 'Pedro', weight_kg: '30500', humidity_pct: '14' },
    ]);
  });

  it('sin ninguna carga no inventa loads', () => {
    const out = unflattenFlowPayload(FORM_DEFINITIONS.harvest_crop, { plot_id: '7', event_date: '2026-04-10' });
    expect(out.loads).toBeUndefined();
  });

  it('siembra: pasa los escalares tal cual', () => {
    const out = unflattenFlowPayload(FORM_DEFINITIONS.sow_crop, { plot_id: '1', crop: 'soja', event_date: '2026-11-02', hectares: '', variety: 'DM 4670', flow_token: 'x' });
    expect(out).toEqual({ plot_id: '1', crop: 'soja', event_date: '2026-11-02', hectares: '', variety: 'DM 4670' });
  });
});

describe('validateFlowData — red de seguridad de las claves del data (Fase 2)', () => {
  // El data completo que hornea form-offer para el alta de hacienda: las 11
  // claves, todas string salvo los *_options (arrays de {id,title}).
  const validLivestockData = (): Record<string, unknown> => ({
    category_options: [{ id: 'novillo', title: 'Novillo' }],
    category_init: '',
    count_init: '',
    breed_options: [{ id: 'angus', title: 'Angus' }],
    breed_init: '',
    location_options: [{ id: 'p:1', title: 'Lote 1' }],
    location_init: '',
    unit_price_init: '',
    currency_init: 'ARS',
    event_date_init: '2026-09-17',
    notes_init: '',
  });

  it('la definición de hacienda declara exactamente las 11 claves esperadas', () => {
    expect(expectedFlowDataKeys(FORM_DEFINITIONS.add_livestock).sort()).toEqual([
      'breed_init', 'breed_options', 'category_init', 'category_options',
      'count_init', 'currency_init', 'event_date_init', 'location_init',
      'location_options', 'notes_init', 'unit_price_init',
    ]);
  });

  it('un data completo y bien tipado pasa', () => {
    expect(validateFlowData(FORM_DEFINITIONS.add_livestock, validLivestockData()).ok).toBe(true);
  });

  it('si falta UNA sola clave, falla (el Flow no abriría en el celular)', () => {
    const data = validLivestockData();
    delete data.location_init;
    const res = validateFlowData(FORM_DEFINITIONS.add_livestock, data);
    expect(res.ok).toBe(false);
    expect(res.errors.some(e => e.includes('location_init'))).toBe(true);
  });

  it('un valor numérico o null rompe el Flow y se detecta', () => {
    const numData = { ...validLivestockData(), count_init: 0 };
    expect(validateFlowData(FORM_DEFINITIONS.add_livestock, numData).ok).toBe(false);
    const nullData = { ...validLivestockData(), notes_init: null };
    expect(validateFlowData(FORM_DEFINITIONS.add_livestock, nullData).ok).toBe(false);
  });

  it('un *_options que no es array de {id,title} falla', () => {
    const bad = { ...validLivestockData(), category_options: 'novillo' };
    expect(validateFlowData(FORM_DEFINITIONS.add_livestock, bad).ok).toBe(false);
  });

  it('un *_options VACÍO pasa el tipado (el guard de requerido-vacío es de form-offer)', () => {
    const empty = { ...validLivestockData(), location_options: [] };
    expect(validateFlowData(FORM_DEFINITIONS.add_livestock, empty).ok).toBe(true);
  });
});

describe('cosecha: revelado progresivo de camiones y rinde', () => {
  type C = { type: string; name?: string; label?: string; visible?: string };
  const children = (buildWhatsAppFlowJson(FORM_DEFINITIONS.harvest_crop) as { screens: Array<{ layout: { children: C[] } }> })
    .screens[0].layout.children;
  const by = (name: string) => children.find(c => c.name === name)!;

  it('cada camión está oculto hasta su casilla, y la casilla N+1 aparece con el camión N', () => {
    expect(by('loads_add_1').visible).toBeUndefined();
    expect(by('loads_1_driver_name').visible).toBe('${data.show_loads_1}');
    expect(by('loads_add_2').visible).toBe('${data.show_loads_1}');
    expect(by('loads_5_weight_kg').visible).toBe('${data.show_loads_5}');
    expect(children.length).toBeLessThanOrEqual(FLOW_LIMITS.componentsPerScreen);
  });

  it('del rinde se ve solo el elegido; la precarga lo deja abierto', () => {
    expect(by('yield_kg').visible).toBe('${data.show_yield_kg}');
    expect(children.indexOf(by('yield_mode'))).toBeLessThan(children.indexOf(by('yield_kg_per_ha')));
    const state = flowStateData(FORM_DEFINITIONS.harvest_crop, { yield_kg_per_ha: 4200 });
    expect(state).toMatchObject({ yield_mode_init: 'yield_kg_per_ha', show_yield_kg_per_ha: true, show_yield_kg: false, show_loads_1: false });
  });

  it('lo oculto no se guarda: casilla desmarcada y rinde no elegido', () => {
    const out = unflattenFlowPayload(FORM_DEFINITIONS.harvest_crop, {
      plot_id: '1', yield_mode: 'yield_kg', yield_kg_per_ha: '4200', yield_kg: '130000',
      loads_add_1: ['si'], loads_1_driver_name: 'Juan', loads_1_weight_kg: '28000',
      loads_add_2: [], loads_2_driver_name: 'Pedro', loads_2_weight_kg: '30000',
      loads_add_3: ['si'], loads_3_driver_name: 'Ana', loads_3_weight_kg: '29000',
    });
    expect(out.yield_kg).toBe('130000');
    expect(out.yield_kg_per_ha).toBeUndefined();
    expect(out.loads).toEqual([{ driver_name: 'Juan', weight_kg: '28000' }]);
  });
});
