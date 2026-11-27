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
import { flowDefinition, type FormDefinition, type FormField, type FormOption } from './form-definitions.js';

export const FIXED_GROUP_SLOTS = 5;

/**
 * Límites de Meta (developers.facebook.com/docs/whatsapp/flows/reference/components,
 * consultado nov 2026). Pasarse deja el Flow con errores de validación.
 */
export const FLOW_LIMITS = {
  textLabel: 20,
  dropdownLabel: 20,
  dateLabel: 40,
  optionTitle: 30,
  maxOptions: 200,
  componentsPerScreen: 50,
} as const;

/** Opción "otro" de un select con `allowOther`; el server ya la entiende. */
export const OTHER_OPTION: FormOption = { id: '__other__', title: '✏️ Escribir otro…' };
const OTHER_TEXT_LABEL = '¿Cuál otro?';

/** Recorta a `max` unidades UTF-16 sin partir un emoji. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/**
 * Opciones dinámicas listas para un Dropdown de Flows: títulos recortados, tope
 * de cantidad y la opción "otro" si el campo la admite (sin ella el Dropdown
 * obligatorio forzaba a elegir una opción cualquiera para poder escribir otra).
 * Devuelve cuántas se recortaron o quedaron afuera para que el llamador loguee.
 */
export function fitFlowOptions(
  options: FormOption[],
  withOther: boolean,
): { options: FormOption[]; truncated: number; dropped: number } {
  const room = FLOW_LIMITS.maxOptions - (withOther ? 1 : 0);
  let truncated = 0;
  const fitted = options.slice(0, room).map(o => {
    const title = clip(o.title, FLOW_LIMITS.optionTitle);
    if (title !== o.title) truncated++;
    return { id: o.id, title };
  });
  if (withOther) fitted.push(OTHER_OPTION);
  return { options: fitted, truncated, dropped: Math.max(0, options.length - room) };
}

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

// REVELADO PROGRESIVO (nov 2026): Flows no puede crear campos, pero sí mostrar
// bloques ya declarados. Cada slot de un grupo aparece al marcar su casilla
// (`update_data`, sin endpoint) y de los campos excluyentes se ve el elegido.
const CHECKED = 'si';
const addKey = (group: string, i: number): string => `${group}_add_${i}`;
const showSlotKey = (group: string, i: number): string => `show_${group}_${i}`;
const showFieldKey = (field: string): string => `show_${field}`;

const toggleInitKey = (group: string, i: number): string => `${group}_add_${i}_init`;

function slotToggle(f: FormField, i: number, slots: number): Record<string, unknown> {
  const t = f.toggle!;
  const number = i + (f.slotOffset ?? 0);
  // Al desmarcar se ocultan también los siguientes.
  const hide: Record<string, boolean> = {};
  for (let n = i; n <= slots; n++) hide[showSlotKey(f.key, n)] = false;
  return {
    type: 'CheckboxGroup', name: addKey(f.key, i), required: false,
    label: i === 1 ? t.label : `${t.noun} ${number}`,
    ...(f.prefillable ? { 'init-value': `\${data.${toggleInitKey(f.key, i)}}` } : {}),
    'data-source': [{
      id: CHECKED,
      title: i === 1 ? t.first : t.next,
      'on-select-action': { name: 'update_data', payload: { [showSlotKey(f.key, i)]: true } },
      'on-unselect-action': { name: 'update_data', payload: hide },
    }],
    ...(i > 1 ? { visible: `\${data.${showSlotKey(f.key, i - 1)}}` } : {}),
  };
}

function choiceSelector(def: FormDefinition): Record<string, unknown> {
  const c = def.flowChoice!;
  return {
    type: 'RadioButtonsGroup', name: c.key, label: c.label, required: false,
    'init-value': `\${data.${initKey(c.key)}}`,
    'data-source': c.options.map(o => ({
      id: o.field,
      title: o.title,
      'on-select-action': {
        name: 'update_data',
        payload: Object.fromEntries(c.options.map(x => [showFieldKey(x.field), x.field === o.field])),
      },
    })),
  };
}

