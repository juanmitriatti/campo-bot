// Renderer CONVERSACIONAL de formularios (WhatsApp sin Flows).
//
// Puro: arma preguntas, resúmenes y menús a partir de la FormDefinition + la
// presentación + los valores del draft. No lee DB ni guarda estado — eso es de
// form-conversation.service.ts. Respeta los límites de WhatsApp: hasta 3
// botones de 20 caracteres, listas de hasta 10 filas con títulos de 24.
import type { BotResponseItem } from '../../services/message-pipeline.js';
import type { InteractiveButton, InteractiveListRow } from '../../types/index.js';
import type { FormDefinition, FormField, FormOption } from '../form-definitions.js';
import type { FormOptions } from '../form-options.js';
import type { FormPresentation } from './presentation.js';
import { isFieldEmpty, optionsFor } from './field-extractor.js';

export const CFORM_PREFIX = 'cform_';
const MAX_BUTTON_TITLE = 20;
const MAX_ROW_TITLE = 24;
const MAX_ROW_DESC = 72;
const MAX_LIST_ROWS = 10;

/** Id de callback corto (Telegram limita a 64 bytes): prefijo del token + verbo. */
export function cbId(token: string, verb: string): string {
  return `${CFORM_PREFIX}${token.slice(0, 8)}_${verb}`;
}

