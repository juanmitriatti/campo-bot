// src/forms/whatsapp-flow-generator.ts
// Genera el Flow JSON de WhatsApp desde la MISMA FormDefinition del form web.
// DARK hasta tener número de WhatsApp en prod: falta publicar el Flow en Meta
// Business Manager y configurar su flow_id en settings (grupo bot).
// Limitación conocida (spec): Flows no tiene grupos repetibles → los groups
// se expanden a maxItems=5 slots fijos opcionales.
import type { FormDefinition, FormField } from './form-definitions.js';

const FIXED_GROUP_SLOTS = 5;

function componentFor(f: FormField, name: string, labelPrefix = ''): Record<string, unknown> | null {
  const label = `${labelPrefix}${f.label}`;
  switch (f.type) {
    case 'select':
      // Las opciones dinámicas (lotes/cultivos) se inyectan como data del
      // screen al enviar el Flow; acá va la referencia.
      return { type: 'Dropdown', name, label, required: f.required, 'data-source': `\${data.${name}_options}` };
    case 'date':
      return { type: 'DatePicker', name, label, required: f.required };
    case 'number':
      return { type: 'TextInput', 'input-type': 'number', name, label, required: f.required };
    case 'text':
      return { type: 'TextInput', name, label, required: f.required };
    default:
      return null;
  }
}

export function buildWhatsAppFlowJson(def: FormDefinition): Record<string, unknown> {
  const children: Record<string, unknown>[] = [];
  for (const f of def.fields) {
    if (f.type === 'group') {
      for (let i = 1; i <= Math.min(f.maxItems ?? FIXED_GROUP_SLOTS, FIXED_GROUP_SLOTS); i++) {
        for (const sub of f.fields ?? []) {
          const c = componentFor({ ...sub, required: false }, `${f.key}_${i}_${sub.key}`, `${f.label} ${i}: `);
          if (c) children.push(c);
        }
      }
      continue;
    }
    const c = componentFor(f, f.key);
    if (c) children.push(c);
  }
  children.push({
    type: 'Footer', label: 'Registrar',
    'on-click-action': { name: 'complete', payload: {} },
  });
  return {
    version: '7.2',
    screens: [{
      id: 'FORM', title: def.title, terminal: true,
      layout: { type: 'SingleColumnLayout', children },
    }],
  };
}
