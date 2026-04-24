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

/**
 * Detects inputs that clearly aren't a city — numbers, agro commands, cancels, etc.
 * When pending-city state is on but the user sends something like "52 hectáreas" or
 * "Siembra...", we should abort the pending flow instead of prompting "¿En qué
 * ciudad...?" over and over.
 */
function looksLikeNonCity(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (/^(cancelar|cancel|salir|nada|ninguna|ninguno|olvidalo|dejalo)\b/.test(t)) return true;
  // Agro / registration verbs
  if (/\b(siembra|sembr[ée]|coseché|cosecha|fumig[ué]|fertilic[ée]|ri?egué|apliqu[ée]|gasté|pagué|compré|vendí|cobré|llovi[oó]|hect[aá]rea|rinde|factura|remito|recibí|agrega|agregar|crear|borrar|eliminar|mover|pas[ée])\b/.test(t)) return true;
  // Numbers-first content ("52 ha", "3000 kg", "$50000")
  if (/^(?:\$|us\$|usd)?\s*\d[\d.,]*\s*(ha|hect|kg|tn|mm|lt|$|pesos|dolares|usd|ars|,|\.)/i.test(t)) return true;
  // Very short (< 3 chars) or no letters at all
  if (t.length < 3 || !/[a-záéíóúñ]/i.test(t)) return true;
  return false;
}

/**
 * Extract the locality part from correction phrases. Handles:
 *   - "está en X" / "queda en X" / "ubicado en X"
 *   - "no, es X" / "es en X" / "es X"
 *   - "está mal, es en X" / "me equivoqué, es X"
 *   - Bare "X" or "en X"
 */
function extractCityCandidate(text: string): string {
  let s = text.trim();

  // Remove leading filler/correction phrases up to the locality keyword.
  // Regex order matters: most specific first.
  const patterns = [
    /^.*?\b(?:no\s*,?|est[aá]\s+mal\s*,?|me\s+equivoqu[ée]\s*,?|perdón\s*,?|perd[oó]n\s*,?)\s+(?:es|fue|seria|sería|es\s+en)\s+/i,
    /^.*?\b(?:est[aá]|queda|ubicad[oa])\s+en\s+/i,
    /^(?:es|fue|es\s+en|fue\s+en)\s+/i,
    /^(?:esta|está|queda|ubicad[oa])\s+(?:en\s+)?/i,
    /^en\s+/i,
  ];
  for (const p of patterns) {
    const next = s.replace(p, '').trim();
    if (next && next !== s) { s = next; break; }
  }

  return s;
}

export async function handlePendingCity(
  text: string,
  pending: PendingCity,
  userId: UserId,
  financialService: FinancialService,
): Promise<PendingCityResult> {
  // Escape hatch: non-city inputs abort the flow so the user can actually register
  // whatever they wanted without getting stuck in "¿En qué ciudad...?".
  if (looksLikeNonCity(text)) {
    return {
      messages: [
        `Dejé pendiente la ubicación de *${pending.fieldName}*. Cuando quieras asignarla, escribí:\n📍 *ubicar campo ${pending.fieldName} en [localidad]*`,
      ],
      clearPending: true,
    };
  }

  const input = extractCityCandidate(text);

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
