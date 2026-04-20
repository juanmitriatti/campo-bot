import { pool } from '../../config/db.js';
import type { UserId } from '../../types/index.js';

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
       WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND active = true`,
      [userId, name]
    );
    return (rowCount ?? 0) > 0;
  }

  async processTemplates(): Promise<number> {
    const { rows } = await pool.query(
      `SELECT et.*, u.id AS user_id
         FROM expense_templates et
         JOIN users u ON et.user_id = u.id
        WHERE et.active = true AND et.next_run_date <= CURRENT_DATE`
    );

    let processed = 0;
    for (const template of rows) {
      try {
        await pool.query(
          `INSERT INTO expenses (user_id, description, amount, currency, category, field_id, plot_id, expense_type, product, quantity, unit, expense_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_DATE)`,
          [template.user_id, template.description || template.name, template.amount, template.currency,
           template.category, template.field_id, template.plot_id, template.expense_type,
           template.product, template.quantity, template.unit]
        );

        const nextRun = this.advanceDate(template.recurrence_type, template.next_run_date);
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

  private advanceDate(recurrenceType: string, currentDate: string | Date): string {
    const d = new Date(currentDate);
    if (recurrenceType === 'monthly') {
      d.setMonth(d.getMonth() + 1);
    } else if (recurrenceType === 'biweekly') {
      d.setDate(d.getDate() + 14);
    } else {
      d.setDate(d.getDate() + 7);
    }
    return d.toISOString().slice(0, 10);
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
