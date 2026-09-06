// Opciones dinámicas de los formularios, compartidas por el render web
// (GET /api/forms/:token) y el envío de Flows por WhatsApp — así el Flow
// endpointless hornea las MISMAS opciones que ve la Mini App. Nunca duplicar.
//
// Cada `FormOptionSource` se resuelve acá y solo si el formulario lo usa.
// Los ids de ubicación llevan prefijo de tipo (`p:` lote, `f:` campo entero,
// `c:` corral) porque un mismo select mezcla entidades distintas; los
// resuelve form-submit con scoping por usuario.
import { KNOWN_CROPS } from '../utils/crops.js';
import { getUserFields, getPlotsByField, getAllActiveCrops } from '../services/expenses.js';
import { CategoryRepository } from '../domain/financial/category.repository.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../constants/agro-terms.js';
import { FeedlotRepository } from '../domain/feedlot/feedlot.repository.js';
import { LIVESTOCK_CATEGORIES, LIVESTOCK_CATEGORY_LABEL } from '../domain/livestock/livestock.types.js';
import { BREED_CATALOG } from '../utils/livestock-breeds.js';
import { FORM_DEFINITIONS, type FormAction, type FormOption, type FormOptionSource } from './form-definitions.js';

export interface FormPlotOption {
  id: number;
  name: string;
  fieldId: number;
  fieldName: string;
  activeCrop: string | null;
}
export interface FormFieldOption { id: number; name: string }
export interface FormCorralOption { id: number; name: string; feedlotName: string }

export interface FormOptions {
  plots: FormPlotOption[];
  fields: FormFieldOption[];
  corrals: FormCorralOption[];
  crops: string[];
  /** Opciones listas para un select, por fuente. Solo las que el form usa. */
  lists: Partial<Record<FormOptionSource, FormOption[]>>;
}

export const plotOptionId = (plotId: number): string => `p:${plotId}`;
export const fieldOptionId = (fieldId: number): string => `f:${fieldId}`;
export const corralOptionId = (corralId: number): string => `c:${corralId}`;

/** Desarma un id de ubicación (`p:12` → {kind:'plot', id:12}). null si no es válido. */
export function parseLocationId(raw: unknown): { kind: 'plot' | 'field' | 'corral'; id: number } | null {
  if (typeof raw !== 'string') return null;
  const m = /^([pfc]):(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const kind = m[1] === 'p' ? 'plot' : m[1] === 'f' ? 'field' : 'corral';
  return { kind, id: Number(m[2]) };
}

export async function computeFormOptions(
  action: FormAction,
  userId: number,
): Promise<FormOptions> {
  const def = FORM_DEFINITIONS[action];
  const sources = new Set<FormOptionSource>();
  for (const f of def.fields) {
    if (f.optionsSource) sources.add(f.optionsSource);
    for (const sub of f.fields ?? []) if (sub.optionsSource) sources.add(sub.optionsSource);
  }

  const fieldsRaw = (await getUserFields(userId)) as Array<{ id: number; name: string }>;
  const fields: FormFieldOption[] = fieldsRaw.map(f => ({ id: f.id, name: f.name }));
  const actives = (await getAllActiveCrops(userId)) as Array<{ plot_id: number; crop: string }>;
  const activeByPlot = new Map(actives.map(a => [a.plot_id, a.crop]));
  const allPlots: FormPlotOption[] = [];
  for (const f of fields) {
    for (const p of (await getPlotsByField(f.id)) as Array<{ id: number; name: string }>) {
      allPlots.push({ id: p.id, name: p.name, fieldId: f.id, fieldName: f.name, activeCrop: activeByPlot.get(p.id) ?? null });
    }
  }
  const plots = def.plotFilter === 'withActiveCrop' ? allPlots.filter(p => p.activeCrop) : allPlots;

  let corrals: FormCorralOption[] = [];
  if (sources.has('livestock_locations')) {
    const rows = await new FeedlotRepository().listCorralsByUser(userId);
    corrals = rows.map(c => ({ id: c.id, name: c.name, feedlotName: c.feedlot_name ?? '' }));
  }

  const lists: FormOptions['lists'] = {};
  const plotTitle = (p: FormPlotOption) => `${p.name} (${p.fieldName})${p.activeCrop ? ` · ${p.activeCrop}` : ''}`;
  if (sources.has('plots')) lists.plots = plots.map(p => ({ id: String(p.id), title: plotTitle(p) }));
  if (sources.has('crops')) lists.crops = KNOWN_CROPS.map(c => ({ id: c, title: c }));
  if (sources.has('locations')) {
    lists.locations = [
      ...plots.map(p => ({ id: plotOptionId(p.id), title: plotTitle(p) })),
      ...fields.map(f => ({ id: fieldOptionId(f.id), title: `Todo el campo ${f.name}` })),
    ];
  }
  if (sources.has('livestock_locations')) {
    lists.livestock_locations = [
      ...plots.map(p => ({ id: plotOptionId(p.id), title: `${p.name} (${p.fieldName})` })),
      ...corrals.map(c => ({ id: corralOptionId(c.id), title: `Corral ${c.name}${c.feedlotName ? ` (${c.feedlotName})` : ''}` })),
    ];
  }
  if (sources.has('expense_categories') || sources.has('income_categories')) {
    const kind = sources.has('expense_categories') ? 'expense' : 'income';
    const repo = new CategoryRepository();
    const own = await repo.listActive(userId, kind);
    const names = own.length > 0 ? own.map(c => c.name) : [...(kind === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES)];
    lists[kind === 'expense' ? 'expense_categories' : 'income_categories'] = names.map(n => ({ id: n, title: n }));
  }
  if (sources.has('livestock_categories')) {
    lists.livestock_categories = LIVESTOCK_CATEGORIES.map(c => ({ id: c, title: LIVESTOCK_CATEGORY_LABEL[c] ?? c }));
  }
  if (sources.has('breeds')) {
    lists.breeds = [...BREED_CATALOG].sort((a, b) => a.sortOrder - b.sortOrder).map(b => ({ id: b.name, title: b.name }));
  }

  return { plots, fields, corrals, crops: [...KNOWN_CROPS], lists };
}
