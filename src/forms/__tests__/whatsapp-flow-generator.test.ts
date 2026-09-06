// src/forms/__tests__/whatsapp-flow-generator.test.ts
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS } from '../form-definitions.js';
import { buildWhatsAppFlowJson, unflattenFlowPayload, isoToFlowDate } from '../whatsapp-flow-generator.js';

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
