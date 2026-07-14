import { saveDomainEvent as dbSaveDomainEvent, findPlotByNameAcrossFields } from '../../services/expenses.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { buildPlotPromptGrouped, buildPlotInteractiveGrouped, validatePlotAsync } from './field-step-helpers.js';
import { EntityValidator } from '../../services/entity-validator.js';
import { ACTIVITY_TYPES, FLOW_ACTIVITY_TYPES } from '../../constants/agro-terms.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId, InteractiveMessage } from '../../types/index.js';

const entityValidator = new EntityValidator();

// SOLO los tipos que este flow sabe registrar (lote/producto/cantidad). Los
// eventos de hacienda/observacion/monitoreo estaban en el picker por compartir
// la lista con las etiquetas de reportes — elegir "Movimiento hacienda" pedia
// "cuanto aplicaste?" y guardaba un evento fantasma sin tocar el inventario.
const activityTypeMap: Record<string, string> = {};
for (const a of FLOW_ACTIVITY_TYPES) {
  activityTypeMap[a.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')] = a.id;
  activityTypeMap[a.id] = a.id;
}
// Tipos que existen pero NO van por este flow → redirect amigable si los tipean.
const nonFlowTypeMap: Record<string, string> = {};
for (const a of ACTIVITY_TYPES) {
  if (!a.flow) {
    nonFlowTypeMap[a.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')] = a.id;
    nonFlowTypeMap[a.id] = a.id;
  }
}

const activityButtons: InteractiveMessage = {
  type: 'list',
  body: '¿Qué actividad realizaste?',
  buttonText: 'Ver actividades',
  sections: [{
    title: 'Actividades',
    rows: FLOW_ACTIVITY_TYPES.map(a => ({
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
      // Pesaje/sanidad/hacienda/etc: se registran contandolo al bot, no por este flow.
      if (nonFlowTypeMap[lower]) {
        return { error: 'Eso se registra contandomelo directo — ej: *"pase 20 terneros al lote Sur"*, *"vacune 40 vacas contra aftosa"*, *"pese los novillos a 380 kg"*. Elegi una actividad de la lista, o escribi *cancelar* y contamelo.' };
      }
      const match = activityTypeMap[lower];
      if (!match) {
        // Try partial match
        const partial = FLOW_ACTIVITY_TYPES.find(a =>
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
      const plots = await entityValidator.getUserPlotsWithFields(userId);
      return buildPlotPromptGrouped(plots);
    },
    interactiveAsync: async (_data, userId) => {
      const plots = await entityValidator.getUserPlotsWithFields(userId);
      return buildPlotInteractiveGrouped(plots);
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
    return {
      messages: [msg.trimEnd()],
      interactive: {
        type: 'buttons',
        // Una sola pregunta de confirmación — antes el texto terminaba en
        // "¿Confirmamos?" Y los botones decían "¿Registramos la actividad?".
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
      if (plots.length === 1) {
        plotId = plots[0].id;
      } else if (plots.length > 1) {
        const fieldHint = data._resolvedFieldHint as string | undefined;
        const match = fieldHint
          ? plots.find((p: any) => p.field_name.toLowerCase() === fieldHint.toLowerCase())
          : null;
        plotId = (match || plots[0]).id;
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
