import { pool } from '../../config/db.js';

// --- Types ---

export interface WarehouseRow {
  id: number;
  field_id: number;
  name: string;
  created_at: Date;
  deleted_at: Date | null;
  field_name?: string;
}

export interface StockItemRow {
  id: number;
  user_id: number;
  warehouse_id: number;
  name: string;
  category: string;
  current_quantity: number;
  unit: string;
  min_stock: number | null;
  grade: string | null;
  humidity_pct: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  warehouse_name?: string;
  field_name?: string;
  field_id?: number;
}

export interface StockMovementRow {
  id: number;
  stock_item_id: number;
  user_id: number;
  movement_type: string;
  quantity: number;
  reason: string | null;
  notes: string | null;
  expense_id: number | null;
  domain_event_id: number | null;
  movement_date: Date;
  created_at: Date;
}

// --- Helpers ---

function accessibleFieldsSql(paramIdx: number): string {
  return `SELECT field_id FROM field_members WHERE user_id = $${paramIdx}`;
}

// --- Repository ---

export class StockRepository {

  // ========================
  // WAREHOUSES
  // ========================

  async createWarehouse(fieldId: number, name: string): Promise<WarehouseRow> {
    const { rows } = await pool.query(
      `INSERT INTO warehouses (field_id, name) VALUES ($1, $2)
       ON CONFLICT (field_id, name) DO UPDATE SET deleted_at = NULL, deleted_by = NULL
       RETURNING *`,
      [fieldId, name]
    );
    return rows[0];
  }

  async getWarehousesByField(fieldId: number): Promise<WarehouseRow[]> {
    const { rows } = await pool.query(
      `SELECT w.*, f.name AS field_name FROM warehouses w
       JOIN fields f ON w.field_id = f.id
       WHERE w.field_id = $1 AND w.deleted_at IS NULL
       ORDER BY w.name`,
      [fieldId]
    );
    return rows;
  }

  async getAccessibleWarehouses(userId: number): Promise<WarehouseRow[]> {
    const { rows } = await pool.query(
      `SELECT w.*, f.name AS field_name FROM warehouses w
       JOIN fields f ON w.field_id = f.id
       WHERE w.field_id IN (${accessibleFieldsSql(1)})
         AND w.deleted_at IS NULL AND f.deleted_at IS NULL
       ORDER BY f.name, w.name`,
      [userId]
    );
    return rows;
  }

  async findWarehouse(userId: number, warehouseName?: string, fieldName?: string): Promise<WarehouseRow | null> {
    let query = `SELECT w.*, f.name AS field_name FROM warehouses w
       JOIN fields f ON w.field_id = f.id
       WHERE w.field_id IN (${accessibleFieldsSql(1)})
         AND w.deleted_at IS NULL AND f.deleted_at IS NULL`;
    const params: (string | number)[] = [userId];

    if (warehouseName) {
      params.push(warehouseName);
      query += ` AND LOWER(w.name) = LOWER($${params.length})`;
    }
    if (fieldName) {
      params.push(fieldName);
      query += ` AND LOWER(f.name) = LOWER($${params.length})`;
    }
    query += ' LIMIT 1';

    const { rows } = await pool.query(query, params);
    return rows[0] || null;
  }

  async getDefaultWarehouse(userId: number, fieldId?: number): Promise<WarehouseRow | null> {
    let query = `SELECT w.*, f.name AS field_name FROM warehouses w
       JOIN fields f ON w.field_id = f.id
       WHERE w.field_id IN (${accessibleFieldsSql(1)})
         AND w.deleted_at IS NULL AND f.deleted_at IS NULL`;
    const params: (string | number)[] = [userId];

    if (fieldId) {
      params.push(fieldId);
      query += ` AND w.field_id = $${params.length}`;
    }
    query += ' ORDER BY w.created_at ASC LIMIT 1';

    const { rows } = await pool.query(query, params);
    return rows[0] || null;
  }

