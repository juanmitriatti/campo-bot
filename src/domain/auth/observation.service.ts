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
  user_name: string | null;
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

interface ObservationFilters {
  fieldId?: number;
  plotId?: number;
  dateFrom?: string;
  dateTo?: string;
}

interface ActivityRow {
  id: number;
  user_id: number;
  plot_id: number | null;
  event_type: string;
  event_date: string;
  crop: string | null;
  product: string | null;
  product_type: string | null;
  quantity: number | null;
  unit: string | null;
  implement: string | null;
  notes: string | null;
  created_at: Date;
  plot_name: string | null;
  field_name: string | null;
  user_name: string | null;
  edited_by_name: string | null;
}

interface PaginatedActivities {
  activities: ActivityRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ActivityFilters {
  fieldId?: number;
  plotId?: number;
  dateFrom?: string;
  dateTo?: string;
  eventType?: string;
}

interface ExpenseRow {
  id: number;
  user_id: number;
  category: string;
  description: string | null;
  amount: number;
  currency: string;
  field_id: number | null;
  plot_id: number | null;
  expense_date: string;
  created_at: Date;
  field_name: string | null;
  plot_name: string | null;
  user_name: string | null;
  edited_by_name: string | null;
}

interface IncomeRow {
  id: number;
  user_id: number;
  category: string;
  description: string | null;
  amount: number;
  currency: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  field_id: number | null;
  plot_id: number | null;
  income_date: string;
  created_at: Date;
  field_name: string | null;
  plot_name: string | null;
  user_name: string | null;
  edited_by_name: string | null;
}

interface PaginatedExpenses {
  expenses: ExpenseRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface PaginatedIncomes {
  incomes: IncomeRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface FinancialFilters {
  fieldId?: number;
  plotId?: number;
  dateFrom?: string;
  dateTo?: string;
  category?: string;
}

export class ObservationService {
  async getUserObservations(userId: number, page: number = 1, limit: number = 20, filters: ObservationFilters = {}): Promise<PaginatedResult> {
    const offset = (page - 1) * limit;

    const conditions = ['(o.user_id = $1 OR o.field_id IN (SELECT field_id FROM field_members WHERE user_id = $1))'];
    const params: (number | string)[] = [userId];
    let paramIdx = 1;

    if (filters.fieldId) {
      paramIdx++;
      conditions.push(`o.field_id = $${paramIdx}`);
      params.push(filters.fieldId);
    }
    if (filters.plotId) {
      paramIdx++;
      conditions.push(`o.plot_id = $${paramIdx}`);
      params.push(filters.plotId);
    }
    if (filters.dateFrom) {
      paramIdx++;
      conditions.push(`o.created_at >= $${paramIdx}::date`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      paramIdx++;
      conditions.push(`o.created_at < ($${paramIdx}::date + interval '1 day')`);
      params.push(filters.dateTo);
    }

    const where = conditions.join(' AND ');

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT o.*, p.name AS plot_name, f.name AS field_name, u.name AS user_name
         FROM agro_observations o
         LEFT JOIN plots p ON o.plot_id = p.id
         LEFT JOIN fields f ON o.field_id = f.id
         LEFT JOIN users u ON o.user_id = u.id
         WHERE ${where}
         ORDER BY o.created_at DESC
         LIMIT $${paramIdx + 1} OFFSET $${paramIdx + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM agro_observations o WHERE ${where}`,
        params
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

  async getUserFieldsWithPlots(userId: number): Promise<{ id: number; name: string; plots: { id: number; name: string }[] }[]> {
    const { rows: fields } = await pool.query(
      `SELECT id, name FROM fields WHERE id IN (SELECT field_id FROM field_members WHERE user_id = $1) AND deleted_at IS NULL ORDER BY name`,
      [userId]
    );
    const { rows: plots } = await pool.query(
      `SELECT id, name, field_id FROM plots WHERE field_id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY name`,
      [fields.map((f: { id: number }) => f.id)]
    );
    return fields.map((f: { id: number; name: string }) => ({
      id: f.id,
      name: f.name,
      plots: plots
        .filter((p: { field_id: number }) => p.field_id === f.id)
        .map((p: { id: number; name: string }) => ({ id: p.id, name: p.name })),
    }));
  }

  async getUserActivities(userId: number, page: number = 1, limit: number = 20, filters: ActivityFilters = {}): Promise<PaginatedActivities> {
    const offset = (page - 1) * limit;

    // Show activities from own data + activities on plots in accessible fields
    const conditions = ['(de.user_id = $1 OR de.plot_id IN (SELECT p.id FROM plots p WHERE p.field_id IN (SELECT field_id FROM field_members WHERE user_id = $1)))'];
    const params: (number | string)[] = [userId];
    let paramIdx = 1;

    if (filters.fieldId) {
      paramIdx++;
      conditions.push(`f.id = $${paramIdx}`);
      params.push(filters.fieldId);
    }
    if (filters.plotId) {
      paramIdx++;
      conditions.push(`de.plot_id = $${paramIdx}`);
      params.push(filters.plotId);
    }
    if (filters.dateFrom) {
      paramIdx++;
      conditions.push(`de.event_date >= $${paramIdx}::date`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      paramIdx++;
      conditions.push(`de.event_date <= $${paramIdx}::date`);
      params.push(filters.dateTo);
    }
    if (filters.eventType) {
      paramIdx++;
      conditions.push(`de.event_type = $${paramIdx}`);
      params.push(filters.eventType);
    }

    const where = conditions.join(' AND ');

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT de.*, p.name AS plot_name, f.name AS field_name, u.name AS user_name, eu.name AS edited_by_name
         FROM domain_events de
         LEFT JOIN plots p ON de.plot_id = p.id
         LEFT JOIN fields f ON p.field_id = f.id
         LEFT JOIN users u ON de.user_id = u.id
         LEFT JOIN users eu ON de.edited_by = eu.id
         WHERE ${where}
         ORDER BY de.event_date DESC, de.created_at DESC
         LIMIT $${paramIdx + 1} OFFSET $${paramIdx + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM domain_events de
         LEFT JOIN plots p ON de.plot_id = p.id
         LEFT JOIN fields f ON p.field_id = f.id
         WHERE ${where}`,
        params
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    return {
      activities: dataResult.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserExpenses(userId: number, page: number = 1, limit: number = 20, filters: FinancialFilters = {}): Promise<PaginatedExpenses> {
    const offset = (page - 1) * limit;

    const conditions = ['(e.user_id = $1 OR e.field_id IN (SELECT field_id FROM field_members WHERE user_id = $1))', 'e.deleted_at IS NULL'];
    const params: (number | string)[] = [userId];
    let paramIdx = 1;

    if (filters.fieldId) {
      paramIdx++;
      conditions.push(`e.field_id = $${paramIdx}`);
      params.push(filters.fieldId);
    }
    if (filters.plotId) {
      paramIdx++;
      conditions.push(`e.plot_id = $${paramIdx}`);
      params.push(filters.plotId);
    }
    if (filters.dateFrom) {
      paramIdx++;
      conditions.push(`e.expense_date >= $${paramIdx}::date`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      paramIdx++;
      conditions.push(`e.expense_date <= $${paramIdx}::date`);
      params.push(filters.dateTo);
    }
    if (filters.category) {
      paramIdx++;
      conditions.push(`e.category = $${paramIdx}`);
      params.push(filters.category);
    }
    if ((filters as Record<string, unknown>).expenseType) {
      paramIdx++;
      conditions.push(`e.expense_type = $${paramIdx}`);
      params.push((filters as Record<string, unknown>).expenseType as string);
    }

    const where = conditions.join(' AND ');

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT e.*, e.expense_type, e.product, e.quantity, e.unit, p.name AS plot_name, f.name AS field_name, u.name AS user_name, eu.name AS edited_by_name
         FROM expenses e
         LEFT JOIN plots p ON e.plot_id = p.id
         LEFT JOIN fields f ON e.field_id = f.id
         LEFT JOIN users u ON e.user_id = u.id
         LEFT JOIN users eu ON e.edited_by = eu.id
         WHERE ${where}
         ORDER BY e.expense_date DESC, e.created_at DESC
         LIMIT $${paramIdx + 1} OFFSET $${paramIdx + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM expenses e WHERE ${where}`,
        params
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    return {
      expenses: dataResult.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserIncomes(userId: number, page: number = 1, limit: number = 20, filters: FinancialFilters = {}): Promise<PaginatedIncomes> {
    const offset = (page - 1) * limit;

    const conditions = ['(i.user_id = $1 OR i.field_id IN (SELECT field_id FROM field_members WHERE user_id = $1))', 'i.deleted_at IS NULL'];
    const params: (number | string)[] = [userId];
    let paramIdx = 1;

    if (filters.fieldId) {
      paramIdx++;
      conditions.push(`i.field_id = $${paramIdx}`);
      params.push(filters.fieldId);
    }
    if (filters.plotId) {
      paramIdx++;
      conditions.push(`i.plot_id = $${paramIdx}`);
      params.push(filters.plotId);
    }
    if (filters.dateFrom) {
      paramIdx++;
      conditions.push(`i.income_date >= $${paramIdx}::date`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      paramIdx++;
      conditions.push(`i.income_date <= $${paramIdx}::date`);
      params.push(filters.dateTo);
    }
    if (filters.category) {
      paramIdx++;
      conditions.push(`i.category = $${paramIdx}`);
      params.push(filters.category);
    }

    const where = conditions.join(' AND ');

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT i.*, p.name AS plot_name, f.name AS field_name, u.name AS user_name, eu.name AS edited_by_name
         FROM incomes i
         LEFT JOIN plots p ON i.plot_id = p.id
         LEFT JOIN fields f ON i.field_id = f.id
         LEFT JOIN users u ON i.user_id = u.id
         LEFT JOIN users eu ON i.edited_by = eu.id
         WHERE ${where}
         ORDER BY i.income_date DESC, i.created_at DESC
         LIMIT $${paramIdx + 1} OFFSET $${paramIdx + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM incomes i WHERE ${where}`,
        params
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    return {
      incomes: dataResult.rows,
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
    // Allow edit if user owns the observation OR has access to its field
    const canEdit = obs.user_id === userId || (obs.field_id && await this._hasFieldAccess(userId, obs.field_id));
    if (!canEdit) {
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

  async editExpense(
    expenseId: number,
    userId: number,
    data: { description?: string; amount?: number; currency?: string; category?: string; expense_date?: string; expense_type?: string; product?: string | null; quantity?: number | null; unit?: string | null }
  ): Promise<ExpenseRow> {
    const { rows } = await pool.query(
      `SELECT * FROM expenses WHERE id = $1 AND deleted_at IS NULL`,
      [expenseId]
    );
    if (rows.length === 0) {
      throw new ObservationError(404, 'Gasto no encontrado');
    }
    // Allow edit if user owns the expense OR has access to its field
    const exp = rows[0];
    const canEdit = exp.user_id === userId || (exp.field_id && await this._hasFieldAccess(userId, exp.field_id));
    if (!canEdit) {
      throw new ObservationError(403, 'No tenés permisos para editar este gasto');
    }

    const sets: string[] = ['updated_at = NOW()'];
    const params: (string | number)[] = [];
    let idx = 0;

    idx++; sets.push(`edited_by = $${idx}`); params.push(userId);
    if (data.description !== undefined) { idx++; sets.push(`description = $${idx}`); params.push(data.description); }
    if (data.amount !== undefined) { idx++; sets.push(`amount = $${idx}`); params.push(data.amount); }
    if (data.currency !== undefined) { idx++; sets.push(`currency = $${idx}`); params.push(data.currency); }
    if (data.category !== undefined) { idx++; sets.push(`category = $${idx}`); params.push(data.category); }
    if (data.expense_date !== undefined) { idx++; sets.push(`expense_date = $${idx}`); params.push(data.expense_date); }
    if (data.expense_type !== undefined) { idx++; sets.push(`expense_type = $${idx}`); params.push(data.expense_type); }
    if (data.product !== undefined) { idx++; sets.push(`product = $${idx}`); params.push(data.product as string); }
    if (data.quantity !== undefined) { idx++; sets.push(`quantity = $${idx}`); params.push(data.quantity as number); }
    if (data.unit !== undefined) { idx++; sets.push(`unit = $${idx}`); params.push(data.unit as string); }

    idx++;
    const result = await pool.query(
      `UPDATE expenses SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, expenseId]
    );
    return result.rows[0];
  }

  async editIncome(
    incomeId: number,
    userId: number,
    data: { description?: string; amount?: number; currency?: string; category?: string; income_date?: string; quantity?: number | null; unit?: string | null }
  ): Promise<IncomeRow> {
    const { rows } = await pool.query(
      `SELECT * FROM incomes WHERE id = $1 AND deleted_at IS NULL`,
      [incomeId]
    );
    if (rows.length === 0) {
      throw new ObservationError(404, 'Ingreso no encontrado');
    }
    // Allow edit if user owns the income OR has access to its field
    const inc = rows[0];
    const canEdit = inc.user_id === userId || (inc.field_id && await this._hasFieldAccess(userId, inc.field_id));
    if (!canEdit) {
      throw new ObservationError(403, 'No tenés permisos para editar este ingreso');
    }

    const sets: string[] = ['updated_at = NOW()'];
    const params: (string | number | null)[] = [];
    let idx = 0;

    idx++; sets.push(`edited_by = $${idx}`); params.push(userId);
    if (data.description !== undefined) { idx++; sets.push(`description = $${idx}`); params.push(data.description); }
    if (data.amount !== undefined) { idx++; sets.push(`amount = $${idx}`); params.push(data.amount); }
    if (data.currency !== undefined) { idx++; sets.push(`currency = $${idx}`); params.push(data.currency); }
    if (data.category !== undefined) { idx++; sets.push(`category = $${idx}`); params.push(data.category); }
    if (data.income_date !== undefined) { idx++; sets.push(`income_date = $${idx}`); params.push(data.income_date); }
    if (data.quantity !== undefined) { idx++; sets.push(`quantity = $${idx}`); params.push(data.quantity); }
    if (data.unit !== undefined) { idx++; sets.push(`unit = $${idx}`); params.push(data.unit); }

    idx++;
    const result = await pool.query(
      `UPDATE incomes SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, incomeId]
    );
    return result.rows[0];
  }

  async editActivity(
    activityId: number,
    userId: number,
    data: { event_type?: string; event_date?: string; crop?: string | null; product?: string | null; quantity?: number | null; unit?: string | null; implement?: string | null; notes?: string | null }
  ): Promise<ActivityRow> {
    const { rows } = await pool.query(
      `SELECT * FROM domain_events WHERE id = $1`,
      [activityId]
    );
    if (rows.length === 0) {
      throw new ObservationError(404, 'Actividad no encontrada');
    }
    // Allow edit if user owns the activity OR has access to the plot's field
    const act = rows[0];
    let canEditActivity = act.user_id === userId;
    if (!canEditActivity && act.plot_id) {
      const { rows: plotRows } = await pool.query(
        `SELECT p.field_id FROM plots p WHERE p.id = $1`,
        [act.plot_id]
      );
      if (plotRows.length > 0) {
        canEditActivity = await this._hasFieldAccess(userId, plotRows[0].field_id);
      }
    }
    if (!canEditActivity) {
      throw new ObservationError(403, 'No tenés permisos para editar esta actividad');
    }

    const sets: string[] = ['updated_at = NOW()'];
    const params: (string | number | null)[] = [];
    let idx = 0;

    idx++; sets.push(`edited_by = $${idx}`); params.push(userId);
    if (data.event_type !== undefined) { idx++; sets.push(`event_type = $${idx}`); params.push(data.event_type); }
    if (data.event_date !== undefined) { idx++; sets.push(`event_date = $${idx}`); params.push(data.event_date); }
    if (data.crop !== undefined) { idx++; sets.push(`crop = $${idx}`); params.push(data.crop); }
    if (data.product !== undefined) { idx++; sets.push(`product = $${idx}`); params.push(data.product); }
    if (data.quantity !== undefined) { idx++; sets.push(`quantity = $${idx}`); params.push(data.quantity); }
    if (data.unit !== undefined) { idx++; sets.push(`unit = $${idx}`); params.push(data.unit); }
    if (data.implement !== undefined) { idx++; sets.push(`implement = $${idx}`); params.push(data.implement); }
    if (data.notes !== undefined) { idx++; sets.push(`notes = $${idx}`); params.push(data.notes); }

    idx++;
    const result = await pool.query(
      `UPDATE domain_events SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, activityId]
    );
    return result.rows[0];
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
    const obsRow = obsRows[0];
    const canView = obsRow.user_id === userId || (obsRow.field_id && await this._hasFieldAccess(userId, obsRow.field_id));
    if (!canView) {
      throw new ObservationError(403, 'No tenés permisos para ver esta observación');
    }

    const { rows } = await pool.query(
      `SELECT * FROM observation_history
       WHERE observation_id = $1
       ORDER BY edited_at DESC`,
      [observationId]
    );
    return rows;
  }

  /** Check if user has access to a field via field_members */
  private async _hasFieldAccess(userId: number, fieldId: number): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM field_members WHERE user_id = $1 AND field_id = $2 LIMIT 1`,
      [userId, fieldId]
    );
    return rows.length > 0;
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
