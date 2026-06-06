/**
 * Conversation guards — shared, ACCENT-SAFE helpers used by all 3 controllers
 * (whatsapp / telegram / test-bot) to decide what to do with a message that
 * arrives while a flow or pending action is open.
 *
 * Why accent-safe: the old detectors used `\b`-anchored accented verbs like
 * `/\bvend[ií]\b/`. In JS (no /u), an accented char isn't a word char, so the
 * trailing `\b` after "í" FAILS — "vendí 10 novillos a 800 USD" was NOT detected
 * as a new action, so its "10" leaked into a stuck "¿a cuántos animales?" pending
 * (silent corruption + data loss). Stripping accents first fixes the whole class.
 */

function norm(text: string): string {
  return (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/**
 * The user said "yes / go ahead / confirm". Used so an affirmation at a
 * plot-asking step means "register at field level" instead of being swallowed
 * by the global confirm handler (which would reply "nada pendiente" and drop
 * the record).
 */
export function isAffirmation(text: string): boolean {
  const t = norm(text).replace(/[!.]+$/, '');
  const EXACT = new Set([
    'si', 'sip', 'sii', 'siii', 'sisi', 'dale', 'ok', 'oka', 'okay', 'okey', 'oki',
    'listo', 'va', 'vale', 'de una', 'obvio', 'claro', 'correcto', 'exacto', 'exacto si',
    'perfecto', 'confirmo', 'confirmar', 'confirma', 'confirmalo', 'confirmado',
    'si confirmo', 'si dale', 'asi es', 'tal cual', 'eso', 'eso mismo', 'ya esta',
    'ya', 'aja', 'sep', 'sib', 'siiii',
  ]);
  if (EXACT.has(t)) return true;
  return /^(si|sip|dale|ok|oka|okey|listo|confirm\w*)\b/.test(t);
}

/** The user said "no / cancel". */
export function isNegationOrCancel(text: string): boolean {
  const t = norm(text).replace(/[!.]+$/, '');
  return ['no', 'nop', 'nope', 'cancelar', 'cancela', 'cancel', 'salir', 'parar',
    'basta', 'chau', 'terminar', 'dejalo', 'olvidalo', 'mejor no'].includes(t);
}

// Action verbs across ALL domains (financial, agro, livestock, stock, admin) —
// accent-STRIPPED forms, so no trailing-\b breakage. A message starting with /
// containing one of these is a NEW write, not an answer to the current prompt.
const ACTION_VERB = /\b(gaste|pague|pago|compre|compro|abone|vendi|vendo|cobre|cobro|ingrese|ingreso|facture|sembre|siembro|fumig\w*|fertilic\w*|cosech\w*|pulveric\w*|are|rastre|plante|plant\w*|regue|riegue|aplique|aplico|llovio|cayo(?:\s+\d|\s+agua|\s+lluvia)|nacio|nacieron|parieron|vacune|desparasite|cure|trate|insemine|destete|eche|pese|pesaron|pesamos|transferi|transfer\w*|pase|agrega|agregue|suma|sume|cargue|registre|registra|anote|anota|renombr\w*)\b/;

// Query / read intents — clima, reportes, listados, "¿cuánto…?". During a flow
// these mean "stop the registration and answer me", not flow input.
const QUERY_INTENT = /\b(clima|pronostico|va a llover|lluvia\?|temperatura|reporte|informe|resumen|como vamos|como venimos|cuanto|cuanta|cuantas|cuantos|que cultivo|que sembr|mis lotes|mis campos|mis gastos|mis ingresos|lista\w*|mostr\w*|stock|hacienda|cuanto gaste|cuanto cobre|saldo|balance|rinde|menu|ayuda)\b/;

/**
 * Broad, accent-safe "this message is a NEW action or a query — not an answer
 * to the pending/flow prompt". When true, the caller should ABANDON the open
 * pending/flow and let the message flow through the normal pipeline, instead of
 * consuming its number into the wrong slot or blocking it with a nudge.
 *
 * Deliberately conservative on bare answers: "40", "40 has", "lote norte",
 * "todos 40", "aftosa", "soja" do NOT match (no action verb, no query word).
 */
export function looksLikeNewActionOrQuery(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (ACTION_VERB.test(t)) return true;
  if (QUERY_INTENT.test(t)) return true;
  // A genuine multi-word question ("va a llover el finde?", "cuánto tengo?").
  if (/\?\s*$/.test(text.trim()) && t.split(/\s+/).length >= 3) return true;
  return false;
}
