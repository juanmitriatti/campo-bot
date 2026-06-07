import type { PendingPlotAreaStore, PendingPlotArea } from './pending-plot-area.js';
import type { FinancialService } from '../domain/financial/financial.service.js';

export interface PendingPlotAreaResult {
  messages: string[];
  handled: boolean; // true = message consumed (don't fall through to pipeline)
}

export function parseHectares(text: string): number | null {
  // Decimal comma → dot, then pull every number out. A bare parseFloat takes the
  // FIRST token, which breaks mid-message corrections like "40, ah no eran 60"
  // (the user means 60). When a correction cue is present, prefer the LAST number.
  const cleaned = text.replace(/,/g, '.');
  const nums = cleaned.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  const hasCorrection = /\b(no|perd[oó]n|en\s+realidad|eran?|mejor\s+dicho|quise\s+decir|digo)\b/i.test(text);
  const pick = hasCorrection ? nums[nums.length - 1] : nums[0];
  const val = parseFloat(pick);
  if (isNaN(val) || val <= 0 || val >= 100000) return null;
  return val;
}

function isCancelIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return ['cancelar', 'cancel', 'salir', 'parar', 'basta', 'chau', 'terminar'].includes(lower);
}

// User wants to defer THIS lote's hectares (leave it null, move on) — distinct
// from cancelling the whole queue. Plain "no" counts as a skip here.
function isSkipIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (['no', 'no se', 'no sé', 'nose', 'ni idea', 'ni idea no se', 'skip', 'saltar', 'salteala', 'saltala', 'paso', 'despues', 'después', 'luego', 'mas tarde', 'más tarde', 'after', 'omitir', 'la cargo despues', 'la cargo después', 'lo cargo despues', 'lo cargo después'].includes(lower)) return true;
  return /\b(no\s+s[eé]|despu[eé]s|m[aá]s\s+tarde|ni\s+idea|la\s+cargo\s+despu[eé]s|lo\s+cargo\s+despu[eé]s)\b/.test(lower);
}

// The message looks like a DIFFERENT action (a gasto/venta/actividad), not an
// answer to "¿cuántas hectáreas?". When detected we bail out of the queue so the
// real action gets processed instead of being eaten / mis-saved as hectares.
function looksLikeOtherAction(text: string): boolean {
  // Strip accents FIRST — a trailing \b after an accented char ("gasté") fails
  // because é isn't a \w, so the verb would never match. Normalize to plain ASCII.
  const lower = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Financial / agro / livestock action verbs that clearly aren't a has answer.
  const actionVerb = /\b(gaste|pague|compre|abone|vendi|cobre|ingres[eo]|facture|sembre|fumig[uoe]|fertilice|coseche|llovio|cayo|agrega|suma|carga|registra|anota|borra|elimina|saca|tengo|hay|nacieron|nacio|pario|parieron|vacune|desparasite|pese|eche)\b/;
  if (actionVerb.test(lower)) return true;
  // A money/unit token strongly implies a financial/stock entry, not a plot
  // size. (Deliberately excludes "mil/palos/lucas" — those are ambiguous with
  // large hectárea figures; financial uses of them carry a verb anyway.)
  if (/\b(pesos?|dolares?|usd|kg|kilos?|toneladas?|tn|litros?|bolsas?|qq)\b/.test(lower)) return true;
  // A number + a livestock/registration noun is never a plot size
  // ("tengo 100 vacas en el lote Uno" was setting the lote to 100 ha and
  // dropping the animals).
  if (/\d/.test(lower) && /\b(vacas?|novillos?|novillitos?|terneros?|terneras?|toros?|toritos?|vaquillonas?|bueyes?|animales?|cabezas?)\b/.test(lower)) return true;
  // "...en (el) lote/potrero X" — the user is naming a DIFFERENT lote, not
  // answering the area for the one we asked about.
  if (/\ben\s+(?:el\s+|los\s+)?(?:lote|potrero|parcela)\s+\S+/.test(lower)) return true;
  return false;
}

