import { StockService } from './stock.service.js';
import type { StockItemRow, StockMovementRow } from './stock.repository.js';
import type { UserId } from '../../types/index.js';
import { pool } from '../../config/db.js';

const stockService = new StockService();

export interface StockDeductionSuggestion {
  domainEventId: number;
  stockItemId: number;
  product: string;
  totalQuantity: number;
  unit: string;
  fieldId: number;
  warehouseName: string;
  currentStock: number;
  plotName?: string;
  plotHectares?: number;
  dosePerHa?: number;
}

export class StockDeductionService {

  /**
   * After saving an activity (spraying/fertilization/planting),
   * find matching stock items and suggest a deduction.
   */
  async suggestDeduction(
    userId: UserId,
    domainEventId: number,
    product: string,
    quantity?: number,
    unit?: string,
    fieldId?: number,
    plotHectares?: number,
    dosePerHa?: number,
  ): Promise<StockDeductionSuggestion | null> {
    if (!product) return null;

    try {
      // Find product in stock
      const fieldName = fieldId ? undefined : undefined;
      const item = await stockService.findProduct(userId, product, fieldName);
      if (!item) return null;

      // Calculate total quantity
      let totalQuantity = quantity || 0;
      if (dosePerHa && plotHectares && !totalQuantity) {
        totalQuantity = dosePerHa * plotHectares;
      }
      if (!totalQuantity) return null;

      // Check unit compatibility
      const itemUnit = item.unit.toLowerCase();
      const reqUnit = (unit || item.unit).toLowerCase();
      if (itemUnit !== reqUnit) {
        // Try common conversions: lt/ha → lt, kg/ha → kg
        const baseUnit = reqUnit.replace('/ha', '');
        if (itemUnit !== baseUnit) return null;
      }

      // Check if there's enough stock
      if (item.current_quantity <= 0) return null;

      // Mark activity as suggestion pending
      await pool.query(
        `UPDATE domain_events SET stock_deduction_status = 'suggested' WHERE id = $1`,
        [domainEventId]
      );

      return {
        domainEventId,
        stockItemId: item.id,
        product: item.name,
        totalQuantity,
        unit: item.unit,
        fieldId: item.field_id || 0,
        warehouseName: item.warehouse_name || 'Principal',
        currentStock: item.current_quantity,
        plotHectares,
        dosePerHa,
      };
    } catch {
      return null;
    }
  }

  /**
   * Apply a stock deduction from an activity.
   */
  async applyDeduction(
    userId: UserId,
    suggestion: StockDeductionSuggestion,
  ): Promise<{ item: StockItemRow; movement: StockMovementRow }> {
    const { item, movement } = await stockService.removeStock(
      userId,
      suggestion.product,
      suggestion.totalQuantity,
      suggestion.unit,
      {
        reason: 'Uso en actividad',
        domainEventId: suggestion.domainEventId,
      },
    );

    // Mark activity as accepted
    await pool.query(
      `UPDATE domain_events SET stock_deduction_status = 'accepted' WHERE id = $1`,
      [suggestion.domainEventId]
    );

    return { item, movement };
  }

  /**
   * Decline a stock deduction.
   */
  async declineDeduction(domainEventId: number): Promise<void> {
    await pool.query(
      `UPDATE domain_events SET stock_deduction_status = 'declined' WHERE id = $1`,
      [domainEventId]
    );
  }
}
