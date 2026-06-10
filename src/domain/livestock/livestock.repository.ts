import { pool } from '../../config/db.js';
import type {
  LivestockCategory,
  LivestockMovementType,
  LivestockGroupRow,
  LivestockMovementRow,
} from './livestock.types.js';

/** Gemelas de género: "terneros" en el habla del campo abarca también terneras
 *  (masculino genérico). Usado por findGroupsByCategory para no fallar el
 *  lookup cuando el usuario alterna el género de la categoría. */
const GENDER_TWIN: Record<string, string> = {
  ternero: 'ternera',
  ternera: 'ternero',
};

function accessibleFieldsSql(paramIdx: number): string {
  // Own fields + fields shared via field_members. The previous version only
  // returned shared fields, so owners saw empty livestock lists.
  return `SELECT id FROM fields WHERE user_id = $${paramIdx} AND deleted_at IS NULL
          UNION
          SELECT field_id FROM field_members WHERE user_id = $${paramIdx}`;
}

/**
 * Repository for livestock groups and movements.
 * All mutations that change counts MUST go through applyMovement/applyTransfer
 * to keep the movement ledger and the group state consistent.
 */
export class LivestockRepository {
  // ========================
  // GROUPS (read)
  // ========================

  async findGroup(plotId: number, category: LivestockCategory, breed: string | null): Promise<LivestockGroupRow | null> {
    const { rows } = await pool.query(
      `SELECT lg.*, p.name AS plot_name, f.name AS field_name
       FROM livestock_groups lg
       LEFT JOIN plots p ON lg.plot_id = p.id
       JOIN fields f ON lg.field_id = f.id
       WHERE lg.plot_id = $1
         AND lg.category = $2
         AND lg.breed IS NOT DISTINCT FROM $3
         AND lg.deleted_at IS NULL`,
      [plotId, category, breed]
    );
    return rows[0] || null;
  }

  async findGroupInCorral(corralId: number, category: LivestockCategory, breed: string | null): Promise<LivestockGroupRow | null> {
    const { rows } = await pool.query(
      `SELECT lg.*, c.name AS corral_name, fl.name AS feedlot_name, f.name AS field_name
       FROM livestock_groups lg
       JOIN corrals c ON lg.corral_id = c.id
       JOIN feedlots fl ON c.feedlot_id = fl.id
       JOIN fields f ON lg.field_id = f.id
       WHERE lg.corral_id = $1
         AND lg.category = $2
         AND lg.breed IS NOT DISTINCT FROM $3
         AND lg.deleted_at IS NULL`,
      [corralId, category, breed]
    );
    return rows[0] || null;
  }

  /**
   * Find all non-deleted groups at a location (plot OR corral) for a given
   * category, regardless of breed. Caller is expected to disambiguate when
   * the result has more than one row.
   */
  async listGroupsAtLocation(
    location: { plotId?: number; corralId?: number },
    category: LivestockCategory
  ): Promise<LivestockGroupRow[]> {
    if (location.corralId) {
      const { rows } = await pool.query(
        `SELECT lg.*, c.name AS corral_name, fl.name AS feedlot_name, f.name AS field_name
         FROM livestock_groups lg
         JOIN corrals c ON lg.corral_id = c.id
         JOIN feedlots fl ON c.feedlot_id = fl.id
         JOIN fields f ON lg.field_id = f.id
         WHERE lg.corral_id = $1
           AND lg.category = $2
           AND lg.deleted_at IS NULL`,
        [location.corralId, category]
      );
      return rows;
    }
    const { rows } = await pool.query(
      `SELECT lg.*, p.name AS plot_name, f.name AS field_name
       FROM livestock_groups lg
       LEFT JOIN plots p ON lg.plot_id = p.id
       JOIN fields f ON lg.field_id = f.id
       WHERE lg.plot_id = $1
         AND lg.category = $2
         AND lg.deleted_at IS NULL`,
      [location.plotId, category]
    );
    return rows;
  }

  async getGroupById(id: string): Promise<LivestockGroupRow | null> {
    const { rows } = await pool.query(
      `SELECT lg.*, p.name AS plot_name, f.name AS field_name,
              c.name AS corral_name, fl2.name AS feedlot_name
       FROM livestock_groups lg
       LEFT JOIN plots p ON lg.plot_id = p.id
       LEFT JOIN corrals c ON lg.corral_id = c.id
       LEFT JOIN feedlots fl2 ON c.feedlot_id = fl2.id
       JOIN fields f ON lg.field_id = f.id
       WHERE lg.id = $1 AND lg.deleted_at IS NULL`,
      [id]
    );
    return rows[0] || null;
  }

