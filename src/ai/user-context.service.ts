import { pool } from '../config/db.js';
import { EntityValidator } from '../services/entity-validator.js';
import { CategoryRepository } from '../domain/financial/category.repository.js';
import { CategoryService, TOP_N_FOR_PROMPT } from '../domain/financial/category.service.js';
import type { UserId } from '../types/index.js';

export interface ContextStackEntry {
  fieldName: string | null;
  plotName: string | null;
}

export interface UserContext {
  fieldNames: string[];
  plotNames: string[];
  corralNames: string[];
  feedlotNames: string[];
  lastFieldName: string | null;
  lastPlotName: string | null;
  recentContexts: ContextStackEntry[];
  expenseCategories: string[];
  incomeCategories: string[];
}

interface CacheEntry {
  context: UserContext;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds

export class UserContextService {
  private cache = new Map<number, CacheEntry>();

  constructor(
    private entityValidator: EntityValidator,
  ) {}

  async loadContext(userId: UserId): Promise<UserContext> {
    // ALWAYS read last_field/plot/recent_contexts fresh — these change every
    // turn (updateConversationState bumps them), and a 60s cache here meant
    // follow-up questions like "ese lote" / "promedio?" / "y la cosecha?"
    // saw stale context from BEFORE the just-prior message had updated state.
    // Stable lists (fields/plots/corrals/feedlots) keep their cache.
    const cached = this.cache.get(userId);
    const cacheValid = cached && cached.expiresAt > Date.now();

    const _categoryRepo = new CategoryRepository();
    const _categoryService = new CategoryService(_categoryRepo);
    await Promise.all([
      _categoryService.bootstrapDefaults(userId, 'expense'),
      _categoryService.bootstrapDefaults(userId, 'income'),
    ]);
    const [_expenseCategories, _incomeCategories] = await Promise.all([
      _categoryRepo.topN(userId, 'expense', TOP_N_FOR_PROMPT),
      _categoryRepo.topN(userId, 'income', TOP_N_FOR_PROMPT),
    ]);

    if (cacheValid) {
      const lastCtx = await this.loadLastContext(userId).catch(() => null);
      return {
        ...cached.context,
        lastFieldName: lastCtx?.lastFieldName ?? null,
        lastPlotName: lastCtx?.lastPlotName ?? null,
        recentContexts: lastCtx?.recentContexts ?? [],
        expenseCategories: _expenseCategories.map(c => c.name),
        incomeCategories: _incomeCategories.map(c => c.name),
      };
    }

    // Cold load — fetch everything in parallel.
    const [fieldsResult, plotsResult, lastContextResult, corralsResult, feedlotsResult] = await Promise.allSettled([
      this.entityValidator.getUserFieldNames(userId),
      this.entityValidator.getUserPlotNames(userId),
      this.loadLastContext(userId),
      this.loadCorralNames(userId),
      this.loadFeedlotNames(userId),
    ]);

    const lastCtx = lastContextResult.status === 'fulfilled' ? lastContextResult.value : null;
    const context: UserContext = {
      fieldNames: fieldsResult.status === 'fulfilled' ? fieldsResult.value : [],
      plotNames: plotsResult.status === 'fulfilled' ? plotsResult.value : [],
      corralNames: corralsResult.status === 'fulfilled' ? corralsResult.value : [],
      feedlotNames: feedlotsResult.status === 'fulfilled' ? feedlotsResult.value : [],
      lastFieldName: lastCtx?.lastFieldName ?? null,
      lastPlotName: lastCtx?.lastPlotName ?? null,
      recentContexts: lastCtx?.recentContexts ?? [],
      expenseCategories: _expenseCategories.map(c => c.name),
      incomeCategories: _incomeCategories.map(c => c.name),
    };

    // Cache only the stable bits (fieldNames/plotNames/etc. are folded into
    // the cached UserContext but the dynamic last_* fields will be re-read
    // on every subsequent call via the cacheValid branch above).
    this.cache.set(userId, { context, expiresAt: Date.now() + CACHE_TTL_MS });

    return context;
  }

  private async loadLastContext(userId: UserId): Promise<{
    lastFieldName: string | null;
    lastPlotName: string | null;
    recentContexts: ContextStackEntry[];
  }> {
    const result = await pool.query(
      `SELECT
         f.name AS field_name,
         p.name AS plot_name,
         cs.context_stack
       FROM conversation_state cs
       LEFT JOIN fields f ON cs.last_field_id = f.id AND f.deleted_at IS NULL
       LEFT JOIN plots p ON cs.last_plot_id = p.id AND p.deleted_at IS NULL
       WHERE cs.user_id = $1`,
      [userId],
    );
    if (result.rows.length === 0) {
      return { lastFieldName: null, lastPlotName: null, recentContexts: [] };
    }
    const row = result.rows[0];
    // Resolve context_stack field/plot IDs to names
    const stack: Array<{ field_id: number | null; plot_id: number | null }> = row.context_stack ?? [];
    let recentContexts: ContextStackEntry[] = [];
    if (stack.length > 0) {
      const fieldIds = [...new Set(stack.map(e => e.field_id).filter(Boolean))];
      const plotIds = [...new Set(stack.map(e => e.plot_id).filter(Boolean))];

      const fieldMap = new Map<number, string>();
      const plotMap = new Map<number, string>();

      if (fieldIds.length > 0) {
        const fRes = await pool.query(
          `SELECT id, name FROM fields WHERE id = ANY($1) AND deleted_at IS NULL`,
          [fieldIds],
        );
        for (const r of fRes.rows) fieldMap.set(r.id, r.name);
      }
      if (plotIds.length > 0) {
        const pRes = await pool.query(
          `SELECT id, name FROM plots WHERE id = ANY($1) AND deleted_at IS NULL`,
          [plotIds],
        );
        for (const r of pRes.rows) plotMap.set(r.id, r.name);
      }

      recentContexts = stack.map(e => ({
        fieldName: e.field_id ? fieldMap.get(e.field_id) ?? null : null,
        plotName: e.plot_id ? plotMap.get(e.plot_id) ?? null : null,
      }));
    }

    return {
      lastFieldName: row.field_name ?? null,
      lastPlotName: row.plot_name ?? null,
      recentContexts,
    };
  }

  private async loadCorralNames(userId: UserId): Promise<string[]> {
    const result = await pool.query(
      `SELECT c.name FROM corrals c
       JOIN feedlots fl ON c.feedlot_id = fl.id
       JOIN fields f ON f.id = fl.field_id
       WHERE (f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))
         AND c.deleted_at IS NULL AND fl.deleted_at IS NULL
       ORDER BY c.name`,
      [userId],
    );
    return result.rows.map((r: { name: string }) => r.name);
  }

  private async loadFeedlotNames(userId: UserId): Promise<string[]> {
    const result = await pool.query(
      `SELECT fl.name FROM feedlots fl
       JOIN fields f ON f.id = fl.field_id
       WHERE (f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))
         AND fl.deleted_at IS NULL
       ORDER BY fl.name`,
      [userId],
    );
    return result.rows.map((r: { name: string }) => r.name);
  }
}
