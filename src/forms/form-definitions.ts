// Fuente ÚNICA de verdad de los formularios estructurados: de acá salen el
// render del form React (GET /api/forms/:token), la validación server-side
// del submit y el Flow JSON de WhatsApp. Nunca duplicar esto.
//
// REGISTRO POR FORMULARIO (Sep 2026): cada FormDefinition declara TODO lo que
// antes estaba repartido en seis archivos — la etiqueta de la oferta, la
// setting del flow_id, el filtro de lotes y la regla cruzada. Sumar un
// formulario = una entrada acá + su builder de comando en form-commands.ts +
// el handler que lo ofrece. Nada más.
import type { FormAction } from '../types/index.js';
import { parseNumberAR } from '../utils/number-ar.js';
import { LIMITS } from '../utils/value-validator.js';

export type { FormAction };

/** Fuentes de opciones dinámicas (las resuelve form-options.ts por usuario). */
export type FormOptionSource =
  | 'plots'
  | 'crops'
  | 'locations'            // lotes (p:<id>) + campos enteros (f:<id>)
  | 'livestock_locations'  // lotes (p:<id>) + corrales (c:<id>)
  | 'expense_categories'
  | 'income_categories'
  | 'livestock_categories'
  | 'breeds';

export interface FormOption { id: string; title: string }

export interface FormField {
  key: string;
  label: string;
  /** Etiqueta para WhatsApp Flows cuando `label` pasa los 20 caracteres de Meta. */
  flowLabel?: string;
  type: 'select' | 'date' | 'number' | 'text' | 'group';
  required: boolean;
  /** Opciones por usuario (lotes, categorías…). Excluyente con `options`. */
  optionsSource?: FormOptionSource;
  /** Opciones fijas (moneda, tipo de labor…). Se hornean en el Flow JSON. */
  options?: FormOption[];
  /** Permite un valor libre además de la lista. En Flows se rinde como un
   *  TextInput acompañante `<key>_other` (el Dropdown no admite "otro"). */
  allowOther?: boolean;
  min?: number;
  max?: number;
  /** Solo enteros (cabezas). */
  integer?: boolean;
  /** Se agrega al error de min/max: cómo se escribe ese dato. */
  rangeHint?: string;
  /** Texto (o "otro" de un select): largo de su columna en la base. */
  maxLength?: number;
  noFuture?: boolean;
  /** Fechas: no más viejas que estos años. */
  maxAgeYears?: number;
  fields?: FormField[];
  maxItems?: number;
  /** WhatsApp Flows: select rendido como botones de opción. */
  radio?: boolean;
  /** WhatsApp Flows: textos de la casilla que muestra cada bloque de un grupo. */
  toggle?: { label: string; noun: string; first: string; next: string };
  /** Grupo cuya fila 1 son los campos base: los bloques se numeran desde 2. */
  slotOffset?: number;
  /** Grupo que se puede abrir precargado (la casilla llega marcada). */
  prefillable?: boolean;
  help?: string;
}

export interface FormDefinition {
  action: FormAction;
  title: string;
  /** Cómo se nombra en la oferta: "cargá *la siembra* con un formulario". */
  label: string;
  /** Setting (grupo bot) con el flow_id publicado en Meta. Vacío = no se ofrece por WhatsApp. */
  settingKey: string;
  /** Lotes visibles en los selects de lote. */
  plotFilter?: 'withActiveCrop';
  fields: FormField[];
  /**
   * Reglas entre campos que la validación por campo no puede expresar.
   * Un issue con `field` es un requerido CONDICIONAL de ese campo: el form web
   * y el Flow lo muestran como texto, el colector conversacional lo pregunta.
   */
  crossCheck?: (data: Record<string, unknown>) => Array<string | FormIssue>;
  /** Campos SOLO del Flow de WhatsApp (el form web y el de chat usan `fields`). */
  flowFields?: FormField[];
  /** WhatsApp Flows: campos excluyentes; un selector muestra solo el elegido. */
  flowChoice?: { key: string; label: string; options: Array<{ field: string; title: string }> };
}

