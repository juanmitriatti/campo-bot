// src/forms/__tests__/whatsapp-flow-generator.test.ts
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS } from '../form-definitions.js';
import { buildWhatsAppFlowJson } from '../whatsapp-flow-generator.js';

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
