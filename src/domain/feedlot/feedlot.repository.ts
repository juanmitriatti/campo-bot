import { pool } from '../../config/db.js';
import type { FeedlotRow, CorralRow } from './feedlot.types.js';

function accessibleFieldsSql(paramIdx: number): string {
  return `SELECT field_id FROM field_members WHERE user_id = $${paramIdx}`;
}

export class FeedlotRepository {
  // ========================
  // FEEDLOTS
  // ========================

  async createFeedlot(
    userId: number,
    fieldId: number,
    name: string,
    opts: { capacity?: number | null; notes?: string | null } = {}
  ): Promise<FeedlotRow> {
    const { rows } = await pool.query(
      `INSERT INTO feedlots (user_id, field_id, name, capacity, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, fieldId, name, opts.capacity ?? null, opts.notes ?? null]
    );
    return rows[0];
  }

  async getFeedlotById(id: number): Promise<FeedlotRow | null> {
    const { rows } = await pool.query(
      `SELECT fl.*, f.name AS field_name
       FROM feedlots fl
       JOIN fields f ON fl.field_id = f.id
       WHERE fl.id = $1 AND fl.deleted_at IS NULL`,
      [id]
    );
    return rows[0] || null;
  }

  async getFeedlotByFieldId(fieldId: number): Promise<FeedlotRow | null> {
    const { rows } = await pool.query(
      `SELECT fl.*, f.name AS field_name
       FROM feedlots fl
       JOIN fields f ON fl.field_id = f.id
       WHERE fl.field_id = $1 AND fl.deleted_at IS NULL`,
      [fieldId]
    );
    return rows[0] || null;
  }

  async listFeedlots(userId: number): Promise<(FeedlotRow & { corral_count: number })[]> {
    const { rows } = await pool.query(
      `SELECT fl.*, f.name AS field_name,
              (SELECT COUNT(*)::int FROM corrals c WHERE c.feedlot_id = fl.id AND c.deleted_at IS NULL) AS corral_count
       FROM feedlots fl
       JOIN fields f ON fl.field_id = f.id
       WHERE fl.field_id IN (${accessibleFieldsSql(1)})
         AND fl.deleted_at IS NULL
         AND f.deleted_at IS NULL
       ORDER BY f.name, fl.name`,
      [userId]
    );
    return rows;
  }

  async updateFeedlot(
    id: number,
    patch: { name?: string; capacity?: number | null; notes?: string | null }
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { params.push(patch.name); sets.push(`name = $${params.length}`); }
    if (patch.capacity !== undefined) { params.push(patch.capacity); sets.push(`capacity = $${params.length}`); }
    if (patch.notes !== undefined) { params.push(patch.notes); sets.push(`notes = $${params.length}`); }
    if (sets.length === 0) return;
    params.push(id);
    await pool.query(
      `UPDATE feedlots SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params
    );
  }

  async deleteFeedlot(id: number): Promise<void> {
    await pool.query(
      `UPDATE feedlots SET deleted_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  // ========================
  // CORRALS
  // ========================

  async createCorral(
    feedlotId: number,
    name: string,
    opts: { capacity?: number | null; notes?: string | null } = {}
  ): Promise<CorralRow> {
    const { rows } = await pool.query(
      `INSERT INTO corrals (feedlot_id, name, capacity, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [feedlotId, name, opts.capacity ?? null, opts.notes ?? null]
    );
    return rows[0];
  }

  async getCorralById(id: number): Promise<CorralRow | null> {
    const { rows } = await pool.query(
      `SELECT c.*, fl.name AS feedlot_name, f.name AS field_name, f.id AS field_id
       FROM corrals c
       JOIN feedlots fl ON c.feedlot_id = fl.id
       JOIN fields f ON fl.field_id = f.id
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id]
    );
    return rows[0] || null;
  }

  async getCorralByName(feedlotId: number, name: string): Promise<CorralRow | null> {
    const { rows } = await pool.query(
      `SELECT c.*, fl.name AS feedlot_name, f.name AS field_name, f.id AS field_id
       FROM corrals c
       JOIN feedlots fl ON c.feedlot_id = fl.id
       JOIN fields f ON fl.field_id = f.id
       WHERE c.feedlot_id = $1
         AND LOWER(c.name) = LOWER($2)
         AND c.deleted_at IS NULL`,
      [feedlotId, name]
    );
    return rows[0] || null;
  }

  async listCorrals(feedlotId: number): Promise<CorralRow[]> {
    const { rows } = await pool.query(
      `SELECT c.*, fl.name AS feedlot_name, f.name AS field_name, f.id AS field_id
       FROM corrals c
       JOIN feedlots fl ON c.feedlot_id = fl.id
       JOIN fields f ON fl.field_id = f.id
       WHERE c.feedlot_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.name`,
      [feedlotId]
    );
    return rows;
  }

  async listCorralsByUser(userId: number): Promise<CorralRow[]> {
    const { rows } = await pool.query(
      `SELECT c.*, fl.name AS feedlot_name, f.name AS field_name, f.id AS field_id
       FROM corrals c
       JOIN feedlots fl ON c.feedlot_id = fl.id
       JOIN fields f ON fl.field_id = f.id
       WHERE fl.field_id IN (${accessibleFieldsSql(1)})
         AND c.deleted_at IS NULL
         AND fl.deleted_at IS NULL
         AND f.deleted_at IS NULL
       ORDER BY f.name, c.name`,
      [userId]
    );
    return rows;
  }

  async updateCorral(
    id: number,
    patch: { name?: string; capacity?: number | null; notes?: string | null }
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { params.push(patch.name); sets.push(`name = $${params.length}`); }
    if (patch.capacity !== undefined) { params.push(patch.capacity); sets.push(`capacity = $${params.length}`); }
    if (patch.notes !== undefined) { params.push(patch.notes); sets.push(`notes = $${params.length}`); }
    if (sets.length === 0) return;
    params.push(id);
    await pool.query(
      `UPDATE corrals SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params
    );
  }

  async deleteCorral(id: number): Promise<void> {
    await pool.query(
      `UPDATE corrals SET deleted_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  /** Get corral names across all feedlots accessible to user */
  async getUserCorralNames(userId: number): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT c.name FROM corrals c
       JOIN feedlots fl ON c.feedlot_id = fl.id
       WHERE fl.field_id IN (${accessibleFieldsSql(1)})
         AND c.deleted_at IS NULL AND fl.deleted_at IS NULL
       ORDER BY c.name`,
      [userId]
    );
    return rows.map((r: { name: string }) => r.name);
  }

  /** Get feedlot names accessible to user */
  async getUserFeedlotNames(userId: number): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT fl.name FROM feedlots fl
       WHERE fl.field_id IN (${accessibleFieldsSql(1)})
         AND fl.deleted_at IS NULL
       ORDER BY fl.name`,
      [userId]
    );
    return rows.map((r: { name: string }) => r.name);
  }
}
