import { normalizarMonto, parseMilimetros } from '../../utils/parser.js';
import {
  saveRainfall as dbSaveRainfall,
  RAINFALL_REJECTED_DUPLICATE,
  getFieldByName as dbGetFieldByName,
  getUserSettings,
  getDailyRainfallTotal,
} from '../../services/expenses.js';
import { isDuplicate, recordAlert, recordDeduped } from '../../services/alert.service.js';
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
    prompt: '¿En qué campo llovió?',
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
      return buildFieldInteractive(fields, '¿En qué campo llovió?');
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
      const field = await dbGetFieldByName(userId, fieldName);
      if (field) fieldId = field.id;
    }

    const saved = await dbSaveRainfall(userId, mm, fieldId);

    if (saved === RAINFALL_REJECTED_DUPLICATE) {
      const label = fieldName || 'General';
      return {
        messages: [`Ya hay un registro de lluvia hoy para *${label}*. Si querés corregirlo, borrá el anterior con *borrar lluvia* y registrá de nuevo.`],
      };
    }

    let msg = `\ud83c\udf27\ufe0f Lluvia registrada: *${mm}mm*`;
    if (fieldName) msg += `\n\ud83d\udccd ${fieldName}`;

    // Check cumulative daily rain threshold alert
    try {
      const settings = await getUserSettings(userId);
      if (settings?.rain_alerts !== false) {
        const threshold = settings?.rain_alert_mm ?? 10;
        const dailyTotal = await getDailyRainfallTotal(userId, fieldId);
        if (dailyTotal >= threshold) {
          const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
          const dedupKey = `field_${fieldId ?? 0}_${today}`;
          const dup = await isDuplicate(userId, 'rain_observed', dedupKey, 24);
          if (!dup) {
            msg += `\n\n\u26a0\ufe0f *Alerta:* Acumulado hoy *${dailyTotal}mm* \u2265 umbral configurado (${threshold}mm)`;
            recordAlert(userId, 'rain_observed', msg, {
              fieldId,
              dedupKey,
              payload: { mm, dailyTotal, threshold, fieldName },
            }).catch(() => {});
          } else {
            recordDeduped(userId, 'rain_observed', dedupKey, msg).catch(() => {});
          }
        }
      }
    } catch {
      // Don't let alert check failure break rain registration
    }

    const suggestions = getSuggestions('rainfall_logged');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