/** Valores de `data` que gobiernan qué se ve al abrir (los hornea form-offer). */
export function flowStateData(rawDef: FormDefinition, initial: Record<string, unknown>): Record<string, unknown> {
  const def = flowDefinition(rawDef);
  const data: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.type !== 'group') continue;
    for (let i = 1; i <= groupSlots(f); i++) {
      const open = f.prefillable ? initial[addKey(f.key, i)] : undefined;
      data[showSlotKey(f.key, i)] = Array.isArray(open) && open.includes(CHECKED);
      if (f.prefillable) data[toggleInitKey(f.key, i)] = Array.isArray(open) ? open : [];
    }
  }
  if (def.flowChoice) {
    const chosen = def.flowChoice.options.find(o => initial[o.field] !== undefined && initial[o.field] !== '')?.field ?? '';
    data[initKey(def.flowChoice.key)] = chosen;
    for (const o of def.flowChoice.options) data[showFieldKey(o.field)] = o.field === chosen;
  }
  return data;
}

function componentFor(f: FormField, name: string, labelPrefix = ''): Record<string, unknown> | null {
  const label = `${labelPrefix}${f.flowLabel ?? f.label}`;
  const init = `\${data.${initKey(name)}}`;
  switch (f.type) {
    case 'select':
      if (f.radio) {
        return { type: 'RadioButtonsGroup', name, label, required: f.required, 'data-source': f.options, 'init-value': init };
      }
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
function dataSchemaFor(rawDef: FormDefinition): Record<string, unknown> {
  const def = flowDefinition(rawDef);
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

  for (const [key, value] of Object.entries(flowStateData(def, {}))) {
    schema[key] = typeof value === 'boolean'
      ? { type: 'boolean', __example__: false }
      : Array.isArray(value)
        ? { type: 'array', items: { type: 'string' }, __example__: [] }
        : { type: 'string', __example__: '' };
  }

  for (const f of def.fields) {
    if (f.type === 'group') {
      for (let i = 1; i <= groupSlots(f); i++) {
        for (const sub of f.fields ?? []) {
          if (sub.type === 'select' && !sub.options) addSelect(`${f.key}_${i}_${sub.key}`);
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

export function buildWhatsAppFlowJson(rawDef: FormDefinition): Record<string, unknown> {
  const def = flowDefinition(rawDef);
  const children: Record<string, unknown>[] = [];
  const names: string[] = [];
  const push = (c: Record<string, unknown> | null) => {
    if (!c) return;
    children.push(c);
    names.push(c.name as string);
  };
  for (const f of def.fields) {
    if (f.type === 'group') {
      const slots = groupSlots(f);
      for (let i = 1; i <= slots; i++) {
        push(slotToggle(f, i, slots));
        for (const sub of f.fields ?? []) {
          // Prefijo corto: "Cargas por camión 1: …" pasaba los 20 caracteres.
          const c = componentFor({ ...sub, required: false }, `${f.key}_${i}_${sub.key}`, `${i + (f.slotOffset ?? 0)}. `);
          push(c && { ...c, visible: `\${data.${showSlotKey(f.key, i)}}` });
        }
      }
      continue;
    }
    const choice = def.flowChoice?.options.findIndex(o => o.field === f.key) ?? -1;
    if (choice === 0) push(choiceSelector(def));
    const component = componentFor(f, f.key);
    push(component && choice >= 0 ? { ...component, visible: `\${data.${showFieldKey(f.key)}}` } : component);
    // El Dropdown de Flows no admite "otro": va un TextInput acompañante.
    if (f.allowOther) {
      push({
        type: 'TextInput', name: otherKey(f.key), required: false,
        label: OTHER_TEXT_LABEL,
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
 * Claves que el esquema de `data` del Flow declara para esta definición — las
 * MISMAS que form-offer tiene que hornear en `flow_action_payload.data`. Se
 * derivan de `dataSchemaFor`, así el generador y el envío nunca divergen.
 */
export function expectedFlowDataKeys(def: FormDefinition): string[] {
  return Object.keys(dataSchemaFor(def));
}

function isOptionArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(
    o => o !== null && typeof o === 'object'
      && typeof (o as { id?: unknown }).id === 'string'
      && typeof (o as { title?: unknown }).title === 'string',
  );
}

export interface FlowDataValidation { ok: boolean; errors: string[] }

/**
 * Red de seguridad antes de enviar el Flow (Fase 2 del alta de hacienda): la
 * pantalla FORM declara N claves de data y si falta UNA SOLA el Flow no abre en
 * el celular; un valor numérico o null también lo rompe. Todo valor debe ser
 * string, salvo los `*_options`, que son arrays de {id,title} string. NO valida
 * que los options requeridos estén no-vacíos (eso lo chequea form-offer antes,
 * porque necesita la definición del campo para saber si es requerido).
 */
export function validateFlowData(
  def: FormDefinition,
  data: Record<string, unknown>,
): FlowDataValidation {
  const errors: string[] = [];
  for (const k of expectedFlowDataKeys(def)) {
    if (!(k in data)) { errors.push(`falta la clave "${k}"`); continue; }
    const v = data[k];
    if (/_add_\d+_init$/.test(k)) {
      if (!Array.isArray(v)) errors.push(`"${k}" debe ser un array`);
    } else if (k.startsWith('show_')) {
      if (typeof v !== 'boolean') errors.push(`"${k}" debe ser booleano`);
    } else if (k.endsWith('_options')) {
      if (!isOptionArray(v)) errors.push(`"${k}" debe ser array de {id,title} string`);
    } else if (typeof v !== 'string') {
      errors.push(`"${k}" debe ser string (llegó ${v === null ? 'null' : typeof v})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Inversa de la expansión de grupos: re-arma `loads[]` desde los slots
 * `loads_<n>_<campo>` que devuelve el Flow, descartando los slots vacíos.
 * Solo deja pasar claves declaradas en la FormDefinition (el flow_token y
 * cualquier extra quedan afuera), así el resto del submit es idéntico al de
 * la Mini App.
 */
export function unflattenFlowPayload(
  rawDef: FormDefinition,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const def = flowDefinition(rawDef);
  const out: Record<string, unknown> = {};
  const isEmpty = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
  // Lo que quedó OCULTO no se guarda: el usuario cambió de idea y ya no lo ve.
  // Solo se descarta ante una señal positiva (casilla presente y desmarcada,
  // selector con valor); si la clave no viene, el dato se respeta.
  const choice = def.flowChoice;
  const chosen = choice?.options.find(o => o.field === payload[choice.key])?.field;
  for (const f of def.fields) {
    if (f.type !== 'group') {
      if (chosen && f.key !== chosen && choice!.options.some(o => o.field === f.key)) {
        if (!isEmpty(payload[f.key])) console.log(`[FORM] flow: se descarta ${f.key} (oculto, se eligió ${chosen})`);
        continue;
      }
      if (f.key in payload) out[f.key] = payload[f.key];
      if (f.allowOther && otherKey(f.key) in payload) out[otherKey(f.key)] = payload[otherKey(f.key)];
      continue;
    }
    const items: Record<string, unknown>[] = [];
    let hidden = false;
    for (let i = 1; i <= groupSlots(f); i++) {
      const toggle = payload[addKey(f.key, i)];
      if (Array.isArray(toggle) && !toggle.includes(CHECKED)) hidden = true;
      const item: Record<string, unknown> = {};
      let any = false;
      for (const sub of f.fields ?? []) {
        const v = payload[`${f.key}_${i}_${sub.key}`];
        if (isEmpty(v)) continue;
        item[sub.key] = v;
        any = true;
      }
      if (any && hidden) console.log(`[FORM] flow: se descarta ${f.key} ${i} (casilla desmarcada)`);
      else if (any) items.push(item);
    }
    if (items.length > 0) out[f.key] = items;
  }
  return out;
}
