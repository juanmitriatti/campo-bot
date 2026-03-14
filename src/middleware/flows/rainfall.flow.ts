import { normalizarMonto, parseMilimetros } from '../../utils/parser.js';
import {
  saveRainfall as dbSaveRainfall,
  getOrCreateField as dbGetOrCreateField,
} from '../../services/expenses.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { buildFieldPrompt, buildFieldInteractive, validateFieldAsync } from './field-step-helpers.js';
import { EntityValidator } from '../../services/entity-validator.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId, InteractiveMessage } from '../../types/index.js';

const entityValidator = new EntityValidator();

const steps: FlowStep[] = [
  {
    field: 'mm',
    prompt: '¿Cuántos milímetros cayeron?',
    validate: (input) => {
      // Try parseMilimetros first (handles "25mm", "llovieron 30")
      let mm = parseMilimetros(input);
      if (!mm) {
        mm = normalizarMonto(input);
      }
      if (!mm || mm <= 0) return { error: 'No entendí los milímetros. Probá con un número, ej: 25 o 25mm' };
      if (mm > 500) return { error: 'Ese valor parece muy alto. ¿Seguro que fueron más de 500mm?' };
      return { value: mm };
    },
  },
  {
    field: 'fieldName',
    prompt: '¿En qué campo llovió? (escribí el nombre o "general" si no aplica)',
    promptAsync: async (_data, userId) => {
      const fields = await entityValidator.getUserFieldNames(userId);
      return buildFieldPrompt(fields, '¿En qué campo llovió?');
    },
    interactiveAsync: async (_data, userId) => {
      const fields = await entityValidator.getUserFieldNames(userId);
      if (fields.length === 0) {
        return {
          type: 'buttons' as const,
          body: '¿En qué campo llovió?',
          buttons: [{ id: 'flow_skip', title: 'Saltar' }],
        };
      }
      return buildFieldInteractive(fields, '¿En qué campo llovió?', 'Sin campo');
    },
    validate: (input) => {
      const lower = input.toLowerCase().trim();
      if (lower === 'general' || lower === 'ninguno' || lower === 'no' || lower === 'sin campo') return { value: null };
      return { value: input.trim() };
    },
    validateAsync: validateFieldAsync,
    optional: true,
  },
];

export const rainfallFlow: FlowDefinition = {
  id: 'rainfall_flow',
  name: 'Registrar Lluvia',
  steps,

  buildConfirmation(data) {
    let msg = '\ud83c\udf27\ufe0f *Confirmar lluvia:*\n\n';
    msg += `Milímetros: *${data.mm}mm*\n`;
    if (data.fieldName) msg += `Campo: *${data.fieldName}*\n`;
    msg += '\n¿Confirmamos?';

    return {
      messages: [msg],
      interactive: {
        type: 'buttons',
        body: '¿Registramos la lluvia?',
        buttons: [
          { id: 'flow_confirm', title: 'Confirmar' },
          { id: 'flow_cancel', title: 'Cancelar' },
          { id: 'flow_back', title: 'Volver' },
        ],
      },
    };
  },

  async execute(userId, data) {
    const mm = data.mm as number;
    const fieldName = data.fieldName as string | null;

    let fieldId: number | null = null;
    if (fieldName) {
      const field = await dbGetOrCreateField(userId, fieldName);
      fieldId = field.id;
    }

    await dbSaveRainfall(userId, mm, fieldId);

    let msg = `\ud83c\udf27\ufe0f Lluvia registrada: *${mm}mm*`;
    if (fieldName) msg += `\n\ud83d\udccd ${fieldName}`;

    const suggestions = getSuggestions('rainfall_logged');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