// Is this message a plausible answer to "how many hectares?" — i.e. a (mostly)
// bare number, optionally with unit words / filler / a correction cue? We strip
// every digit, unit word, connector and correction word; if NOTHING meaningful
// remains, it's a hectares answer. If real words survive ("crear depósito galpón
// 3"), it's a DIFFERENT intent and must NOT be eaten as an area — even though it
// contains a digit. This inverts the old "re-prompt on anything" trap.
function isBareHectaresAnswer(text: string): boolean {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!/\d/.test(t)) return false; // no number → not a hectares answer
  const residue = t
    .replace(/\d+(?:[.,]\d+)?/g, ' ')
    // units + connectors + filler + correction cues
    .replace(/\b(has?|hectareas?|hectarea|tiene|tienen|son|es|de|del|aprox|aproximadamente|como|mas|menos|o|y|el|la|lote|mide|alrededor|unas?|unos?|ah|no|nono|eran?|perdon|realidad|mejor|dicho|quise|decir|digo|seran?|cerca)\b/g, ' ')
    .replace(/[^a-z]/g, ' ')
    .trim();
  return residue.length === 0;
}

function buildPrompt(item: PendingPlotArea): string {
  const total = item.total ?? 1;
  const counter = total > 1 ? ` (${item.seq ?? 1} de ${total})` : '';
  const skipHint = total > 1 ? '\n_Podés responder todas juntas (ej: "Norte 40, Sur 30"), o escribir *saltar* para cargarla después._'
    : '\n_Escribí *saltar* si querés cargarla después._';
  return `📐 ¿Cuántas hectáreas tiene *${item.plotName}*?${counter}${skipHint}`;
}

// Parse a batch answer that pairs lote names with hectares, e.g.
// "Norte 40, Sur 30 y Este 80" → [{name:'Norte',ha:40}, ...].
function parseNamedAreas(text: string): Array<{ name: string; ha: number }> {
  const out: Array<{ name: string; ha: number }> = [];
  // Split on commas / " y " then look for "<name> <number>" or "<number> <name>".
  for (const chunk of text.split(/\s*,\s*|\s+y\s+/i)) {
    const c = chunk.trim();
    if (!c) continue;
    let m = c.match(/^(.+?)[\s:]+(\d+(?:[.,]\d+)?)\s*(?:has?\.?|hect[aá]reas?)?$/i);
    if (!m) m = c.match(/^(\d+(?:[.,]\d+)?)\s*(?:has?\.?|hect[aá]reas?)?\s+(.+)$/i);
    if (!m) continue;
    const nameRaw = isNaN(Number(m[1].replace(',', '.'))) ? m[1] : m[2];
    const numRaw = isNaN(Number(m[1].replace(',', '.'))) ? m[2] : m[1];
    const ha = parseFloat(numRaw.replace(',', '.'));
    const name = nameRaw.replace(/\b(lote|el|la)\b/gi, '').trim();
    if (name && ha > 0 && ha < 100000) out.push({ name, ha });
  }
  return out;
}

/**
 * Shared handler for pending plot area assignment.
 * Used by all 3 controllers (WhatsApp, Telegram, test-bot).
 *
 * Returns { handled: true } when the message was consumed (valid hectares, cancel, skip, or re-prompt).
 * Returns { handled: false } when the message is clearly another action — the queue is cleared and
 * the message falls through to the normal pipeline so the user can pivot freely.
 */
