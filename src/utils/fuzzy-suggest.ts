/**
 * Suggest common phrases the user might have meant, based on Levenshtein
 * distance against a curated whitelist of short verbs/keywords.
 *
 * Used by the "no entendí" fallback to upgrade a generic message into a
 * helpful one — instead of "Probá de nuevo", we offer 1-2 actionable
 * examples plus a `menú` reminder.
 *
 * Threshold is tight (≤2 edits) so we don't surface noisy guesses.
 */

// Anchor words → example phrase the user can copy verbatim.
// Kept short and Spanish-only. Order matters loosely: most common first so
// when scores tie, the more useful phrase wins.
const ANCHORS: ReadonlyArray<{ word: string; example: string }> = [
  { word: 'gasto', example: '"gasté 50000 en gasoil"' },
  { word: 'gaste', example: '"gasté 50000 en gasoil"' },
  { word: 'compre', example: '"compré 200 lt de glifosato"' },
  { word: 'pague', example: '"pagué 100000 de servicios"' },
  { word: 'ingreso', example: '"vendí 20 tn de soja a 200000"' },
  { word: 'vendi', example: '"vendí 20 tn de soja a 200000"' },
  { word: 'cobre', example: '"cobré 500000 por arrendamiento"' },
  { word: 'lluvia', example: '"llovió 25mm en La Esperanza"' },
  { word: 'llovio', example: '"llovió 25mm en La Esperanza"' },
  { word: 'fumigue', example: '"fumigué lote 1A con glifosato"' },
  { word: 'sembre', example: '"sembré soja en lote 1A"' },
  { word: 'coseche', example: '"cosechamos 50 tn de soja en lote 1A"' },
  { word: 'fertilice', example: '"fertilicé lote 1A con urea"' },
  { word: 'observacion', example: '"observación lote 1A: malezas"' },
  { word: 'monitoreo', example: '"soja V3 con 15% rama negra"' },
  { word: 'vaca', example: '"agregar 20 vacas Angus en lote 1A"' },
  { word: 'hacienda', example: '"agregar 20 vacas Angus en lote 1A"' },
  { word: 'stock', example: '"cargué 500 kg de urea en galpón"' },
  { word: 'campo', example: '"agregar campo La Esperanza en Pergamino"' },
  { word: 'lote', example: '"agregar lote 1A en campo La Esperanza"' },
  { word: 'clima', example: '"clima en Pergamino"' },
  { word: 'pronostico', example: '"pronóstico en Pergamino"' },
  { word: 'reporte', example: '"reporte financiero del mes"' },
  { word: 'menu', example: '*menú*' },
  { word: 'ayuda', example: '*ayuda*' },
];

/** Damerau-Levenshtein distance (handles 1 transposition as a single edit). */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array<number>(bl + 1);
  const curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  let two: number[] = new Array(bl + 1).fill(0);
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1,     // deletion
        prev[j - 1] + cost, // substitution
      );
      // Transposition (Damerau)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], two[j - 2] + 1);
      }
    }
    two = prev.slice();
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }
  return prev[bl];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,;:"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return up to `max` example phrases the user might have meant. Empty array
 * when nothing is close enough (caller should fall back to a generic hint).
 */
export function suggestExamples(rawText: string, max = 2): string[] {
  const text = normalize(rawText);
  if (!text || text.length > 80) return []; // very long inputs are usually not typos
  const tokens = text.split(' ').filter(t => t.length >= 3);
  if (tokens.length === 0) return [];

  const scored: Array<{ example: string; score: number }> = [];
  for (const anchor of ANCHORS) {
    let best = Infinity;
    for (const tok of tokens) {
      // Skip tokens that are wildly different in length (cheap early-out).
      if (Math.abs(tok.length - anchor.word.length) > 2) continue;
      const d = distance(tok, anchor.word);
      if (d < best) best = d;
    }
    // Tighter threshold for short anchors to avoid noisy matches.
    const maxDistance = anchor.word.length <= 5 ? 1 : 2;
    if (best <= maxDistance) {
      scored.push({ example: anchor.example, score: best });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { example } of scored) {
    if (seen.has(example)) continue;
    seen.add(example);
    out.push(example);
    if (out.length >= max) break;
  }
  return out;
}

/** Compose a friendly "no entendí" message with suggestions when available. */
export function buildFallbackMessage(rawText: string): string {
  const suggestions = suggestExamples(rawText, 2);
  if (suggestions.length > 0) {
    const list = suggestions.map(s => `   • ${s}`).join('\n');
    return `🤔 No entendí del todo. ¿Quisiste decir algo como esto?\n${list}\n\nSi era otra cosa, reformulalo. Para ver todo lo que puedo hacer escribí *menú*.`;
  }
  return `🤔 No entendí del todo. Probá con algo como:\n   • "gasté 50000 en gasoil"\n   • "llovió 25mm en La Esperanza"\n   • "agregar campo Don Pedro"\n\nO escribí *menú* para ver todo lo que puedo hacer.`;
}
