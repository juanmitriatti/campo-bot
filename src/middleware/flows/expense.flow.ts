import { normalizarMonto } from '../../utils/parser.js';
import { FinancialService } from '../../domain/financial/financial.service.js';
import { FinancialRepository } from '../../domain/financial/financial.repository.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { buildFieldPrompt, buildFieldInteractive, validateFieldAsync } from './field-step-helpers.js';
import { EntityValidator } from '../../services/entity-validator.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId, ParsedExpense, InteractiveMessage } from '../../types/index.js';

const entityValidator = new EntityValidator();

const EXPENSE_CATEGORIES = [
  'Combustible', 'Fertilizantes', 'Semillas', 'Agroquímicos',
  'Sueldos', 'Maquinaria', 'Arrendamiento', 'Impuestos', 'Otros',
];

const categoryList: InteractiveMessage = {
  type: 'list',
  body: '¿En qué categoría?',
  buttonText: 'Ver categorías',
  sections: [{
    title: 'Categorías',
    rows: EXPENSE_CATEGORIES.map(c => ({
      id: `flow_cat_${c.toLowerCase()}`,
      title: c,
    })),
  }],
};

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
    interactive: categoryList,
    validate: (input) => {
      const lower = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const match = EXPENSE_CATEGORIES.find(c =>
        c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').startsWith(lower) ||
        lower.startsWith(c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
      );
      if (!match) return { error: `Categoría no válida. Elegí una de la lista.` };
      return { value: match };
    },
  },
  {
    field: 'fieldName',
    prompt: '¿En qué campo? (escribí el nombre o "general" si no aplica)',
    promptAsync: async (_data, userId) => {
      const fields = await entityValidator.getUserFieldNames(userId);
      return buildFieldPrompt(fields);
    },
    interactiveAsync: async (_data, userId) => {
      const fields = await entityValidator.getUserFieldNames(userId);
      return buildFieldInteractive(fields);
    },
    validate: (input) => {
      const lower = input.toLowerCase().trim();
      if (lower === 'general' || lower === 'ninguno' || lower === 'no') return { value: null };
      return { value: input.trim() };
    },
    validateAsync: validateFieldAsync,
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
    const currency = amountInfo.currency === 'USD' ? ' USD' : '';
    let msg = '\ud83d\udcb8 *Confirmar gasto:*\n\n';
    msg += `Monto: *$${Number(amountInfo.amount).toLocaleString('es-AR')}${currency}*\n`;
    msg += `Categoría: *${data.category}*\n`;
    if (data.fieldName) msg += `Campo: *${data.fieldName}*\n`;
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
    const fieldName = data.fieldName as string | null;

    let fieldId: number | null = null;
    if (fieldName) {
      const field = await financialService.getOrCreateField(userId, fieldName);
      fieldId = field.id;
    }

    const expenseData: ParsedExpense = {
      type: 'expense',
      amount: amountInfo.amount,
      category: data.category as string,
      description: (data.description as string) || '',
      currency: amountInfo.currency as 'ARS' | 'USD',
    };

    await financialService.saveExpense(userId, expenseData, fieldId);

    const currency = amountInfo.currency === 'USD' ? ' USD' : '';
    let msg = '\u2705 Gasto registrado\n';
    msg += `${data.category}\n`;
    msg += `$${Number(amountInfo.amount).toLocaleString('es-AR')}${currency}`;
    if (fieldName) msg += `\n\ud83d\udccd ${fieldName}`;

    const suggestions = getSuggestions('expense_saved');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
