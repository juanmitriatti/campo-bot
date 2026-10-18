/**
 * Centralized conversational LEXICON — single source of truth for the synonym
 * sets that the deterministic correction/pivot/guard layer matches against.
 *
 * WHY THIS EXISTS: the same word-lists (correction cues, currency words, units,
 * delete verbs, copulas) were copy-pasted across ~10 regexes in
 * conversation-engine, pending-action-processor, pending-correction-interceptor
 * and conversation-guards. Adding a synonym meant editing every copy. Now a new
 * synonym is added in ONE place and every matcher benefits.
 *
 * All matchers are accent-insensitive (they normalize first), so "perdón" /
 * "perdon", "dólares" / "dolares", "más" / "mas" all match the same entry.
 */

/** Lowercase + strip accents/diacritics (keeps ñ→n collapse off — ñ is distinct). */
export function normLex(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Correction cues — "the user is correcting something they said".
// Add slang/variants HERE and every correction extractor picks them up.
// ─────────────────────────────────────────────────────────────────────────────
export const CORRECTION_CUES: readonly string[] = [
  'no', 'nop', 'nono', 'perdon', 'perdona', 'perdoname', 'disculpa', 'disculpame',
  'en realidad', 'realidad', 'mejor dicho', 'mas bien', 'mejor', 'cambio', 'cambia',
  'me equivoque', 'equivoque', 'corrijo', 'correccion', 'quise decir', 'queria decir',
  'uy', 'opa', 'ah no', 'mentira', 'esperate',
];

/** Regex-alternation fragment of the correction cues (accent-free, for embedding). */
export const CORRECTION_ALT = CORRECTION_CUES.map(c => c.replace(/ /g, '\\s+')).join('|');

/** Matches a leading correction cue (accent-insensitive). e.g. "perdón, ..." */
export const CORRECTION_PREFIX_RE = new RegExp(`^(?:${CORRECTION_ALT}),?\\s+`, 'i');

/** Does the text START with a correction cue? (normalized) */
export function startsWithCorrectionCue(text: string): boolean {
  return CORRECTION_PREFIX_RE.test(normLex(text));
}

/**
 * "perdón, quise decir 20" / "no, eran 20" / "me equivoqué, 20 vaquillonas":
 * el mensaje ENTERO es una corrección de cantidad. Devuelve el número, o null
 * si hay algo más (otro número, un verbo, un lote). Exige la marca de
 * corrección: "20" pelado es una respuesta, no una corrección.
 */
export function extractHeadCountCorrection(text: string): number | null {
  let t = normLex(text).trim().replace(/[.!¡]+$/g, '').trim();
  if (!t || t.length > 60 || !CORRECTION_PREFIX_RE.test(t + ' ')) return null;
  for (let i = 0; i < 3 && CORRECTION_PREFIX_RE.test(t + ' '); i++) {
    t = (t + ' ').replace(CORRECTION_PREFIX_RE, '').trim();
  }
  const m = t.match(/^(?:(?:eran|son|fueron|era|es)\s+)?(\d{1,5})(?:\s+(?:cabezas?|animales?|[a-zñ]+))?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * "movelos al corral 2" / "llevalos a la Loma" contestando "¿A qué lote o
 * corral muevo los N?": el verbo de mover repite la pregunta, lo que importa es
 * el destino. Devuelve el resto ("al corral 2"), o null si el mensaje no
 * arranca con un verbo de mover sobre "los/las" o si trae animales propios
 * (una cantidad o una caravana — eso es otro movimiento, no la respuesta).
 */
export function extractMoveDestinationAnswer(text: string): string | null {
  const t = normLex(text).trim().replace(/[.!¡]+$/g, '').trim();
  if (!t || t.length > 60) return null;
  const m = t.match(/^(?:move\w*|muev\w*|lleva\w*|pasa\w*|manda\w*|mete\w*)(?:\s+(?:los|las|a\s+(?:los|las)))?\s+((?:a|al|a\s+la|para|hacia|en)\b.+)$/);
  if (!m) return null;
  const rest = m[1].trim();
  if (/\d{5,}/.test(rest) || /\b\d+\s+(?:vacas?|novill\w*|terner\w*|toros?|vaquillonas?|animales?|cabezas?)\b/.test(rest)) return null;
  return rest;
}

/**
 * "soja de segunda" / "maíz de 2da" / "soja 1ra": el usuario dice si la gruesa
 * va detrás de una fina. 2 = de segunda, 1 = de primera, null = no lo dijo
 * (y la campaña lo infiere del antecesor, `inferCropOrder`). Exige el cultivo
 * pegado: "la segunda tanda" no es una soja de 2da.
 */
export function extractCropOrderCue(text: string | null | undefined): 1 | 2 | null {
  const t = normLex(text ?? '');
  const m = t.match(/\b(?:soja|soya|maiz|girasol|sorgo)\s+(?:de\s+)?(segunda|2da|2a|2\s*[°º]|primera|1ra|1a|1\s*[°º])(?=$|[\s,.;!?])/);
  if (!m) return null;
  return /^(segunda|2)/.test(m[1]) ? 2 : 1;
}

/**
 * Saca del texto los números que nombran una UBICACIÓN ("corral 2", "lote 5",
 * "potrero nº 3"): un número así nunca es una caravana. Sin esto "movelos al
 * corral 2" hizo que el validador reemplazara las 4 caravanas por «2».
 */
export function stripLocationNumbers(text: string): string {
  return text.replace(/\b(?:corral|lote|potrero|cuadro|parcela|manga)\s+(?:n(?:[°º.]|ro\.?)?\s*)?\d+\b/gi, ' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Copula / "was/were" cues — "eran 5000", "fue ayer", "salió 200".
// ─────────────────────────────────────────────────────────────────────────────
export const COPULA_CUES: readonly string[] = [
  'eran', 'era', 'fue', 'fueron', 'son', 'es', 'seran', 'seria', 'serian',
  'salio', 'salieron', 'costo', 'costaron', 'costaba', 'costaban', 'iban a ser', 'iba a ser',
];
/** Alternation fragment for embedding in larger regexes (already accent-free). */
export const COPULA_ALT = COPULA_CUES.map(c => c.replace(/ /g, '\\s+')).join('|');

// ─────────────────────────────────────────────────────────────────────────────
// Currency lexicon (incl. Argentine slang).
// ─────────────────────────────────────────────────────────────────────────────
export const CURRENCY_USD_TERMS: readonly string[] = [
  'dolar', 'dolares', 'usd', 'u$d', 'u$s', 'us$', 'verde', 'verdes', 'dolca', 'dolquis', 'green',
];
export const CURRENCY_ARS_TERMS: readonly string[] = [
  'peso', 'pesos', 'mango', 'mangos', 'moneda nacional', 'nacionales', 'ars', 'guita',
];
// Los términos se ESCAPAN ("u$s" sin escapar es "u" + fin de línea + "s" y no
// matchea nunca: «u$s 300» quedaba en pesos) y el borde es por lookaround, no
// \b: "us$" termina en un símbolo y \b no ve borde entre "$" y un espacio.
const termAlt = (terms: readonly string[]) => terms
  .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
  .join('|');
const USD_RE = new RegExp(`(?<![a-z0-9])(?:${termAlt(CURRENCY_USD_TERMS)})(?![a-z0-9])`, 'i');
const ARS_RE = new RegExp(`(?<![a-z0-9])(?:${termAlt(CURRENCY_ARS_TERMS)})(?![a-z0-9])`, 'i');

/** Detect a currency mention. Returns 'USD' | 'ARS' | null (accent-insensitive). */
export function detectCurrencyTerm(text: string): 'USD' | 'ARS' | null {
  const t = normLex(text);
  if (USD_RE.test(t)) return 'USD';
  if (ARS_RE.test(t)) return 'ARS';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agro dose/quantity units (NOT money). Used to tell "5 litros" (dose) from
// "5 mil" (money). Keep monetary multipliers OUT of here.
// ─────────────────────────────────────────────────────────────────────────────
export const UNIT_TERMS: readonly string[] = [
  'litros', 'litro', 'lts', 'lt', 'l', 'kg', 'kilos', 'kilo', 'cc', 'cm3', 'ml',
  'gramos', 'gr', 'g', 'tn', 'toneladas', 'tonelada', 'qq', 'quintales', 'quintal',
  'bolsas', 'bolsa', 'dosis', 'rollos', 'rollo', 'unidades', 'unidad', 'has', 'hectareas',
];
/** Capturing matcher: "<number> <unit>" → [_, number, unit]. */
export const QUANTITY_UNIT_RE = new RegExp(
  `\\b(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_TERMS.map(u => u.replace(/ /g, '\\s+')).join('|')})\\b`,
  'i',
);

/** Money hints — when present, a "correction" is about an AMOUNT, not a dose. */
export const MONEY_HINT_RE = /[$]|\bpesos?\b|\bd[oó]lar(?:es)?\b|\busd\b|\bmil\b|\bpalos?\b|\blucas?\b|\bmillon\w*\b|\bmango\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// Delete / undo verbs.
// ─────────────────────────────────────────────────────────────────────────────
export const DELETE_VERBS: readonly string[] = [
  'borr', 'elimin', 'saca', 'saque', 'quit', 'anul', 'deshac', 'remov',
];
const DELETE_RE = new RegExp(`\\b(?:${DELETE_VERBS.join('|')})\\w*`, 'i');
/** "dar de baja" is a multiword delete. */
const DELETE_PHRASE_RE = /\b(?:dar|dale|da)\s+de\s+baja\b/i;
export function hasDeleteVerb(text: string): boolean {
  const t = normLex(text);
  return DELETE_RE.test(t) || DELETE_PHRASE_RE.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferral — "después te digo" durante un pending (ronda 3, Jul 2026).
// El usuario difiere la respuesta a un slot pendiente. NO es cancelación (el
// pending se mantiene) ni una respuesta (no se consume como valor). Distinto
// de NON_ANSWER_RE del pending-processor: eso incluye saludos y preguntas;
// esto es SOLO la intención explícita de contestar más tarde.
// ─────────────────────────────────────────────────────────────────────────────
const DEFERRAL_RE = new RegExp(
  '^(?:' +
  [
    'despu[eé]s\\s+te\\s+(?:digo|paso|aviso|confirmo)',
    'despu[eé]s\\s+(?:veo|lo\\s+veo|me\\s+fijo)',
    'luego\\s+te\\s+(?:digo|paso|aviso)',
    'm[aá]s\\s+tarde(?:\\s+te\\s+(?:digo|paso|aviso))?',
    'ahora\\s+no(?:\\s+(?:s[eé]|puedo|tengo))?',
    'ma[ñn]ana\\s+te\\s+(?:digo|paso|aviso|confirmo)',
    'todav[ií]a\\s+no\\s+(?:s[eé]|lo\\s+s[eé]|lo\\s+tengo)',
    'no\\s+s[eé]\\s+todav[ií]a',
    'cuando\\s+(?:sepa|lo\\s+tenga|me\\s+entere)\\s+te\\s+(?:digo|paso|aviso)',
    'dejame\\s+(?:pensar|ver|fijarme)',
    'me\\s+fijo\\s+y\\s+te\\s+(?:digo|paso|aviso)',
  ].join('|') +
  ')\\b',
  'i',
);
/** ¿El mensaje es un "te contesto después" (diferir, no cancelar ni responder)? */
export function isDeferralIntent(text: string): boolean {
  return DEFERRAL_RE.test(normLex(text).trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip a leading correction cue AND a leading "en"/article from a short answer,
 * returning the bare referent. "no, en el Norte" → "Norte"; "mejor lote A1" → "A1".
 * Used so plot/field/category answers carrying a correction prefix aren't dropped.
 */
export function stripAnswerPrefix(text: string): string {
  return text
    .replace(CORRECTION_PREFIX_RE, '')
    // Asentimiento/adición: "sí, en Laguna" / "también en Laguna" — sin esto,
    // "también en Laguna" se tomaba como NOMBRE de lote y el bot ofrecía crear
    // el lote «también en Laguna» (QA agentes Ago 2026).
    .replace(/^(?:(?:s[ií]|dale|claro|obvio|ok|bueno)[,\s]+)?(?:tambi[eé]n\s+|y\s+)?/i, '')
    // "al Sur", "a la Loma", "para el Norte", "las del Sur" (HAC-14): el destino
    // o la ubicación también se contesta así y mataba la pregunta.
    .replace(/^(?:(?:el|l[ao]s?)\s+(?:del?|de\s+l[ao]s?)\s+)/i, '')
    .replace(/^(en\s+(?:el\s+|la\s+|los\s+|las\s+)?|al\s+|a\s+l[ao]s?\s+|a\s+|para\s+(?:el\s+|la\s+)?|hacia\s+(?:el\s+|la\s+)?|del\s+|de\s+l[ao]s?\s+|el\s+|la\s+)/i, '')
    .replace(/^(?:lote|corral|potrero)\s+(?=\S)/i, (m) => /^corral/i.test(m) ? m : '')
    .trim();
}

/**
 * Muletillas con las que la gente antepone el nombre de una entidad al
 * crearla: "agregar campo se llama El Rehue" / "campo que se llama X" /
 * "llamado X" / "de nombre X" / "con el nombre X". Devuelve solo el nombre.
 * Prod (Tomás, 6 sep 2026): quedó un campo llamado «se llama el rehue».
 * Fuente única — la usan el regex de add_field, el paso "nombre" del
 * field_flow y el re-enunciado dentro del flow.
 */
export function stripNameLeadIn(name: string): string {
  return name
    .trim()
    .replace(/^(?:que\s+)?se\s+llama\s+/i, '')
    .replace(/^(?:llamad[oa]|de\s+nombre|con\s+(?:el\s+)?nombre(?:\s+de)?|nombre)\s*:?\s+/i, '')
    .replace(/^["'«“”]+|["'»“”]+$/g, '')
    .trim();
}

/**
 * ¿La frase se refiere a TODO el grupo, sin número? "vacuné las vacas del Sur",
 * "desparasité todos los terneros", "eché los toros con el rodeo". Con artículo
 * definido plural y sin dígitos, el productor habla del grupo entero: preguntar
 * "¿A cuántos animales?" y perder el evento en el pivot siguiente fue lo que
 * pasó en el QA de prod (7 sep 2026). Con un número explícito NO aplica.
 */
/**
 * Igual que impliesWholeGroup pero ignorando el PESO: "pesé los terneros,
 * promedio 160 kg" es el grupo entero aunque tenga dígitos. Cualquier otro
 * número ("pesé 10 terneros, 160 kg") sigue siendo una cantidad explícita.
 */
export function impliesWholeGroupIgnoringWeight(text: string | null | undefined): boolean {
  if (!text) return false;
  const stripped = String(text)
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|kgs|kilos?|kilogramos?)\b/gi, ' ')
    .replace(/\bpromedio\s+(?:de\s+)?\d+(?:[.,]\d+)?\b/gi, ' promedio ');
  return impliesWholeGroup(stripped);
}

export function impliesWholeGroup(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = normLex(text);
  if (/\d/.test(t)) return false;
  if (/\b(?:tod[ao]s?|el\s+rodeo|la\s+tropa|todo\s+el\s+lote|el\s+lote\s+entero|la\s+majada)\b/.test(t)) return true;
  return /\b(?:l[ao]s)\s+(?:vacas?|novill[oa]s?|novillit[oa]s?|terner[oa]s?|tor[oa]s?|torit[oa]s?|vaquillonas?|vaquillas?|animales|cabezas|ovejas?|corderos?|carneros?|chanchos?|cerd[oa]s?|yeguas?|caballos?|cabras?)\b/.test(t);
}

/**
 * ¿El número N aparece en el texto SOLO como superficie ("5 hectáreas", "5 ha",
 * "5has")? Entonces no puede ser una cantidad de animales/insumos.
 *
 * "En 5 hectáreas de ese lote tengo vacas" → el agente registró 5 vacas (prod,
 * 8 sep 2026). El 5 es superficie; la cantidad de vacas no se dijo y el
 * handler tiene que preguntarla. Con "5 vacas en 5 hectáreas" NO aplica: el 5
 * también aparece como cantidad.
 */
export const AREA_UNIT_RE = /\s*(?:ha|has|hect[aá]reas?|hect\.?)\b/i;

export function numberOnlyAppearsAsArea(text: string | null | undefined, n: number): boolean {
  if (!text || !Number.isFinite(n)) return false;
  const re = /(\d+(?:[.,]\d+)?)/g;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(',', '.'));
    if (v !== n) continue;
    seen++;
    const after = text.slice(m.index + m[1].length);
    if (!AREA_UNIT_RE.test(after.slice(0, 12)) || !/^\s*(?:ha|has|hect)/i.test(after)) return false;
  }
  return seen > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formularios conversacionales (WhatsApp sin Flows, Sep 2026).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Omitir" un campo OPCIONAL del formulario conversacional. Nunca aplica a un
 * obligatorio (el colector lo re-pregunta). Incluye el "no" pelado: ante
 * "¿Es de algún lote? (opcional)", "no" significa "no, seguí".
 */
const SKIP_RE = /^(?:omit\w*|salt\w*|skip|pasa|paso|siguiente|no|nop|no se|ni idea|nada|ninguno|ninguna|sin\s+\w+|no\s+(?:importa|tengo|aplica|hace\s+falta|corresponde)|dejalo|deja|vacio|despues|luego)\.?$/;
export function isSkipAnswer(text: string): boolean {
  return SKIP_RE.test(normLex(text).trim().replace(/[!.,]+$/, ''));
}

/** Cancelar el formulario entero (NO incluye "no": eso omite o abre "Editar"). */
const FORM_CANCEL_RE = /^(?:cancel\w*|cancela(?:lo|r)?|sali(?:r)?|parar?|basta|terminar|descart\w*|olvidalo|olvidate|chau|no\s+quiero|dejalo\s+asi\s+no|no\s+lo\s+cargues)\.?$/;
export function isFormCancel(text: string): boolean {
  return FORM_CANCEL_RE.test(normLex(text).trim().replace(/[!.,]+$/, ''));
}

/**
 * Consultas por estado de siembra de los lotes (texto ya normalizado: minúsculas
 * sin acentos). "que lotes tengo sin sembrar" caía en el regex genérico de
 * list_plots ("q(ue)? lotes? tengo", sin anclar) y devolvía TODOS los lotes.
 *
 * - Fuerte: la frase sola ya es la pregunta ("sin sembrar", "me falta sembrar").
 * - Débil ("libres", "vacíos", "para sembrar"): solo con contexto de lote/ha,
 *   para no robar "días libres" o "tengo la tarde libre".
 */
const UNSOWN_STRONG = String.raw`sin\s+(?:sembrar|siembra|cultivos?|cultivar)|no\s+(?:est[aá]n?\s+|tienen?\s+|fueron\s+)?sembrad[oa]s?|(?:me\s+)?(?:falta|queda)n?\s+(?:por\s+)?sembrar|no\s+sembr[eé]|no\s+sembramos`;
const UNSOWN_WEAK = String.raw`libres?|vac[ií]os?|desocupad[oa]s?|disponibles?|para\s+sembrar`;
const PLOT_CONTEXT = String.raw`lotes?|has|hect[aá]reas?|superficie|campos?`;

export const UNSOWN_PLOTS_QUERY_RES: RegExp[] = [
  new RegExp(String.raw`\b(?:${UNSOWN_STRONG})\b`),
  new RegExp(String.raw`\b(?:${PLOT_CONTEXT})\b.*\b(?:${UNSOWN_WEAK})\b`),
];

/**
 * "qué lotes tengo sembrados" / "lotes con soja" → cultivos activos. El grupo 1,
 * si existe, es el cultivo nombrado.
 */
export const SOWN_PLOTS_QUERY_RES: RegExp[] = [
  /\blotes?\b(?:\s+\w+){0,3}\s+con\s+(soja|maiz|trigo|girasol|sorgo|cebada|avena|centeno|algodon|mani)\b/,
  /\blotes?\b(?:\s+\w+){0,3}\s+sembrad[oa]s\b/,
  /^(?:y\s+)?(?:que|cuanto|cuantas?|cuales)\s+(?:lotes\s+)?(?:tengo|hay|tenemos)\s+sembrad[oa]s?\b/,
];

/**
 * "unirme ABC123" / "acepto ABC123": canjear una invitación a un campo. El
 * grupo 1 es el código (6 caracteres, ver generateCode()). Lo usan el parser
 * (comando accept_invite) y el gate de canal no verificado del webhook.
 */
export const INVITE_ACCEPT_RE = /^(?:unirme|unirme\s+al?\s+campo|aceptar(?:\s+invitaci[oó]n)?|acepto)\s+([A-Za-z0-9]{6})\s*\.?$/i;

/**
 * "verificar 123456": vincular este WhatsApp a una cuenta web. El texto lo
 * arma `whatsappVerifyText()` y llega por el link wa.me de Mi cuenta — el bot
 * no le puede mandar el código a un número que nunca le escribió (ventana de
 * 24 h de Meta). Grupo 1 = el código de 6 dígitos. Lo usa el webhook ANTES del
 * gate de canal no verificado, que es justo el estado de quien se vincula.
 */
// Grupo 1: 6 dígitos (código atado a un número) o 10 caracteres con letras Y
// dígitos (código sin número, ver generateWaToken en channel-verification
// .service) — "verificar herbicidas" no es un código.
export const WHATSAPP_VERIFY_RE = /^(?:verificar|vincular|c[oó]digo)\s*:?\s*(\d{6}|(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{10})\s*\.?$/i;

/**
 * "borrar mi cuenta" / "darme de baja": baja de la cuenta por chat. Anclado a
 * la frase entera — "borrar mi cuenta de gastos" no es esto. Lo usa el parser
 * (comando delete_my_account); la baja SIEMPRE pasa por un botón de un uso.
 */
export const DELETE_MY_ACCOUNT_RE = /^(?:quiero\s+|quisiera\s+)?(?:borrar|eliminar|cerrar|dar\s+de\s+baja)\s+(?:mi\s+|la\s+)?cuenta(?:\s+de\s+miagro)?\s*\.?$|^(?:quiero\s+)?darme\s+de\s+baja(?:\s+de\s+miagro)?\s*\.?$|^baja\s+de\s+(?:mi\s+)?cuenta\s*\.?$/i;

export function whatsappVerifyText(code: string): string {
  return `verificar ${code}`;
}

/** "editar" / "corregir el monto" escrito en el resumen de un formulario (texto normalizado). */
export const FORM_EDIT_RE = /^(?:editar?|edita|corregir?|corregi|cambiar?|cambia|modificar?|modifica)\b/;

/** "Retomar"/"volvamos al gasto": retomar un formulario a medio cargar. */
export const RESUME_FORM_RE = /^(?:(?:dale\s+)?(?:retom\w*|segui\w*|sigamos|continu\w*|volv\w*)(?:\s+(?:con|a|al|a\s+la))?\s*(?:el|la|lo)?\s*(?:formulario|form|carga|registro)?\s*(?:de(?:l)?\s+(?:la\s+|el\s+)?)?(siembra|cosecha|gastos?|ingresos?|labor(?:es)?|hacienda)?)$/;

/** Palabra del formulario → acción (para "formulario de gasto" / "volvamos al gasto"). */
export function formActionFromWord(word: string | null | undefined): 'sow_crop' | 'harvest_crop' | 'log_expense' | 'log_income' | 'log_activity' | 'add_livestock' | null {
  const w = normLex(word ?? '').trim();
  if (!w) return null;
  if (w.startsWith('siembr')) return 'sow_crop';
  if (w.startsWith('cosech')) return 'harvest_crop';
  if (w.startsWith('gast')) return 'log_expense';
  if (w.startsWith('ingres')) return 'log_income';
  if (w.startsWith('labor')) return 'log_activity';
  if (w.startsWith('hacienda')) return 'add_livestock';
  return null;
}

/**
 * Palabras con las que el usuario NOMBRA un dato de un formulario al corregirlo
 * en el resumen ("el monto era 300 mil", "el lote es el Sur"). Clave = key del
 * campo en la FormDefinition; texto normalizado (normLex). En el resumen, un
 * dato que se reconoce por NOMBRE de entidad (lote, categoría, cultivo…) o que
 * es texto libre solo se corrige si la frase lo nombra: «viento del norte»
 * cambiaba el lote a Norte (QA formularios, oct 2026).
 */
export const FORM_FIELD_CUES: Record<string, RegExp> = {
  plot_id: /\b(lote|campo|corral|potrero|ubicacion)\b/,
  location: /\b(lote|campo|corral|potrero|ubicacion)\b/,
  crop: /\bcultivo\b/,
  event_date: /\b(fecha|dia)\b/,
  hectares: /\b(hectareas?|has?|superficie)\b/,
  variety: /\bvariedad\b/,
  yield_kg_per_ha: /\b(rinde|rindio|rendimiento)\b/,
  yield_kg: /\b(rinde|rindio|rendimiento|total|kilos)\b/,
  humidity_pct: /\bhumedad\b/,
  loads: /\b(cargas?|camion(?:es)?)\b/,
  amount: /\b(monto|importe|valor|plata)\b/,
  currency: /\bmoneda\b/,
  category: /\b(categoria|rubro|tipo)\b/,
  description: /\b(detalle|descripcion)\b/,
  activity_type: /\b(labor|actividad|tipo)\b/,
  product: /\b(producto|implemento)\b/,
  quantity: /\b(dosis|cantidad)\b/,
  unit: /\bunidad\b/,
  notes: /\b(observacion(?:es)?|notas?)\b/,
  count: /\b(cabezas|cantidad|animales)\b/,
  breed: /\braza\b/,
  unit_price: /\bprecio\b/,
  buyer: /\b(comprador|acopio|cliente)\b/,
  quantity_tn: /\b(toneladas?|tn|cantidad)\b/,
};

export function namesFormField(text: string, fieldKey: string): boolean {
  const re = FORM_FIELD_CUES[fieldKey];
  return !!re && re.test(normLex(text));
}

/**
 * Saca la etiqueta y la cópula del arranque de una corrección:
 * "no, el detalle era compra en YPF" → "compra en YPF". null si la frase no
 * ARRANCA nombrando el campo (para texto libre no hay otra forma segura de
 * saber dónde empieza el valor).
 */
export function stripFieldCue(text: string, fieldKey: string): string | null {
  const cue = FORM_FIELD_CUES[fieldKey];
  if (!cue) return null;
  const original = text.trimStart();
  const norm = normLex(original);
  const re = new RegExp(
    String.raw`^(?:(?:${CORRECTION_ALT}),?\s+)?(?:(?:el|la|los|las|en|de)\s+)?(?:${cue.source})\s*(?:(?:es|era|eran|fue|fueron|son|va|van|iba)\b|:)?\s*`,
  );
  const m = re.exec(norm);
  if (!m) return null;
  // normLex conserva el largo (minúsculas + sin tildes), así que el corte vale
  // sobre el texto original y el valor no pierde mayúsculas ni acentos.
  const rest = original.slice(m[0].length).trim();
  return rest || null;
}

/**
 * Verbos del MISMO dominio que un formulario abierto: "gasté 200 lucas de
 * gasoil" dentro del formulario de gasto es una RESPUESTA (se mergea), no un
 * pivot. Un verbo de OTRO dominio ("llovió 20 mm") parquea el formulario.
 */
export const FORM_DOMAIN_VERBS: Record<string, RegExp> = {
  log_expense: /\b(gast\w*|pagu\w*|pago|compr\w*|abon\w*|carg\w*|anot\w*|registr\w*)\b/,
  log_income: /\b(vend\w*|cobr\w*|ingres\w*|factur\w*|carg\w*|anot\w*|registr\w*)\b/,
  sow_crop: /\b(sembr\w*|siembr\w*|plant\w*|carg\w*|anot\w*|registr\w*)\b/,
  harvest_crop: /\b(cosech\w*|trill\w*|rindi\w*|carg\w*|anot\w*|registr\w*)\b/,
  log_activity: /\b(fumig\w*|pulveri\w*|aplic\w*|fertili\w*|labr\w*|rastr\w*|are|regu\w*|rieg\w*|carg\w*|anot\w*|registr\w*)\b/,
  add_livestock: /\b(compr\w*|entr\w*|ingres\w*|carg\w*|agreg\w*|anot\w*|registr\w*)\b/,
};
export function matchesFormDomainVerb(action: string, text: string): boolean {
  const re = FORM_DOMAIN_VERBS[action];
  return !!re && re.test(normLex(text));
}

/**
 * Verbo con el que el usuario REGISTRA cada tipo de actividad pendiente. Sirve
 * para saber si un mensaje nuevo re-enuncia la misma actividad que quedó a
 * medio preguntar ("Sembré soja en el campo 2" con la siembra de soja sin lote):
 * en ese caso no corresponde avisar "dejé pendiente la siembra", porque el
 * mensaje nuevo LA reemplaza (prod 12 oct 2026).
 */
const REGISTRATION_VERB_BY_COMMAND: Record<string, RegExp> = {
  sow_crop: /\b(?:sembr\w*|siembr\w*)\b/,
  harvest_crop: /\b(?:cosech\w*|trill\w*)\b/,
  log_spraying: /\b(?:fumig\w*|pulveri\w*|aplic\w*)\b/,
  log_fertilization: /\b(?:fertili\w*)\b/,
  log_tillage: /\b(?:labr\w*|rastr\w*|are|aramos|disque\w*|cincel\w*)\b/,
  log_irrigation: /\b(?:rieg\w*|regu\w*|regamos)\b/,
  log_health_event: /\b(?:vacun\w*|desparasit\w*)\b/,
  log_rainfall: /\b(?:llov\w*|lluvia\w*)\b/,
};
export function mentionsRegistrationOf(command: string, text: string): boolean {
  const re = REGISTRATION_VERB_BY_COMMAND[command];
  return !!re && re.test(normLex(text));
}

// ─────────────────────────────────────────────────────────────────────────────
// Respuesta COLECTIVA a "¿En qué lote?": "todos", "en todos los lotes", "los
// tres", "ambos", "todo el campo". La resuelve resolvePlotListAnswer
// (entity-matcher) contra los lotes del campo de la pregunta. Prod 12 oct 2026:
// "En todos" y "En los tres lotes" se buscaron como lotes llamados «todos» y
// «tres lotes».
// ─────────────────────────────────────────────────────────────────────────────
const COLLECTIVE_PLOT_ANSWER_RE = /^(?:(?:en|a|para)\s+)?(?:(?:todos|todas)(?:\s+(?:los|las))?|ambos|ambas|los\s+(\w+)|las\s+(\w+)|todo\s+el\s+campo|el\s+campo\s+entero|el\s+campo\s+completo)(?:\s+(?:lotes?|potreros?|cuadros?))?(?:\s+(?:del?\s+)?(?:este\s+)?campo(?:\s+\S+)?)?\s*[.!]*$/;

/**
 * ¿La respuesta nombra TODOS los lotes en vez de uno? Devuelve la cantidad que
 * dijo ("los tres" → 3), `'all'` sin cantidad ("todos", "todo el campo") o null
 * si no es una respuesta colectiva. "los del norte" no es colectiva.
 */
export function collectivePlotAnswer(text: string): number | 'all' | null {
  const t = normLex(text.trim());
  const m = COLLECTIVE_PLOT_ANSWER_RE.exec(t);
  if (!m) return null;
  const word = m[1] ?? m[2];
  if (word == null) return /\b(?:ambos|ambas)\b/.test(t) ? 2 : 'all';
  const n = /^\d+$/.test(word) ? Number(word) : COLLECTIVE_COUNT_WORDS[word];
  return n != null && n >= 2 ? n : null;
}
const COLLECTIVE_COUNT_WORDS: Record<string, number> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

/**
 * ¿El texto tiene ALGÚN cuantificador de totalidad (todo, todos, ambos, entero,
 * completo, cada, "los tres", "los 3")? Respaldo mínimo para el `all_plots` del
 * agente: la frase la interpreta el agente; esto solo descarta el flag cuando
 * no hay ninguna palabra que lo sostenga. Prueba local 14 oct 2026: "Coseché en
 * el campo 1" llegó con all_plots y cosechó los dos lotes del campo.
 */
export function hasWholeQuantifier(text: string): boolean {
  const t = normLex(text);
  return /\b(?:tod[oa]s?|ambos|ambas|enter[oa]|complet[oa]|cada)\b/.test(t)
    || /\b(?:los|las)\s+(?:\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/.test(t);
}

/** Tipo de labor por verbo/sustantivo (form de labores). */
export function detectActivityTypeTerm(text: string): 'spraying' | 'fertilization' | 'tillage' | 'irrigation' | null {
  const t = normLex(text);
  if (/\b(fumig\w*|pulveri\w*|aplicacion|herbicid\w*|curasemill\w*)\b/.test(t)) return 'spraying';
  if (/\b(fertili\w*|abon\w*)\b/.test(t)) return 'fertilization';
  if (/\b(labr\w*|rastr\w*|disc\w*|cincel\w*|are|arada|arado|escarific\w*)\b/.test(t)) return 'tillage';
  if (/\b(rieg\w*|regu\w*|regamos|regar)\b/.test(t)) return 'irrigation';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Superficie ADICIONAL: "sembré otras 60 ha", "60 ha más", "el resto del lote".
// Distingue una segunda tanda de siembra (se suma) de un re-envío del mismo
// mensaje (no se suma). AGR-8, auditoría oct 2026.
// ─────────────────────────────────────────────────────────────────────────────
export function mentionsAdditionalArea(text: string): boolean {
  const t = normLex(text);
  return /\b(otras?|otros|el\s+resto|lo\s+que\s+falta(ba)?|restantes?)\b/.test(t)
    || /\b\d+(?:[.,]\d+)?\s*(ha|has|hectareas?)\s+mas\b/.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan futuro SIN nada hecho (invariante 12): "el sábado fumigo el Norte",
// "mañana tengo que pagar el flete", "hay que vacunar la semana que viene".
// Es la red del servidor cuando el agente igual llama una tool que REGISTRA
// (AGR-16). Conservador: cualquier verbo en pasado o marca de pasado ("ayer",
// "fumigué", "cosecharon") lo descarta — perder un registro real es peor que
// dejar pasar un plan.
// ─────────────────────────────────────────────────────────────────────────────
const FUTURE_PLAN_MARKER_RE = /\b(voy\s+a|vamos\s+a|van\s+a|tengo\s+que|tenemos\s+que|hay\s+que|manana|pasado\s+manana|que\s+viene|proxim[oa]s?|tengo\s+pensado|planeo|pienso|acordame|recordame)\b/;
const WEEKDAY_RE = /\b(el|este|el\s+proximo)\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo|finde|fin\s+de\s+semana)\b/;
// Solo primera singular: "sembramos", "pagamos" también son pretérito.
const PRESENT_AGRO_VERB_RE = /\b(fumigo|siembro|cosecho|aplico|fertilizo|vacuno|pago|vendo|compro|cargo)\b/;
const PAST_MARKER_RE = /\b(ayer|anteayer|anoche|hace\s+\d+|la\s+semana\s+pasada|el\s+mes\s+pasado|pasado\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)|(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+pasado)\b/;

export function isFuturePlanOnly(text: string): boolean {
  const raw = text.toLowerCase();
  // Pretérito con tilde ("fumigué", "sembró", "pagué") o plural ("cosecharon", "vinieron").
  if (/[a-zñ]{2,}(é|ó)(?![a-zñáéíóú])/.test(raw)) return false;
  const t = normLex(text);
  if (/\b[a-zñ]{3,}(aron|ieron)\b/.test(t)) return false;
  if (PAST_MARKER_RE.test(t)) return false;
  if (FUTURE_PLAN_MARKER_RE.test(t)) return true;
  return WEEKDAY_RE.test(t) && PRESENT_AGRO_VERB_RE.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Destino de un camión que es ALMACENAJE PROPIO (silo, silo bolsa, galpón,
// "al campo"), no un acopiador. Anclado a todo el destinatario: «Agro Campo SA»
// o «Acopio La Casa» son acopiadores y antes contaban como silo propio (AGR-14).
// ─────────────────────────────────────────────────────────────────────────────
export function isOwnStorageDestination(destinatario: string | null | undefined): boolean {
  const t = normLex(destinatario ?? '').trim();
  if (!t) return false;
  return /^(al\s+|el\s+|en\s+(el\s+)?|a\s+la\s+)?(silo(\s*bolsa)?s?|silobolsas?|bolsas?|silo\s+propio|propio|galpon(\s+propio)?|planta\s+propia|campo|casa)(\s+propi[oa])?$/.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pedido de SOPORTE y FRUSTRACIÓN con el bot (oct 2026). Antes "quiero hablar
// con una persona" o "no me entendés nada" caían en el agente o en el fallback
// conversacional, que sugería... escribir *menú*. Es la ventana de abandono:
// ahí hay que mostrar el canal de soporte y dejar el mensaje anotado.
// Ambos anclados y cortos: "hablar con alguien de Cargill" NO es soporte.
// Se matchean sobre texto normalizado (sin tildes) pero toleran tildes igual.
// ─────────────────────────────────────────────────────────────────────────────
export const SUPPORT_REQUEST_RE =
  /^(?:(?:hola|che|buenas)[\s,]+)?(?:quiero|quisiera|necesito|me\s+gustar[ií]a|(?:me\s+)?pod(?:[eé]s|r[ií]as?|r[ií]an)|pueden|puedo|c[oó]mo\s+(?:hago\s+para|puedo))?\s*(?:hablar|contactar(?:me)?|comunicar(?:me)?|escribir(?:le|les)?|chatear)\s+(?:con\s+)?(?:una?\s+|el\s+|la\s+|los\s+)?(?:persona|humano|humana|alguien|operador[a]?|soporte|equipo|gente|desarrollador(?:es)?|due[ñn]o|responsable)(?:\s+(?:real|de\s+verdad|del\s+equipo|de\s+soporte|de\s+miagro|del\s+bot|que\s+me\s+ayude|humana?))?\s*[.!?]*$|^(?:(?:hola|che|buenas)[\s,]+)?(?:quiero\s+|necesito\s+|pedir\s+|tengo\s+(?:una?\s+)?|quiero\s+hacer\s+(?:una?\s+)?)?(?:soporte(?:\s+t[eé]cnico)?|ayuda\s+humana|atenci[oó]n\s+al\s+cliente|servicio\s+al\s+cliente|contacto(?:\s+de\s+soporte)?|reclamo|queja|hablar\s+con\s+soporte|tel[eé]fono\s+de\s+contacto|mail\s+de\s+contacto)\s*[.!?]*$/i;

export const FRUSTRATION_RE =
  /^(?:(?:che|pero|uf+|bueno|ay|dale|otra\s+vez|de\s+nuevo)[\s,]+)*(?:no\s+(?:me\s+)?(?:entend[eé]s|entiendes|entendiste|entend[ií]s|est[aá]s\s+entendiendo)(?:\s+(?:nada|un\s+carajo|una\s+mierda|ni\s+ahi|ni\s+ah[ií]|nada\s+de\s+nada|lo\s+que\s+te\s+digo|lo\s+que\s+digo))?|no\s+(?:me\s+)?(?:sirve[s]?|serv[ií]s)(?:\s+(?:para|de)\s+nada)?|(?:esto|este\s+bot|el\s+bot|la\s+app|vos)\s+no\s+(?:sirve|funciona|anda|va|me\s+sirve|me\s+entiende|entiende\s+nada|entiende)(?:\s+(?:nada|bien|m[aá]s|para\s+nada))?|no\s+(?:funciona|anda)(?:\s+(?:nada|bien|esto|este\s+bot|el\s+bot|la\s+app))?|(?:sos|eres|es|son)\s+(?:un\s+|una\s+|re\s+|muy\s+)?(?:in[uú]til|desastre|mal[ií]simo|p[eé]simo|porquer[ií]a|mierda|cagada|bot\s+in[uú]til|bot\s+de\s+mierda|una\s+cagada|una\s+porquer[ií]a)|qu[eé]\s+(?:bot\s+)?(?:in[uú]til|malo|desastre|porquer[ií]a|cagada|mierda)(?:\s+(?:que\s+)?(?:sos|es|eres))?|no\s+(?:te\s+)?entiendo\s+(?:nada\s+)?(?:de\s+)?(?:lo\s+que\s+(?:dec[ií]s|hac[eé]s|me\s+dec[ií]s)|c[oó]mo\s+(?:funciona|funcion[aá]s|se\s+usa|te\s+uso)|esto|este\s+bot|nada)|me\s+(?:ten[eé]s|tiene|tienen|tengo)\s+(?:re\s+)?(?:podrido|harto|harta|cansado|cansada)|dej[aá]\s+de\s+(?:preguntar(?:me)?|repetir|decir\s+lo\s+mismo)(?:\s+lo\s+mismo)?|siempre\s+(?:me\s+)?(?:dec[ií]s|respond[eé]s)\s+lo\s+mismo|no\s+me\s+ayud[aá]s(?:\s+en\s+nada)?|no\s+hac[eé]s\s+nada|no\s+pod[eé]s\s+(?:hacer\s+)?nada)\s*[.!?]*$/i;

/** true si el texto es un pedido de soporte o una queja contra el bot (ambos
 *  anclados: un mensaje largo con contenido propio NO matchea). */
export function isSupportOrFrustration(text: string): { support: boolean; frustrated: boolean } {
  const t = normLex(text).replace(/[¡!¿]/g, '').replace(/\s{2,}/g, ' ').trim();
  const frustrated = FRUSTRATION_RE.test(t);
  const support = frustrated || SUPPORT_REQUEST_RE.test(t);
  return { support, frustrated };
}
