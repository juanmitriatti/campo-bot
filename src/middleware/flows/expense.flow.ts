import { normalizarMonto } from '../../utils/parser.js';
import { FinancialService } from '../../domain/financial/financial.service.js';
import { FinancialRepository } from '../../domain/financial/financial.repository.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { buildPlotPromptGrouped, buildPlotInteractiveGrouped, validatePlotAsync } from './field-step-helpers.js';
import { EntityValidator } from '../../services/entity-validator.js';
import { CategoryRepository } from '../../domain/financial/category.repository.js';
import { CategoryService } from '../../domain/financial/category.service.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import { logError } from '../../services/error-logger.js';
import type { UserId, ParsedExpense, InteractiveMessage } from '../../types/index.js';

const entityValidator = new EntityValidator();

const NEW_CATEGORY_SENTINEL = '__NEW_CATEGORY__';
const NEW_CATEGORY_BUTTON_TITLE = '+ Crear nueva';

const categoryRepo = new CategoryRepository();
const categoryService = new CategoryService(categoryRepo);

const financialService = new FinancialService(new FinancialRepository());

const steps: FlowStep[] = [
  {
    field: 'amount',
    prompt: '¿Cuánto gastaste? (ej: 50000, 50mil, 200 dólares)',
    validate: (input) => {
      const amount = normalizarMonto(input);
      if (!amount || amount <= 0) return { error: 'No entendí el monto. Probá con un número, ej: 50000 o 50mil' };
      const isUsd = /d[oó]lar|usd/i.test(input);
      return { value: { amount, currency: isUsd ? 'USD' : 'ARS' } };
    },
  },
  {
    field: 'category',
    prompt: '¿En qué categoría?',
    interactiveAsync: async (_data, userId) => {
      await categoryService.bootstrapDefaults(userId, 'expense');
      const cats = await categoryRepo.listActive(userId, 'expense');
      return {
        type: 'list',
        body: '¿En qué categoría?',
        buttonText: 'Ver categorías',
        sections: [{
          title: 'Categorías',
          rows: [
            ...cats.map(c => ({ id: `flow_cat_${c.id}`, title: c.name })),
            { id: 'flow_cat_new', title: NEW_CATEGORY_BUTTON_TITLE },
          ],
        }],
      };
    },
    validateAsync: async (input, _data, userId) => {
      const trimmed = input.trim();
      if (!trimmed) return { error: 'Decime la categoría o tocá una de la lista.' };
      if (trimmed.toLowerCase() === NEW_CATEGORY_BUTTON_TITLE.toLowerCase()) {
        return { value: NEW_CATEGORY_SENTINEL };
      }
      const existing = await categoryRepo.findByName(userId, 'expense', trimmed);
      if (existing) return { value: existing.name };
      if (trimmed.length > 60) return { error: 'El nombre es muy largo (máx 60 caracteres).' };
      return { value: trimmed };
    },
    validate: () => ({ value: '' }), // sync fallback unused; validateAsync above takes over
  },
  {
    field: 'categoryNewName',
    prompt: '¿Cómo se llama la nueva categoría?',
    skipIf: (data) => data.category !== NEW_CATEGORY_SENTINEL,
    validate: (input) => {
      const trimmed = input.trim();
      if (!trimmed) return { error: 'No puede estar vacío.' };
      if (trimmed.length > 60) return { error: 'Demasiado largo (máx 60 caracteres).' };
      return { value: trimmed };
    },
  },
  {
    field: 'plotName',
    prompt: '¿En qué lote?',
    promptAsync: async (_data, userId) => {
      const plots = await entityValidator.getUserPlotsWithFields(userId);
      return buildPlotPromptGrouped(plots);
    },
    interactiveAsync: async (_data, userId) => {
      const plots = await entityValidator.getUserPlotsWithFields(userId);
      return buildPlotInteractiveGrouped(plots);
    },
    validate: (input) => {
      return { value: input.trim() };
    },
    validateAsync: validatePlotAsync,
  },
  {
    field: 'description',
    prompt: '¿Algún detalle? (opcional, podés saltar)',
    interactive: {
      type: 'buttons',
      body: '¿Algún detalle?',
      buttons: [{ id: 'flow_skip', title: 'Saltar' }],
    },
    validate: (input) => ({ value: input.trim() }),
    optional: true,
  },
];

