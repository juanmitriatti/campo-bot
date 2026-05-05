import { StockService } from './stock.service.js';
import type { StockItemRow, StockMovementRow } from './stock.repository.js';
import type { UserId } from '../../types/index.js';
import { pool } from '../../config/db.js';
import { logError } from '../../services/error-logger.js';

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
      // If no quantity, still return suggestion so handler can ask the user
      if (!totalQuantity) {
        // Check if there's stock at all
        if (item.current_quantity <= 0) return null;

        await pool.query(
          `UPDATE domain_events SET stock_deduction_status = 'suggested' WHERE id = $1`,
          [domainEventId]
        );

        return {
          domainEventId,
          stockItemId: item.id,
          product: item.name,
          totalQuantity: 0,
          unit: item.unit,
          fieldId: item.field_id || 0,
          warehouseName: item.warehouse_name || 'Principal',
          currentStock: item.current_quantity,
          plotHectares,
          dosePerHa,
        };
      }

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
    } catch (err) {
      console.error('[stock-deduction] suggestDeduction failed:', err);
      logError('stock', 'DEDUCTION_SUGGEST', err as Error);
      return null;
    }
  }

  /**
   * Apply a stock deduction from an activity.
   *
   * Idempotency guard: if the activity's stock_deduction_status is already
   * 'accepted' OR if a stock_movement is already linked to this
   * domain_event_id, skip the deduction. This prevents the double-deduction
   * bug surfaced by the QA "Roberto" persona — the spray flow could leave
   * a pending deduction AND the agent could also fire remove_stock in the
   * same compound, causing 240 lt to leave stock when the user used 120.
   */
  async applyDeduction(
    userId: UserId,
    suggestion: StockDeductionSuggestion,
  ): Promise<{ item: StockItemRow; movement: StockMovementRow; alreadyApplied?: boolean }> {
    const guard = await pool.query(
      `SELECT
         (SELECT stock_deduction_status FROM domain_events WHERE id = $1) AS status,
         (SELECT COUNT(*)::int FROM stock_movements WHERE domain_event_id = $1) AS movement_count`,
      [suggestion.domainEventId],
    );
    const status = guard.rows[0]?.status;
    const movementCount = Number(guard.rows[0]?.movement_count || 0);
    if (status === 'accepted' || movementCount > 0) {
      // Already deducted via this domain_event — return current item state without duplicating.
      const item = await stockService.findProduct(userId, suggestion.product);
      const fakeMovement = { id: 0, stock_item_id: suggestion.stockItemId, user_id: Number(userId), movement_type: 'salida', quantity: 0, reason: 'duplicate-skipped', notes: null, expense_id: null, domain_event_id: suggestion.domainEventId, movement_date: new Date(), created_at: new Date() } as StockMovementRow;
      return { item: item!, movement: fakeMovement, alreadyApplied: true };
    }

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
