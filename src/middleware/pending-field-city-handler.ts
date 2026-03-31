import { localidadLookup } from '../services/localidad-lookup.service.js';
import type { FinancialService } from '../domain/financial/financial.service.js';
import type { UserId } from '../types/index.js';

interface PendingCity {
  fieldName: string;
}

export interface PendingCityResult {
  messages: string[];
  clearPending: boolean;
}

export function formatLocation(city: string, province: string | null): string {
  return province ? `${city}, ${province}` : city;
}

export async function handlePendingCity(
  text: string,
  pending: PendingCity,
  userId: UserId,
  financialService: FinancialService,
): Promise<PendingCityResult> {
  // Strip common prefixes and full-sentence patterns like "el campo X está en Y"
  let input = text.trim()
    .replace(/^.*?\b(?:est[aá]|queda|ubicad[oa])\s+en\s+/i, '')
    .replace(/^(?:esta|está|queda|ubicad[oa])\s+(?:en\s+)?/i, '')
    .replace(/^en\s+/i, '')
    .trim();

  if (!input) {
    return {
      messages: ['Escribí el nombre de la localidad.'],
      clearPending: false,
    };
  }

  const result = localidadLookup.lookup(input);

  switch (result.status) {
    case 'exact': {
      const loc = result.matches[0];
      await financialService.setFieldCity(userId, pending.fieldName, loc.nombre, loc.provincia);
      return {
        messages: [`📍 Campo *${pending.fieldName}* ubicado en *${formatLocation(loc.nombre, loc.provincia)}*`],
        clearPending: true,
      };
    }

    case 'disambiguate': {
      const options = result.matches
        .map(m => `• ${m.nombre}, ${m.provincia}`)
        .join('\n');
      return {
        messages: [
          `Hay varias localidades con ese nombre:\n\n${options}\n\nEscribí el nombre con la provincia, ej: *${result.matches[0].nombre}, ${result.matches[0].provincia}*`,
        ],
        clearPending: false,
      };
    }

    case 'suggestions': {
      const suggestions = result.matches
        .map(m => `• ${m.nombre}, ${m.provincia}`)
        .join('\n');
      return {
        messages: [
          `No encontré "${input}". ¿Quisiste decir?\n\n${suggestions}\n\nEscribí el nombre correcto.`,
        ],
        clearPending: false,
      };
    }

    case 'not_found':
    default:
      return {
        messages: [
          `No encontré la localidad "${input}" en el listado de localidades argentinas.\n\nRevisá el nombre e intentá de nuevo, o escribí *cancelar* para omitir.`,
        ],
        clearPending: false,
      };
  }
}
