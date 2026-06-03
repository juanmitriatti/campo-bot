import { normalizarMonto } from '../../utils/parser.js';
import { formatMoney } from '../../utils/format-money.js';
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
            ...cats.map(c => ({ id: 'flow_cat_' + c.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '_'), title: c.name })),
            { id: 'flow_cat_new', title: NEW_CATEGORY_BUTTON_TITLE },
          ],
        }],
      };
    },
    validateAsync: async (input, _data, userId) => {
      const trimmed = input.trim();
      if (!trimmed) return { error: 'Decime la categoría o tocá una de la lista.' };
      // Match special sentinels first: 'new' (suffix of flow_cat_new) or the button title literal
      if (trimmed.toLowerCase() === 'new' || trimmed.toLowerCase() === NEW_CATEGORY_BUTTON_TITLE.toLowerCase()) {
        return { value: NEW_CATEGORY_SENTINEL };
      }
      // The controller may pass the slug of the button id when the user tapped a list row.
      // Try to find by slug match against active categories.
      const all = await categoryRepo.listActive(userId, 'expense');
      const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '_');
      const bySlug = all.find(c => norm(c.name) === trimmed.toLowerCase());
      if (bySlug) return { value: bySlug.name };
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
    prompt: '¿En qué lote? (escribí *campo* o tocá Confirmar para registrarlo a nivel de campo)',
    promptAsync: async (_data, userId) => {
      const plots = await entityValidator.getUserPlotsWithFields(userId);
      return buildPlotPromptGrouped(plots) + '\n\n_Tocá Confirmar para registrarlo a nivel de campo (sin lote)._';
    },
    interactiveAsync: async (_data, userId) => {
      const plots = await entityValidator.getUserPlotsWithFields(userId);
      return buildPlotInteractiveGrouped(plots);
    },
    validate: (input) => {
      return { value: input.trim() };
    },
    validateAsync: validatePlotAsync,
    optional: true,
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
    const finalCategory = data.category === NEW_CATEGORY_SENTINEL
      ? (data.categoryNewName as string)
      : (data.category as string);
    let msg = '\ud83d\udcb8 *Confirmar gasto:*\n\n';
    msg += `Monto: *${formatMoney(Number(amountInfo.amount), amountInfo.currency)}*\n`;
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

    // Similarity check (only when creating a brand new one — i.e., user took the
    // "+ Crear nueva" path or typed free text not in the catalog).
    const isFreshCreate = data.category === NEW_CATEGORY_SENTINEL
      || !(await categoryRepo.findByName(userId, 'expense', finalCategory));
    if (isFreshCreate) {
      const similar = await categoryService.findSimilar(userId, 'expense', finalCategory);
      if (similar) {
        const { encodePendingExpensePayload } = await import('../../domain/financial/financial.handler.js');
        const payload = encodePendingExpensePayload({
          data: {
            type: 'expense',
            amount: amountInfo.amount,
            currency: amountInfo.currency as 'ARS' | 'USD',
            description: (data.description as string) || '',
            category: finalCategory,
            expenseDate: (data.expenseDate as string) ?? null,
            expenseType: (data.expenseType as 'insumo' | 'varios') ?? null,
            product: (data.product as string) ?? null,
            quantity: (data.quantity as number) ?? null,
            unit: (data.unit as string) ?? null,
          },
          fieldId,
          plotId,
        });
        return {
          messages: [],
          interactive: {
            type: 'buttons' as const,
            body: `Ya tenés una categoría parecida: *${similar.name}*.\n¿Usás esa o creás *${finalCategory}* como nueva?`,
            buttons: [
              { id: `cat_sim_use_exp_${payload}_${similar.id}`, title: `Usar ${similar.name}` },
              { id: `cat_sim_new_exp_${payload}_${encodeURIComponent(finalCategory)}`, title: `Crear ${finalCategory}` },
              { id: 'cat_sim_cancel', title: 'Cancelar' },
            ],
          },
        };
      }
    }

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

    let msg = '\u2705 Gasto registrado\n';
    msg += `${data.category}\n`;
    msg += `${formatMoney(Number(amountInfo.amount), amountInfo.currency)}`;
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
