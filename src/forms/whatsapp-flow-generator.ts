// src/forms/whatsapp-flow-generator.ts
// Genera el Flow JSON de WhatsApp desde la MISMA FormDefinition del form web.
// Limitación conocida (spec): Flows no tiene grupos repetibles → los groups
// se expanden a maxItems=5 slots fijos opcionales.
//
// PRELLENADO: cada componente declara `init-value` apuntando a una clave de
// `data`, y la pantalla declara el esquema de esa data. Sin las dos cosas el
// Flow salía en blanco y el usuario tenía que re-tipear lo que ya había dicho
// en el chat. Los valores concretos los hornea form-offer al enviar el mensaje.
import type { FormDefinition, FormField } from './form-definitions.js';

const FIXED_GROUP_SLOTS = 5;

/** Sufijo de la clave de data con el valor inicial de un campo. */
export function initKey(name: string): string {
  return `${name}_init`;
}

/** Sufijo de la clave de data con las opciones de un select. */
export function optionsKey(name: string): string {
  return `${name}_options`;
}

/**
 * Los DatePicker de Flows toman el valor como epoch en MILISEGUNDOS, en string
 * — no como YYYY-MM-DD. Mandar la fecha ISO deja el campo vacío sin error.
 */
export function isoToFlowDate(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? String(ms) : null;
}

function componentFor(f: FormField, name: string, labelPrefix = ''): Record<string, unknown> | null {
  const label = `${labelPrefix}${f.label}`;
  const init = `\${data.${initKey(name)}}`;
  switch (f.type) {
    case 'select':
      // Las opciones dinámicas (lotes/cultivos) se inyectan como data del
      // screen al enviar el Flow; acá va la referencia.
      return {
        type: 'Dropdown', name, label, required: f.required,
        'data-source': `\${data.${optionsKey(name)}}`,
        'init-value': init,
      };
    case 'date':
      return { type: 'DatePicker', name, label, required: f.required, 'init-value': init };
    case 'number':
      return { type: 'TextInput', 'input-type': 'number', name, label, required: f.required, 'init-value': init };
    case 'text':
      return { type: 'TextInput', name, label, required: f.required, 'init-value': init };
    default:
      return null;
  }
}

/**
 * Esquema de `data` de la pantalla. Flows EXIGE declarar toda clave referenciada
 * con `${data.x}`, incluido un `__example__`; sin esto el Flow no valida al
 * publicarlo en Meta.
 */
function dataSchemaFor(def: FormDefinition): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  const addScalar = (name: string) => {
    schema[initKey(name)] = { type: 'string', __example__: '' };
  };
  const addSelect = (name: string) => {
    schema[optionsKey(name)] = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
      __example__: [{ id: '1', title: 'Ejemplo' }],
    };
    addScalar(name);
  };

  for (const f of def.fields) {
    if (f.type === 'group') {
      for (let i = 1; i <= Math.min(f.maxItems ?? FIXED_GROUP_SLOTS, FIXED_GROUP_SLOTS); i++) {
        for (const sub of f.fields ?? []) {
          if (sub.type === 'select') addSelect(`${f.key}_${i}_${sub.key}`);
          else if (sub.type !== 'group') addScalar(`${f.key}_${i}_${sub.key}`);
        }
      }
      continue;
    }
    if (f.type === 'select') addSelect(f.key);
    else addScalar(f.key);
  }
  return schema;
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
      data: dataSchemaFor(def),
      layout: { type: 'SingleColumnLayout', children },
    }],
  };
}
