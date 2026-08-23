/**
 * Expense categories that belong to the CAMPO, not to a lote.
 *
 * `financial.handler.ts` uses this to strip an auto-resolved plot from a
 * corporate-overhead expense when the user gave no plot signal (see
 * utils/plot-intent.ts for the "unless they explicitly named one" half).
 *
 * `review-findings.service.ts` needs the SAME set for the opposite reason: an
 * expense left at field level BY THIS RULE is correct and must never be reported
 * to the user as "te olvidaste el lote". Two copies of this list would drift and
 * the Resumen would start flagging its own deliberate behaviour — so it lives
 * here once (invariante 3).
 */
export const FIELD_LEVEL_CATEGORIES: ReadonlySet<string> = new Set([
  'sueldos', 'arrendamiento', 'alquiler', 'servicios', 'impuestos',
  'contabilidad', 'administración', 'administracion', 'gastos generales',
]);

export function isFieldLevelCategory(category: string | null | undefined): boolean {
  return FIELD_LEVEL_CATEGORIES.has(String(category ?? '').toLowerCase().trim());
}
