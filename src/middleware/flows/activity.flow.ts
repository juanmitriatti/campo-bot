import { saveDomainEvent as dbSaveDomainEvent, findPlotByNameAcrossFields } from '../../services/expenses.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { buildPlotPrompt, validatePlotAsync } from './field-step-helpers.js';
import { EntityValidator } from '../../services/entity-validator.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId, InteractiveMessage } from '../../types/index.js';

const entityValidator = new EntityValidator();

const ACTIVITY_TYPES = [
  { id: 'spraying', label: 'Fumigación' },
  { id: 'fertilization', label: 'Fertilización' },
  { id: 'planting', label: 'Siembra' },
  { id: 'tillage', label: 'Labranza' },
  { id: 'harvest', label: 'Cosecha' },
  { id: 'irrigation', label: 'Riego' },
];

const activityTypeMap: Record<string, string> = {};
for (const a of ACTIVITY_TYPES) {
  activityTypeMap[a.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')] = a.id;
  activityTypeMap[a.id] = a.id;
}

const activityButtons: InteractiveMessage = {
  type: 'list',
  body: '¿Qué actividad realizaste?',
  buttonText: 'Ver actividades',
  sections: [{
    title: 'Actividades',
    rows: ACTIVITY_TYPES.map(a => ({
      id: `flow_activity_${a.id}`,
      title: a.label,
    })),
  }],
};

const steps: FlowStep[] = [
  {
    field: 'activityType',
    prompt: '¿Qué actividad realizaste?',
    interactive: activityButtons,
    validate: (input) => {
      const lower = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const match = activityTypeMap[lower];
      if (!match) {
        // Try partial match
        const partial = ACTIVITY_TYPES.find(a =>
          a.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').startsWith(lower) ||
          a.id.startsWith(lower)
        );
        if (!partial) return { error: 'Actividad no válida. Elegí una de la lista.' };
        return { value: partial.id };
      }
      return { value: match };
    },
  },
  {
    field: 'plotName',
    prompt: '¿En qué lote? (escribí el nombre, opcional)',
    promptAsync: async (_data, userId) => {
      const plots = await entityValidator.getUserPlotNames(userId);
      return buildPlotPrompt(plots);
    },
    interactive: {
      type: 'buttons',
      body: '¿En qué lote?',
      buttons: [{ id: 'flow_skip', title: 'Saltar' }],
    },
    validate: (input) => {
      const val = input.trim();
      if (val.length < 1) return { error: 'Ingresá un nombre de lote válido.' };
      return { value: val };
    },
    validateAsync: validatePlotAsync,
    optional: true,
  },
  {
    field: 'product',
    prompt: '¿Qué producto usaste? (opcional, podés saltar)',
    interactive: {
      type: 'buttons',
      body: '¿Qué producto?',
      buttons: [{ id: 'flow_skip', title: 'Saltar' }],
    },
    validate: (input) => ({ value: input.trim() }),
    optional: true,
    skipIf: (data) => data.activityType === 'tillage' || data.activityType === 'harvest',
  },
  {
    field: 'quantity',
    prompt: '¿Cuánto? (ej: 3 lt/ha, 200 kg, opcional)',
    interactive: {
      type: 'buttons',
      body: '¿Cuánto aplicaste?',
      buttons: [{ id: 'flow_skip', title: 'Saltar' }],
    },
    validate: (input) => {
      // Try to parse "3 lt", "200 kg", etc.
      const match = input.match(/^([\d.,]+)\s*(\w+)?/);
      if (!match) return { error: 'Ingresá cantidad y unidad, ej: 3 lt o 200 kg' };
      const num = parseFloat(match[1].replace(/,/g, '.'));
      if (isNaN(num) || num <= 0) return { error: 'El número no es válido.' };
      return { value: { quantity: num, unit: match[2] || null } };
    },
    optional: true,
    skipIf: (data) => data.activityType === 'tillage' || data.activityType === 'harvest',
  },
];

function getActivityLabel(type: string): string {
  return ACTIVITY_TYPES.find(a => a.id === type)?.label || type;
}

export const activityFlow: FlowDefinition = {
  id: 'activity_flow',
  name: 'Nueva Actividad',
  steps,

  buildConfirmation(data) {
    const label = getActivityLabel(data.activityType as string);
    let msg = '\ud83c\udf31 *Confirmar actividad:*\n\n';
    msg += `Tipo: *${label}*\n`;
    if (data.plotName) msg += `Lote: *${data.plotName}*\n`;
    if (data.product) msg += `Producto: *${data.product}*\n`;
    if (data.quantity) {
      const q = data.quantity as { quantity: number; unit: string | null };
      msg += `Cantidad: *${q.quantity}${q.unit ? ' ' + q.unit : ''}*\n`;
    }
    msg += '\n¿Confirmamos?';

    return {
      messages: [msg],
      interactive: {
        type: 'buttons',
        body: '¿Registramos la actividad?',
        buttons: [
          { id: 'flow_confirm', title: 'Confirmar' },
          { id: 'flow_cancel', title: 'Cancelar' },
          { id: 'flow_back', title: 'Volver' },
        ],
      },
    };
  },

  async execute(userId, data) {
    const activityType = data.activityType as string;
    const label = getActivityLabel(activityType);
    const quantityInfo = data.quantity as { quantity: number; unit: string | null } | undefined;
    const plotName = data.plotName as string | null;

    // Resolve plot_id from plot name
    let plotId: number | null = null;
    if (plotName) {
      const plots = await findPlotByNameAcrossFields(userId, plotName);
      if (plots.length > 0) {
        plotId = plots[0].id;
      }
    }

    await dbSaveDomainEvent(userId, {
      eventType: activityType,
      plotId,
      plotCropId: null,
      crop: null,
      product: (data.product as string) || null,
      productType: null,
      quantity: quantityInfo?.quantity || null,
      unit: quantityInfo?.unit || null,
      implement: null,
      notes: null,
    });

    let msg = `\u2705 Actividad registrada: *${label}*`;
    if (plotName) msg += `\n\ud83d\udccd Lote: ${plotName}`;
    if (data.product) msg += `\nProducto: ${data.product}`;

    const suggestions = getSuggestions('activity_logged');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
