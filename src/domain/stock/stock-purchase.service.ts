import { StockService } from './stock.service.js';
import { StockRepository } from './stock.repository.js';
import type { StockItemRow, StockMovementRow } from './stock.repository.js';
import type { UserId } from '../../types/index.js';

const stockService = new StockService();
const repo = new StockRepository();

export interface StockEntrySuggestion {
  expenseId: number;
  product: string;
  quantity: number;
  unit: string;
  fieldId: number;
  warehouseId: number;
  warehouseName: string;
}

export interface GrainStockEntry {
  type: 'grain';
  domainEventId: number;
  crop: string;
  quantity: number;
  unit: string;
  fieldId: number;
  warehouseName?: string;
}

export class StockPurchaseService {

  /**
   * After saving an insumo expense, check if we should suggest loading it to stock.
   * Returns a suggestion if field has (or can have) a warehouse.
   */
  async suggestStockEntry(
    userId: UserId,
    expenseId: number,
    product: string,
    quantity: number,
    unit: string,
    fieldId: number,
  ): Promise<StockEntrySuggestion | null> {
    if (!product || !quantity || !unit || !fieldId) return null;

    try {
      // Resolve or auto-create warehouse for the field
      const warehouse = await stockService.resolveWarehouse(userId, undefined, undefined);
      if (!warehouse) return null;

      // Check warehouse belongs to same field
      const fieldWarehouses = await repo.getWarehousesByField(fieldId);
      const match = fieldWarehouses[0]; // use first warehouse in field
      if (!match) {
        // Auto-create for this specific field
        const newWh = await repo.createWarehouse(fieldId, 'Principal');
        return {
          expenseId,
          product,
          quantity,
          unit,
          fieldId,
          warehouseId: newWh.id,
          warehouseName: newWh.name,
        };
      }

      return {
        expenseId,
        product,
        quantity,
        unit,
        fieldId,
        warehouseId: match.id,
        warehouseName: match.name,
      };
    } catch {
      return null;
    }
  }

  /**
   * Apply a stock entry from a purchase (expense → stock).
   */
  async applyStockEntry(
    userId: UserId,
    suggestion: StockEntrySuggestion | GrainStockEntry,
    category?: string,
  ): Promise<{ item: StockItemRow; movement: StockMovementRow }> {
    // Grain entry from harvest
    if ('type' in suggestion && suggestion.type === 'grain') {
      const grain = suggestion as GrainStockEntry;
      const { item, movement } = await stockService.addGrainStock(
        userId,
        grain.crop,
        grain.quantity,
        grain.unit,
        {
          warehouseName: grain.warehouseName,
          domainEventId: grain.domainEventId,
        },
      );
      return { item, movement };
    }

    // Normal insumo entry from expense
    const { item, movement } = await stockService.addStock(
      userId,
      suggestion.product,
      suggestion.quantity,
      suggestion.unit,
      {
        category: category || 'otros',
        reason: 'Compra',
        expenseId: (suggestion as StockEntrySuggestion).expenseId,
      },
    );
    return { item, movement };
  }

  /**
   * Decline stock entry — no-op, just for tracking.
   */
  declineStockEntry(_suggestion: StockEntrySuggestion): void {
    // No action needed; the suggestion is discarded
  }
}
