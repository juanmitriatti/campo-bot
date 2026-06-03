// ============================================================================
// Text Normalizer — Audio transcription normalization
// ============================================================================

/**
 * Normalize raw STT (speech-to-text) transcription output.
 * Strips artifacts that break intent detection: random punctuation,
 * accents, filler words, repeated words, and odd casing.
 * Applied ONLY to audio messages, never to typed text.
 */
export function normalizeTranscript(text) {
  let result = text;
  // 1. Lowercase + strip accents (NFD decomposition)
  result = result.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // 2. Strip emojis
  result = result.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}]/gu, '');
  // 2.5. Collapse thousands separators inside numbers BEFORE punctuation is
  // stripped, so dictated amounts like "100.000 dólares" (Whisper writes digits
  // with separators) aren't shattered into "100 000" — which the parser reads
  // as 100. Only fires on a separator sitting between a digit and a 3-digit
  // group, so decimals ("5.5", "13.5") and times ("3.30") are left intact.
  // Runs twice to cover chained groups ("1.000.000" → "1000000").
  for (let i = 0; i < 2; i++) result = result.replace(/(\d)[.,](?=\d{3}(?:\D|$))/g, '$1');
  // 3. Remove punctuation separators (. , ; : ! ¡ ¿ ?)
  result = result.replace(/[.,;:!¡¿?]+/g, ' ');
  // 4. Strip leading filler words (common Whisper artifacts in Spanish)
  result = result.replace(/^(?:(?:eh|este|em|bueno|a\s+ver|o\s+sea|digamos|mira|entonces|dale|ok(?:ay)?|bien)\s*)+/i, '');
  // 5. Remove repeated consecutive words ("el el lote" → "el lote")
  result = result.replace(/\b(\w+)\s+\1\b/gi, '$1');
  // 6. Normalize plot codes (Whisper bug: "a dos" → "a2", "lote tres" → "lote 3")
  result = normalizePlotNumbers(result);
  // 7. Collapse whitespace + trim
  result = result.replace(/\s{2,}/g, ' ').trim();
  return result;
}

/**
 * Strips common filler phrases from audio transcriptions before they reach
 * the parser. This allows voice messages like "mostrame info de mis lotes"
 * to match the same patterns as typed "mis lotes".
 */
export function stripFillerPhrases(text) {
  let cleaned = text;

  // "mostrame información de mis lotes" → "mis lotes"
  // "dame info de mis campos" → "mis campos"
  // "decime los datos del lote" → "lote"
  // "quiero la información de mis lotes" → "mis lotes"
  // BUT preserve "info lote 3", "info del campo norte", "datos del lote 5"
  // Lookahead includes optional de(l)? to prevent backtracking from stripping it
  cleaned = cleaned.replace(
    /^(?:(?:mostrame|dame|decime|pasame|quiero)\s+)?(?:(?:la\s+)?informaci[oó]n|info|datos?)\s+(?!(?:de(?:l)?\s+)?(?:(?:el|la)\s+)?(?:lot[e]?|campo|parcela)\b)(?:de(?:l)?\s+)?/i,
    ''
  );

  // "mostrame mis lotes" → "mis lotes"
  // "dame mis campos" → "mis campos"
  cleaned = cleaned.replace(
    /^(?:mostrame|dame|decime|pasame)\s+/i,
    ''
  );

  // "me podrias decirme el clima" → "el clima"
  // "me podes mostrar mis lotes" → "mis lotes"
  cleaned = cleaned.replace(
    /^(?:(?:me\s+)?(?:podrias?|podes|puedes)\s+(?:decir(?:me)?|mostrar(?:me)?|dar(?:me)?|pasar(?:me)?)\s+)/i,
    ''
  );

  // "quiero ver mis campos" → "mis campos"
  // "necesito saber el clima" → "el clima"
  cleaned = cleaned.replace(
    /^(?:quiero|quisiera|necesito)\s+(?:saber|ver|conocer)\s+/i,
    ''
  );

  // "la ciudad de Bragado" → "Bragado"
  // "la localidad de Junin" → "Junin"
  // "la zona de Pergamino" → "Pergamino"
  cleaned = cleaned.replace(/\bla\s+ciudad\s+de\s+/gi, '');
  cleaned = cleaned.replace(/\bla\s+localidad\s+de\s+/gi, '');
  cleaned = cleaned.replace(/\bla\s+zona\s+de\s+/gi, '');

  // "por favor" → strip
  cleaned = cleaned.replace(/\bpor\s+favor\b/gi, '');

  return cleaned.trim();
}

/**
 * Convert written numbers (uno–diez) to digits in lote/plot context.
 * Covers:
 *   "lote tres" → "lote 3"
 *   "lote a dos" → "lote a2" (alphanumeric plot codes — Whisper bug fix)
 *   "lote b uno" → "lote b1"
 *   "a tres" / "el a dos" tras "lote" → "a3" / "el a2"
 *
 * Does NOT affect counts like "compré tres bolsas" outside lote context.
 */
export function normalizePlotNumbers(text) {
  const NUMS = {
    uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5',
    seis: '6', siete: '7', ocho: '8', nueve: '9', diez: '10',
  };
  let result = text;
  // (a) "lote tres" → "lote 3"
  result = result.replace(
    /\blote\s+(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/gi,
    (_, n) => `lote ${NUMS[n.toLowerCase()]}`
  );
  // (b) "lote a dos" / "lote a tres" → "lote a2" / "lote a3" (alphanumeric codes,
  //     common Whisper artifact for plot names like A1/A2/B3/etc.)
  result = result.replace(
    /\blote\s+([a-z])\s+(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/gi,
    (_, letter, n) => `lote ${letter.toLowerCase()}${NUMS[n.toLowerCase()]}`
  );
  // (c) "el lote a dos" pattern after preposition (en, del, al, mi)
  result = result.replace(
    /\b(en|del|al|mi|el|la)\s+([a-z])\s+(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/gi,
    (m, prep, letter, n) => {
      // Only apply when followed/preceded by lote context. Safe heuristic:
      // letter must be a single character that could be a plot code.
      return `${prep} ${letter.toLowerCase()}${NUMS[n.toLowerCase()]}`;
    }
  );
  return result;
}
