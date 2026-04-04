import { StockRepository } from './stock.repository.js';
import type { WarehouseRow, StockItemRow, StockMovementRow } from './stock.repository.js';
import { getFieldByName } from '../../services/expenses.js';
import type { UserId } from '../../types/index.js';

export class StockService {
  private repo: StockRepository;

  constructor(repo?: StockRepository) {
    this.repo = repo ?? new StockRepository();
  }

  // ========================
  // WAREHOUSES
  // ========================

  async createWarehouse(
    userId: UserId,
    name: string,
    fieldName?: string,
  ): Promise<{ warehouse: WarehouseRow; autoCreated: boolean }> {
    const field = await this.resolveField(userId, fieldName);
    if (!field) throw new Error(fieldName ? `Campo "${fieldName}" no encontrado` : 'No tenés campos registrados');

    const warehouse = await this.repo.createWarehouse(field.id, name);
    return { warehouse, autoCreated: false };
  }

  async listWarehouses(userId: UserId, fieldName?: string): Promise<WarehouseRow[]> {
    if (fieldName) {
      const field = await this.resolveField(userId, fieldName);
      if (!field) throw new Error(`Campo "${fieldName}" no encontrado`);
      return this.repo.getWarehousesByField(field.id);
    }
    return this.repo.getAccessibleWarehouses(Number(userId));
  }

  // ========================
  // STOCK OPERATIONS
  // ========================

  async addStock(
    userId: UserId,
    product: string,
    quantity: number,
    unit: string,
    opts: {
      fieldName?: string;
      warehouseName?: string;
      category?: string;
      reason?: string;
      expenseId?: number;
      movementDate?: string;
    } = {},
  ): Promise<{ item: StockItemRow; movement: StockMovementRow; created: boolean }> {
    const warehouse = await this.resolveWarehouse(userId, opts.warehouseName, opts.fieldName);

    // Find existing item or create new one
    let item = await this.repo.findStockItem(warehouse.id, product);
    let created = false;

    if (item) {
      // Validate unit compatibility
      if (item.unit.toLowerCase() !== unit.toLowerCase()) {
        throw new Error(`El producto "${item.name}" está en ${item.unit}, no se puede cargar en ${unit}`);
      }
    }

    if (!item) {
      const category = opts.category || 'otros';
      item = await this.repo.createStockItem(Number(userId), warehouse.id, product, category, 0, unit);
      created = true;
    }

    const { item: updatedItem, movement } = await this.repo.applyMovement(
      item.id, Number(userId), 'entrada', quantity,
      opts.reason || 'Carga manual',
      undefined, opts.expenseId, undefined, opts.movementDate,
    );

    // Add warehouse/field context
    updatedItem.warehouse_name = warehouse.name;
    updatedItem.field_name = warehouse.field_name;

    return { item: updatedItem, movement, created };
  }

  async removeStock(
    userId: UserId,
    product: string,
    quantity: number,
    unit: string,
    opts: {
      fieldName?: string;
      warehouseName?: string;
      reason?: string;
      domainEventId?: number;
      movementDate?: string;
    } = {},
  ): Promise<{ item: StockItemRow; movement: StockMovementRow }> {
    const item = await this.findProduct(userId, product, opts.fieldName);
    if (!item) throw new Error(`No se encontró "${product}" en el stock`);

    if (item.unit.toLowerCase() !== unit.toLowerCase()) {
      throw new Error(`"${item.name}" está en ${item.unit}, no se puede descontar en ${unit}`);
    }

    const { item: updatedItem, movement } = await this.repo.applyMovement(
      item.id, Number(userId), 'salida', quantity,
      opts.reason || 'Descarga manual',
      undefined, undefined, opts.domainEventId, opts.movementDate,
    );

    updatedItem.warehouse_name = item.warehouse_name;
    updatedItem.field_name = item.field_name;

    return { item: updatedItem, movement };
  }

  async adjustStock(
    userId: UserId,
    product: string,
    quantity: number,
    unit: string,
    opts: { fieldName?: string; warehouseName?: string; reason?: string } = {},
  ): Promise<{ item: StockItemRow; movement: StockMovementRow }> {
    const warehouse = await this.resolveWarehouse(userId, opts.warehouseName, opts.fieldName);

    let item = await this.repo.findStockItem(warehouse.id, product);
    if (!item) {
      // Create with adjusted quantity
      item = await this.repo.createStockItem(Number(userId), warehouse.id, product, 'otros', quantity, unit);
      const movement = await this.repo.createMovement(
        item.id, Number(userId), 'ajuste', quantity,
        opts.reason || 'Ajuste de inventario',
      );
      item.warehouse_name = warehouse.name;
      item.field_name = warehouse.field_name;
      return { item, movement };
    }

    if (item.unit.toLowerCase() !== unit.toLowerCase()) {
      throw new Error(`"${item.name}" está en ${item.unit}, no se puede ajustar en ${unit}`);
    }

    const { item: updatedItem, movement } = await this.repo.applyMovement(
      item.id, Number(userId), 'ajuste', quantity,
      opts.reason || 'Ajuste de inventario',
    );

    updatedItem.warehouse_name = item.warehouse_name;
    updatedItem.field_name = item.field_name;

    return { item: updatedItem, movement };
  }

  async checkStock(
    userId: UserId,
    product?: string,
    fieldName?: string,
  ): Promise<StockItemRow[]> {
    if (product) {
      const item = await this.findProduct(userId, product, fieldName);
      return item ? [item] : [];
    }

    let fieldId: number | undefined;
    if (fieldName) {
      const field = await this.resolveField(userId, fieldName);
      if (field) fieldId = field.id;
    }

    return this.repo.getStockItems(Number(userId), fieldId);
  }

