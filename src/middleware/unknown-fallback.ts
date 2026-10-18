/**
 * Salida de "no entendí" (oct 2026). Antes todos los caminos terminales —
 * fuzzy fallback del mapper, agente vacío, regex sin match, lock liberado,
 * IA caída — devolvían texto pelado que pedía "escribí *menú*". Era el único
 * lugar del bot donde una respuesta que necesita acción del usuario iba sin
 * botones, y es justo el momento en que el usuario se va.
 *
 * Esta es la fuente ÚNICA de esa botonera: un botón por lo que SÍ se entendió
 * a medias (si el texto huele a gasto, el flow de gasto; a lluvia, la lluvia…),
 * uno al menú y uno a soporte. Todo id tiene ruta en CALLBACK_MAP y el título
 * cabe en los 20 caracteres de WhatsApp (`validateUnknownFallbackButtons` lo
 * verifica en el test).
 */
import type { InteractiveButton } from '../types/index.js';
// Solo el tipo (se borra al compilar): el pipeline importa este módulo.
import type { BotResponseItem } from '../services/message-pipeline.js';
import { normLex } from '../utils/lexicon.js';

export const UNKNOWN_FALLBACK_BODY = '¿Te sirve alguna de estas?';

/** Dominio detectado por palabra clave → botón que abre la carga guiada de ESO. */
const DOMAIN_BUTTONS: ReadonlyArray<{ re: RegExp; button: InteractiveButton }> = [
  { re: /\b(gast[eéo]|gastos?|pagu[eé]|pagos?|compr[eéo]|compras?|factura|gasoil|sueldos?|arrendamiento)\b/, button: { id: 'flow_new_expense', title: 'Cargar gasto' } },
  { re: /\b(vend[ií]|ventas?|cobr[eé]|cobros?|ingresos?|me\s+pagaron)\b/, button: { id: 'flow_new_income', title: 'Cargar ingreso' } },
  { re: /\b(llovi[oó]|lluvias?|llueve|cayeron|mil[ií]metros|mm)\b/, button: { id: 'flow_new_rainfall', title: 'Cargar lluvia' } },
  { re: /\b(fumig\w*|pulveriz\w*|sembr\w*|siembras?|cosech\w*|fertiliz\w*|labranza|rastr[ae]\w*|riego|regu[eé]|aplic\w*)\b/, button: { id: 'flow_new_activity', title: 'Cargar actividad' } },
  { re: /\b(vacas?|novillos?|terneros?|terneras?|vaquillonas?|toros?|hacienda|ganado|cabezas|animales)\b/, button: { id: 'form_open_livestock', title: 'Cargar hacienda' } },
  { re: /\b(lotes?|potreros?)\b/, button: { id: 'cmd_agregar_lote', title: 'Crear lote' } },
  { re: /\b(campos?|establecimiento)\b/, button: { id: 'cmd_agregar_campo', title: 'Crear campo' } },
];

/** Botón genérico cuando ninguna palabra clave delata el dominio. */
const STEP_BY_STEP: InteractiveButton = { id: 'cmd_formulario', title: 'Cargar paso a paso' };
const MENU: InteractiveButton = { id: 'back_menu', title: 'Ver menú' };
const SUPPORT: InteractiveButton = { id: 'cmd_soporte', title: 'Soporte' };

/** El botón de carga guiada que mejor corresponde a lo que el usuario escribió. */
export function detectDomainButton(text: string): InteractiveButton | null {
  const t = normLex(text);
  for (const { re, button } of DOMAIN_BUTTONS) {
    if (re.test(t)) return { ...button };
  }
  return null;
}

/** Los 3 botones de la salida "no entendí" (WhatsApp admite 3). */
export function unknownFallbackButtons(text: string): InteractiveButton[] {
  const domain = detectDomainButton(text) ?? { ...STEP_BY_STEP };
  const buttons = [domain, { ...MENU }, { ...SUPPORT }];
  console.log(`[UNKNOWN_FALLBACK] botones=${buttons.map(b => b.id).join(',')} raw="${text.slice(0, 60)}"`);
  return buttons;
}

/** Item interactivo listo para apilar detrás del texto de "no entendí". */
export function unknownFallbackItem(text: string, body: string = UNKNOWN_FALLBACK_BODY): BotResponseItem {
  return { type: 'interactive', interactive: { type: 'buttons', body, buttons: unknownFallbackButtons(text) } };
}

/** Todos los botones que este módulo puede emitir (para el test de catálogo). */
export function allUnknownFallbackButtons(): InteractiveButton[] {
  return [...DOMAIN_BUTTONS.map(d => d.button), STEP_BY_STEP, MENU, SUPPORT];
}