  async listGroups(
    userId: number,
    opts: { fieldId?: number; plotId?: number; corralId?: number; category?: LivestockCategory } = {}
  ): Promise<LivestockGroupRow[]> {
    let query = `SELECT lg.*, p.name AS plot_name, f.name AS field_name,
              c.name AS corral_name, fl2.name AS feedlot_name
       FROM livestock_groups lg
       LEFT JOIN plots p ON lg.plot_id = p.id
       LEFT JOIN corrals c ON lg.corral_id = c.id
       LEFT JOIN feedlots fl2 ON c.feedlot_id = fl2.id
       JOIN fields f ON lg.field_id = f.id
       WHERE lg.field_id IN (${accessibleFieldsSql(1)})
         AND lg.deleted_at IS NULL
         AND f.deleted_at IS NULL`;
    const params: (string | number)[] = [userId];

    if (opts.fieldId) {
      params.push(opts.fieldId);
      query += ` AND lg.field_id = $${params.length}`;
    }
    if (opts.plotId) {
      params.push(opts.plotId);
      query += ` AND lg.plot_id = $${params.length}`;
    }
    if (opts.corralId) {
      params.push(opts.corralId);
      query += ` AND lg.corral_id = $${params.length}`;
    }
    if (opts.category) {
      params.push(opts.category);
      query += ` AND lg.category = $${params.length}`;
    }
    query += ' ORDER BY f.name, COALESCE(p.name, c.name), lg.category';

    const { rows } = await pool.query(query, params);
    return rows;
  }

  async countTotal(userId: number, opts: { fieldId?: number; plotId?: number; corralId?: number } = {}): Promise<number> {
    let query = `SELECT COALESCE(SUM(lg.count), 0) AS total
       FROM livestock_groups lg
       WHERE lg.field_id IN (${accessibleFieldsSql(1)})
         AND lg.deleted_at IS NULL`;
    const params: (string | number)[] = [userId];
    if (opts.fieldId) {
      params.push(opts.fieldId);
      query += ` AND lg.field_id = $${params.length}`;
    }
    if (opts.plotId) {
      params.push(opts.plotId);
      query += ` AND lg.plot_id = $${params.length}`;
    }
    if (opts.corralId) {
      params.push(opts.corralId);
      query += ` AND lg.corral_id = $${params.length}`;
    }
    const { rows } = await pool.query(query, params);
    return parseInt(rows[0].total, 10);
  }

  // ========================
  // GROUPS (write, non-atomic)
  // ========================

  /** Create a new group with count=0 in a plot (movements fill it) */
  async createGroup(
    userId: number,
    fieldId: number,
    plotId: number,
    category: LivestockCategory,
    breed: string | null,
    opts: { avg_weight_kg?: number | null; notes?: string | null } = {}
  ): Promise<LivestockGroupRow> {
    const { rows } = await pool.query(
      `INSERT INTO livestock_groups
         (user_id, field_id, plot_id, corral_id, category, breed, count, avg_weight_kg, notes)
       VALUES ($1, $2, $3, NULL, $4, $5, 0, $6, $7)
       ON CONFLICT (plot_id, category, breed) WHERE plot_id IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET deleted_at = NULL, updated_at = NOW()
       RETURNING *`,
      [userId, fieldId, plotId, category, breed, opts.avg_weight_kg ?? null, opts.notes ?? null]
    );
    return rows[0];
  }

  /** Create a new group with count=0 in a corral (movements fill it) */
  async createGroupInCorral(
    userId: number,
    fieldId: number,
    corralId: number,
    category: LivestockCategory,
    breed: string | null,
    opts: { avg_weight_kg?: number | null; notes?: string | null } = {}
  ): Promise<LivestockGroupRow> {
    const { rows } = await pool.query(
      `INSERT INTO livestock_groups
         (user_id, field_id, plot_id, corral_id, category, breed, count, avg_weight_kg, notes)
       VALUES ($1, $2, NULL, $3, $4, $5, 0, $6, $7)
       ON CONFLICT (corral_id, category, breed) WHERE corral_id IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET deleted_at = NULL, updated_at = NOW()
       RETURNING *`,
      [userId, fieldId, corralId, category, breed, opts.avg_weight_kg ?? null, opts.notes ?? null]
    );
    return rows[0];
  }

