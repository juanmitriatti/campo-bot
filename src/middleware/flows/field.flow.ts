import { FinancialService } from '../../domain/financial/financial.service.js';
import { FinancialRepository } from '../../domain/financial/financial.repository.js';
import { localidadLookup } from '../../services/localidad-lookup.service.js';
import { formatLocation } from '../pending-field-city-handler.js';
import { getSuggestions } from '../contextual-suggestions.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId } from '../../types/index.js';

const financialService = new FinancialService(new FinancialRepository());

const steps: FlowStep[] = [
  {
    field: 'name',
    prompt: '¿Cómo se llama el campo?',
    validate: (input) => {
      const name = input.trim();
      if (name.length < 2) return { error: 'El nombre tiene que tener al menos 2 caracteres.' };
      if (name.length > 100) return { error: 'El nombre es demasiado largo (máx 100 caracteres).' };
      // Reject command-like input that was likely meant as a different intent
      const lower = name.toLowerCase();
      if (/^(?:agregar|agrega|nuevo|crear|borrar|eliminar|sacar|quitar|restaurar|renombrar)\s/.test(lower)) {
        return { error: 'Eso parece un comando. Escribí *cancelar* para salir y ejecutar el comando.' };
      }
      // Reject query keywords that indicate a different intent
      if (/^(?:mis\s+(?:campos|lotes)|ver\s+|listar\s+|cuantos?\s+|mostrar?\s+|ayuda|menu|clima)/.test(lower)) {
        return { error: 'Eso parece una consulta. Escribí *cancelar* para salir del flujo.' };
      }
      // Reject financial patterns (expense/income)
      if (/\b(?:gast[eéo]|pag[uée]|compr[eéo]|vend[ií]|cobr[eé])\b/.test(lower) && /\d/.test(lower)) {
        return { error: 'Eso parece un gasto o ingreso. Escribí *cancelar* para salir y registrarlo.' };
      }
      return { value: name };
    },
  },
  {
    field: 'city',
    prompt: '¿En qué localidad está el campo?',
    validate: (input) => {
      const city = input.trim();
      if (city.length < 2) return { error: 'La localidad tiene que tener al menos 2 caracteres.' };
      return { value: city };
    },
    validateAsync: async (input, data) => {
      const city = input.trim();
      if (city.length < 2) return { error: 'La localidad tiene que tener al menos 2 caracteres.' };

      const result = localidadLookup.lookup(city);

      switch (result.status) {
        case 'exact': {
          const loc = result.matches[0];
          data._province = loc.provincia;
          return { value: loc.nombre };
        }
        case 'disambiguate': {
          const options = result.matches
            .map(m => `• ${m.nombre}, ${m.provincia}`)
            .join('\n');
          return {
            error: `Hay varias localidades con ese nombre:\n\n${options}\n\nEscribí el nombre con la provincia, ej: *${result.matches[0].nombre}, ${result.matches[0].provincia}*`,
          };
        }
        case 'suggestions': {
          const suggestions = result.matches
            .map(m => `• ${m.nombre}, ${m.provincia}`)
            .join('\n');
          return {
            error: `No encontré "${city}". ¿Quisiste decir?\n\n${suggestions}`,
          };
        }
        case 'not_found':
        default:
          return {
            error: `No encontré la localidad "${city}". Revisá el nombre e intentá de nuevo.`,
          };
      }
    },
  },
];

export const fieldFlow: FlowDefinition = {
  id: 'field_flow',
  name: 'Nuevo Campo',
  steps,

  buildConfirmation(data) {
    let msg = '🏡 *Confirmar nuevo campo:*\n\n';
    msg += `Nombre: *${data.name}*\n`;
    if (data.city) {
      const province = data._province as string | null;
      msg += `Localidad: *${formatLocation(data.city as string, province)}*\n`;
    }
    msg += '\n¿Confirmamos?';

    return {
      messages: [msg],
      interactive: {
        type: 'buttons',
        body: '¿Creamos el campo?',
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
    const province = data._province as string | null;

    // Check for duplicate before creating
    const existing = await financialService.getFieldByName(userId, name);
    if (existing) {
      const cityChanged = city && city.toLowerCase() !== (existing.city || '').toLowerCase();
      let msg = `⚠️ Ya existe un campo llamado *${existing.name}*`;
      if (existing.city) msg += ` (ubicación: ${existing.city})`;
      msg += '.';
      if (cityChanged) msg += `\nLa nueva ubicación sería *${formatLocation(city, province)}*.`;
      msg += '\n\n¿Qué querés hacer?';

      const buttons: { id: string; title: string }[] = [];
      if (cityChanged) buttons.push({ id: 'field_dup_update', title: 'Actualizar ubic.' });
      buttons.push({ id: 'field_dup_rename', title: 'Otro nombre' });
      buttons.push({ id: 'field_dup_cancel', title: 'Cancelar' });

      return {
        messages: [msg],
        interactive: { type: 'buttons' as const, body: '¿Qué querés hacer?', buttons },
        sideEffects: { setFieldDuplicate: { name, city } },
      };
    }

    // No duplicate — create
    await financialService.getOrCreateField(userId, name);
    if (city) {
      await financialService.setFieldCity(userId, name, city, province);
    }

    let msg = `📍 Campo *${name}* creado correctamente.`;
    if (city) msg += `\nUbicación: ${formatLocation(city, province)}`;

    const suggestions = getSuggestions('field_created');
    return {
      messages: [msg],
      interactive: suggestions ?? undefined,
    };
  },
};
