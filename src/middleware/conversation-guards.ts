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

/**
 * At a "¿en qué lote?" step, the user explicitly wants to save WITHOUT a plot
 * (at field level): "sin lote", "no importa el lote", "a nivel campo", "dejalo
 * así", "como sea". Used so income/expense gets saved instead of looping on the
 * plot question forever (which silently dropped the record on pivot). Distinct
 * from a bare "no" (that's cancel, handled by isNegationOrCancel).
 */
export function wantsFieldLevelSave(text: string): boolean {
  const t = norm(text).replace(/[!.]+$/, '');
  const EXACT = new Set([
    'sin lote', 'a nivel campo', 'nivel campo', 'el campo', 'todo el campo',
    'no importa', 'no importa el lote', 'no interesa', 'no aplica', 'cualquiera',
    'cualquier lote', 'como sea', 'dejalo asi', 'asi nomas', 'sin asignar',
    'no se el lote', 'ningun lote', 'sin lugar', 'no se cual', 'da igual',
  ]);
  if (EXACT.has(t)) return true;
  return /\b(sin\s+lote|a\s+nivel\s+(?:de\s+)?campo|sin\s+asignar(?:lo)?|ning[uú]n\s+lote|no\s+importa\s+el\s+lote|dejalo\s+(?:asi|sin\s+lote)|da\s+igual\s+el\s+lote|cualquier\s+lote)\b/.test(t);
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
const QUERY_INTENT = /\b(clima|pronostico|va a llover|lluvia\?|temperatura|reporte|informe|resumen|como vamos|como venimos|cuanto|cuanta|cuantas|cuantos|que cultivo|que sembr|que lotes?|que campos?|lotes tengo|campos tengo|mis lotes|mis campos|mis gastos|mis ingresos|lista\w*|mostr\w*|stock|hacienda|cuanto gaste|cuanto cobre|saldo|balance|rinde|menu|ayuda)\b/;

/**
 * Broad, accent-safe "this message is a NEW action or a query — not an answer
 * to the pending/flow prompt". When true, the caller should ABANDON the open
 * pending/flow and let the message flow through the normal pipeline, instead of
 * consuming its number into the wrong slot or blocking it with a nudge.
 *
 * Deliberately conservative on bare answers: "40", "40 has", "lote norte",
 * "todos 40", "aftosa", "soja" do NOT match (no action verb, no query word).
 */
/**
 * The message carries no actionable text — empty, whitespace, or only
 * emojis/punctuation ("   ", "🚜🌽", "..."). Used to give a gentle hint instead
 * of a blank reply or a full greeting.
 */
export function isContentlessMessage(text: string): boolean {
  if (!text || !text.trim()) return true;
  const stripped = text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length === 0;
}

export function looksLikeNewActionOrQuery(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (ACTION_VERB.test(t)) return true;
  if (QUERY_INTENT.test(t)) return true;
  // Livestock registration ("tengo 100 vacas", "30 terneros", "120 cabezas") —
  // a number + an animal noun. Lets it abandon a stuck flow/pending (e.g. the
  // field-city step) instead of being swallowed as a bad locality.
  // EXCLUDE price-unit phrases: "X por cabeza / por animal / por vaca" is a
  // UNIT PRICE ("per head"), NOT a count — otherwise "500000 pesos por cabeza"
  // (a price answer to a livestock-purchase pending) escaped and corrupted the
  // last income via edit_last_income (seen live, Jun 2026).
  if (/\d/.test(t)
      && /\b(vacas?|novillos?|novillitos?|terneros?|terneras?|toros?|toritos?|vaquillonas?|bueyes?|animales?|cabezas?)\b/.test(t)
      && !/\b(por|la|el|cada)\s+(vaca|novillo\w*|ternero?\w*|toro|vaquillona|cabeza|animal)\b/.test(t)) return true;
  // A genuine multi-word question ("va a llover el finde?", "cuánto tengo?").
  if (/\?\s*$/.test(text.trim()) && t.split(/\s+/).length >= 3) return true;
  return false;
}

/**
 * Stricter sibling of looksLikeNewActionOrQuery: ONLY a genuine action verb or
 * query word counts — the bare number+animal heuristic and the trailing-question
 * heuristic are intentionally excluded.
 *
 * Used at financial-slot pendings (waiting for amount/price/quantity) where the
 * user's reply is EXPECTED to be money-shaped and may legitimately contain
 * animal/unit words ("500000 pesos por cabeza" = price per head). Only a real
 * new verb ("vendí 10 novillos a 800") or a query should abandon such a pending.
 */
export function hasActionVerbOrQuery(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  return ACTION_VERB.test(t) || QUERY_INTENT.test(t);
}

/**
 * Consulta read-only pura: tiene palabra de query y NINGÚN verbo de acción.
 * "cuánta hacienda tengo" → true; "vendí 10 novillos" → false; "cuánto gasté
 * y registrá 50 mil" → false (hay verbo).
 *
 * Usada en el escape de pendings: una consulta read-only en medio de un
 * pending recuperable (con missing[]) debe RESPONDERSE sin matar el pending —
 * paridad con los taps de botones, que nunca lo tocaban. Sin esto, "cuánta
 * hacienda tengo" en medio del "¿a cuánto fue la compra?" borraba el pending
 * y la respuesta de precio posterior iba al agente a ciegas (alucinó
 * edit_last_livestock → router null → silencio total, visto live Jun 2026).
 */
// Interrogativo inmediatamente antes (≤2 palabras) de un verbo de acción =
// pregunta sobre el PASADO ("cuánto gasté este mes", "qué sembré en el norte"),
// no una acción nueva.
const INTERROGATIVE_VERB_RE = /(^|\s)(cuanto|cuanta|cuantos|cuantas|que|cual|cuales|cuando|donde|como)\s+(\w+\s+){0,2}(gaste|pague|pago|compre|compro|vendi|vendo|cobre|cobro|ingrese|facture|sembre|plante|fumigue|fertilice|coseche|aplique|regue|pese|vacune|desparasite)\b/;

export function isReadOnlyQuery(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (!QUERY_INTENT.test(t)) return false;
  if (!ACTION_VERB.test(t)) return true;
  return INTERROGATIVE_VERB_RE.test(t);
}