export function parseCbId(id: string): { tok8: string; verb: string } | null {
  const m = /^cform_([0-9a-f]{8})_([a-z0-9_]+)$/.exec(id);
  return m ? { tok8: m[1], verb: m[2] } : null;
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function isoToAR(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function shiftISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDateForUser(iso: string, todayISO: string): string {
  if (iso === todayISO) return `${isoToAR(iso)} (hoy)`;
  if (iso === shiftISO(todayISO, -1)) return `${isoToAR(iso)} (ayer)`;
  return isoToAR(iso);
}

function money(n: number, currency: unknown): string {
  const formatted = n.toLocaleString('es-AR', { maximumFractionDigits: 2 });
  return currency === 'USD' ? `US$ ${formatted}` : `$${formatted}`;
}

function optionTitle(f: FormField, id: unknown, options: FormOptions): string | null {
  if (id === undefined || id === null || id === '') return null;
  const hit = optionsFor(f, options).find(o => o.id === String(id));
  return hit ? hit.title : String(id);
}

/** Valor legible de un campo del draft, o null si está vacío. */
export function formatFieldValue(
  f: FormField,
  values: Record<string, unknown>,
  options: FormOptions,
  todayISO: string,
): string | null {
  if (isFieldEmpty(values, f)) return null;
  const v = values[f.key];
  switch (f.type) {
    case 'date':
      return formatDateForUser(String(v), todayISO);
    case 'number': {
      const n = Number(v);
      if (f.key === 'amount' || f.key === 'unit_price') return money(n, values.currency);
      if (f.key === 'quantity') return `${n.toLocaleString('es-AR')}${values.unit ? ` ${String(values.unit)}` : ''}`;
      if (f.key === 'yield_kg_per_ha') return `${n.toLocaleString('es-AR')} kg/ha`;
      if (f.key === 'yield_kg') return `${n.toLocaleString('es-AR')} kg`;
      if (f.key === 'humidity_pct') return `${n.toLocaleString('es-AR')} %`;
      if (f.key === 'hectares') return `${n.toLocaleString('es-AR')} ha`;
      return n.toLocaleString('es-AR');
    }
    case 'select': {
      const other = values[`${f.key}_other`];
      if (f.allowOther && typeof other === 'string' && other.trim()) return other.trim();
      return optionTitle(f, v, options);
    }
    case 'group': {
      const items = v as Array<{ weight_kg?: number }>;
      const kg = items.reduce((s, i) => s + (Number(i.weight_kg) || 0), 0);
      return `${items.length} camión${items.length === 1 ? '' : 'es'} · ${kg.toLocaleString('es-AR')} kg`;
    }
    default:
      return String(v);
  }
}

/** Campos que se muestran en el resumen (la unidad va pegada a la dosis). */
function summaryFields(def: FormDefinition): FormField[] {
  return def.fields.filter(f => !(f.key === 'unit' && def.fields.some(x => x.key === 'quantity')));
}

/** "🏷️ Combustible · 💰 $250.000" — recordatorio corto al retomar. */
export function renderRecap(
  def: FormDefinition,
  pres: FormPresentation,
  values: Record<string, unknown>,
  options: FormOptions,
  todayISO: string,
): string {
  const parts: string[] = [];
  for (const f of summaryFields(def)) {
    if (f.type === 'date' || f.key === 'currency') continue;
    const txt = formatFieldValue(f, values, options, todayISO);
    if (txt) parts.push(`${pres.fields[f.key]?.emoji ?? '•'} ${txt}`);
    if (parts.length >= 3) break;
  }
  return parts.join(' · ');
}

export interface QuestionArgs {
  def: FormDefinition;
  pres: FormPresentation;
  field: FormField;
  options: FormOptions;
  token: string;
  todayISO: string;
  /** Por qué se vuelve a preguntar ("🤔 No encontré…"). */
  reason?: string | null;
  /** Nota de progreso previa (ej. "✏️ Actualicé: Importe."). */
  notes?: string[];
  /** Es el ÚNICO obligatorio que falta y ya hay otros datos. */
  onlyMissing?: boolean;
  /** 2º rechazo del mismo campo: mostrar el formato esperado y la salida. */
  escalate?: boolean;
  /** Candidatos a mostrar en vez de toda la lista (ambigüedad). */
  candidates?: FormOption[];
  /** Opcional ofrecido: se agrega "Omitir". */
  skippable?: boolean;
}

export interface QuestionRender {
  items: BotResponseItem[];
  choices: { field: string; ids: string[] } | null;
}

export function renderQuestion(a: QuestionArgs): QuestionRender {
  const { field: f, pres, token, todayISO } = a;
  const fp = pres.fields[f.key];
  const lines: string[] = [];
  for (const n of a.notes ?? []) lines.push(n);
  if (a.reason) lines.push(a.reason);
  if (a.onlyMissing) lines.push(`Me falta solamente ${f.label.toLowerCase()}.`);
  lines.push(fp?.ask ?? `¿${f.label}?`);
  if (a.escalate) {
    if (fp?.hint) lines.push(`\n💡 ${fp.hint}`);
    lines.push('Si preferís dejarlo para después, escribí *cancelar*.');
  }
  const body = lines.join('\n');
  const skip = a.skippable ? [{ id: cbId(token, 'skip'), title: '⏭️ Omitir' }] : [];

  // Fecha: atajos Hoy / Ayer (el valor viaja como ISO en choices).
  if (f.type === 'date') {
    const today = todayISO;
    const yesterday = shiftISO(todayISO, -1);
    return {
      items: [{
        type: 'interactive',
        interactive: {
          type: 'buttons',
          body,
          buttons: [
            { id: cbId(token, 'o0'), title: 'Hoy' },
            { id: cbId(token, 'o1'), title: 'Ayer' },
            ...skip,
          ].slice(0, 3),
        },
      }],
      choices: { field: f.key, ids: [today, yesterday] },
    };
  }

  if (f.type === 'select') {
    const all = a.candidates ?? optionsFor(f, a.options);
    if (all.length === 0) {
      return {
        items: skip.length
          ? [{ type: 'interactive', interactive: { type: 'buttons', body, buttons: skip } }]
          : [{ type: 'text', text: body }],
        choices: null,
      };
    }
    // ≤3 en total → botones.
    if (all.length + skip.length <= 3) {
      const buttons: InteractiveButton[] = all.map((o, i) => ({ id: cbId(token, `o${i}`), title: cut(o.title, MAX_BUTTON_TITLE) }));
      return {
        items: [{ type: 'interactive', interactive: { type: 'buttons', body, buttons: [...buttons, ...skip] } }],
        choices: { field: f.key, ids: all.map(o => o.id) },
      };
    }
    // Lista: hasta 10 filas. Si no entran, las primeras + "Otro (escribilo)":
    // el texto libre se matchea contra la lista COMPLETA.
    const reserved = skip.length + (all.length + skip.length > MAX_LIST_ROWS ? 1 : 0);
    const shown = all.slice(0, MAX_LIST_ROWS - reserved);
    const rows: InteractiveListRow[] = shown.map((o, i) => ({
      id: cbId(token, `o${i}`),
      title: cut(o.title, MAX_ROW_TITLE),
      ...(o.title.length > MAX_ROW_TITLE ? { description: cut(o.title, MAX_ROW_DESC) } : {}),
    }));
    if (shown.length < all.length) rows.push({ id: cbId(token, 'other'), title: '✍️ Otro (escribilo)' });
    if (skip.length) rows.push({ id: cbId(token, 'skip'), title: '⏭️ Omitir' });
    return {
      items: [{
        type: 'interactive',
        interactive: { type: 'list', body, buttonText: 'Elegir', sections: [{ title: cut(f.label, MAX_ROW_TITLE), rows }] },
      }],
      choices: { field: f.key, ids: shown.map(o => o.id) },
    };
  }

  return {
    items: skip.length
      ? [{ type: 'interactive', interactive: { type: 'buttons', body, buttons: skip } }]
      : [{ type: 'text', text: body }],
    choices: null,
  };
}

export interface SummaryArgs {
  def: FormDefinition;
  pres: FormPresentation;
  values: Record<string, unknown>;
  options: FormOptions;
  token: string;
  todayISO: string;
  notes?: string[];
}

/** Resumen antes de guardar: [✅ Confirmar][✏️ Editar][❌ Cancelar]. */
export function renderSummary(a: SummaryArgs): BotResponseItem[] {
  const { def, pres, values, options, todayISO } = a;
  const lines: string[] = [...(a.notes ?? [])];
  if (lines.length) lines.push('');
  lines.push(`Revisemos ${pres.noun}:`, '');
  const missingOptional: string[] = [];
  for (const f of summaryFields(def)) {
    const txt = formatFieldValue(f, values, options, todayISO);
    if (txt) lines.push(`${pres.fields[f.key]?.emoji ?? '•'} *${f.label}:* ${txt}`);
    else if (!f.required && f.key !== 'yield_kg' && f.key !== 'currency') missingOptional.push(f.label.toLowerCase());
  }
  lines.push('', '¿Está todo correcto?');
  if (missingOptional.length) {
    lines.push(`_Para sumar ${missingOptional.slice(0, 3).join(', ')}, tocá ✏️ Editar._`);
  }
  return [{
    type: 'interactive',
    interactive: {
      type: 'buttons',
      body: lines.join('\n'),
      buttons: [
        { id: cbId(a.token, 'ok'), title: '✅ Confirmar' },
        { id: cbId(a.token, 'edit'), title: '✏️ Editar' },
        { id: cbId(a.token, 'cancel'), title: '❌ Cancelar' },
      ],
    },
  }];
}

/** Menú "¿Qué querés cambiar?" — un campo por fila con su valor actual. */
export function renderEditMenu(a: SummaryArgs): BotResponseItem[] {
  const rows: InteractiveListRow[] = [];
  a.def.fields.forEach((f, i) => {
    if (f.key === 'unit' && a.def.fields.some(x => x.key === 'quantity')) return;
    if (rows.length >= MAX_LIST_ROWS) return;
    const txt = formatFieldValue(f, a.values, a.options, a.todayISO);
    rows.push({
      id: cbId(a.token, `e${i}`),
      title: cut(`${a.pres.fields[f.key]?.emoji ?? ''} ${f.label}`.trim(), MAX_ROW_TITLE),
      description: cut(txt ?? (f.required ? '(falta)' : '(vacío — opcional)'), MAX_ROW_DESC),
    });
  });
  return [{
    type: 'interactive',
    interactive: {
      type: 'list',
      body: '✏️ ¿Qué querés cambiar? Elegí el dato o escribí la corrección (ej: *el monto era 300 mil*).',
      buttonText: 'Elegir dato',
      sections: [{ title: 'Datos', rows }],
    },
  }];
}
