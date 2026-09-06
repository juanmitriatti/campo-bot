// src/forms/whatsapp-flow-generator.ts
// Genera el Flow JSON de WhatsApp desde la MISMA FormDefinition del form web.
// Limitación conocida (spec): Flows no tiene grupos repetibles → los groups
// se expanden a maxItems=5 slots fijos opcionales. Este archivo es la fuente
// ÚNICA de esa convención de nombres (`<grupo>_<n>_<campo>`): la aplana al
// generar y la des-aplana al recibir (unflattenFlowPayload).
//
// PRELLENADO: cada componente declara `init-value` apuntando a una clave de
// `data`, y la pantalla declara el esquema de esa data. Sin las dos cosas el
// Flow salía en blanco y el usuario tenía que re-tipear lo que ya había dicho
// en el chat. Los valores concretos los hornea form-offer al enviar el mensaje.
//
// RESPUESTA: la action `complete` del Footer DEBE llevar en su payload
// `${form.<campo>}` por cada componente. Sin eso el nfm_reply trae solo el
// flow_token y el submit recibe un formulario vacío (bug de la v1 dark).
import type { FormDefinition, FormField } from './form-definitions.js';

export const FIXED_GROUP_SLOTS = 5;

/** Sufijo de la clave de data con el valor inicial de un campo. */
export function initKey(name: string): string {
  return `${name}_init`;
}

/** Sufijo de la clave de data con las opciones de un select. */
export function optionsKey(name: string): string {
  return `${name}_options`;
}

/** Clave del texto libre que acompaña a un select con `allowOther`. */
export function otherKey(name: string): string {
  return `${name}_other`;
}

/**
 * Formato de fecha del DatePicker. Desde Flow JSON 5.0 el DatePicker usa
 * 'YYYY-MM-DD' tanto para init-value como para el valor que devuelve (antes
 * era epoch en ms — la v1 dark mandaba eso y el campo quedaba vacío en 7.x).
 * Devuelve la ISO validada o null si no es una fecha ISO.
 */
export function isoToFlowDate(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? iso : null;
}

function groupSlots(f: FormField): number {
  return Math.min(f.maxItems ?? FIXED_GROUP_SLOTS, FIXED_GROUP_SLOTS);
}

function componentFor(f: FormField, name: string, labelPrefix = ''): Record<string, unknown> | null {
  const label = `${labelPrefix}${f.label}`;
  const init = `\${data.${initKey(name)}}`;
  switch (f.type) {
    case 'select':
      // Opciones fijas (moneda, tipo de labor) van inline; las dinámicas
      // (lotes, categorías) se inyectan como data del screen al enviar el Flow.
      return {
        type: 'Dropdown', name, label, required: f.required,
        'data-source': f.options
          ? f.options.map(o => ({ id: o.id, title: o.title }))
          : `\${data.${optionsKey(name)}}`,
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
  const addScalar = (name: string, example = '') => {
    schema[initKey(name)] = { type: 'string', __example__: example };
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
      for (let i = 1; i <= groupSlots(f); i++) {
        for (const sub of f.fields ?? []) {
          if (sub.type === 'select') addSelect(`${f.key}_${i}_${sub.key}`);
          else if (sub.type !== 'group') addScalar(`${f.key}_${i}_${sub.key}`);
        }
      }
      continue;
    }
    if (f.type === 'select' && !f.options) addSelect(f.key);
    else if (f.type === 'date') addScalar(f.key, '2026-01-15');
    else addScalar(f.key);
    if (f.allowOther) addScalar(otherKey(f.key));
  }
  return schema;
}

export function buildWhatsAppFlowJson(def: FormDefinition): Record<string, unknown> {
  const children: Record<string, unknown>[] = [];
  const names: string[] = [];
  const push = (c: Record<string, unknown> | null) => {
    if (!c) return;
    children.push(c);
    names.push(c.name as string);
  };
  for (const f of def.fields) {
    if (f.type === 'group') {
      for (let i = 1; i <= groupSlots(f); i++) {
        for (const sub of f.fields ?? []) {
          push(componentFor({ ...sub, required: false }, `${f.key}_${i}_${sub.key}`, `${f.label} ${i}: `));
        }
      }
      continue;
    }
    push(componentFor(f, f.key));
    // El Dropdown de Flows no admite "otro": va un TextInput acompañante.
    if (f.allowOther) {
      push({
        type: 'TextInput', name: otherKey(f.key), required: false,
        label: `${f.label} (otro, si no está en la lista)`,
        'init-value': `\${data.${initKey(otherKey(f.key))}}`,
      });
    }
  }
  // El payload de `complete` es lo que vuelve en nfm_reply.response_json
  // (junto al flow_token). Un campo que no esté acá NO llega al submit.
  const payload: Record<string, string> = {};
  for (const n of names) payload[n] = `\${form.${n}}`;
  children.push({
    type: 'Footer', label: 'Registrar',
    'on-click-action': { name: 'complete', payload },
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

/**
 * Inversa de la expansión de grupos: re-arma `loads[]` desde los slots
 * `loads_<n>_<campo>` que devuelve el Flow, descartando los slots vacíos.
 * Solo deja pasar claves declaradas en la FormDefinition (el flow_token y
 * cualquier extra quedan afuera), así el resto del submit es idéntico al de
 * la Mini App.
 */
export function unflattenFlowPayload(
  def: FormDefinition,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const isEmpty = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
  for (const f of def.fields) {
    if (f.type !== 'group') {
      if (f.key in payload) out[f.key] = payload[f.key];
      if (f.allowOther && otherKey(f.key) in payload) out[otherKey(f.key)] = payload[otherKey(f.key)];
      continue;
    }
    const items: Record<string, unknown>[] = [];
    for (let i = 1; i <= groupSlots(f); i++) {
      const item: Record<string, unknown> = {};
      let any = false;
      for (const sub of f.fields ?? []) {
        const v = payload[`${f.key}_${i}_${sub.key}`];
        if (isEmpty(v)) continue;
        item[sub.key] = v;
        any = true;
      }
      if (any) items.push(item);
    }
    if (items.length > 0) out[f.key] = items;
  }
  return out;
}
