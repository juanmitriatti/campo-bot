import type { CategoryRepository, CategoryKind, UserCategory } from './category.repository.js';

export type MatchIntent = 'exact' | 'new' | 'unknown';

export type MatchResult =
  | { kind: 'matched'; category: UserCategory }
  | { kind: 'needs-confirmation'; suggestions: UserCategory[] };

const DEFAULT_EXPENSE_CATEGORIES = [
  'Semillas', 'Fertilizantes', 'Agroquímicos', 'Combustible',
  'Sueldos', 'Maquinaria', 'Servicios', 'Insumos', 'Otros',
];

const DEFAULT_INCOME_CATEGORIES = [
  'Venta de soja', 'Venta de maíz', 'Venta de trigo', 'Venta de girasol',
  'Venta de hacienda', 'Arrendamiento', 'Otros',
];

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

  async bump(categoryId: number): Promise<void> {
    await this.repo.bump(categoryId);
  }
}
