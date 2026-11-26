/**
 * Cuerpo del PATCH /expenses/:id del modal de edición.
 *
 * Producto, cantidad, unidad y precio por unidad se mandan SIEMPRE con lo que
 * hay en el formulario (que arranca con los valores guardados), sin importar el
 * tipo de gasto. Antes, si el tipo no era "insumo" se mandaban en `null`: un
 * gasto "flete 30 tn a 20 mil la tonelada" (tipo varios) perdía cantidad y
 * precio por unidad con solo cambiarle la fecha (auditoría de datos, nov 2026).
 */
import { parseNumberAR } from './parse-number';

export interface ExpenseFormState {
  description: string;
  amount: number;
  currency: string;
  category: string;
  expenseDate: string;
  expenseType: string;
  product: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  plotId: string;
  initialPlotId: string;
}

const numOrNull = (v: string): number | null => parseNumberAR(v);

export function buildExpensePatch(s: ExpenseFormState): Record<string, unknown> {
  return {
    description: s.description.trim() || null,
    amount: s.amount,
    currency: s.currency,
    category: s.category,
    expense_date: s.expenseDate,
    expense_type: s.expenseType,
    product: s.product.trim() || null,
    quantity: numOrNull(s.quantity),
    unit: s.unit.trim() || null,
    unit_price: numOrNull(s.unitPrice),
    ...(s.plotId !== s.initialPlotId ? { plot_id: s.plotId ? Number(s.plotId) : null } : {}),
  };
}
