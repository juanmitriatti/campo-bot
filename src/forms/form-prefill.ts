// Resolución del PREFILL → valores iniciales de los campos del formulario.
//
// Fuente ÚNICA. Esta lógica vivía sólo dentro de FormPage.tsx (React), así que
// el formulario web prellenaba lo que el usuario ya había dicho pero el Flow de
// WhatsApp salía en blanco. Duplicarla del lado del server habría creado la
// segunda fuente de verdad que el proyecto prohíbe (invariante 3), así que se
// extrae acá y la usan los dos canales.
//
// El prefill viene con nombres del DOMINIO (plotName, eventDate, amount…) y los
// campos del form tienen otras claves (plot_id, event_date, location…):
// traducir es justamente el trabajo de este módulo. Sólo incluye las claves
// que se pudieron resolver — un campo ausente acá se le pide al usuario.

import { FORM_DEFINITIONS, type FormAction } from './form-definitions.js';
import { corralOptionId, fieldOptionId, plotOptionId, type FormOptions } from './form-options.js';

export interface PrefillInput {
  action: FormAction;
  prefill: Record<string, unknown>;
  options: FormOptions;
  todayISO: string;
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');

export function resolveFormInitialValues(input: PrefillInput): Record<string, unknown> {
  const { action, prefill, options, todayISO } = input;
  const out: Record<string, unknown> = {};
  const def = FORM_DEFINITIONS[action];
  const keys = new Set(def.fields.map(f => f.key));

  // Fecha: por defecto hoy; si el usuario dijo una (ya resuelta a ISO por
  // relative-dates), esa gana.
  if (keys.has('event_date')) {
    const fromUser = prefill.eventDate;
    out.event_date = typeof fromUser === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromUser)
      ? fromUser
      : todayISO;
  }

  // Lote: el usuario lo nombra por NOMBRE ("el lote Norte") y el form necesita
  // el id. Se matchea contra las opciones reales del usuario; con campo dicho,
  // desempata entre lotes homónimos de campos distintos.
  const namedPlot = norm(prefill.plotName);
  const namedField = norm(prefill.fieldName);
  const matchPlot = () => {
    if (!namedPlot) return null;
    const candidates = options.plots.filter(p => norm(p.name) === namedPlot);
    return (namedField && candidates.find(p => norm(p.fieldName) === namedField)) || candidates[0] || null;
  };
  if (keys.has('plot_id')) {
    const match = matchPlot();
    if (match) out.plot_id = String(match.id);
    else if (!namedPlot && options.plots.length === 1) out.plot_id = String(options.plots[0].id);
  }

  // Ubicación mixta (lote / campo entero / corral).
  if (keys.has('location')) {
    const plot = matchPlot();
    const corralName = norm(prefill.corralName);
    if (plot) out.location = plotOptionId(plot.id);
    else if (corralName) {
      const c = options.corrals.find(x => norm(x.name) === corralName);
      if (c) out.location = corralOptionId(c.id);
    } else if (namedField) {
      const f = options.fields.find(x => norm(x.name) === namedField);
      if (f) out.location = fieldOptionId(f.id);
    }
  }

  // Cultivo: sólo si el usuario lo nombró Y existe entre sus opciones. Nunca
  // inferirlo (invariante 13: no adivinar el cultivo que el usuario no dijo).
  if (keys.has('crop')) {
    const named = norm(prefill.crop);
    if (named) {
      const match = options.crops.find(c => norm(c) === named);
      if (match) out.crop = match;
    }
  }

  // Categoría (gasto/ingreso): match contra la lista del usuario; si dijo una
  // que no está, va como "otro" para que la vea escrita y no la pierda.
  if (keys.has('category')) {
    const named = norm(prefill.category);
    const list = options.lists.expense_categories ?? options.lists.income_categories ?? options.lists.livestock_categories ?? [];
    if (named) {
      const match = list.find(o => norm(o.id) === named || norm(o.title) === named);
      if (match) out.category = match.id;
      else if (typeof prefill.category === 'string' && def.fields.find(f => f.key === 'category')?.allowOther) {
        out.category_other = prefill.category.trim();
      }
    }
  }

  if (keys.has('breed') && typeof prefill.breed === 'string') {
    const match = (options.lists.breeds ?? []).find(o => norm(o.id) === norm(prefill.breed));
    if (match) out.breed = match.id;
  }

  // Selects fijos: pasan si el valor es una opción válida.
  for (const f of def.fields) {
    if (f.type !== 'select' || !f.options) continue;
    const domainKey = f.key === 'activity_type' ? 'activityType' : f.key;
    const v = prefill[domainKey];
    if (typeof v === 'string' && f.options.some(o => o.id === v)) out[f.key] = v;
  }

  // Numéricos que el usuario ya dijo.
  for (const k of ['hectares', 'yield_kg_per_ha', 'yield_kg', 'humidity_pct', 'amount', 'quantity', 'count', 'unit_price'] as const) {
    if (!keys.has(k)) continue;
    const v = prefill[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }

  // Textos que el usuario ya dijo.
  for (const k of ['variety', 'product', 'description', 'notes'] as const) {
    if (!keys.has(k)) continue;
    const v = prefill[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }

  return out;
}