export const expenseFlow: FlowDefinition = {
  id: 'expense_flow',
  name: 'Nuevo Gasto',
  steps,

  buildConfirmation(data) {
    const amountInfo = data.amount as { amount: number; currency: string };
    const currency = amountInfo.currency === 'USD' ? ' USD' : '';
    const finalCategory = data.category === NEW_CATEGORY_SENTINEL
      ? (data.categoryNewName as string)
      : (data.category as string);
    let msg = '\ud83d\udcb8 *Confirmar gasto:*\n\n';
    msg += `Monto: *$${Number(amountInfo.amount).toLocaleString('es-AR')}${currency}*\n`;
    msg += `Categoría: *${finalCategory}*\n`;
    if (data.plotName) msg += `Lote: *${data.plotName}*\n`;
    if (data.description) msg += `Detalle: ${data.description}\n`;
    msg += '\n¿Confirmamos?';

    return {
      messages: [msg],
      interactive: {
        type: 'buttons',
        body: '¿Confirmamos el gasto?',
        buttons: [
          { id: 'flow_confirm', title: 'Confirmar' },
          { id: 'flow_cancel', title: 'Cancelar' },
          { id: 'flow_back', title: 'Volver' },
        ],
      },
    };
  },

  async execute(userId, data) {
    const amountInfo = data.amount as { amount: number; currency: string };
    const plotName = data.plotName as string | null;

    let fieldId: number | null = null;
    let plotId: number | null = null;
    let resolvedPlotName: string | null = plotName;
    let resolvedFieldName: string | null = null;

    if (plotName) {
      const plots = await financialService.findPlotByNameAcrossFields(userId, plotName);
      if (plots.length === 1) {
        plotId = plots[0].id;
        fieldId = plots[0].field_id;
        resolvedPlotName = plots[0].name;
        resolvedFieldName = plots[0].field_name;
      } else if (plots.length > 1) {
        // Disambiguate using field hint from validation step
        const fieldHint = data._resolvedFieldHint as string | undefined;
        const match = fieldHint
          ? plots.find(p => p.field_name.toLowerCase() === fieldHint.toLowerCase())
          : null;
        const selected = match || plots[0];
        plotId = selected.id;
        fieldId = selected.field_id;
        resolvedPlotName = selected.name;
        resolvedFieldName = selected.field_name;
      }
    }

    const finalCategory = data.category === NEW_CATEGORY_SENTINEL
      ? (data.categoryNewName as string)
      : (data.category as string);
    // Ensure the category exists in user_categories + bump usage
    try {
      const res = await categoryService.match(userId, 'expense', finalCategory, 'new');
      if (res.kind === 'matched') {
        await categoryService.bump(res.category.id);
      }
    } catch (catErr) {
      logError('expense-flow', 'CAT_PERSIST', catErr as Error);
    }
    const expenseData: ParsedExpense = {
      type: 'expense',
      amount: amountInfo.amount,
      category: finalCategory,
      description: (data.description as string) || '',
      currency: amountInfo.currency as 'ARS' | 'USD',
      ...(data.expenseDate ? { expenseDate: data.expenseDate as string } : {}),
      ...(data.expenseType ? { expenseType: data.expenseType as 'insumo' | 'varios' } : {}),
      ...(data.product ? { product: data.product as string } : {}),
      ...(data.quantity ? { quantity: data.quantity as number } : {}),
      ...(data.unit ? { unit: data.unit as string } : {}),
    };

    const saved = await financialService.saveExpense(userId, expenseData, fieldId, plotId);

    const currency = amountInfo.currency === 'USD' ? ' USD' : '';
    let msg = '\u2705 Gasto registrado\n';
    msg += `${data.category}\n`;
    msg += `$${Number(amountInfo.amount).toLocaleString('es-AR')}${currency}`;
    if (resolvedPlotName && resolvedFieldName) {
      msg += `\n\ud83d\udccd Lote ${resolvedPlotName} (${resolvedFieldName})`;
    } else if (resolvedPlotName) {
      msg += `\n\ud83d\udccd Lote ${resolvedPlotName}`;
    }

    // Suggest stock entry for insumo expenses
    if (expenseData.expenseType === 'insumo' && expenseData.product && expenseData.quantity && expenseData.unit && fieldId) {
      try {
        const { StockPurchaseService } = await import('../../domain/stock/stock-purchase.service.js');
        const purchaseService = new StockPurchaseService();
        const suggestion = await purchaseService.suggestStockEntry(
          userId, saved.id, expenseData.product, expenseData.quantity, expenseData.unit, fieldId,
        );
        if (suggestion) {
          msg += `\n\n📦 ¿Querés cargar *${expenseData.quantity}${expenseData.unit} de ${expenseData.product}* al stock del Depósito ${suggestion.warehouseName}?`;
          return {
            messages: [],
            interactive: {
              type: 'buttons' as const,
              body: msg,
              buttons: [
                { id: `stock_entry_yes_${saved.id}`, title: 'Sí, cargar' },
                { id: `stock_entry_no_${saved.id}`, title: 'No' },
              ],
            },
            sideEffects: {
              setPendingStockEntry: suggestion,
            },
          };
        }
      } catch (stockErr) {
        console.error('[expense-flow] Stock suggestion failed:', stockErr);
        logError('expense-flow', 'STOCK_SUGGEST', stockErr as Error);
      }
    }

    const suggestions = getSuggestions('expense_saved');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