  async getStockHistory(
    userId: UserId,
    product: string,
    fieldName?: string,
  ): Promise<{ item: StockItemRow; movements: StockMovementRow[] }> {
    const item = await this.findProduct(userId, product, fieldName);
    if (!item) throw new Error(`No se encontró "${product}" en el stock`);

    const movements = await this.repo.getMovements(item.id, 20);
    return { item, movements };
  }

  async setMinStock(
    userId: UserId,
    product: string,
    minStock: number,
    fieldName?: string,
  ): Promise<StockItemRow> {
    const item = await this.findProduct(userId, product, fieldName);
    if (!item) throw new Error(`No se encontró "${product}" en el stock`);

    await this.repo.updateQuantity(item.id, item.current_quantity); // just to get updated_at
    // Direct update for min_stock
    const pool = (await import('../../config/db.js')).pool;
    await pool.query(
      `UPDATE stock_items SET min_stock = $1, updated_at = NOW() WHERE id = $2`,
      [minStock, item.id]
    );
    item.min_stock = minStock;
    return item;
  }

  async getLowStockItems(userId: UserId): Promise<StockItemRow[]> {
    return this.repo.getLowStockItems(Number(userId));
  }

  async addGrainStock(
    userId: UserId,
    crop: string,
    quantity: number,
    unit: string,
    opts: {
      fieldName?: string;
      warehouseName?: string;
      humidity?: number;
      grade?: string;
      domainEventId?: number;
    } = {},
  ): Promise<{ item: StockItemRow; movement: StockMovementRow; created: boolean }> {
    const warehouse = await this.resolveWarehouse(userId, opts.warehouseName, opts.fieldName);

    let item = await this.repo.findStockItem(warehouse.id, crop);
    let created = false;

    if (item) {
      if (item.unit.toLowerCase() !== unit.toLowerCase()) {
        throw new Error(`"${item.name}" está en ${item.unit}, no se puede cargar en ${unit}`);
      }
      // Update grain attrs if provided
      if (opts.humidity !== undefined || opts.grade) {
        const pool = (await import('../../config/db.js')).pool;
        const sets: string[] = [];
        const params: (string | number)[] = [];
        if (opts.humidity !== undefined) {
          params.push(opts.humidity);
          sets.push(`humidity_pct = $${params.length}`);
        }
        if (opts.grade) {
          params.push(opts.grade);
          sets.push(`grade = $${params.length}`);
        }
        params.push(item.id);
        await pool.query(
          `UPDATE stock_items SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
          params
        );
      }
    }

    if (!item) {
      item = await this.repo.createStockItem(
        Number(userId), warehouse.id, crop, 'granos', 0, unit,
        opts.grade, opts.humidity,
      );
      created = true;
    }

    const { item: updatedItem, movement } = await this.repo.applyMovement(
      item.id, Number(userId), 'entrada', quantity,
      'Cosecha',
      undefined, undefined, opts.domainEventId,
    );

    updatedItem.warehouse_name = warehouse.name;
    updatedItem.field_name = warehouse.field_name;

    return { item: updatedItem, movement, created };
  }

  // ========================
  // HELPERS
  // ========================

  private async resolveField(userId: UserId, fieldName?: string): Promise<{ id: number; name: string } | null> {
    if (fieldName) {
      const field = await getFieldByName(Number(userId), fieldName);
      return field || null;
    }
    // Try to get first accessible field
    const pool = (await import('../../config/db.js')).pool;
    const { rows } = await pool.query(
      `SELECT f.id, f.name FROM fields f
       JOIN field_members fm ON f.id = fm.field_id
       WHERE fm.user_id = $1 AND f.deleted_at IS NULL
       ORDER BY f.id ASC LIMIT 1`,
      [Number(userId)]
    );
    return rows[0] || null;
  }

  async resolveWarehouse(
    userId: UserId,
    warehouseName?: string,
    fieldName?: string,
  ): Promise<WarehouseRow & { field_name?: string }> {
    // If warehouse name specified, find it
    if (warehouseName) {
      const wh = await this.repo.findWarehouse(Number(userId), warehouseName, fieldName);
      if (wh) return wh;
      throw new Error(`Depósito "${warehouseName}" no encontrado`);
    }

    // Resolve field
    const field = await this.resolveField(userId, fieldName);
    if (!field) throw new Error(fieldName ? `Campo "${fieldName}" no encontrado` : 'No tenés campos registrados');

    // Get warehouses for this field
    const warehouses = await this.repo.getWarehousesByField(field.id);

    if (warehouses.length === 1) return warehouses[0];
    if (warehouses.length > 1) {
      // Return the first one (oldest)
      return warehouses[0];
    }

    // No warehouse: auto-create "Principal"
    const wh = await this.repo.createWarehouse(field.id, 'Principal');
    (wh as WarehouseRow & { field_name?: string }).field_name = field.name;
    return wh as WarehouseRow & { field_name?: string };
  }

  async findProduct(userId: UserId, product: string, fieldName?: string): Promise<StockItemRow | null> {
    let fieldId: number | undefined;
    if (fieldName) {
      const field = await this.resolveField(userId, fieldName);
      if (field) fieldId = field.id;
    }
    return this.repo.findStockItemFuzzy(Number(userId), product, fieldId);
  }
}