  async updateGroupMetadata(
    id: string,
    patch: { breed?: string | null; avg_weight_kg?: number | null; notes?: string | null }
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.breed !== undefined) {
      params.push(patch.breed);
      sets.push(`breed = $${params.length}`);
    }
    if (patch.avg_weight_kg !== undefined) {
      params.push(patch.avg_weight_kg);
      sets.push(`avg_weight_kg = $${params.length}`);
    }
    if (patch.notes !== undefined) {
      params.push(patch.notes);
      sets.push(`notes = $${params.length}`);
    }
    if (sets.length === 0) return;
    params.push(id);
    await pool.query(
      `UPDATE livestock_groups SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params
    );
  }

  // ========================
  // MOVEMENTS (read)
  // ========================

  async getMovementsForGroup(groupId: string, limit = 20): Promise<LivestockMovementRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM livestock_movements
       WHERE source_group_id = $1 OR dest_group_id = $1
       ORDER BY movement_date DESC, created_at DESC
       LIMIT $2`,
      [groupId, limit]
    );
    return rows;
  }

  async getRecentMovements(userId: number, limit = 20): Promise<LivestockMovementRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM livestock_movements
       WHERE user_id = $1
       ORDER BY movement_date DESC, created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }

  /**
   * List movements across all accessible fields with JOINed group/plot/field/corral context.
   * Supports pagination and filters. Used by dashboard history panel.
   */
  async listMovements(
    userId: number,
    opts: {
      fieldId?: number;
      plotId?: number;
      corralId?: number;
      category?: LivestockCategory;
      movementType?: LivestockMovementType;
      desde?: string;
      hasta?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ rows: (LivestockMovementRow & {
    source_category?: LivestockCategory | null;
    source_breed?: string | null;
    source_plot_name?: string | null;
    source_field_name?: string | null;
    source_corral_name?: string | null;
    source_feedlot_name?: string | null;
    dest_category?: LivestockCategory | null;
    dest_breed?: string | null;
    dest_plot_name?: string | null;
    dest_field_name?: string | null;
    dest_corral_name?: string | null;
    dest_feedlot_name?: string | null;
  })[]; total: number }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = Math.max(0, opts.offset ?? 0);

    const where: string[] = [
      `m.user_id = $1`,
      // At least one endpoint's group must be in an accessible field (owned or shared)
      `(
        (src.field_id IS NOT NULL AND src.field_id IN (${accessibleFieldsSql(1)}))
        OR
        (dst.field_id IS NOT NULL AND dst.field_id IN (${accessibleFieldsSql(1)}))
      )`,
    ];
    const params: (string | number)[] = [userId];

    if (opts.fieldId) {
      params.push(opts.fieldId);
      where.push(`(src.field_id = $${params.length} OR dst.field_id = $${params.length})`);
    }
    if (opts.plotId) {
      params.push(opts.plotId);
      where.push(`(src.plot_id = $${params.length} OR dst.plot_id = $${params.length})`);
    }
    if (opts.corralId) {
      params.push(opts.corralId);
      where.push(`(src.corral_id = $${params.length} OR dst.corral_id = $${params.length})`);
    }
    if (opts.category) {
      params.push(opts.category);
      where.push(`(src.category = $${params.length} OR dst.category = $${params.length})`);
    }
    if (opts.movementType) {
      params.push(opts.movementType);
      where.push(`m.movement_type = $${params.length}`);
    }
    if (opts.desde) {
      params.push(opts.desde);
      where.push(`m.movement_date >= $${params.length}::date`);
    }
    if (opts.hasta) {
      params.push(opts.hasta);
      where.push(`m.movement_date <= $${params.length}::date`);
    }

    const baseFrom = `FROM livestock_movements m
       LEFT JOIN livestock_groups src ON m.source_group_id = src.id
       LEFT JOIN plots sp ON src.plot_id = sp.id
       LEFT JOIN corrals sc ON src.corral_id = sc.id
       LEFT JOIN feedlots sfl ON sc.feedlot_id = sfl.id
       LEFT JOIN fields sf ON src.field_id = sf.id
       LEFT JOIN livestock_groups dst ON m.dest_group_id = dst.id
       LEFT JOIN plots dp ON dst.plot_id = dp.id
       LEFT JOIN corrals dc ON dst.corral_id = dc.id
       LEFT JOIN feedlots dfl ON dc.feedlot_id = dfl.id
       LEFT JOIN fields df ON dst.field_id = df.id
       WHERE ${where.join(' AND ')}`;

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params);
    const total = countResult.rows[0]?.total ?? 0;

    params.push(limit);
    params.push(offset);
    const { rows } = await pool.query(
      `SELECT m.*,
              src.category AS source_category, src.breed AS source_breed,
              sp.name AS source_plot_name, sf.name AS source_field_name,
              sc.name AS source_corral_name, sfl.name AS source_feedlot_name,
              dst.category AS dest_category, dst.breed AS dest_breed,
              dp.name AS dest_plot_name, df.name AS dest_field_name,
              dc.name AS dest_corral_name, dfl.name AS dest_feedlot_name
       ${baseFrom}
       ORDER BY m.movement_date DESC, m.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { rows, total };
  }

  // ========================
  // MOVEMENTS (atomic single-group)
  // ========================

  /**
   * Atomic: update ONE group's count + create ONE movement row.
   * Used for entrada, salida, muerte, nacimiento, ajuste.
   *
   * - entrada / nacimiento: delta is added to destGroupId
   * - salida / muerte:      delta is subtracted from sourceGroupId (fails if count goes negative)
   * - ajuste:               destGroupId count is SET to delta (absolute)
   */
  async applySingleMovement(
    userId: number,
    movementType: LivestockMovementType,
    groupId: string,
    count: number,
    opts: {
      avg_weight_kg?: number | null;
      unit_price_ars?: number | null;
      unit_price_usd?: number | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    } = {}
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow }> {
    if (!['entrada', 'salida', 'muerte', 'nacimiento', 'ajuste'].includes(movementType)) {
      throw new Error(`applySingleMovement no soporta tipo "${movementType}"`);
    }
    if (count <= 0 && movementType !== 'ajuste') {
      throw new Error('La cantidad debe ser mayor a 0');
    }
    if (movementType === 'ajuste' && count < 0) {
      throw new Error('El ajuste no puede ser negativo');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: locked } = await client.query(
        `SELECT * FROM livestock_groups WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [groupId]
      );
      if (locked.length === 0) throw new Error('Grupo de hacienda no encontrado');
      const group = locked[0] as LivestockGroupRow;

      let newCount: number;
      if (movementType === 'entrada' || movementType === 'nacimiento') {
        newCount = Number(group.count) + count;
      } else if (movementType === 'salida' || movementType === 'muerte') {
        newCount = Number(group.count) - count;
        if (newCount < 0) {
          throw new Error(`Cantidad insuficiente. Disponible: ${group.count} animales`);
        }
      } else {
        // ajuste: set absolute
        newCount = count;
      }

      await client.query(
        `UPDATE livestock_groups SET count = $1, updated_at = NOW() WHERE id = $2`,
        [newCount, groupId]
      );

      const isIncoming = movementType === 'entrada' || movementType === 'nacimiento';
      const source = isIncoming ? null : groupId;
      const dest = isIncoming ? groupId : (movementType === 'ajuste' ? groupId : null);

      const movementCount = movementType === 'ajuste'
        ? Math.max(1, Math.abs(newCount - Number(group.count)) || 1)
        : count;

      const { rows: movements } = await client.query(
        `INSERT INTO livestock_movements
           (user_id, movement_type, source_group_id, dest_group_id, count,
            avg_weight_kg, unit_price_ars, unit_price_usd, reason, notes, movement_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::date, CURRENT_DATE))
         RETURNING *`,
        [
          userId,
          movementType,
          source,
          dest,
          movementCount,
          opts.avg_weight_kg ?? null,
          opts.unit_price_ars ?? null,
          opts.unit_price_usd ?? null,
          opts.reason ?? null,
          opts.notes ?? null,
          opts.movement_date ?? null,
        ]
      );

      await client.query('COMMIT');

      return {
        group: { ...group, count: newCount },
        movement: movements[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic: move `count` animals from sourceGroupId → destGroupId in a single transaction.
   * Used for 'transferencia' (between plots/corrals) and 'recategorizacion' (same location, different category).
   * Locks rows in consistent ID order to avoid deadlocks.
   */
  async applyTransferMovement(
    userId: number,
    movementType: 'transferencia' | 'recategorizacion',
    sourceGroupId: string,
    destGroupId: string,
    count: number,
    opts: {
      avg_weight_kg?: number | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    } = {}
  ): Promise<{
    sourceGroup: LivestockGroupRow;
    destGroup: LivestockGroupRow;
    movement: LivestockMovementRow;
  }> {
    if (count <= 0) throw new Error('La cantidad debe ser mayor a 0');
    if (sourceGroupId === destGroupId) {
      throw new Error('El grupo origen y destino no pueden ser el mismo');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock both groups in a consistent order (smaller UUID first) to avoid deadlocks
      const [firstId, secondId] = sourceGroupId < destGroupId
        ? [sourceGroupId, destGroupId]
        : [destGroupId, sourceGroupId];

      const { rows: lockedRows } = await client.query(
        `SELECT * FROM livestock_groups
         WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
         ORDER BY id
         FOR UPDATE`,
        [[firstId, secondId]]
      );

      if (lockedRows.length !== 2) {
        throw new Error('Grupo origen o destino no encontrado');
      }

      const byId = new Map<string, LivestockGroupRow>();
      for (const row of lockedRows) byId.set(row.id, row);
      const sourceGroup = byId.get(sourceGroupId)!;
      const destGroup = byId.get(destGroupId)!;

      const newSourceCount = Number(sourceGroup.count) - count;
      if (newSourceCount < 0) {
        throw new Error(`Cantidad insuficiente en origen. Disponible: ${sourceGroup.count} animales`);
      }
      const newDestCount = Number(destGroup.count) + count;

      await client.query(
        `UPDATE livestock_groups SET count = $1, updated_at = NOW() WHERE id = $2`,
        [newSourceCount, sourceGroupId]
      );
      await client.query(
        `UPDATE livestock_groups SET count = $1, updated_at = NOW() WHERE id = $2`,
        [newDestCount, destGroupId]
      );

      const { rows: movements } = await client.query(
        `INSERT INTO livestock_movements
           (user_id, movement_type, source_group_id, dest_group_id, count,
            avg_weight_kg, reason, notes, movement_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE))
         RETURNING *`,
        [
          userId,
          movementType,
          sourceGroupId,
          destGroupId,
          count,
          opts.avg_weight_kg ?? null,
          opts.reason ?? null,
          opts.notes ?? null,
          opts.movement_date ?? null,
        ]
      );

      await client.query('COMMIT');

      return {
        sourceGroup: { ...sourceGroup, count: newSourceCount },
        destGroup: { ...destGroup, count: newDestCount },
        movement: movements[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setMovementFinancialLink(
    movementId: string,
    expenseId: number | null,
    incomeId: number | null,
  ): Promise<void> {
    await pool.query(
      `UPDATE livestock_movements
       SET linked_expense_id = COALESCE($2, linked_expense_id),
           linked_income_id = COALESCE($3, linked_income_id)
       WHERE id = $1`,
      [movementId, expenseId, incomeId]
    );
  }

  async countUserMovements(userId: number): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM livestock_movements WHERE user_id = $1`,
      [userId]
    );
    return rows[0].n;
  }

  async findMovementById(movementId: string): Promise<{
    id: string;
    movement_type: string;
    count: number;
    source_group_id: string | null;
    dest_group_id: string | null;
    avg_weight_kg: number | null;
  } | null> {
    const { rows } = await pool.query(
      `SELECT id::text AS id, movement_type, count,
              source_group_id::text AS source_group_id,
              dest_group_id::text AS dest_group_id,
              avg_weight_kg
       FROM livestock_movements WHERE id = $1`,
      [movementId]
    );
    return rows[0] ?? null;
  }

  async softDeleteDomainEvent(userId: number, eventId: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE domain_events SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [eventId, userId]
    );
    return (rowCount ?? 0) > 0;
  }

  async findGroupsByCategory(
    userId: number,
    category: string | null,
  ): Promise<Array<{ id: string; plot_id: number | null; corral_id: number | null; count: number; location_label: string }>> {
    const params: unknown[] = [userId];
    let categoryFilter = '';
    if (category) {
      // Fallback de género: en el campo "40 terneros" es el genérico del
      // conjunto — si el usuario cargó "terneras" y después dice "desteté 40
      // terneros", el match exacto devolvía 0 y el evento moría con "no tenés
      // hacienda" (visto live). Matcheamos la categoría Y su gemela de género.
      const twin = GENDER_TWIN[category];
      if (twin) {
        params.push([category, twin]);
        categoryFilter = ' AND g.category::text = ANY($2)';
      } else {
        params.push(category);
        categoryFilter = ' AND g.category::text = $2';
      }
    }
    const { rows } = await pool.query(
      `SELECT
         g.id::text AS id,
         g.plot_id,
         g.corral_id,
         g.count,
         COALESCE(
           CASE WHEN g.corral_id IS NOT NULL THEN
             (SELECT 'Corral ' || c.name || ' (' || f.name || ')'
                FROM corrals c JOIN feedlots ft ON ft.id = c.feedlot_id JOIN fields f ON f.id = ft.field_id
               WHERE c.id = g.corral_id)
             END,
           CASE WHEN g.plot_id IS NOT NULL THEN
             (SELECT f.name || ' > ' || p.name
                FROM plots p JOIN fields f ON f.id = p.field_id
               WHERE p.id = g.plot_id)
             END
         ) AS location_label
       FROM livestock_groups g
       WHERE g.user_id = $1 AND g.deleted_at IS NULL${categoryFilter}
         AND g.count > 0
       ORDER BY g.count DESC`,
      params
    );
    return rows;
  }
}
