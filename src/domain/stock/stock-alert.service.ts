import { pool } from '../../config/db.js';
import { StockRepository } from './stock.repository.js';
import type { StockItemRow } from './stock.repository.js';

const repo = new StockRepository();

export interface LowStockUser {
  userId: number;
  phone: string;
  telegramId: string | null;
  name: string | null;
  items: StockItemRow[];
}

export class StockAlertService {

  /**
   * Get all users who have low stock items (current_quantity <= min_stock).
   */
  async getLowStockUsers(): Promise<LowStockUser[]> {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id AS user_id, u.phone_number, u.telegram_id, u.name
       FROM users u
       JOIN field_members fm ON fm.user_id = u.id
       JOIN warehouses w ON w.field_id = fm.field_id AND w.deleted_at IS NULL
       JOIN stock_items si ON si.warehouse_id = w.id AND si.deleted_at IS NULL
       WHERE si.min_stock IS NOT NULL AND si.current_quantity <= si.min_stock`
    );

    const result: LowStockUser[] = [];
    for (const row of rows) {
      const items = await repo.getLowStockItems(row.user_id);
      if (items.length > 0) {
        result.push({
          userId: row.user_id,
          phone: row.phone_number,
          telegramId: row.telegram_id,
          name: row.name,
          items,
        });
      }
    }
    return result;
  }

  /**
   * Format a low stock alert message.
   */
  formatLowStockAlert(items: StockItemRow[]): string {
    if (items.length === 0) return '';

    // Group by field + warehouse
    const groups = new Map<string, StockItemRow[]>();
    for (const item of items) {
      const key = `${item.field_name || '?'} > ${item.warehouse_name || 'Principal'}`;
      const existing = groups.get(key) || [];
      existing.push(item);
      groups.set(key, existing);
    }

    const lines: string[] = ['⚠️ *Alerta de stock bajo*\n'];
    for (const [key, groupItems] of groups) {
      lines.push(`📍 ${key}`);
      for (const item of groupItems) {
        const pct = item.min_stock ? Math.round((item.current_quantity / item.min_stock) * 100) : 0;
        const color = pct <= 30 ? '🔴' : '🟡';
        lines.push(`  ${color} ${item.name}: ${item.current_quantity}${item.unit} (mínimo: ${item.min_stock}${item.unit})`);
      }
    }

    return lines.join('\n');
  }
}
