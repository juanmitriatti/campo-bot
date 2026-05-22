import type { CategoryRepository, CategoryKind, UserCategory } from './category.repository.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../constants/agro-terms.js';
import { levenshtein, normalizeForSimilarity } from '../../utils/levenshtein.js';

export type MatchIntent = 'exact' | 'new' | 'unknown';

export type MatchResult =
  | { kind: 'matched'; category: UserCategory }
  | { kind: 'needs-confirmation'; suggestions: UserCategory[] };

// Bootstrap defaults reuse the project-wide canonical lists so the dashboard
// filters and the new per-user catalog stay consistent. Users can add more
// custom categories on top of these via the "Categorías" tab.
const DEFAULT_EXPENSE_CATEGORIES: readonly string[] = EXPENSE_CATEGORIES;
const DEFAULT_INCOME_CATEGORIES: readonly string[] = INCOME_CATEGORIES;

export const TOP_N_FOR_PROMPT = 8;
// 9 categorías + 1 "+ Otra" = 10 filas. Es el límite de WhatsApp interactive list.
// Antes era 7, pero solo se usaban como botones (max 3 visible). Ahora la UI
// usa LIST cuando hay más de 3, por lo que aprovechamos el espacio.
export const SUGGESTIONS_FOR_BUTTONS = 9;

export class CategoryService {
  constructor(private readonly repo: CategoryRepository) {}

  /**
   * Match the user's raw category string against their catalog.
   * - intent='exact': caller is confident there's a match → look it up
   * - intent='new': caller wants to create → upsert (no duplicate)
   * - intent='unknown' or null name: return suggestions for confirmation
   */
  async match(userId: number, kind: CategoryKind, name: string | null, intent: MatchIntent): Promise<MatchResult> {
    const trimmed = (name ?? '').trim();
    if (trimmed) {
      const existing = await this.repo.findByName(userId, kind, trimmed);
      if (existing) {
        return { kind: 'matched', category: existing };
      }
      if (intent === 'new') {
        const created = await this.repo.create(userId, kind, trimmed);
        return { kind: 'matched', category: created };
      }
    }
    const suggestions = await this.repo.topN(userId, kind, SUGGESTIONS_FOR_BUTTONS);
    return { kind: 'needs-confirmation', suggestions };
  }

  async bootstrapDefaults(userId: number, kind: CategoryKind): Promise<void> {
    const existing = await this.repo.listActive(userId, kind);
    if (existing.length > 0) return;
    const defaults = kind === 'expense' ? DEFAULT_EXPENSE_CATEGORIES : DEFAULT_INCOME_CATEGORIES;
    for (const name of defaults) {
      await this.repo.create(userId, kind, name);
    }
  }

  async findById(userId: number, id: number): Promise<import('./category.repository.js').UserCategory | null> {
    return this.repo.findById(userId, id);
  }

  async bump(categoryId: number): Promise<void> {
    await this.repo.bump(categoryId);
  }

  /**
   * Look for an existing category whose name is "similar" to the candidate
   * (typo or plural/singular). Returns the best match if any.
   *
   * Heuristic: normalize both sides, then accept if EITHER:
   *  - Levenshtein distance ≤ 2 (typos like "Combustibe" ≈ "Combustible")
   *  - One normalized string contains the other AND the length diff is ≤ 3
   *    (plurals: "Sueldo" inside "Sueldos"; "Maíz" inside "Maíces")
   *
   * Skips itself on case-insensitive exact match (handled by match()).
   */
  async findSimilar(userId: number, kind: CategoryKind, name: string): Promise<UserCategory | null> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 3) return null;
    const candidates = await this.repo.findSimilarExcludingExact(userId, kind, trimmed);
    if (candidates.length === 0) return null;

    const normCandidate = normalizeForSimilarity(trimmed);
    let best: UserCategory | null = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      const normC = normalizeForSimilarity(c.name);
      if (!normC) continue;
      const dist = levenshtein(normCandidate, normC);
      const lenDiff = Math.abs(normCandidate.length - normC.length);
      const contains = normC.includes(normCandidate) || normCandidate.includes(normC);

      // Accept criteria: small Levenshtein OR substring with small length diff
      const matches = dist <= 2 || (contains && lenDiff <= 3);
      if (matches && dist < bestScore) {
        best = c;
        bestScore = dist;
      }
    }
    return best;
  }

  /**
   * Detect EXISTING duplicate pairs in the user's catalog. Same heuristic as
   * findSimilar (Levenshtein ≤ 2 OR substring with small length diff), but
   * applied pairwise across ALL active categories of the kind.
   *
   * Returns pairs (deduplicated). The "keep" entry is the one with higher
   * usage_count; ties broken by lower id (older row). The caller can use this
   * to surface merge suggestions in the dashboard.
   */
  async findDuplicatePairs(
    userId: number,
    kind: CategoryKind,
  ): Promise<Array<{ keep: UserCategory; drop: UserCategory }>> {
    const all = await this.repo.listActive(userId, kind);
    const pairs: Array<{ keep: UserCategory; drop: UserCategory }> = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        if (!areSimilar(a.name, b.name)) continue;
        const aWins = a.usageCount > b.usageCount
          || (a.usageCount === b.usageCount && a.id < b.id);
        pairs.push(aWins ? { keep: a, drop: b } : { keep: b, drop: a });
      }
    }
    return pairs;
  }
}

/** Shared similarity check used by both findSimilar and findDuplicatePairs. */
function areSimilar(name1: string, name2: string): boolean {
  if (name1.toLowerCase() === name2.toLowerCase()) return false;
  const n1 = normalizeForSimilarity(name1);
  const n2 = normalizeForSimilarity(name2);
  if (n1.length < 3 || n2.length < 3) return false;
  const dist = levenshtein(n1, n2);
  const lenDiff = Math.abs(n1.length - n2.length);
  const contains = n1.includes(n2) || n2.includes(n1);
  return dist <= 2 || (contains && lenDiff <= 3);
}