export async function handlePendingPlotArea(
  text: string,
  phone: string,
  store: PendingPlotAreaStore,
  financialService: FinancialService,
): Promise<PendingPlotAreaResult> {
  const pending = store.get(phone);
  if (!pending) {
    return { messages: [], handled: false };
  }

  // Cancel → clear entire queue
  if (isCancelIntent(text)) {
    store.clear(phone);
    return { messages: ['👍 Podés asignar las hectáreas después.'], handled: true };
  }

  // Skip THIS lote → leave null, advance to next
  if (isSkipIntent(text)) {
    const next = store.dequeueFirst(phone);
    if (next) {
      return { messages: [`👍 Dejé *${pending.plotName}* sin hectáreas por ahora.`, buildPrompt(next)], handled: true };
    }
    return { messages: [`👍 Dejé *${pending.plotName}* sin hectáreas por ahora. Podés cargarlas cuando quieras.`], handled: true };
  }

  // Pivot to another action (gasto/venta/actividad…) → bail out so the pipeline
  // handles it. Clear the queue and DON'T consume the message. Prevents the old
  // bug where "gasté 50000 en gasoil" set the lote to 50000 ha and dropped the
  // gasto. Fires on any action-verb/financial-unit signal even when the message
  // contains a number (50000 < 100000 used to slip through as a valid "area").
  if (looksLikeOtherAction(text)) {
    store.clear(phone);
    return { messages: [], handled: false };
  }

  // ── Batch: "todos/todas N" → apply N to every pending lote ──
  const bulkAll = text.match(/^\s*(?:para\s+)?(?:tod[oa]s)\s+(?:de\s+|en\s+)?(\d+(?:[.,]\d+)?)\s*(?:has?\.?|hect[aá]reas?)?\s*$/i);
  if (bulkAll) {
    const ha = parseFloat(bulkAll[1].replace(',', '.'));
    if (ha > 0 && ha < 100000) {
      const all = store.items(phone);
      for (const it of all) await financialService.setPlotArea(it.plotId, ha);
      store.clear(phone);
      return { messages: [`📍 Asigné *${ha} ha* a ${all.length} lote${all.length > 1 ? 's' : ''}: ${all.map(a => `*${a.plotName}*`).join(', ')}`], handled: true };
    }
  }

  // ── Batch: "Norte 40, Sur 30, Este 80" → match each by name ──
  const named = parseNamedAreas(text);
  if (named.length >= 2 || (named.length === 1 && /[,]|\sy\s/i.test(text))) {
    const all = store.items(phone);
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    const done: string[] = [];
    for (const pair of named) {
      const match = all.find(it => norm(it.plotName) === norm(pair.name));
      if (match) {
        await financialService.setPlotArea(match.plotId, pair.ha);
        store.removeByPlotId(phone, match.plotId);
        done.push(`*${match.plotName}* (${pair.ha} ha)`);
      }
    }
    if (done.length > 0) {
      const confirm = `📍 Cargué: ${done.join(', ')}`;
      const next = store.get(phone);
      if (next) return { messages: [confirm, buildPrompt(next)], handled: true };
      return { messages: [confirm], handled: true };
    }
  }

  // ── Is this even a hectares answer? ──
  // Positive matching: only stay inside the hectares interaction when the message
  // is a (mostly) bare number. Anything else — a command, a query, a greeting, a
  // sentence that merely happens to contain a digit ("creá el galpón 3") — must
  // NOT be trapped. We clear the queue and fall through so the pipeline handles it.
  // This kills the old "re-prompt forever, eat every following message" bug.
  if (!isBareHectaresAnswer(text)) {
    store.clear(phone);
    return { messages: [], handled: false };
  }

  // ── Bare-number answer for the current lote ──
  const hectares = parseHectares(text);
  if (hectares !== null) {
    await financialService.setPlotArea(pending.plotId, hectares);
    const confirmMsg = `📍 Lote *${pending.plotName}*: superficie actualizada a *${hectares} ha*`;
    const next = store.dequeueFirst(phone);
    if (next) return { messages: [confirmMsg, buildPrompt(next)], handled: true };
    return { messages: [confirmMsg], handled: true };
  }

  // Looked like a number but it's out of range (0, negative, ≥100000) → re-prompt,
  // keep the queue so the user can retry. (Genuine number-fumble, not a pivot.)
  return {
    messages: [`Ingresá un número válido de hectáreas para *${pending.plotName}*.\nEj: *150* o *150 ha*\n\nEscribí *saltar* para cargarla después, o *cancelar* para omitir todas.`],
    handled: true,
  };
}

/**
 * Process setPendingPlotArea / setPendingPlotAreaQueue sideEffects from a HandlerResponse.
 * Stores in the queue and returns a prompt message to append (or null).
 */
export function storePlotAreaSideEffects(
  phone: string,
  store: PendingPlotAreaStore,
  sideEffects: {
    setPendingPlotArea?: { plotId: number; plotName: string; fieldName: string };
    setPendingPlotAreaQueue?: Array<{ plotId: number; plotName: string; fieldName: string }>;
  } | undefined,
): string | null {
  if (!sideEffects) return null;

  const now = Date.now();

  if (sideEffects.setPendingPlotAreaQueue && sideEffects.setPendingPlotAreaQueue.length > 0) {
    const items = sideEffects.setPendingPlotAreaQueue.map(p => ({
      plotId: p.plotId, plotName: p.plotName, fieldName: p.fieldName, timestamp: now,
    }));
    store.setQueue(phone, items);
    const first = store.get(phone);
    return first ? buildPrompt(first) : null;
  }

  if (sideEffects.setPendingPlotArea) {
    const pa = sideEffects.setPendingPlotArea;
    store.set(phone, { plotId: pa.plotId, plotName: pa.plotName, fieldName: pa.fieldName, timestamp: now });
    const first = store.get(phone);
    return first ? buildPrompt(first) : null;
  }

  return null;
}
