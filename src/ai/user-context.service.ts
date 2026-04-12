import { pool } from '../config/db.js';
import { EntityValidator } from '../services/entity-validator.js';
import type { UserId } from '../types/index.js';

export interface UserContext {
  fieldNames: string[];
  plotNames: string[];
  corralNames: string[];
  feedlotNames: string[];
  lastFieldName: string | null;
  lastPlotName: string | null;
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
    // Check cache
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.context;
    }

    // Load all in parallel — partial failure is OK
    const [fieldsResult, plotsResult, lastContextResult, corralsResult, feedlotsResult] = await Promise.allSettled([
      this.entityValidator.getUserFieldNames(userId),
      this.entityValidator.getUserPlotNames(userId),
      this.loadLastContext(userId),
      this.loadCorralNames(userId),
      this.loadFeedlotNames(userId),
    ]);

    const context: UserContext = {
      fieldNames: fieldsResult.status === 'fulfilled' ? fieldsResult.value : [],
      plotNames: plotsResult.status === 'fulfilled' ? plotsResult.value : [],
      corralNames: corralsResult.status === 'fulfilled' ? corralsResult.value : [],
      feedlotNames: feedlotsResult.status === 'fulfilled' ? feedlotsResult.value : [],
      lastFieldName: lastContextResult.status === 'fulfilled' ? lastContextResult.value.lastFieldName : null,
      lastPlotName: lastContextResult.status === 'fulfilled' ? lastContextResult.value.lastPlotName : null,
    };

    // Cache it
    this.cache.set(userId, { context, expiresAt: Date.now() + CACHE_TTL_MS });

    return context;
  }

  private async loadLastContext(userId: UserId): Promise<{ lastFieldName: string | null; lastPlotName: string | null }> {
    const result = await pool.query(
      `SELECT
         f.name AS field_name,
         p.name AS plot_name
       FROM conversation_state cs
       LEFT JOIN fields f ON cs.last_field_id = f.id AND f.deleted_at IS NULL
       LEFT JOIN plots p ON cs.last_plot_id = p.id AND p.deleted_at IS NULL
       WHERE cs.user_id = $1`,
      [userId],
    );
    if (result.rows.length === 0) {
      return { lastFieldName: null, lastPlotName: null };
    }
    return {
      lastFieldName: result.rows[0].field_name ?? null,
      lastPlotName: result.rows[0].plot_name ?? null,
    };
  }

  private async loadCorralNames(userId: UserId): Promise<string[]> {
    const result = await pool.query(
      `SELECT c.name FROM corrals c
       JOIN feedlots fl ON c.feedlot_id = fl.id
       WHERE fl.field_id IN (SELECT field_id FROM field_members WHERE user_id = $1)
         AND c.deleted_at IS NULL AND fl.deleted_at IS NULL
       ORDER BY c.name`,
      [userId],
    );
    return result.rows.map((r: { name: string }) => r.name);
  }

  private async loadFeedlotNames(userId: UserId): Promise<string[]> {
    const result = await pool.query(
      `SELECT fl.name FROM feedlots fl
       WHERE fl.field_id IN (SELECT field_id FROM field_members WHERE user_id = $1)
         AND fl.deleted_at IS NULL
       ORDER BY fl.name`,
      [userId],
    );
    return result.rows.map((r: { name: string }) => r.name);
  }
}
