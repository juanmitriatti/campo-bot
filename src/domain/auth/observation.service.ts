import { pool } from '../../config/db.js';
import { normalizeObservationText, detectObservationCategory } from '../../services/observations.js';

interface ObservationRow {
  id: number;
  user_id: number;
  field_id: number | null;
  plot_id: number | null;
  observation_text: string;
  normalized_text: string | null;
  category: string;
  source: string;
  created_at: Date;
  updated_at: Date | null;
  plot_name: string | null;
  field_name: string | null;
}

interface HistoryRow {
  id: number;
  observation_id: number;
  previous_text: string;
  new_text: string;
  previous_category: string | null;
  new_category: string | null;
  edited_by: number;
  edited_at: Date;
}

interface PaginatedResult {
  observations: ObservationRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class ObservationService {
  async getUserObservations(userId: number, page: number = 1, limit: number = 20): Promise<PaginatedResult> {
    const offset = (page - 1) * limit;

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT o.*, p.name AS plot_name, f.name AS field_name
         FROM agro_observations o
         LEFT JOIN plots p ON o.plot_id = p.id
         LEFT JOIN fields f ON o.field_id = f.id
         WHERE o.user_id = $1
         ORDER BY o.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM agro_observations WHERE user_id = $1`,
        [userId]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    return {
      observations: dataResult.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async editObservation(
    observationId: number,
    userId: number,
    newText: string
  ): Promise<{ observation: ObservationRow; history: HistoryRow }> {
    // Fetch existing
    const { rows } = await pool.query(
      `SELECT * FROM agro_observations WHERE id = $1`,
      [observationId]
    );
    if (rows.length === 0) {
      throw new ObservationError(404, 'Observación no encontrada');
    }

    const obs = rows[0];
    if (obs.user_id !== userId) {
      throw new ObservationError(403, 'No tenés permisos para editar esta observación');
    }

    // Normalize and re-categorize
    const normalizedText = normalizeObservationText(newText);
    const newCategory = detectObservationCategory(newText);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert history entry
      const historyResult = await client.query(
        `INSERT INTO observation_history
         (observation_id, previous_text, new_text, previous_category, new_category, edited_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [observationId, obs.observation_text, normalizedText, obs.category, newCategory, userId]
      );

      // Update observation
      const updateResult = await client.query(
        `UPDATE agro_observations
         SET observation_text = $1, normalized_text = $2, category = $3, updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [normalizedText, normalizedText, newCategory, observationId]
      );

      await client.query('COMMIT');

      return {
        observation: updateResult.rows[0],
        history: historyResult.rows[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getObservationHistory(observationId: number, userId: number): Promise<HistoryRow[]> {
    // Verify ownership
    const { rows: obsRows } = await pool.query(
      `SELECT user_id FROM agro_observations WHERE id = $1`,
      [observationId]
    );
    if (obsRows.length === 0) {
      throw new ObservationError(404, 'Observación no encontrada');
    }
    if (obsRows[0].user_id !== userId) {
      throw new ObservationError(403, 'No tenés permisos para editar esta observación');
    }

    const { rows } = await pool.query(
      `SELECT * FROM observation_history
       WHERE observation_id = $1
       ORDER BY edited_at DESC`,
      [observationId]
    );
    return rows;
  }
}

export class ObservationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ObservationError';
  }
}