/** Problema de validación atribuible (o no) a un campo. */
export interface FormIssue { field?: string; message: string }

export const CURRENCY_OPTIONS: FormOption[] = [
  { id: 'ARS', title: 'Pesos (ARS)' },
  { id: 'USD', title: 'Dólares (USD)' },
];

export const ACTIVITY_TYPE_OPTIONS: FormOption[] = [
  { id: 'spraying', title: 'Fumigación' },
  { id: 'fertilization', title: 'Fertilización' },
  { id: 'tillage', title: 'Labranza' },
  { id: 'irrigation', title: 'Riego' },
];

export const DOSE_UNIT_OPTIONS: FormOption[] = ['lt/ha', 'kg/ha', 'cc/ha', 'lt', 'kg', 'mm']
  .map(u => ({ id: u, title: u }));

/** Máximo por unidad. Generosos: guano o cal se aplican de a toneladas por ha. */
const MAX_DOSE_BY_UNIT: Record<string, number> = {
  'lt/ha': 1_000, 'kg/ha': 40_000, 'cc/ha': 20_000, lt: 1_000_000, kg: 10_000_000, mm: 500,
};

// Techos de cordura: lo que pasa de acá es imposible, no "raro" (lo raro se
// pregunta, como el rinde sobre el techo del cultivo).
const MAX_HECTARES = 100_000;
const MAX_MONEY = LIMITS.amount_max;
const MAX_HEADS = LIMITS.livestock_max_count;

const DATE_FIELD: FormField = { key: 'event_date', label: 'Fecha', type: 'date', required: true, noFuture: true, maxAgeYears: 10 };
const NOTES_FIELD: FormField = { key: 'notes', label: 'Observaciones', type: 'text', required: false, maxLength: 500 };
const COUNT_FIELD: FormField = { key: 'count', label: 'Cabezas', type: 'number', required: true, min: 1, max: MAX_HEADS, integer: true };

const PRICE_MODE_FIELD: FormField = {
  key: 'price_mode', label: 'Precio es', type: 'select', required: false,
  options: [{ id: 'head', title: 'Por cabeza' }, { id: 'kg', title: 'Por kg vivo' }, { id: 'total', title: 'Total' }],
};
const ROW_PRICE_FIELD: FormField = { key: 'unit_price', label: 'Precio', type: 'number', required: false, min: 0.01, max: MAX_MONEY };
const AVG_WEIGHT_FIELD: FormField = { key: 'avg_weight_kg', label: 'Kg promedio', type: 'number', required: false, min: 1, max: 1500 };

/** Flow de alta de hacienda: hasta 5 categorías, un lote para todo, precio opcional. */
const LIVESTOCK_FLOW_FIELDS: FormField[] = [
  {
    key: 'origin', label: '¿Cómo entraron?', type: 'select', required: false, radio: true,
    options: [{ id: 'compra', title: 'Compra' }, { id: 'existente', title: 'Ya los tenía' }, { id: 'otro', title: 'Otro ingreso' }],
  },
  { key: 'location', label: 'Lote o corral', type: 'select', required: true, optionsSource: 'livestock_locations' },
  DATE_FIELD,
  { key: 'category', label: 'Categoría', type: 'select', required: true, optionsSource: 'livestock_categories' },
  COUNT_FIELD,
  { key: 'breed', label: 'Raza', type: 'select', required: false, optionsSource: 'breeds' },
  PRICE_MODE_FIELD,
  ROW_PRICE_FIELD,
  AVG_WEIGHT_FIELD,
  {
    key: 'animals', label: 'Otras categorías', type: 'group', required: false, maxItems: 4, slotOffset: 1, prefillable: true,
    toggle: { label: 'Más categorías', noun: 'Categoría', first: '➕ Agregar otra categoría', next: '➕ Agregar otra categoría' },
    fields: [
      { key: 'category', label: 'Categoría', type: 'select', required: false, optionsSource: 'livestock_categories' },
      { ...COUNT_FIELD, required: false },
      { key: 'breed', label: 'Raza', type: 'select', required: false, optionsSource: 'breeds' },
      PRICE_MODE_FIELD,
      ROW_PRICE_FIELD,
      AVG_WEIGHT_FIELD,
    ],
  },
  { key: 'currency', label: 'Moneda del precio', type: 'select', required: false, options: CURRENCY_OPTIONS },
  NOTES_FIELD,
];

