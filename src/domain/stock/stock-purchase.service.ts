import { StockService } from './stock.service.js';
import { StockRepository } from './stock.repository.js';
import { logError } from '../../services/error-logger.js';
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
      // Find or auto-create warehouse for the expense's field
      const fieldWarehouses = await repo.getWarehousesByField(fieldId);
      let warehouse = fieldWarehouses[0];
      if (!warehouse) {
        warehouse = await repo.createWarehouse(fieldId, 'Principal');
      }

      return {
        expenseId,
        product,
        quantity,
        unit,
        fieldId,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
      };
    } catch (err) {
      console.error('[stock-purchase] suggestStockEntry error:', err);
      logError('stock', 'PURCHASE_SUGGEST', err as Error);
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
