import type { CategoryRepository, CategoryKind, UserCategory } from './category.repository.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../constants/agro-terms.js';

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
export const SUGGESTIONS_FOR_BUTTONS = 7;

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
}