/** La definición tal como la ve el Flow de WhatsApp. */
export function flowDefinition(def: FormDefinition): FormDefinition {
  return def.flowFields ? { ...def, fields: def.flowFields } : def;
}

export const FORM_DEFINITIONS: Record<FormAction, FormDefinition> = {
  sow_crop: {
    action: 'sow_crop',
    title: '🌱 Registrar siembra',
    label: 'la siembra',
    settingKey: 'WHATSAPP_FLOW_ID_SOW',
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      { key: 'crop', label: 'Cultivo', type: 'select', required: true, optionsSource: 'crops', allowOther: true, maxLength: 50 },
      DATE_FIELD,
      { key: 'hectares', label: 'Hectáreas sembradas', type: 'number', required: false, min: 0.01, max: MAX_HECTARES, help: 'Solo si sembraste una parte del lote' },
      { key: 'variety', label: 'Variedad', type: 'text', required: false, maxLength: 100, help: 'Ej: DM 4670' },
    ],
  },
  harvest_crop: {
    action: 'harvest_crop',
    title: '🌾 Registrar cosecha',
    label: 'la cosecha',
    settingKey: 'WHATSAPP_FLOW_ID_HARVEST',
    plotFilter: 'withActiveCrop',
    flowChoice: {
      key: 'yield_mode',
      label: 'Tipo de rinde',
      options: [{ field: 'yield_kg_per_ha', title: 'Por hectárea (kg/ha)' }, { field: 'yield_kg', title: 'Total (kg)' }],
    },
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      DATE_FIELD,
      { key: 'yield_kg_per_ha', label: 'Rinde (kg/ha)', type: 'number', required: false, min: 100, max: 30000, rangeHint: 'Va en kilos por hectárea: 42 qq/ha = 4200.', help: 'En kg por hectárea (1 qq = 100 kg). Ej: 42 qq/ha = 4200' },
      { key: 'yield_kg', label: 'Rinde total (kg)', type: 'number', required: false, min: 100, max: 100_000_000, rangeHint: 'Va en kilos: 130 toneladas = 130000.' },
      // Avance parcial: sin esto "42 qq/ha" se multiplicaba por TODO el lote
      // aunque se hubieran cosechado 40 de 100 ha, y una segunda cosecha pisaba
      // el rinde en vez de sumar (el handler acumula solo si llegan las ha).
      { key: 'hectares', label: 'Hectáreas cosechadas', type: 'number', required: false, min: 0.01, max: MAX_HECTARES, help: 'Solo si cosechaste una parte del lote' },
      { key: 'humidity_pct', label: 'Humedad (%)', type: 'number', required: false, min: 0, max: 50 },
      {
        key: 'loads', label: 'Cargas por camión', type: 'group', required: false, maxItems: 20,
        toggle: { label: 'Camiones', noun: 'Camión', first: 'Cargar camiones', next: '➕ Agregar otro camión' },
        fields: [
          { key: 'driver_name', label: 'Chofer', type: 'text', required: true, maxLength: 100 },
          { key: 'weight_kg', label: 'Peso (kg)', type: 'number', required: true, min: 1000, max: 60_000, rangeHint: 'Va el peso de UN camión en kilos: 28 toneladas = 28000.' },
          { key: 'destinatario', label: 'Destinatario', type: 'text', required: false, maxLength: 100 },
          { key: 'humidity_pct', label: 'Humedad (%)', type: 'number', required: false, min: 0, max: 50 },
        ],
      },
    ],
    crossCheck: d => (d.yield_kg !== undefined && d.yield_kg_per_ha !== undefined)
      ? [{ field: 'yield_kg', message: 'Cargá el rinde por hectárea O el total, no los dos.' }] : [],
  },
  log_expense: {
    action: 'log_expense',
    title: '💸 Registrar gasto',
    label: 'el gasto',
    settingKey: 'WHATSAPP_FLOW_ID_EXPENSE',
    fields: [
      { key: 'amount', label: 'Monto', type: 'number', required: true, min: 0.01, max: MAX_MONEY },
      { key: 'currency', label: 'Moneda', type: 'select', required: true, options: CURRENCY_OPTIONS },
      { key: 'category', label: 'Categoría', type: 'select', required: true, optionsSource: 'expense_categories', allowOther: true, maxLength: 50 },
      { key: 'location', label: 'Lote o campo', type: 'select', required: false, optionsSource: 'locations', help: 'Dejalo vacío si no corresponde a un lote' },
      DATE_FIELD,
      { key: 'description', label: 'Detalle', type: 'text', required: false, maxLength: 500, help: 'Ej: 200 lt de gasoil en YPF' },
    ],
  },
  log_income: {
    action: 'log_income',
    title: '💰 Registrar ingreso',
    label: 'el ingreso',
    settingKey: 'WHATSAPP_FLOW_ID_INCOME',
    fields: [
      { key: 'amount', label: 'Monto', type: 'number', required: true, min: 0.01, max: MAX_MONEY },
      { key: 'currency', label: 'Moneda', type: 'select', required: true, options: CURRENCY_OPTIONS },
      { key: 'category', label: 'Categoría', type: 'select', required: true, optionsSource: 'income_categories', allowOther: true, maxLength: 50 },
      // Venta de grano: sin comprador ni cantidad la venta no entra al saldo por
      // acopio ("cuánta soja me queda en Cargill"). Van ANTES de la ubicación:
      // con comprador el lote se deduce de la campaña y ni se pregunta.
      { key: 'buyer', label: 'Comprador', type: 'text', required: false, maxLength: 100, help: 'Solo en ventas de grano. Ej: Cargill' },
      { key: 'quantity_tn', label: 'Toneladas vendidas', type: 'number', required: false, min: 0.001, max: 100_000, rangeHint: 'Va en toneladas, no en kilos.', help: 'Solo en ventas de grano' },
      { key: 'location', label: 'Lote o campo', type: 'select', required: false, optionsSource: 'locations', help: 'Dejalo vacío si no corresponde a un lote' },
      DATE_FIELD,
      { key: 'description', label: 'Detalle', type: 'text', required: false, maxLength: 500, help: 'Ej: 30 tn de soja a Cargill' },
    ],
  },
  log_activity: {
    action: 'log_activity',
    title: '🧪 Registrar labor',
    label: 'la labor',
    settingKey: 'WHATSAPP_FLOW_ID_ACTIVITY',
    fields: [
      { key: 'activity_type', label: 'Labor', type: 'select', required: true, options: ACTIVITY_TYPE_OPTIONS },
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      { key: 'product', label: 'Producto o implemento', flowLabel: 'Producto/implemento', type: 'text',required: false, maxLength: 150, help: 'Obligatorio salvo en riego. Ej: glifosato, urea, rastra' },
      { key: 'quantity', label: 'Dosis o cantidad', type: 'number', required: false, min: 0.001, max: 10_000_000 },
      { key: 'unit', label: 'Unidad', type: 'select', required: false, options: DOSE_UNIT_OPTIONS },
      DATE_FIELD,
      NOTES_FIELD,
    ],
    crossCheck: d => {
      const errs: FormIssue[] = [];
      const t = d.activity_type;
      if ((t === 'spraying' || t === 'fertilization' || t === 'tillage') && !d.product) {
        errs.push({ field: 'product', message: t === 'tillage' ? 'Indicá el implemento o producto de la labranza.' : 'Indicá el producto aplicado.' });
      }
      if (t === 'irrigation' && d.quantity === undefined) errs.push({ field: 'quantity', message: 'Indicá los mm de riego en Dosis o cantidad.' });
      if (d.quantity !== undefined && !d.unit) errs.push({ field: 'unit', message: 'Indicá la unidad de la dosis.' });
      const cap = t === 'irrigation' ? MAX_DOSE_BY_UNIT.mm : MAX_DOSE_BY_UNIT[String(d.unit ?? '')];
      if (typeof d.quantity === 'number' && cap !== undefined && d.quantity > cap) {
        errs.push({ field: 'quantity', message: `Dosis o cantidad: ${d.quantity} ${d.unit ?? ''} es demasiado (máximo ${cap}). Revisá el número y la unidad.` });
      }
      return errs;
    },
  },
  add_livestock: {
    action: 'add_livestock',
    title: '🐄 Alta de hacienda',
    label: 'la hacienda',
    settingKey: 'WHATSAPP_FLOW_ID_LIVESTOCK',
    flowFields: LIVESTOCK_FLOW_FIELDS,
    fields: [
      { key: 'category', label: 'Categoría', type: 'select', required: true, optionsSource: 'livestock_categories' },
      COUNT_FIELD,
      { key: 'breed', label: 'Raza', type: 'select', required: false, optionsSource: 'breeds' },
      { key: 'location', label: 'Lote o corral', type: 'select', required: true, optionsSource: 'livestock_locations' },
      { key: 'unit_price', label: 'Precio por cabeza', type: 'number', required: false, min: 0.01, max: MAX_MONEY, help: 'Si fue una compra, genera el gasto vinculado' },
      { key: 'currency', label: 'Moneda del precio', type: 'select', required: false, options: CURRENCY_OPTIONS },
      DATE_FIELD,
      NOTES_FIELD,
    ],
  },
};

