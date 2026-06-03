import { FinancialService } from '../../domain/financial/financial.service.js';
import { FinancialRepository } from '../../domain/financial/financial.repository.js';
import { localidadLookup } from '../../services/localidad-lookup.service.js';
import { formatLocation } from '../pending-field-city-handler.js';
import { getSuggestions } from '../contextual-suggestions.js';
import { MapTokenService } from '../../services/map-token.service.js';
import type { FlowDefinition, FlowStep } from './flow.interface.js';
import type { UserId } from '../../types/index.js';

const financialService = new FinancialService(new FinancialRepository());
const mapTokenService = new MapTokenService();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:3000';
}

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
    field: 'locationMethod',
    prompt: '¿Cómo querés ubicar el campo?',
    skipIf: (data) => data.city !== undefined, // Skip when city is pre-filled
    interactive: {
      type: 'buttons',
      body: '¿Cómo querés ubicar el campo?',
      buttons: [
        { id: 'flow_field_loc_city', title: 'Escribir localidad' },
        { id: 'flow_field_loc_map', title: 'Dibujar en mapa' },
        { id: 'flow_field_loc_share', title: 'Compartir ubicación' },
      ],
    },
    validate: (input) => {
      const lower = input.trim().toLowerCase();
      // Accept callback IDs from buttons
      if (lower === 'flow_field_loc_city' || /localidad|ciudad|escribir/i.test(lower)) {
        return { value: 'city' };
      }
      if (lower === 'flow_field_loc_map' || /mapa|dibujar/i.test(lower)) {
        return { value: 'map' };
      }
      if (lower === 'flow_field_loc_share' || /ubicaci[oó]n|compartir|gps/i.test(lower)) {
        return { value: 'share' };
      }
      return { error: 'Elegí una opción: *Escribir localidad*, *Dibujar en mapa* o *Compartir ubicación*.' };
    },
  },
  {
    field: 'city',
    prompt: '¿En qué localidad está el campo?',
    skipIf: (data) => data.locationMethod !== 'city',
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
    const method = data.locationMethod as string;
    let msg = '🏡 *Confirmar nuevo campo:*\n\n';
    msg += `Nombre: *${data.name}*\n`;

    if (data.city) {
      // Show the captured locality regardless of how it was provided — a
      // pre-filled city (e.g. "tengo un campo en Pergamino") doesn't set
      // locationMethod='city', and omitting it made users think it was lost.
      const province = data._province as string | null;
      msg += `Localidad: *${formatLocation(data.city as string, province)}*\n`;
    } else if (method === 'map') {
      msg += `Ubicación: _Se va a generar un enlace para dibujar el contorno en el mapa_\n`;
    } else if (method === 'share') {
      msg += `Ubicación: _Después de confirmar, compartí tu ubicación_\n`;
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
    const method = (data.locationMethod as string) || 'city';
    const city = data.city as string | null;
    const province = data._province as string | null;
    const channel = data._channel as string | null;
    const channelId = data._channelId as string | null;

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

    // No duplicate — create field
    const field = await financialService.getOrCreateField(userId, name);
    const fieldId = field.id;

    if (method === 'city') {
      // Existing city behavior
      if (city) {
        await financialService.setFieldCity(userId, name, city, province);
      }
      let msg = `📍 Campo *${name}* creado correctamente.`;
      if (city) msg += `\nUbicación: ${formatLocation(city, province)}`;
      const suggestions = getSuggestions('field_created');
      return { messages: [msg], interactive: suggestions ?? undefined };
    }

    if (method === 'map') {
      // Generate map token and return URL
      const effectiveChannel = channel || 'whatsapp';
      const effectiveChannelId = channelId || '';

      const token = await mapTokenService.createToken(
        userId, name, fieldId, effectiveChannel, effectiveChannelId,
      );

      const baseUrl = getAppUrl();
      const mapUrl = `${baseUrl}/map?token=${token}`;

      return {
        messages: [
          `📍 Campo *${name}* creado correctamente.\n\n🗺️ Abrí este enlace para dibujar el contorno del campo:\n${mapUrl}\n\n_El enlace expira en 30 minutos._`,
        ],
      };
    }

    if (method === 'share') {
      // Create field, set pending location for next location message
      return {
        messages: [
          `📍 Campo *${name}* creado correctamente.\n\n📌 Ahora compartí tu ubicación para ubicar el campo en el mapa.`,
        ],
        sideEffects: {
          setPendingFieldLocation: { fieldId, fieldName: name },
        },
      };
    }

    // Fallback (shouldn't happen)
    let msg = `📍 Campo *${name}* creado correctamente.`;
    const suggestions = getSuggestions('field_created');
    return { messages: [msg], interactive: suggestions ?? undefined };
  },
};
