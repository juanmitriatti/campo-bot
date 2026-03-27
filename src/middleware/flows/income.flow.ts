import { normalizarMonto } from '../../utils/parser.js';
import { FinancialService } from '../../domain/financial/financial.service.js';
import { FinancialRepository } from '../../domain/financial/financial.repository.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { buildPlotPromptGrouped, buildPlotInteractiveGrouped, validatePlotAsync } from './field-step-helpers.js';
import { EntityValidator } from '../../services/entity-validator.js';
import { INCOME_CATEGORIES } from '../../constants/agro-terms.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId, ParsedIncome, InteractiveMessage } from '../../types/index.js';

const entityValidator = new EntityValidator();

const categoryList: InteractiveMessage = {
  type: 'list',
  body: '¿De qué es el ingreso?',
  buttonText: 'Ver categorías',
  sections: [{
    title: 'Categorías',
    rows: INCOME_CATEGORIES.map(c => ({
      id: `flow_cat_${c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}`,
      title: c,
    })),
  }],
};

const financialService = new FinancialService(new FinancialRepository());

const steps: FlowStep[] = [
  {
    field: 'amount',
    prompt: '¿Cuánto cobraste? (ej: 500000, 1.5 palos, 3000 dólares)',
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
    interactive: categoryList,
    validate: (input) => {
      const lower = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const match = INCOME_CATEGORIES.find(c =>
        c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').startsWith(lower) ||
        lower.startsWith(c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
      );
      if (!match) return { error: 'Categoría no válida. Elegí una de la lista.' };
      return { value: match };
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
      const lower = input.toLowerCase().trim();
      if (lower === 'ninguno' || lower === 'no' || lower === 'sin lote') return { value: null };
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

export const incomeFlow: FlowDefinition = {
  id: 'income_flow',
  name: 'Nuevo Ingreso',
  steps,

  buildConfirmation(data) {
    const amountInfo = data.amount as { amount: number; currency: string };
    const currency = amountInfo.currency === 'USD' ? ' USD' : '';
    let msg = '\ud83d\udcb0 *Confirmar ingreso:*\n\n';
    msg += `Monto: *$${Number(amountInfo.amount).toLocaleString('es-AR')}${currency}*\n`;
    msg += `Categoría: *${data.category}*\n`;
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
      if (plots.length > 0) {
        plotId = plots[0].id;
        fieldId = plots[0].field_id;
        resolvedPlotName = plots[0].name;
        resolvedFieldName = plots[0].field_name;
      }
    }

    const incomeData: ParsedIncome = {
      type: 'income',
      amount: amountInfo.amount,
      category: data.category as string,
      description: (data.description as string) || '',
      currency: amountInfo.currency as 'ARS' | 'USD',
      quantity: quantity,
      unit: quantity ? 'tn' : null,
      unit_price: quantity ? Math.round(amountInfo.amount / quantity) : null,
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
