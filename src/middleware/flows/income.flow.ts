import { normalizarMonto } from '../../utils/parser.js';
import { FinancialService } from '../../domain/financial/financial.service.js';
import { FinancialRepository } from '../../domain/financial/financial.repository.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { buildPlotPromptGrouped, buildPlotInteractiveGrouped, validatePlotAsync } from './field-step-helpers.js';
import { EntityValidator } from '../../services/entity-validator.js';
import { CategoryRepository } from '../../domain/financial/category.repository.js';
import { CategoryService } from '../../domain/financial/category.service.js';
import { logError } from '../../services/error-logger.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId, ParsedIncome, InteractiveMessage } from '../../types/index.js';

const entityValidator = new EntityValidator();

const NEW_CATEGORY_SENTINEL = '__NEW_CATEGORY__';
const NEW_CATEGORY_BUTTON_TITLE = '+ Crear nueva';

const categoryRepo = new CategoryRepository();
const categoryService = new CategoryService(categoryRepo);

const financialService = new FinancialService(new FinancialRepository());

const steps: FlowStep[] = [
  {
    field: 'amount',
    prompt: '¿Cuánto fue? (ej: 500000, 1.5M, 1 palo y medio, USD 3000)',
    validate: (input) => {
      const amount = normalizarMonto(input);
      if (!amount || amount <= 0) return { error: 'No entendí el monto. Probá con un número, ej: 500000 o 1.5 palos' };
      const isUsd = /d[oó]lar|usd/i.test(input);
      return { value: { amount, currency: isUsd ? 'USD' : 'ARS' } };
    },
  },
  {
    field: 'category',
    prompt: '¿De qué es el ingreso?',
    interactiveAsync: async (_data, userId) => {
      await categoryService.bootstrapDefaults(userId, 'income');
      const cats = await categoryRepo.listActive(userId, 'income');
      return {
        type: 'list',
        body: '¿De qué es el ingreso?',
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
    validate: () => ({ value: '' }), // sync fallback unused; validateAsync below takes over
    validateAsync: async (input, _data, userId) => {
      const trimmed = input.trim();
      if (!trimmed) return { error: 'Decime la categoría o tocá una de la lista.' };
      // Match special sentinels first: 'new' (suffix of flow_cat_new) or the button title literal
      if (trimmed.toLowerCase() === 'new' || trimmed.toLowerCase() === NEW_CATEGORY_BUTTON_TITLE.toLowerCase()) {
        return { value: NEW_CATEGORY_SENTINEL };
      }
      // The controller may pass the slug of the button id when the user tapped a list row.
      // Try to find by slug match against active categories.
      const all = await categoryRepo.listActive(userId, 'income');
      const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '_');
      const bySlug = all.find(c => norm(c.name) === trimmed.toLowerCase());
      if (bySlug) return { value: bySlug.name };
      const existing = await categoryRepo.findByName(userId, 'income', trimmed);
      if (existing) return { value: existing.name };
      if (trimmed.length > 60) return { error: 'El nombre es muy largo (máx 60 caracteres).' };
      return { value: trimmed };
    },
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
    field: 'quantity',
    prompt: '¿Cuántas toneladas? (opcional, podés saltar)',
    interactive: {
      type: 'buttons',
      body: '¿Cuántas toneladas?',
      buttons: [{ id: 'flow_skip', title: 'Saltar' }],
    },
    validate: (input) => {
      const num = parseFloat(input.replace(/,/g, '.'));
      if (isNaN(num) || num <= 0) return { error: 'Ingresá un número válido de toneladas.' };
      return { value: num };
    },
    optional: true,
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

export const incomeFlow: FlowDefinition = {
  id: 'income_flow',
  name: 'Nuevo Ingreso',
  steps,

  buildConfirmation(data) {
    const amountInfo = data.amount as { amount: number; currency: string };
    const currency = amountInfo.currency === 'USD' ? ' USD' : '';
    const finalCategory = data.category === NEW_CATEGORY_SENTINEL
      ? (data.categoryNewName as string)
      : (data.category as string);
    let msg = '\ud83d\udcb0 *Confirmar ingreso:*\n\n';
    msg += `Monto: *$${Number(amountInfo.amount).toLocaleString('es-AR')}${currency}*\n`;
    msg += `Categoría: *${finalCategory}*\n`;
    if (data.quantity) msg += `Cantidad: *${data.quantity} tn*\n`;
    if (data.plotName) msg += `Lote: *${data.plotName}*\n`;
    if (data.description) msg += `Detalle: ${data.description}\n`;
    msg += '\n¿Confirmamos?';

    return {
      messages: [msg],
      interactive: {
        type: 'buttons',
        body: '¿Confirmamos el ingreso?',
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
    const quantity = data.quantity as number | null;

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
      || !(await categoryRepo.findByName(userId, 'income', finalCategory));
    if (isFreshCreate) {
      const similar = await categoryService.findSimilar(userId, 'income', finalCategory);
      if (similar) {
        const { encodePendingIncomePayload } = await import('../../domain/financial/financial.handler.js');
        const payload = encodePendingIncomePayload({
          data: {
            type: 'income',
            amount: amountInfo.amount,
            currency: amountInfo.currency as 'ARS' | 'USD',
            description: (data.description as string) || '',
            category: finalCategory,
            incomeDate: (data.incomeDate as string) ?? null,
            quantity: quantity,
            unit: quantity ? 'tn' : null,
            unit_price: quantity ? Math.round(amountInfo.amount / quantity) : null,
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
              { id: `cat_sim_use_inc_${payload}_${similar.id}`, title: `Usar ${similar.name}` },
              { id: `cat_sim_new_inc_${payload}_${encodeURIComponent(finalCategory)}`, title: `Crear ${finalCategory}` },
              { id: 'cat_sim_cancel', title: 'Cancelar' },
            ],
          },
        };
      }
    }

    try {
      const res = await categoryService.match(userId, 'income', finalCategory, 'new');
      if (res.kind === 'matched') {
        await categoryService.bump(res.category.id);
      }
    } catch (catErr) {
      logError('income-flow', 'CAT_PERSIST', catErr as Error);
    }
    const incomeData: ParsedIncome = {
      type: 'income',
      amount: amountInfo.amount,
      category: finalCategory,
      description: (data.description as string) || '',
      currency: amountInfo.currency as 'ARS' | 'USD',
      quantity: quantity,
      unit: quantity ? 'tn' : null,
      unit_price: quantity ? Math.round(amountInfo.amount / quantity) : null,
      ...(data.incomeDate ? { incomeDate: data.incomeDate as string } : {}),
    };

    await financialService.saveIncome(userId, incomeData, fieldId, plotId);

    const currency = amountInfo.currency === 'USD' ? ' USD' : '';
    let msg = '\ud83d\udcb0 Ingreso registrado\n';
    msg += `${data.category}\n`;
    msg += `$${Number(amountInfo.amount).toLocaleString('es-AR')}${currency}`;
    if (quantity) msg += `\n${quantity} tn`;
    if (resolvedPlotName && resolvedFieldName) {
      msg += `\n\ud83d\udccd Lote ${resolvedPlotName} (${resolvedFieldName})`;
    } else if (resolvedPlotName) {
      msg += `\n\ud83d\udccd Lote ${resolvedPlotName}`;
    }

    const suggestions = getSuggestions('income_saved');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
