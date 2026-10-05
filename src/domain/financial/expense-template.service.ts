import { pool } from '../../config/db.js';
import type { UserId } from '../../types/index.js';
import { sqlNormalizedName } from '../../utils/entity-matcher.js';

export interface ExpenseTemplate {
  id: number;
  name: string;
  amount: number;
  currency: string;
  category: string | null;
  description: string | null;
  recurrence_type: string;
  recurrence_day: number;
  active: boolean;
  next_run_date: string;
  field_name?: string;
  plot_name?: string;
}

export class ExpenseTemplateService {
  async create(
    userId: UserId,
    data: {
      name: string;
      amount: number;
      currency?: string;
      category?: string;
      description?: string;
      fieldId?: number;
      plotId?: number;
      expenseType?: string;
      product?: string;
      quantity?: number;
      unit?: string;
      recurrenceType: string;
      recurrenceDay: number;
    }
  ): Promise<ExpenseTemplate> {
    const nextRun = this.calculateNextRunDate(data.recurrenceType, data.recurrenceDay);

    const { rows } = await pool.query(
      `INSERT INTO expense_templates
        (user_id, name, amount, currency, category, description, field_id, plot_id,
         expense_type, product, quantity, unit, recurrence_type, recurrence_day, next_run_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [userId, data.name, data.amount, data.currency || 'ARS', data.category || null,
       data.description || null, data.fieldId || null, data.plotId || null,
       data.expenseType || 'varios', data.product || null, data.quantity || null,
       data.unit || null, data.recurrenceType, data.recurrenceDay, nextRun]
    );
    return this.mapRow(rows[0]);
  }

  async list(userId: UserId): Promise<ExpenseTemplate[]> {
    const { rows } = await pool.query(
      `SELECT et.*, f.name AS field_name, p.name AS plot_name
         FROM expense_templates et
         LEFT JOIN fields f ON et.field_id = f.id
         LEFT JOIN plots p ON et.plot_id = p.id
        WHERE et.user_id = $1 AND et.active = true
        ORDER BY et.next_run_date ASC`,
      [userId]
    );
    return rows.map(r => this.mapRow(r));
  }

  async delete(userId: UserId, templateId: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE expense_templates SET active = false WHERE id = $1 AND user_id = $2 AND active = true`,
      [templateId, userId]
    );
    return (rowCount ?? 0) > 0;
  }

  async deleteByName(userId: UserId, name: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE expense_templates SET active = false
       WHERE user_id = $1 AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$2::text')} AND active = true`,
      [userId, name]
    );
    if ((rowCount ?? 0) > 0) return true;
    // FIN-41: "borrá el gasto fijo de internet" con el gasto llamado "Internet
    // fibra" no encontraba nada. Por nombre parcial, solo si es UNO (con dos no
    // se adivina).
    const { rows } = await pool.query(
      `SELECT id FROM expense_templates
        WHERE user_id = $1 AND active = true
          AND ${sqlNormalizedName('name')} LIKE '%' || ${sqlNormalizedName('$2::text')} || '%'`,
      [userId, name]
    );
    if (rows.length !== 1) {
      if (rows.length > 1) console.log(`[INTERCEPT] deleteByName "${name}": ${rows.length} gastos fijos parecidos — no se borra ninguno`);
      return false;
    }
    return this.delete(userId, rows[0].id);
  }

  async processTemplates(): Promise<number> {
    const { rows } = await pool.query(
      `SELECT et.*, u.id AS user_id
         FROM expense_templates et
         JOIN users u ON et.user_id = u.id
        WHERE et.active = true AND et.next_run_date <= CURRENT_DATE
          AND u.deleted_at IS NULL`
    );

    let processed = 0;
    for (const template of rows) {
      try {
        await pool.query(
          `INSERT INTO expenses (user_id, description, amount, currency, category, field_id, plot_id, expense_type, product, quantity, unit, expense_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          // Con la fecha que TOCABA (next_run_date), no la de hoy: si el cron se
          // atrasó, el gasto igual cae en su día (CRN-12).
          [template.user_id, template.description || template.name, template.amount, template.currency,
           // FIN-41: sin categoría generaba gastos con category NULL, invisibles en los reportes por categoría.
           template.category || 'Otros', template.field_id, template.plot_id, template.expense_type,
           template.product, template.quantity, template.unit, isoDate(template.next_run_date)]
        );

        const nextRun = this.advanceDate(template.recurrence_type, template.next_run_date, template.recurrence_day);
        await pool.query(
          `UPDATE expense_templates SET next_run_date = $1, last_run_date = CURRENT_DATE WHERE id = $2`,
          [nextRun, template.id]
        );
        processed++;
      } catch (err) {
        console.error(`[expense-template] Error processing template ${template.id}:`, err);
      }
    }
    return processed;
  }

  private calculateNextRunDate(recurrenceType: string, recurrenceDay: number): string {
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));

    if (recurrenceType === 'monthly') {
      const target = new Date(today.getFullYear(), today.getMonth(), recurrenceDay);
      if (target <= today) {
        target.setMonth(target.getMonth() + 1);
      }
      return target.toISOString().slice(0, 10);
    }

    if (recurrenceType === 'weekly') {
      const daysUntil = (recurrenceDay - today.getDay() + 7) % 7 || 7;
      const target = new Date(today);
      target.setDate(target.getDate() + daysUntil);
      return target.toISOString().slice(0, 10);
    }

    if (recurrenceType === 'biweekly') {
      const daysUntil = (recurrenceDay - today.getDay() + 7) % 7 || 14;
      const target = new Date(today);
      target.setDate(target.getDate() + daysUntil);
      return target.toISOString().slice(0, 10);
    }

    return today.toISOString().slice(0, 10);
  }

  /**
   * Próxima corrida. Mensual: el MISMO día del mes (recurrence_day), recortado
   * al último día si el mes es más corto — antes setMonth desbordaba y el 31
   * de enero pasaba al 2 de marzo, y de ahí en más quedaba corrido (CRN-12).
   */
  private advanceDate(recurrenceType: string, currentDate: string | Date, recurrenceDay?: number | null): string {
    const [y, m, d] = isoDate(currentDate).split('-').map(Number);
    if (recurrenceType === 'monthly') {
      const wanted = recurrenceDay && recurrenceDay > 0 ? recurrenceDay : d;
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      const lastDay = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
      const day = Math.min(wanted, lastDay);
      return `${nextY}-${String(nextM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCDate(base.getUTCDate() + (recurrenceType === 'biweekly' ? 14 : 7));
    return base.toISOString().slice(0, 10);
  }

  private mapRow(row: any): ExpenseTemplate {
    return {
      id: row.id,
      name: row.name,
      amount: Number(row.amount),
      currency: row.currency,
      category: row.category,
      description: row.description,
      recurrence_type: row.recurrence_type,
      recurrence_day: row.recurrence_day,
      active: row.active,
      next_run_date: row.next_run_date,
      field_name: row.field_name || undefined,
      plot_name: row.plot_name || undefined,
    };
  }
}

/** Fecha-calendario YYYY-MM-DD de una columna DATE (llega como medianoche UTC) o de un string. */
function isoDate(v: string | Date): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
