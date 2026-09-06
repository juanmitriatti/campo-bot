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
  noFuture?: boolean;
  fields?: FormField[];
  maxItems?: number;
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
  /** Reglas entre campos que la validación por campo no puede expresar. */
  crossCheck?: (data: Record<string, unknown>) => string[];
}

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

const DATE_FIELD: FormField = { key: 'event_date', label: 'Fecha', type: 'date', required: true, noFuture: true };

export const FORM_DEFINITIONS: Record<FormAction, FormDefinition> = {
  sow_crop: {
    action: 'sow_crop',
    title: '🌱 Registrar siembra',
    label: 'la siembra',
    settingKey: 'WHATSAPP_FLOW_ID_SOW',
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      { key: 'crop', label: 'Cultivo', type: 'select', required: true, optionsSource: 'crops', allowOther: true },
      DATE_FIELD,
      { key: 'hectares', label: 'Hectáreas sembradas', type: 'number', required: false, min: 0.01, help: 'Solo si sembraste una parte del lote' },
      { key: 'variety', label: 'Variedad', type: 'text', required: false, help: 'Ej: DM 4670' },
    ],
  },
  harvest_crop: {
    action: 'harvest_crop',
    title: '🌾 Registrar cosecha',
    label: 'la cosecha',
    settingKey: 'WHATSAPP_FLOW_ID_HARVEST',
    plotFilter: 'withActiveCrop',
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      DATE_FIELD,
      { key: 'yield_kg_per_ha', label: 'Rinde (kg/ha)', type: 'number', required: false, min: 1 },
      { key: 'yield_kg', label: 'Rinde total (kg)', type: 'number', required: false, min: 1 },
      { key: 'humidity_pct', label: 'Humedad (%)', type: 'number', required: false, min: 0, max: 50 },
      {
        key: 'loads', label: 'Cargas por camión', type: 'group', required: false, maxItems: 20,
        fields: [
          { key: 'driver_name', label: 'Chofer', type: 'text', required: true },
          { key: 'weight_kg', label: 'Peso (kg)', type: 'number', required: true, min: 1 },
          { key: 'destinatario', label: 'Destinatario', type: 'text', required: false },
          { key: 'humidity_pct', label: 'Humedad (%)', type: 'number', required: false, min: 0, max: 50 },
        ],
      },
    ],
    crossCheck: d => (d.yield_kg !== undefined && d.yield_kg_per_ha !== undefined)
      ? ['Cargá el rinde por hectárea O el total, no los dos.'] : [],
  },
  log_expense: {
    action: 'log_expense',
    title: '💸 Registrar gasto',
    label: 'el gasto',
    settingKey: 'WHATSAPP_FLOW_ID_EXPENSE',
    fields: [
      { key: 'amount', label: 'Monto', type: 'number', required: true, min: 0.01 },
      { key: 'currency', label: 'Moneda', type: 'select', required: true, options: CURRENCY_OPTIONS },
      { key: 'category', label: 'Categoría', type: 'select', required: true, optionsSource: 'expense_categories', allowOther: true },
      { key: 'location', label: 'Lote o campo', type: 'select', required: false, optionsSource: 'locations', help: 'Dejalo vacío si no corresponde a un lote' },
      DATE_FIELD,
      { key: 'description', label: 'Detalle', type: 'text', required: false, help: 'Ej: 200 lt de gasoil en YPF' },
    ],
  },
  log_income: {
    action: 'log_income',
    title: '💰 Registrar ingreso',
    label: 'el ingreso',
    settingKey: 'WHATSAPP_FLOW_ID_INCOME',
    fields: [
      { key: 'amount', label: 'Monto', type: 'number', required: true, min: 0.01 },
      { key: 'currency', label: 'Moneda', type: 'select', required: true, options: CURRENCY_OPTIONS },
      { key: 'category', label: 'Categoría', type: 'select', required: true, optionsSource: 'income_categories', allowOther: true },
      { key: 'location', label: 'Lote o campo', type: 'select', required: false, optionsSource: 'locations', help: 'Dejalo vacío si no corresponde a un lote' },
      DATE_FIELD,
      { key: 'description', label: 'Detalle', type: 'text', required: false, help: 'Ej: 30 tn de soja a Cargill' },
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
      { key: 'product', label: 'Producto o implemento', type: 'text', required: false, help: 'Obligatorio salvo en riego. Ej: glifosato, urea, rastra' },
      { key: 'quantity', label: 'Dosis o cantidad', type: 'number', required: false, min: 0.001 },
      { key: 'unit', label: 'Unidad', type: 'select', required: false, options: DOSE_UNIT_OPTIONS },
      DATE_FIELD,
      { key: 'notes', label: 'Observaciones', type: 'text', required: false },
    ],
    crossCheck: d => {
      const errs: string[] = [];
      const t = d.activity_type;
      if ((t === 'spraying' || t === 'fertilization' || t === 'tillage') && !d.product) {
        errs.push(t === 'tillage' ? 'Indicá el implemento o producto de la labranza.' : 'Indicá el producto aplicado.');
      }
      if (t === 'irrigation' && d.quantity === undefined) errs.push('Indicá los mm de riego en Dosis o cantidad.');
      if (d.quantity !== undefined && !d.unit) errs.push('Indicá la unidad de la dosis.');
      return errs;
    },
  },
  add_livestock: {
    action: 'add_livestock',
    title: '🐄 Alta de hacienda',
    label: 'la hacienda',
    settingKey: 'WHATSAPP_FLOW_ID_LIVESTOCK',
    fields: [
      { key: 'category', label: 'Categoría', type: 'select', required: true, optionsSource: 'livestock_categories' },
      { key: 'count', label: 'Cabezas', type: 'number', required: true, min: 1 },
      { key: 'breed', label: 'Raza', type: 'select', required: false, optionsSource: 'breeds' },
      { key: 'location', label: 'Lote o corral', type: 'select', required: true, optionsSource: 'livestock_locations' },
      { key: 'unit_price', label: 'Precio por cabeza', type: 'number', required: false, min: 0.01, help: 'Si fue una compra, genera el gasto vinculado' },
      { key: 'currency', label: 'Moneda del precio', type: 'select', required: false, options: CURRENCY_OPTIONS },
      DATE_FIELD,
      { key: 'notes', label: 'Observaciones', type: 'text', required: false },
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

function validateScalar(f: FormField, raw: unknown, errors: string[], label?: string): unknown {
  const name = label ?? f.label;
  const empty = raw === undefined || raw === null || raw === '';
  if (empty) {
    if (f.required) errors.push(`${name} es obligatorio.`);
    return undefined;
  }
  if (f.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) { errors.push(`${name} debe ser un número.`); return undefined; }
    if (f.min !== undefined && n < f.min) { errors.push(`${name} debe ser al menos ${f.min}.`); return undefined; }
    if (f.max !== undefined && n > f.max) { errors.push(`${name} debe ser como máximo ${f.max}.`); return undefined; }
    return n;
  }
  if (f.type === 'text' || f.type === 'select') {
    const s = String(raw).trim();
    if (!s) { if (f.required) errors.push(`${name} es obligatorio.`); return undefined; }
    if (f.type === 'select' && f.options && !f.options.some(o => o.id === s)) {
      errors.push(`${name}: opción inválida.`);
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
      const empty = raw === undefined || raw === null || raw === '';
      if (empty) { if (f.required) errors.push(`${f.label} es obligatoria.`); continue; }
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { errors.push(`${f.label} inválida.`); continue; }
      const d = new Date(s + 'T00:00:00Z');
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) { errors.push(`${f.label} inválida.`); continue; }
      if (f.noFuture && s > todayISO) { errors.push(`${f.label} no puede ser futura.`); continue; }
      data[f.key] = s;
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

  if (errors.length === 0 && def.crossCheck) errors.push(...def.crossCheck(data));

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data };
}
