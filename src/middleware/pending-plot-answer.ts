// Qué quiso decir el usuario cuando contesta "¿en qué lote?". Se resuelve ANTES
// de re-rutear: con "tres bonetes" (un CAMPO de un solo lote) el alta de
// hacienda fallaba con ❌ y se perdía (prod, nov 2026).
import { findAllUserPlots } from '../services/expenses.js';
import { compactEntityName, findEquivalentName, uniqueNearName, stripLeadingArticle } from '../utils/entity-matcher.js';

export type PlotAnswer =
  | { kind: 'plot' }
  | { kind: 'field'; field: string; plots: string[] }
  | { kind: 'unknown' };

export async function classifyPlotAnswer(userId: number, value: string): Promise<PlotAnswer> {
  // "corral 2" lo resuelve el camino de hacienda.
  if (/^(?:al?\s+|en\s+(?:el\s+)?)?corral\b/i.test(value)) return { kind: 'plot' };
  const plots = (await findAllUserPlots(userId as never)) as Array<{ name: string; field_name: string }>;
  const names = plots.map(p => p.name);
  const wanted = [value, stripLeadingArticle(value)].map(compactEntityName);
  if (names.some(n => wanted.includes(compactEntityName(n)))) return { kind: 'plot' };

  // Un CAMPO nombrado entero gana sobre el parecido con algún lote.
  // El procesador le saca el artículo a la respuesta ("la barrida" → "barrida").
  const field = plots.find(p => [p.field_name, stripLeadingArticle(p.field_name)]
    .some(n => wanted.includes(compactEntityName(n))))?.field_name;
  if (field) return { kind: 'field', field, plots: plots.filter(p => p.field_name === field).map(p => p.name) };

  if (findEquivalentName(value, names) || uniqueNearName(value, names)) return { kind: 'plot' };
  return { kind: 'unknown' };
}

/** ¿La respuesta a "¿qué cultivo?" es en realidad un campo o un lote del usuario? */
export async function isOwnPlaceName(userId: number, value: string): Promise<boolean> {
  const plots = (await findAllUserPlots(userId as never)) as Array<{ name: string; field_name: string }>;
  const key = (s: string) => compactEntityName(stripLeadingArticle(s));
  const wanted = key(value);
  return plots.some(p => key(p.name) === wanted || key(p.field_name) === wanted);
}
