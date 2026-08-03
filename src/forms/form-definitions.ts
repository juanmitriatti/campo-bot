// Fuente ÚNICA de verdad de los formularios estructurados: de acá salen el
// render del form React (GET /api/forms/:token), la validación server-side
// del submit y, a futuro, el Flow JSON de WhatsApp. Nunca duplicar esto.

export interface FormField {
  key: string;
  label: string;
  type: 'select' | 'date' | 'number' | 'text' | 'group';
  required: boolean;
  optionsSource?: 'plots' | 'crops';
  allowOther?: boolean;
  min?: number;
  max?: number;
  noFuture?: boolean;
  fields?: FormField[];
  maxItems?: number;
  help?: string;
}

export interface FormDefinition {
  action: 'sow_crop' | 'harvest_crop';
  title: string;
  fields: FormField[];
}

export const FORM_DEFINITIONS: Record<'sow_crop' | 'harvest_crop', FormDefinition> = {
  sow_crop: {
    action: 'sow_crop',
    title: '🌱 Registrar siembra',
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      { key: 'crop', label: 'Cultivo', type: 'select', required: true, optionsSource: 'crops', allowOther: true },
      { key: 'event_date', label: 'Fecha', type: 'date', required: true, noFuture: true },
      { key: 'hectares', label: 'Hectáreas sembradas', type: 'number', required: false, min: 0.01, help: 'Solo si sembraste una parte del lote' },
      { key: 'variety', label: 'Variedad', type: 'text', required: false, help: 'Ej: DM 4670' },
    ],
  },
  harvest_crop: {
    action: 'harvest_crop',
    title: '🌾 Registrar cosecha',
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      { key: 'event_date', label: 'Fecha', type: 'date', required: true, noFuture: true },
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
  },
};

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
    return s;
  }
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
    const raw = payload[f.key];
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
      const v = validateScalar(f, raw, errors);
      if (v !== undefined) data[f.key] = v;
    }
  }

  // Regla cruzada de cosecha: rinde por ha y total son excluyentes.
  if (def.action === 'harvest_crop' && data.yield_kg !== undefined && data.yield_kg_per_ha !== undefined) {
    errors.push('Cargá el rinde por hectárea O el total, no los dos.');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data };
}
