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
  /** Campaña y lote de la cosecha: tras el tap se ofrece el costo de cosechar (P2-12). */
  plotCropId?: number;
  plotLabel?: string;
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
      // Sin la feature de stock no se ofrece (STK-15): el gate vive acá para
      // cubrir los tres caminos que lo ofrecen (gasto, confirmación, flow).
      if (!(await hasStockFeature(userId))) return null;
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
    // Un botón viejo (o de cuando tenía el plan) tampoco escribe sin la feature.
    if (!(await hasStockFeature(userId))) {
      console.log(`[INTERCEPT] stock entry sin feature stock: user=${userId}`);
      throw new Error('Tu plan no incluye el stock de insumos.');
    }
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
          fieldId: grain.warehouseName ? undefined : grain.fieldId || undefined,
        },
      );
      return { item, movement };
    }

    // Normal insumo entry from expense. El `'type' in x && x.type === 'grain'`
    // de arriba no alcanza para que TS descarte GrainStockEntry en esta rama,
    // así que se nombra la variante una sola vez en lugar de castear por campo.
    // Al galpón que se le mostró al usuario (el del campo del gasto). Antes se
    // ignoraba y la compra del campo Beta entraba al galpón de Alfa (STK-2).
    const insumo = suggestion as StockEntrySuggestion;
    const { item, movement } = await stockService.addStockToWarehouse(
      userId,
      insumo.warehouseId,
      insumo.product,
      category || 'otros',
      insumo.quantity,
      insumo.unit,
      'Compra',
      insumo.expenseId,
    );
    item.warehouse_name = item.warehouse_name ?? insumo.warehouseName;
    return { item, movement };
  }

  /**
   * Decline stock entry — no-op, just for tracking.
   */
  declineStockEntry(_suggestion: StockEntrySuggestion): void {
    // No action needed; the suggestion is discarded
  }
}

async function hasStockFeature(userId: UserId): Promise<boolean> {
  const { FeatureGate } = await import('../billing/feature-gate.js');
  return new FeatureGate().hasFeature(userId, 'stock');
}
