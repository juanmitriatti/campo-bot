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
  if (/^(cancelar|cancel|salir|nada|ninguna|ninguno|olvidalo|dejalo|olvidá|olvidate)\b/.test(t)) return true;
  // Agro / registration verbs. \b before the verb is enough; trailing boundary doesn't
  // play well with accented endings (é, í, ó) under ASCII \b semantics.
  if (/\b(siembra|sembr[ée]|cosech[ée]|cosecha|fumig[ué]|fertilic[ée]|ri[eé]gu[ée]|apliqu[ée]|gast[ée]|pagu[ée]|compr[ée]|vend[íi]|cobr[ée]|us[ée]|cargu[ée]|llov[ií][oó]?|hect[aá]rea|rinde|rind[ií][oó]?|factura|remito|recib[íi]|agrega|agregar|crear|borrar|eliminar|mover|pas[ée]|metele|met[ée]|ech[ée]|inseminé?|tratam|vacun[ée]|desparasit[ée])/.test(t)) return true;
  // Numbers-first content ("52 ha", "3000 kg", "$50000", "us$3000")
  if (/^(?:\$|us\$|usd)\s*\d/i.test(t)) return true;
  if (/^\d[\d.,]*\s*(ha|hect|kg|tn|qq|mm|lt|cc|bolsas|pesos|dolares|usd|ars)/i.test(t)) return true;
  // Registration content: a number + a farm noun is never a locality
  // ("tengo 100 vacas y 30 terneros en el lote Norte" was being eaten as a city).
  if (/\d/.test(t) && /\b(vacas?|novillos?|novillitos?|terneros?|terneras?|toros?|toritos?|vaquillonas?|bueyes?|animales?|cabezas?|lote|potrero|parcela|hect[aá]reas?)\b/.test(t)) return true;
  // Declarative "tengo / hay / son N ..."
  if (/^(?:tengo|hay|son|tenemos|tiene)\s+\d/.test(t)) return true;
  // Listas con ":" — típico de cosecha "lote 1A: Britos 30 tn, Pérez 25 tn"
  if (/:/.test(t) && /\d/.test(t)) return true;
  // Pregunta o reporte
  if (/^(¿|cómo|como|cuánto|cuanto|cuál|cual|qué|que|reporte|informe|pasame|dame|mostr|listar|listame)\b/.test(t)) return true;
  // Cualquier "?" en el texto = no es localidad
  if (/\?/.test(t)) return true;
  // Mensajes muy largos (> 60 chars) raramente son una localidad
  if (t.length > 60) return true;
  // Múltiples comas separando DATOS — pero "Pergamino, Buenos Aires, Argentina"
  // es una respuesta de localidad perfectamente válida. Solo escapamos cuando
  // además hay dígitos (listas tipo "A: 30, B: 40, C: 50"); texto puro con
  // comas se intenta como localidad (el lookup contra el censo decide).
  if ((t.match(/,/g) || []).length >= 2 && /\d/.test(t)) return true;
  // SQL / inyección — empieza con keywords destructivos
  if (/^(drop|delete|select|insert|update|truncate|ignore\s+all)\b/.test(t)) return true;
  // Muy corto o sin letras
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
