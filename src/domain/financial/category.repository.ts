import { pool } from '../../config/db.js';

export type CategoryKind = 'expense' | 'income';

export interface UserCategory {
  id: number;
  userId: number;
  kind: CategoryKind;
  name: string;
  usageCount: number;
  lastUsedAt: Date | null;
}

export class CategoryRepository {
  async listActive(userId: number, kind: CategoryKind): Promise<UserCategory[]> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE user_id = $1 AND kind = $2 AND deleted_at IS NULL
       ORDER BY usage_count DESC, last_used_at DESC NULLS LAST, lower(name)`,
      [userId, kind]
    );
    return rows.map(mapRow);
  }

  async topN(userId: number, kind: CategoryKind, n: number): Promise<UserCategory[]> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE user_id = $1 AND kind = $2 AND deleted_at IS NULL
       ORDER BY usage_count DESC, last_used_at DESC NULLS LAST, lower(name)
       LIMIT $3`,
      [userId, kind, n]
    );
    return rows.map(mapRow);
  }

  async findByName(userId: number, kind: CategoryKind, name: string): Promise<UserCategory | null> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE user_id = $1 AND kind = $2 AND lower(name) = lower($3) AND deleted_at IS NULL`,
      [userId, kind, name]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findById(userId: number, id: number): Promise<UserCategory | null> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(userId: number, kind: CategoryKind, name: string): Promise<UserCategory> {
    const { rows } = await pool.query(
      `INSERT INTO user_categories (user_id, kind, name)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, kind, name, usage_count, last_used_at`,
      [userId, kind, name.trim()]
    );
    return mapRow(rows[0]);
  }

  async rename(userId: number, id: number, name: string): Promise<UserCategory | null> {
    const { rows } = await pool.query(
      `UPDATE user_categories SET name = $3
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, user_id, kind, name, usage_count, last_used_at`,
      [id, userId, name.trim()]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async softDelete(userId: number, id: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE user_categories SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );
    return (rowCount ?? 0) > 0;
  }

  async bump(id: number): Promise<void> {
    await pool.query(
      `UPDATE user_categories SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  /** Count how many non-deleted expenses or incomes reference this category by name. */
  async usageInTransactions(userId: number, kind: CategoryKind, name: string): Promise<number> {
    const table = kind === 'expense' ? 'expenses' : 'incomes';
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${table}
       WHERE user_id = $1 AND deleted_at IS NULL AND lower(category) = lower($2)`,
      [userId, name]
    );
    return rows[0].n;
  }

  async reassign(userId: number, kind: CategoryKind, fromName: string, toName: string): Promise<number> {
    const table = kind === 'expense' ? 'expenses' : 'incomes';
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET category = $3
       WHERE user_id = $1 AND deleted_at IS NULL AND lower(category) = lower($2)`,
      [userId, fromName, toName]
    );
    return rowCount ?? 0;
  }
}

function mapRow(r: any): UserCategory {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    kind: r.kind,
    name: r.name,
    usageCount: Number(r.usage_count),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
  };
}