  async countAccessibleWarehouses(userId: number): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM warehouses w
       WHERE w.field_id IN (${accessibleFieldsSql(1)})
         AND w.deleted_at IS NULL`,
      [userId]
    );
    return parseInt(rows[0].count, 10);
  }

  // ========================
  // STOCK ITEMS
  // ========================

  async findStockItem(warehouseId: number, productName: string): Promise<StockItemRow | null> {
    const { rows } = await pool.query(
      `SELECT si.*, w.name AS warehouse_name, f.name AS field_name, f.id AS field_id
       FROM stock_items si
       JOIN warehouses w ON si.warehouse_id = w.id
       JOIN fields f ON w.field_id = f.id
       WHERE si.warehouse_id = $1 AND LOWER(si.name) = LOWER($2) AND si.deleted_at IS NULL`,
      [warehouseId, productName]
    );
    return rows[0] || null;
  }

  async findStockItemFuzzy(userId: number, productName: string, fieldId?: number): Promise<StockItemRow | null> {
    const normalizedName = productName.toLowerCase();
    let query = `SELECT si.*, w.name AS warehouse_name, f.name AS field_name, f.id AS field_id
       FROM stock_items si
       JOIN warehouses w ON si.warehouse_id = w.id
       JOIN fields f ON w.field_id = f.id
       WHERE w.field_id IN (${accessibleFieldsSql(1)})
         AND si.deleted_at IS NULL AND w.deleted_at IS NULL
         AND (LOWER(si.name) = $2 OR LOWER(si.name) LIKE $3)`;
    const params: (string | number)[] = [userId, normalizedName, `%${normalizedName}%`];

    if (fieldId) {
      params.push(fieldId);
      query += ` AND f.id = $${params.length}`;
    }
    query += ' ORDER BY CASE WHEN LOWER(si.name) = $2 THEN 0 ELSE 1 END, si.current_quantity DESC LIMIT 1';

    const { rows } = await pool.query(query, params);
    return rows[0] || null;
  }

  async createStockItem(
    userId: number,
    warehouseId: number,
    name: string,
    category: string,
    quantity: number,
    unit: string,
    grade?: string,
    humidityPct?: number,
  ): Promise<StockItemRow> {
    const { rows } = await pool.query(
      `INSERT INTO stock_items (user_id, warehouse_id, name, category, current_quantity, unit, grade, humidity_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, warehouseId, name, category, quantity, unit, grade || null, humidityPct ?? null]
    );
    return rows[0];
  }

  async updateQuantity(itemId: number, newQuantity: number): Promise<void> {
    await pool.query(
      `UPDATE stock_items SET current_quantity = $1, updated_at = NOW() WHERE id = $2`,
      [newQuantity, itemId]
    );
  }

  async getStockItems(userId: number, fieldId?: number, warehouseId?: number): Promise<StockItemRow[]> {
    let query = `SELECT si.*, w.name AS warehouse_name, f.name AS field_name, f.id AS field_id
       FROM stock_items si
       JOIN warehouses w ON si.warehouse_id = w.id
       JOIN fields f ON w.field_id = f.id
       WHERE w.field_id IN (${accessibleFieldsSql(1)})
         AND si.deleted_at IS NULL AND w.deleted_at IS NULL`;
    const params: (string | number)[] = [userId];

    if (fieldId) {
      params.push(fieldId);
      query += ` AND f.id = $${params.length}`;
    }
    if (warehouseId) {
      params.push(warehouseId);
      query += ` AND si.warehouse_id = $${params.length}`;
    }
    query += ' ORDER BY f.name, w.name, si.name';

    const { rows } = await pool.query(query, params);
    return rows;
  }

  async getStockItemById(itemId: number): Promise<StockItemRow | null> {
    const { rows } = await pool.query(
      `SELECT si.*, w.name AS warehouse_name, f.name AS field_name, f.id AS field_id
       FROM stock_items si
       JOIN warehouses w ON si.warehouse_id = w.id
       JOIN fields f ON w.field_id = f.id
       WHERE si.id = $1 AND si.deleted_at IS NULL`,
      [itemId]
    );
    return rows[0] || null;
  }

  async getLowStockItems(userId: number): Promise<StockItemRow[]> {
    const { rows } = await pool.query(
      `SELECT si.*, w.name AS warehouse_name, f.name AS field_name, f.id AS field_id
       FROM stock_items si
       JOIN warehouses w ON si.warehouse_id = w.id
       JOIN fields f ON w.field_id = f.id
       WHERE w.field_id IN (${accessibleFieldsSql(1)})
         AND si.deleted_at IS NULL AND w.deleted_at IS NULL
         AND si.min_stock IS NOT NULL AND si.current_quantity <= si.min_stock
       ORDER BY f.name, w.name, si.name`,
      [userId]
    );
    return rows;
  }

  // ========================
  // STOCK MOVEMENTS
  // ========================

  async createMovement(
    stockItemId: number,
    userId: number,
    movementType: string,
    quantity: number,
    reason?: string,
    notes?: string,
    expenseId?: number,
    domainEventId?: number,
    movementDate?: string,
  ): Promise<StockMovementRow> {
    const { rows } = await pool.query(
      `INSERT INTO stock_movements
       (stock_item_id, user_id, movement_type, quantity, reason, notes, expense_id, domain_event_id, movement_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE))
       RETURNING *`,
      [
        stockItemId, userId, movementType, quantity,
        reason || null, notes || null,
        expenseId || null, domainEventId || null,
        movementDate || null,
      ]
    );
    return rows[0];
  }

  async getMovements(stockItemId: number, limit = 20): Promise<StockMovementRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM stock_movements
       WHERE stock_item_id = $1
       ORDER BY movement_date DESC, created_at DESC
       LIMIT $2`,
      [stockItemId, limit]
    );
    return rows;
  }

  /**
   * Atomic: update quantity + create movement in transaction
   */
  async applyMovement(
    itemId: number,
    userId: number,
    movementType: string,
    quantity: number,
    reason?: string,
    notes?: string,
    expenseId?: number,
    domainEventId?: number,
    movementDate?: string,
  ): Promise<{ item: StockItemRow; movement: StockMovementRow }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the item row
      const { rows: items } = await client.query(
        `SELECT * FROM stock_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [itemId]
      );
      if (items.length === 0) throw new Error('Stock item no encontrado');
      const item = items[0];

      let newQty: number;
      if (movementType === 'entrada') {
        newQty = parseFloat(item.current_quantity) + quantity;
      } else if (movementType === 'salida') {
        newQty = parseFloat(item.current_quantity) - quantity;
        if (newQty < 0) throw new Error(`Stock insuficiente. Disponible: ${item.current_quantity} ${item.unit}`);
      } else {
        // ajuste: set absolute value
        newQty = quantity;
      }

      await client.query(
        `UPDATE stock_items SET current_quantity = $1, updated_at = NOW() WHERE id = $2`,
        [newQty, itemId]
      );

      const { rows: movements } = await client.query(
        `INSERT INTO stock_movements
         (stock_item_id, user_id, movement_type, quantity, reason, notes, expense_id, domain_event_id, movement_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE))
         RETURNING *`,
        [
          itemId, userId, movementType,
          movementType === 'ajuste' ? quantity : quantity,
          reason || null, notes || null,
          expenseId || null, domainEventId || null,
          movementDate || null,
        ]
      );

      await client.query('COMMIT');

      item.current_quantity = newQty;
      return { item, movement: movements[0] };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
