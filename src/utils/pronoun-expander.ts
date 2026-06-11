/**
 * Expand pronoun references in user text to explicit lote names BEFORE
 * sending to the agent.
 *
 * The agent prompt has a rule saying "ese lote / ahí / el mismo" → use
 * plot="__last__". The LLM follows it imperfectly: with seasoned users,
 * "ahi mismo" sometimes triggers a literal plot="ahi mismo" (which never
 * resolves) and sometimes triggers a confused text response ("¿qué lote?").
 *
 * Rather than trust the LLM to apply the rule, this preprocessor mutates
 * the message itself so the agent receives unambiguous text:
 *   In:  "y otros 50000 en sueldos ahi mismo"
 *   Out: "y otros 50000 en sueldos en lote Norte"
 * Now the agent has zero work to do.
 *
 * Safe by design: only fires when (a) we find a pronoun phrase AND (b)
 * the context_stack actually has a recent plot to expand to. Otherwise
 * the text passes through unchanged and the agent handles it.
 *
 * Used by IntentClassifier before invoking the agent (see usage there).
 */

/** Pronoun phrases that refer to the most-recent plot.
 *  Order: longer-first so "antes de ayer" doesn't get caught by "ayer", etc.
 *
 *  Note on word boundaries: JS \b is ASCII-only, so it doesn't fire correctly
 *  around accented chars like "ahí" / "aquí". We use lookaheads instead
 *  ((?=\s|$|[.,!?;:])) to assert end-of-token without relying on \b. */
const TOKEN_END = String.raw`(?=\s|$|[.,!?;:])`;
const PRONOUN_PATTERNS: ReadonlyArray<RegExp> = [
  // "ahí mismo / también / igual" — variantes de continuidad de lugar. "ahí
  // también fumigué" (común por audio, Whisper transcribe "ahí también") no
  // se expandía → el agente resolvía el lote por contexto pero el validador
  // anti-alucinación lo dropeaba (no estaba literal en el texto). Reportado live.
  new RegExp(String.raw`\b(?:ah[ií]|all[íi]|all[áa])\s+(?:mismo|tambi[eé]n|igual)\b`, 'gi'),
  // "ahí / allí / allá" seguido de un VERBO de acción agro (sembré, fumigué,
  // apliqué, coseché...) — "ahí sembré soja". El \s+ va DENTRO del lookahead
  // para no comerse el espacio antes del verbo (el match es solo "ahí").
  new RegExp(String.raw`\b(?:ah[ií]|all[íi]|all[áa])(?=\s+(?:sembr|fumig|aplic|cosech|fertiliz|pulveric|ar[eé]|rastr|disqu|reg[uoó]|pas[eé]|met[íi]|agregu|cargu|gast[eé]|pagu[eé]|vend[íi]|compr[eé]))`, 'gi'),
  // "(el/ese/este) mismo lote / campo / potrero" — consume the article/demonstrative
  // if present so "en el mismo lote" → "en en lote X" → collapsed to "en lote X" below.
  new RegExp(String.raw`\b(?:el\s+|ese\s+|este\s+)?mismo\s+(?:lote|campo|potrero)\b`, 'gi'),
  // "el mismo" without noun — keeps natural flow ("y el mismo" → "y en lote X")
  new RegExp(String.raw`\bel\s+mismo\b`, 'gi'),
  // "ese / este / aquel + lote/campo" — explicit pronoun + noun
  new RegExp(String.raw`\b(?:ese|este|aquel|aquella?|esa)\s+(?:lote|campo|potrero|parcela)\b`, 'gi'),
  // "el de antes" / "el de recién" / "el anterior" — backref to prev plot
  new RegExp(String.raw`\bel\s+(?:de\s+(?:antes|reci[eé]n|hoy)|anterior)\b`, 'gi'),
  // "ahí" / "allí" after a clear plot-context preposition — lookahead for end
  // of token (avoids JS \b not firing after accented "í").
  new RegExp(String.raw`\b(?:en|a|del?)\s+ah[ií]${TOKEN_END}`, 'gi'),
  new RegExp(String.raw`\b(?:en|a|del?)\s+all[íi]${TOKEN_END}`, 'gi'),
];

/** Pronoun phrases that refer to the SECOND-most-recent plot ("el otro").
 *  Only expand when the caller can provide a distinct previous plot from
 *  the context_stack — otherwise these pass through untouched. */
const OTHER_PLOT_PATTERNS: ReadonlyArray<RegExp> = [
  // "el otro lote / campo / potrero / parcela"
  new RegExp(String.raw`\bel\s+otro\s+(?:lote|campo|potrero|parcela)\b`, 'gi'),
  // "en el otro" / "al otro" / "del otro" sin sustantivo — solo tras preposición
  // clara de lugar para no comerse "el otro día" (que es temporal).
  new RegExp(String.raw`\b(?:en|a|del?)\s+el\s+otro${TOKEN_END}`, 'gi'),
];

/**
 * Returns { expanded: string, replaced: number } — expanded is the new
 * text, replaced is the count of pronoun phrases swapped out. When
 * replaced=0 the text is identical to the input.
 *
 * `prevPlotName` (optional) is the SECOND-most-recent plot from the
 * context_stack; when present, "el otro lote" expands to it.
 */
export function expandPronouns(
  text: string,
  lastPlotName: string | null | undefined,
  prevPlotName?: string | null,
): { expanded: string; replaced: number } {
  if (!text || (!lastPlotName && !prevPlotName)) return { expanded: text, replaced: 0 };
  let out = text;
  let replaced = 0;

  // "el otro lote" se resuelve PRIMERO (al segundo lote del stack) para que
  // los patrones de "mismo/ese lote" no se lo roben hacia el lote más reciente.
  if (prevPlotName) {
    const otherReplacement = `en lote ${prevPlotName}`;
    for (const pat of OTHER_PLOT_PATTERNS) {
      const before = out;
      out = out.replace(pat, otherReplacement);
      if (out !== before) {
        const matches = before.match(pat);
        if (matches) replaced += matches.length;
      }
    }
  }

  if (lastPlotName) {
    // Build the explicit phrase we'll use to replace pronouns. Includes the
    // "en lote" prefix so the agent's lote-extraction sees it correctly.
    const replacement = `en lote ${lastPlotName}`;

    for (const pat of PRONOUN_PATTERNS) {
      const before = out;
      out = out.replace(pat, replacement);
      if (out !== before) {
        // Count actual replacements
        const matches = before.match(pat);
        if (matches) replaced += matches.length;
      }
    }
  }

  // Collapse double prepositions that may appear when the original text
  // already had a preposition before the pronoun ("en ahí" → "en en lote X")
  // or an article we didn't consume ("en el en lote X" — rare leftover).
  if (replaced > 0) {
    // "en/a/de [el] en lote" → "en lote"
    out = out.replace(/\b(?:en|a|del?)\s+(?:el\s+)?en\s+lote\b/gi, 'en lote');
    out = out.replace(/\s{2,}/g, ' ').trim();
  }

  return { expanded: out, replaced };
}
