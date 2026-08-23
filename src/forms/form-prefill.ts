// Resolución del PREFILL → valores iniciales de los campos del formulario.
//
// Fuente ÚNICA. Esta lógica vivía sólo dentro de FormPage.tsx (React), así que
// el formulario web prellenaba lo que el usuario ya había dicho pero el Flow de
// WhatsApp salía en blanco: el `prefill` se guardaba en form_sessions y nunca
// llegaba al mensaje. Duplicarla del lado del server habría creado la segunda
// fuente de verdad que el proyecto prohíbe (invariante 3), así que se extrae acá
// y la usan los dos canales.
//
// El prefill viene con nombres del DOMINIO (plotName, eventDate, hectares) y los
// campos del form tienen otras claves (plot_id, event_date, hectares): traducir
// es justamente el trabajo de este módulo.

import { FORM_DEFINITIONS } from './form-definitions.js';
import type { FormOptions } from './form-options.js';

export interface PrefillInput {
  action: 'sow_crop' | 'harvest_crop';
  prefill: Record<string, unknown>;
  options: FormOptions;
  todayISO: string;
}

/**
 * Devuelve los valores iniciales por CLAVE DE CAMPO del formulario.
 * Sólo incluye las claves que se pudieron resolver — un campo ausente acá
 * simplemente se le pide al usuario.
 */
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
  // el id. Se matchea contra las opciones reales del usuario.
  if (keys.has('plot_id')) {
    const named = typeof prefill.plotName === 'string' ? prefill.plotName.trim().toLowerCase() : '';
    if (named) {
      const field = typeof prefill.fieldName === 'string' ? prefill.fieldName.trim().toLowerCase() : '';
      // Con campo dicho, desempata entre lotes homónimos de campos distintos.
      const candidates = options.plots.filter(p => p.name.trim().toLowerCase() === named);
      const match = (field && candidates.find(p => p.fieldName.trim().toLowerCase() === field)) || candidates[0];
      if (match) out.plot_id = String(match.id);
    } else if (options.plots.length === 1) {
      // Un solo lote: no tiene sentido preguntarlo.
      out.plot_id = String(options.plots[0].id);
    }
  }

  // Cultivo: sólo si el usuario lo nombró Y existe entre sus opciones. Nunca
  // inferirlo (invariante 13: no adivinar el cultivo que el usuario no dijo).
  if (keys.has('crop')) {
    const named = typeof prefill.crop === 'string' ? prefill.crop.trim().toLowerCase() : '';
    if (named) {
      const match = options.crops.find(c => c.trim().toLowerCase() === named);
      if (match) out.crop = match;
    }
  }

  // Numéricos que el usuario ya dijo.
  for (const k of ['hectares', 'yield_kg_per_ha', 'yield_kg', 'humidity_pct'] as const) {
    if (!keys.has(k)) continue;
    const v = prefill[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }

  if (keys.has('variety') && typeof prefill.variety === 'string' && prefill.variety.trim()) {
    out.variety = prefill.variety.trim();
  }

  return out;
}
