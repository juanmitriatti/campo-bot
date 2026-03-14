import { FinancialService } from '../../domain/financial/financial.service.js';
import { FinancialRepository } from '../../domain/financial/financial.repository.js';
import { getSuggestions } from '../contextual-suggestions.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId } from '../../types/index.js';

const financialService = new FinancialService(new FinancialRepository());

const steps: FlowStep[] = [
  {
    field: 'name',
    prompt: '\u00bfC\u00f3mo se llama el campo?',
    validate: (input) => {
      const name = input.trim();
      if (name.length < 2) return { error: 'El nombre tiene que tener al menos 2 caracteres.' };
      if (name.length > 100) return { error: 'El nombre es demasiado largo (m\u00e1x 100 caracteres).' };
      return { value: name };
    },
  },
  {
    field: 'city',
    prompt: '\u00bfEn qu\u00e9 localidad? (opcional, pod\u00e9s saltar)',
    interactive: {
      type: 'buttons',
      body: '\u00bfEn qu\u00e9 localidad est\u00e1?',
      buttons: [{ id: 'flow_skip', title: 'Saltar' }],
    },
    validate: (input) => {
      const city = input.trim();
      if (city.length < 2) return { error: 'La localidad tiene que tener al menos 2 caracteres.' };
      return { value: city };
    },
    optional: true,
  },
];

export const fieldFlow: FlowDefinition = {
  id: 'field_flow',
  name: 'Nuevo Campo',
  steps,

  buildConfirmation(data) {
    let msg = '\ud83c\udfe1 *Confirmar nuevo campo:*\n\n';
    msg += `Nombre: *${data.name}*\n`;
    if (data.city) msg += `Localidad: *${data.city}*\n`;
    msg += '\n\u00bfConfirmamos?';

    return {
      messages: [msg],
      interactive: {
        type: 'buttons',
        body: '\u00bfCreamos el campo?',
        buttons: [
          { id: 'flow_confirm', title: 'Confirmar' },
          { id: 'flow_cancel', title: 'Cancelar' },
          { id: 'flow_back', title: 'Volver' },
        ],
      },
    };
  },

  async execute(userId, data) {
    const name = data.name as string;
    const city = data.city as string | null;

    await financialService.getOrCreateField(userId, name);
    if (city) {
      await financialService.setFieldCity(userId, name, city);
    }

    let msg = `\ud83d\udccd Campo *${name}* creado correctamente.`;
    if (city) msg += `\nUbicaci\u00f3n: ${city}`;

    const suggestions = getSuggestions('field_created');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