export const FORM_ACTIONS = Object.keys(FORM_DEFINITIONS) as FormAction[];

export function isFormAction(x: unknown): x is FormAction {
  return typeof x === 'string' && x in FORM_DEFINITIONS;
}

type ValidationResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * Validación de UN campo escalar o fecha, la misma para los tres renderers
 * (form web, WhatsApp Flow, colector conversacional). Devuelve el valor
 * normalizado, `undefined` si viene vacío (y es opcional) o el error en
 * lenguaje de usuario. Nunca duplicar estas reglas en un renderer.
 */
export function validateFieldValue(
  f: FormField,
  raw: unknown,
  todayISO: string,
  label?: string,
): { value?: unknown; error?: string } {
  const errors: string[] = [];
  if (f.type === 'date') {
    const empty = raw === undefined || raw === null || raw === '';
    if (empty) return f.required ? { error: `${label ?? f.label} es obligatoria.` } : {};
    const s = String(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: `${label ?? f.label} inválida.` };
    const d = new Date(s + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { error: `${label ?? f.label} inválida.` };
    if (f.noFuture && s > todayISO) return { error: `${label ?? f.label} no puede ser futura.` };
    if (f.maxAgeYears !== undefined) {
      const oldest = `${Number(todayISO.slice(0, 4)) - f.maxAgeYears}${todayISO.slice(4)}`;
      if (s < oldest) return { error: `${label ?? f.label} es de hace más de ${f.maxAgeYears} años. Revisá el año.` };
    }
    return { value: s };
  }
  const value = validateScalar(f, raw, errors, label);
  return errors.length > 0 ? { error: errors[0] } : { value };
}

/** Issues del crossCheck normalizados (los strings sueltos quedan sin campo). */
export function crossCheckIssues(def: FormDefinition, data: Record<string, unknown>): FormIssue[] {
  if (!def.crossCheck) return [];
  return def.crossCheck(data).map(i => (typeof i === 'string' ? { message: i } : i));
}

function validateScalar(f: FormField, raw: unknown, errors: string[], label?: string): unknown {
  const name = label ?? f.label;
  const empty = raw === undefined || raw === null || raw === '';
  if (empty) {
    if (f.required) errors.push(`${name} es obligatorio.`);
    return undefined;
  }
  if (f.type === 'number') {
    const n = parseNumberAR(raw);
    const hint = f.rangeHint ? ` ${f.rangeHint}` : '';
    const ar = (v: number) => v.toLocaleString('es-AR', { maximumFractionDigits: 3 });
    if (n === null) { errors.push(`${name} debe ser un número.`); return undefined; }
    if (f.integer && !Number.isInteger(n)) { errors.push(`${name} debe ser un número entero.`); return undefined; }
    if (f.min !== undefined && n < f.min) { errors.push(`${name} debe ser al menos ${ar(f.min)}.${hint}`); return undefined; }
    if (f.max !== undefined && n > f.max) { errors.push(`${name} debe ser como máximo ${ar(f.max)}.${hint}`); return undefined; }
    return n;
  }
  if (f.type === 'text' || f.type === 'select') {
    const s = String(raw).trim();
    if (!s) { if (f.required) errors.push(`${name} es obligatorio.`); return undefined; }
    if (f.type === 'select' && f.options && !f.options.some(o => o.id === s)) {
      errors.push(`${name}: opción inválida.`);
      return undefined;
    }
    if (f.maxLength !== undefined && s.length > f.maxLength) {
      errors.push(`${name} es muy largo (máximo ${f.maxLength} caracteres).`);
      return undefined;
    }
    return s;
  }
  return raw;
}

/**
 * Valor efectivo de un select con `allowOther`: si vino `<key>_other` con
 * texto, ese gana sobre la opción elegida (o sobre la ausencia de opción).
 * Aplica igual al form web y al Flow — los dos mandan la clave acompañante.
 */
function selectRaw(f: FormField, payload: Record<string, unknown>): unknown {
  const raw = payload[f.key];
  if (!f.allowOther) return raw;
  const other = payload[`${f.key}_other`];
  if (typeof other === 'string' && other.trim()) return other.trim();
  if (raw === '__other__') return undefined;
  return raw;
}

export function validateFormPayload(
  def: FormDefinition,
  payload: Record<string, unknown>,
  todayISO: string,
): ValidationResult {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};

  for (const f of def.fields) {
    const raw = f.type === 'select' ? selectRaw(f, payload) : payload[f.key];
    if (f.type === 'date') {
      const r = validateFieldValue(f, raw, todayISO);
      if (r.error) { errors.push(r.error); continue; }
      if (r.value !== undefined) data[f.key] = r.value;
    } else if (f.type === 'group') {
      if (raw === undefined || raw === null) continue;
      if (!Array.isArray(raw)) { errors.push(`${f.label} inválidas.`); continue; }
      if (f.maxItems && raw.length > f.maxItems) { errors.push(`${f.label}: máximo ${f.maxItems}.`); continue; }
      const items: Record<string, unknown>[] = [];
      raw.forEach((item, i) => {
        const out: Record<string, unknown> = {};
        for (const sub of f.fields ?? []) {
          const v = validateScalar(sub, (item as Record<string, unknown>)[sub.key], errors, `Carga ${i + 1}: ${sub.label.toLowerCase()}`);
          if (v !== undefined) out[sub.key] = v;
        }
        items.push(out);
      });
      if (items.length > 0) data[f.key] = items;
    } else {
      const v = validateScalar(f, raw, errors, undefined);
      if (v !== undefined) data[f.key] = v;
    }
  }

  if (errors.length === 0) errors.push(...crossCheckIssues(def, data).map(i => i.message));

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data };
}
