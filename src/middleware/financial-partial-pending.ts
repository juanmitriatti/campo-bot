/**
 * Build a slot-extractor pending for income_partial / expense_partial intents.
 *
 * Previously these intents kicked off the rigid `income_flow` / `expense_flow`
 * state machines, which only accept the slot at the current step. If the user
 * answered out of order (e.g. provided the plot when the flow asked for the
 * amount), the flow either rejected the input or escaped entirely — Juan,
 * 2026-05-28: "Vendi algo" → "10tn de soja" → "Lote a2" → flow escaped,
 * routed to `plot_info`, income never saved.
 *
 * The fix uses the unified slot-extractor pending mechanism (same one used
 * by fumigación / fertilización / etc.). It accepts ANY missing slot in any
 * order; when all required slots are filled the system routes to the real
 * `log_income` / `log_expense` handler.
 */

import type { ParsedIncome, ParsedExpense } from '../types/index.js';

interface PartialPendingPlan {
  command: 'log_income' | 'log_expense';
  data: Record<string, unknown>;
  missing: string[];
  askPrompt: string;
}

function buildIncomeAsk(missing: string[]): string {
  // Specific prompts when only one thing is missing — friendlier UX
  if (missing.length === 1) {
    switch (missing[0]) {
      case 'amount': return '💰 ¿Cuánto fue? (ej: 500000, 1.5M, USD 3000)';
      case 'unit_price': return '💰 ¿A qué precio? (ej: a 380 mil la tonelada, a 550 USD c/u)';
      case 'category': return '💰 ¿De qué fue el ingreso? (ej: cosecha, venta de soja, arrendamiento)';
      case 'plot': return '📍 ¿En qué lote?';
      case 'field': return '📍 ¿En qué campo?';
      case 'quantity': return '📦 ¿Qué cantidad? (ej: 10 tn, 500 kg)';
    }
  }
  // Multi-slot ask — list them in one prompt (slot-extractor accepts any order)
  const parts: string[] = [];
  if (missing.includes('quantity')) parts.push('cantidad (ej: 10 tn)');
  if (missing.includes('unit_price') || missing.includes('amount')) {
    parts.push('precio (ej: a 380 mil la tn) o monto total');
  }
  if (missing.includes('category')) parts.push('qué fue (ej: venta de soja, cosecha)');
  if (missing.includes('plot')) parts.push('lote');
  return `💰 Me falta info del ingreso: ${parts.join(', ')}.`;
}

function buildExpenseAsk(missing: string[]): string {
  if (missing.length === 1) {
    switch (missing[0]) {
      case 'amount': return '💸 ¿Cuánto fue? (ej: 50000, 1.5M, USD 200)';
      case 'category': return '💸 ¿En qué fue el gasto? (ej: gasoil, sueldos, fertilizante)';
      case 'plot': return '📍 ¿En qué lote?';
      case 'field': return '📍 ¿En qué campo?';
      case 'quantity': return '📦 ¿Qué cantidad? (ej: 10 lt, 500 kg)';
    }
  }
  const parts: string[] = [];
  if (missing.includes('amount')) parts.push('monto');
  if (missing.includes('category')) parts.push('en qué fue (ej: gasoil, sueldos)');
  if (missing.includes('plot')) parts.push('lote');
  return `💸 Me falta info del gasto: ${parts.join(', ')}.`;
}

/**
 * Plan the pending for a partial income intent. Returns the command, the
 * data we have, the missing slots, and the ask prompt. Returns null when
 * the partial is actually complete enough to proceed (rare — caller would
 * normally not call this when complete).
 */
export function planIncomePartialPending(data: ParsedIncome & Record<string, unknown>): PartialPendingPlan {
  const missing: string[] = [];
  const hasAmount = typeof data.amount === 'number' && data.amount > 0;
  const hasQty = typeof data.quantity === 'number' && data.quantity > 0;
  const hasUnitPrice = typeof data.unit_price === 'number' && data.unit_price > 0;
  // Required: either total amount OR (quantity + unit_price) so we can compute.
  if (!hasAmount && !(hasQty && hasUnitPrice)) {
    if (!hasUnitPrice && hasQty) missing.push('unit_price');
    else if (!hasQty && hasUnitPrice) missing.push('quantity');
    else missing.push('amount');
  }
  if (!data.category) missing.push('category');
  // Plot/field is OPTIONAL for incomes (some sales are field-level / no lot)
  // — we don't add it to missing by default.
  return {
    command: 'log_income',
    data: { ...data, command: 'log_income' },
    missing,
    askPrompt: buildIncomeAsk(missing),
  };
}

export function planExpensePartialPending(data: ParsedExpense & Record<string, unknown>): PartialPendingPlan {
  const missing: string[] = [];
  if (!(typeof data.amount === 'number' && data.amount > 0)) {
    // Allow quantity + unit_price as alternative (mapper computes total)
    if (!(typeof data.quantity === 'number' && data.quantity > 0
       && typeof data.unit_price === 'number' && data.unit_price > 0)) {
      missing.push('amount');
    }
  }
  if (!data.category) missing.push('category');
  return {
    command: 'log_expense',
    data: { ...data, command: 'log_expense' },
    missing,
    askPrompt: buildExpenseAsk(missing),
  };
}
