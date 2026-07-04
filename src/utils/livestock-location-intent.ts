/**
 * livestock-location-intent.ts — Detector server-side de la intención de
 * ubicación de hacienda: ¿el animal va en un LOTE o en un FEEDLOT (corral)?
 *
 * Por qué existe: cuando el usuario agrega hacienda sin nombrar una ubicación
 * concreta y menciona "feedlot" / "no sé si lote o feedlot", el agente IA
 * resolvía la pregunta con texto suelto (respond_text) y la respuesta volvía
 * fresca al LLM → resultado NO determinístico (a veces lote, a veces feedlot).
 * Este detector deja que el HANDLER decida de forma determinística (botones
 * Lote/Feedlot para el caso ambiguo; feedlot directo cuando es inequívoco).
 *
 * Regla de oro del bot: ninguna pregunta al usuario puede ser texto suelto.
 */

export type LivestockLocationIntent = 'feedlot' | 'lote' | 'ambiguous' | 'none';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // quita tildes
}

// "feedlot", "feed lot", "engorde", "encierre/encierro", "a corral", "corral(es)"
const FEEDLOT_RE = /\b(?:feed\s?lots?|engord[ae]\w*|encierr\w+|corral(?:es)?)\b/;
// "lote(s)", "potrero(s)", "parcela(s)", "cuadro", "pastura", "pastizal"
const LOTE_RE = /\b(?:lotes?|potreros?|parcelas?|cuadros?|pasturas?|pastizal\w*)\b/;
// señales de duda explícita
const UNCERTAIN_RE = /\b(?:no\s+se|no\s+estoy\s+segur\w+|ni\s+idea|no\s+sabr[ií]a|no\s+sabe)\b/;

/**
 * Clasifica el mensaje del usuario en su intención de ubicación de hacienda.
 * Solo se consulta cuando el agente NO pasó plot ni corral concretos.
 *
 * - 'ambiguous' → menciona lote Y feedlot (o feedlot + duda explícita): mostrar
 *   botones [En un lote] [En un feedlot].
 * - 'feedlot'   → menciona feedlot/corral/engorde sin lote: ir a feedlot directo.
 * - 'lote'      → menciona lote/potrero sin feedlot: comportamiento de lote.
 * - 'none'      → sin señal: comportamiento actual (no agrega fricción).
 */
export function livestockLocationIntent(text: string | null | undefined): LivestockLocationIntent {
  if (!text) return 'none';
  const t = normalize(text);
  const hasFeedlot = FEEDLOT_RE.test(t);
  const hasLote = LOTE_RE.test(t);
  const uncertain = UNCERTAIN_RE.test(t);

  if (hasFeedlot && hasLote) return 'ambiguous';
  if (hasFeedlot && uncertain) return 'ambiguous';
  if (hasFeedlot) return 'feedlot';
  if (hasLote) return 'lote';
  return 'none';
}
