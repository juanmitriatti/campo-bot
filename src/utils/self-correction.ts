import { extractCropFromText } from './crops.js';
import { CORRECTION_ALT } from './lexicon.js';

// A bare COUNT correction ("no, perdón, eran 8" / "no, eran 8 vacas"): a
// correction cue (or the copula "eran/son/fueron") followed by an integer, with
// NO price markers. Used to distinguish a quantity correction from a price
// answer while a livestock price-pending is open (bug: "vendí 5 → ¿precio? →
// no, eran 8" silently kept 5 instead of correcting to 8).
const PRICE_MARKER_RE = /[$]|\busd\b|d[oó]lar|peso|\bmil\b|\bpalos?\b|\blucas?\b|c\/u|cabeza|\bcada\b|\bkg\b|\blt\b|por\s+(?:cabeza|cero|tonelada|kilo)/iu;
const COUNT_CORRECTION_RE = new RegExp(`\\b(?:${CORRECTION_ALT}|eran|son|fueron|fue)\\b[^\\d]{0,15}?(\\d{1,5})\\b`, 'iu');

/**
 * Extracts the corrected COUNT from a quantity-correction message, or null when
 * the message isn't a count correction (no cue) or is actually a price answer
 * (has $/USD/mil/palo/per-head markers → let the price slot handle it).
 */
export function extractCountCorrection(text: string): number | null {
  if (!text) return null;
  if (PRICE_MARKER_RE.test(text)) return null; // it's a price, not a count
  const m = COUNT_CORRECTION_RE.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

/**
 * Unified pre-agent self-correction normalizer.
 *
 * Rewrites an intra-message (or standalone) self-correction so the agent sees
 * an unambiguous value, the same way the pronoun-expander removes pronoun
 * ambiguity before the agent. Handles the TYPED, text-detectable corrections
 * consistently — crop, plot, and number-with-unit — embedded anywhere in the
 * message:
 *
 *   "sembré soja en el lote Norte no era maíz, 100 has" → "sembré maíz en el lote Norte, 100 has"
 *   "fumigué el lote Norte, perdón era el lote Sur"      → "fumigué el lote Sur"
 *   "sembré 50 has no eran 80 has"                        → "sembré 80 has"
 *
 * It does NOT touch money / category / date corrections — those keep their
 * existing dedicated handlers (extractReferencedAmountCorrection,
 * extractCategoryCorrection, extractLastRecordDateCorrection). Conservative by
 * design: only fires when the corrected value is confidently typed AND a prior
 * same-type token exists to replace; otherwise returns the text unchanged.
 */

// Correction cues. "no" is AMBIGUOUS (contrast vs correction) so it REQUIRES a
// copula (no ERA/FUE maíz = correction; "no maíz" = contrast, left alone). The
// explicit cues are unambiguous corrections, so the copula is optional.
const STRONG_CUE =
  /(?:perd[oó]n|disculp[aá](?:me)?|en\s+realidad|mejor(?:\s+dicho)?|quise\s+decir|me\s+equivoqu[eé]|corrig[ieí]+)\s*,?\s+(?:(?:era|eran|fue|fueron|es|son)\s+)?/iu;
const WEAK_CUE = /\bno\s*,?\s+(?:era|eran|fue|fueron|es|son)\s+/iu;

const ACTION_VERB_RE = /\b(sembr|cosech|implant|levant|fumig|fertiliz|ar[aá]|reg[aá]|labr|pulveriz)\w*/iu;

// Non-money quantity units (money corrections stay with their own handler).
const QTY_RE = /(\d[\d.,]*)\s*(has?|hect[aá]reas?|kg|kilos?|lt|litros?|tn|toneladas?|qq|quintales?|bolsas?)\b/iu;

interface Clause { idx: number; cueLen: number; value: string; }

function findClause(text: string): Clause | null {
  const s = STRONG_CUE.exec(text);
  if (s) return { idx: s.index, cueLen: s[0].length, value: text.slice(s.index + s[0].length) };
  const w = WEAK_CUE.exec(text);
  if (w) return { idx: w.index, cueLen: w[0].length, value: text.slice(w.index + w[0].length) };
  return null;
}

function cleanup(s: string): string {
  return s
    .replace(/\s*,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s*,\s*$/, '')
    .replace(/^\s*,\s*/, '')
    .trim();
}

/** Splits into tokens while keeping it simple for "find prior token" scans. */
function tokens(s: string): string[] {
  return s.split(/(?<=[\s,])|(?=[\s,])/).map(t => t.trim()).filter(Boolean);
}

export function resolveSelfCorrection(text: string): string {
  if (!text) return text;
  const clause = findClause(text);
  if (!clause) return text;

  const before = text.slice(0, clause.idx);

  // --- 1) CROP correction ---
  const cropWord = /^\s*([\p{L}]+)/u.exec(clause.value);
  const correctedCrop = cropWord ? extractCropFromText(cropWord[1]) : null;
  if (correctedCrop && ACTION_VERB_RE.test(before)) {
    for (const tok of tokens(before)) {
      const c = extractCropFromText(tok);
      if (c && c !== correctedCrop) {
        const after = text.slice(clause.idx + clause.cueLen + cropWord![0].length);
        return cleanup(before.replace(tok, correctedCrop) + after);
      }
    }
  }

  // NOTE: plot corrections are intentionally NOT rewritten here. Plot names are
  // commonly multi-word ("La Esperanza", "San Martin", "Lote Norte Grande") and
  // can't be delimited reliably in free text without corrupting the message.
  // Standalone plot corrections ("no, era en lote Sur") keep their dedicated
  // handler (detectCorrection / PLOT_CORRECTION_PATTERNS in correction-classifier).

  // --- 2) NUMBER (with unit) correction ---
  const correctedQty = QTY_RE.exec(clause.value);
  if (correctedQty && correctedQty.index === 0) {
    const priorQty = QTY_RE.exec(before);
    if (priorQty && priorQty[0] !== correctedQty[0]) {
      const after = text.slice(clause.idx + clause.cueLen + correctedQty[0].length);
      const rewrittenBefore =
        before.slice(0, priorQty.index) + correctedQty[0] + before.slice(priorQty.index + priorQty[0].length);
      return cleanup(rewrittenBefore + after);
    }
  }

  return text;
}
