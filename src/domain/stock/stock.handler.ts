import { StockService } from './stock.service.js';
import { formatDateAR } from '../../utils/date.js';
import { saveExpense } from '../../services/expenses.js';
import type { UserId, User, UserSettings, ParsedCommand, HandlerResponse } from '../../types/index.js';

const stockService = new StockService();

export class StockHandler {
  async handleCommand(
    cmd: ParsedCommand,
    userId: UserId,
    _user: User,
    _settings: UserSettings,
  ): Promise<HandlerResponse> {
    try {
      switch (cmd.command) {
        case 'create_warehouse': return await this.createWarehouse(cmd, userId);
        case 'list_warehouses': return await this.listWarehouses(cmd, userId);
        case 'add_stock': return await this.addStock(cmd, userId);
        case 'remove_stock': return await this.removeStock(cmd, userId);
        case 'adjust_stock': return await this.adjustStock(cmd, userId);
        case 'check_stock': return await this.checkStock(cmd, userId);
        case 'stock_history': return await this.stockHistory(cmd, userId);
        case 'set_min_stock': return await this.setMinStock(cmd, userId);
        case 'check_low_stock': return await this.checkLowStock(userId);
        default:
          return { messages: ['Comando de stock no reconocido.'] };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error en operación de stock';
      return { messages: [`❌ ${msg}`] };
    }
  }

  private async createWarehouse(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const name = cmd.warehouseName as string || cmd.product as string;
    if (!name) return { messages: ['Necesito el nombre del depósito. Ej: "crear depósito Galpón Norte en campo X"'] };

    const { warehouse } = await stockService.createWarehouse(userId, name, cmd.fieldName as string);
    return {
      messages: [`🏭 Depósito *${warehouse.name}* creado correctamente.`],
    };
  }

  private async listWarehouses(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const warehouses = await stockService.listWarehouses(userId, cmd.fieldName as string);

    if (warehouses.length === 0) {
      return { messages: ['No tenés depósitos registrados. Se creará uno automáticamente al cargar stock.'] };
    }

    const productCounts = await stockService.getWarehouseProductCounts(userId);
    const lines = warehouses.map(w => {
      const count = productCounts.get(w.id) || 0;
      const countLabel = count > 0 ? ` — ${count} producto${count > 1 ? 's' : ''}` : '';
      return `  📦 *${w.name}* (${w.field_name})${countLabel}`;
    });
    return {
      messages: [`🏭 *Depósitos*\n\n${lines.join('\n')}`],
    };
  }

  private async addStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const product = cmd.product as string;
    const quantity = cmd.quantity as number;
    const unit = cmd.unit as string;

    // Unified pending-action guard. When the user says "Cargá stock" without
    // specifying product/quantity/unit, persist the partial cmd and let the
    // SlotExtractor merge the next message. Same pattern as fertilization.
    const missing: string[] = [];
    if (!product) missing.push('product');
    if (!quantity || quantity <= 0) missing.push('quantity');
    if (!unit) missing.push('unit');
    if (missing.length > 0) {
      const askParts: string[] = [];
      if (missing.includes('product')) askParts.push('¿qué producto?');
      if (missing.includes('quantity')) askParts.push('¿qué cantidad?');
      if (missing.includes('unit')) askParts.push('¿qué unidad? (lt, kg, bolsas...)');
      const askPrompt = `📦 Cargar stock — me faltan datos: ${askParts.join(' ')}`;
      return {
        messages: [askPrompt],
        sideEffects: {
          setPendingActivity: {
            command: 'add_stock',
            data: { ...cmd },
            missing,
            askPrompt,
          },
        },
      };
    }

    const { item, movement, created } = await stockService.addStock(userId, product, quantity, unit, {
      fieldName: cmd.fieldName as string,
      warehouseName: cmd.warehouseName as string,
      category: cmd.category as string,
      reason: cmd.reason as string,
    });

    // Auto-create linked expense if unit_price provided (follows livestock pattern)
    let expenseLine = '';
    const unitPriceArs = cmd.unit_price_ars as number | undefined;
    const unitPriceUsd = cmd.unit_price_usd as number | undefined;
    if (unitPriceArs || unitPriceUsd) {
      try {
        const price = unitPriceArs ?? unitPriceUsd!;
        const currency = unitPriceArs ? 'ARS' : 'USD';
        const totalAmount = quantity * price;
        const expense = await saveExpense(
          userId,
          {
            category: 'Insumos',
            description: `Compra insumo: ${quantity} ${unit} de ${product}`,
            amount: totalAmount,
            currency,
            expenseType: 'insumo',
            product,
            quantity,
            unit,
            unit_price: price,
          },
          item.field_id ?? null,
          null,
        );
        if (expense?.id) {
          await stockService.linkMovementToExpense(movement.id, expense.id);
        }
        const moneyLabel = currency === 'USD'
          ? `USD ${totalAmount.toLocaleString('es-AR')}`
          : `$${totalAmount.toLocaleString('es-AR')}`;
        expenseLine = `\n  💰 Gasto registrado: ${moneyLabel}`;
      } catch (err) {
        console.error('[STOCK_HANDLER] Failed to create linked expense:', (err as Error).message);
        // Best-effort: stock insert succeeded, expense failed — don't fail the whole operation
      }
    }

    const newLabel = created ? ' (nuevo)' : '';
    return {
      messages: [
        `📥 *Stock registrado*\n\n` +
        `  📦 *${item.name}*${newLabel}\n` +
        `  ➕ ${quantity} ${unit}\n` +
        `  📊 Total: *${item.current_quantity} ${item.unit}*\n` +
        `  🏭 ${item.warehouse_name || 'Principal'} (${item.field_name || ''})` +
        expenseLine,
      ],
    };
  }

  private async removeStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const product = cmd.product as string;
    const quantity = cmd.quantity as number;
    const unit = cmd.unit as string;

    if (!product) return { messages: ['Necesito el nombre del producto. Ej: "usé 50lt de glifosato"'] };
    if (!quantity || quantity <= 0) return { messages: ['Necesito la cantidad. Ej: "usé 50lt de glifosato"'] };
    if (!unit) return { messages: ['Necesito la unidad. Ej: "usé 50lt de glifosato"'] };

    const { item } = await stockService.removeStock(userId, product, quantity, unit, {
      fieldName: cmd.fieldName as string,
      warehouseName: cmd.warehouseName as string,
      reason: cmd.reason as string,
    });

    return {
      messages: [
        `📤 *Stock descontado*\n\n` +
        `  📦 *${item.name}*\n` +
        `  ➖ ${quantity} ${unit}\n` +
        `  📊 Quedan: *${item.current_quantity} ${item.unit}*\n` +
        `  🏭 ${item.warehouse_name || 'Principal'} (${item.field_name || ''})`,
      ],
    };
  }

  private async adjustStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const product = cmd.product as string;
    const quantity = cmd.quantity as number;
    const unit = cmd.unit as string;

    if (!product) return { messages: ['Necesito el producto. Ej: "tengo 200lt de glifosato"'] };
    if (quantity == null || quantity < 0) return { messages: ['Necesito la cantidad actual. Ej: "tengo 200lt de glifosato"'] };
    if (!unit) return { messages: ['Necesito la unidad. Ej: "tengo 200lt de glifosato"'] };

    const { item } = await stockService.adjustStock(userId, product, quantity, unit, {
      fieldName: cmd.fieldName as string,
      warehouseName: cmd.warehouseName as string,
      reason: cmd.reason as string,
    });

    return {
      messages: [
        `📊 *Stock ajustado*\n\n` +
        `  📦 *${item.name}*\n` +
        `  📊 Cantidad actual: *${item.current_quantity} ${item.unit}*\n` +
        `  🏭 ${item.warehouse_name || 'Principal'} (${item.field_name || ''})`,
      ],
    };
  }

  private async checkStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // ── Unified dispatch path: when ANY new param is present, route to handleQueryStock ──
    const hasNewParam = cmd.view != null || cmd.lowStockOnly != null || cmd.category != null
      || cmd.warehouseName != null || cmd.quantityMin != null || cmd.quantityMax != null
      || cmd.hasMinStock != null || cmd.group_by != null || cmd.aggregateMetric != null
      || cmd.compareWarehouse != null || cmd.compareCategory != null || cmd.compareField != null
      || cmd.inherit != null || cmd.sort_by != null || cmd.sort_desc != null || cmd.top_n != null;
    if (hasNewParam || (!cmd.product && !cmd.fieldName)) {
      return this.handleQueryStock(cmd, userId);
    }
    // Legacy path: single-product lookup (preserves the older response shape for that case)
    const items = await stockService.checkStock(
      userId,
      cmd.product as string,
      cmd.fieldName as string,
    );

    if (items.length === 0) {
      if (cmd.product) {
        return { messages: [`No se encontró "${cmd.product}" en el stock.`] };
      }
      return {
        messages: ['📦 No tenés stock registrado. Cargá insumos con "cargué X de Y".'],
        suggestionKey: 'stock_empty',
      };
    }

    if (items.length === 1) {
      const it = items[0];
      const minLabel = it.min_stock != null ? `  ⚠️ Mínimo: ${it.min_stock} ${it.unit}\n` : '';
      const lowWarning = it.min_stock != null && it.current_quantity <= it.min_stock ? '  🔴 *STOCK BAJO*\n' : '';
      const grainInfo = (it.grade || it.humidity_pct != null)
        ? `  🌾 ${it.grade ? `Grado: ${it.grade}` : ''}${it.grade && it.humidity_pct != null ? ' | ' : ''}${it.humidity_pct != null ? `Humedad: ${it.humidity_pct}%` : ''}\n`
        : '';
      return {
        messages: [
          `📦 *${it.name}*\n\n` +
          `  📊 Cantidad: *${it.current_quantity} ${it.unit}*\n` +
          grainInfo +
          minLabel + lowWarning +
          `  🏭 ${it.warehouse_name || 'Principal'} (${it.field_name || ''})`,
        ],
      };
    }

    // Aggregate by unit so a "cuánto en total" question gets a real summary line
    // even when units differ. Mixing lt and kg without breakdown is misleading.
    const totalsByUnit = new Map<string, number>();
    for (const it of items) {
      const unit = String(it.unit).toLowerCase();
      totalsByUnit.set(unit, (totalsByUnit.get(unit) || 0) + Number(it.current_quantity));
    }
    const totalLine = Array.from(totalsByUnit.entries())
      .map(([u, q]) => `${q.toLocaleString('es-AR')} ${u}`)
      .join(' · ');
    const summary = `\n\n📊 *Total*: ${totalLine}`;

    // Same product spread across multiple warehouses — the user asked
    // "cuánto X tengo" and we have it in N depots. Show product-focused
    // header + per-depot breakdown so they see the real picture.
    const allSameProduct = cmd.product && items.every(it => String(it.name).toLowerCase() === String(items[0].name).toLowerCase());
    if (allSameProduct) {
      const breakdown = items
        .map(it => `  • *${it.current_quantity} ${it.unit}* — ${it.warehouse_name || 'Principal'} (${it.field_name || ''})`)
        .join('\n');
      return {
        messages: [`📦 *${items[0].name}* — Total: *${totalLine}*\n\nRepartido en ${items.length} depósitos:\n${breakdown}`],
      };
    }

    // Multiple items — detail when ≤15, compact when more
    if (items.length <= 15) {
      const lines = items.map(it => {
        const minLabel = it.min_stock != null ? `  ⚠️ Mínimo: ${it.min_stock} ${it.unit}\n` : '';
        const lowWarning = it.min_stock != null && it.current_quantity <= it.min_stock ? '  🔴 *STOCK BAJO*\n' : '';
        const grainInfo = (it.grade || it.humidity_pct != null)
          ? `  🌾 ${it.grade ? `Grado: ${it.grade}` : ''}${it.grade && it.humidity_pct != null ? ' | ' : ''}${it.humidity_pct != null ? `Humedad: ${it.humidity_pct}%` : ''}\n`
          : '';
        return `📦 *${it.name}*\n` +
          `  📊 Cantidad: *${it.current_quantity} ${it.unit}*\n` +
          grainInfo +
          minLabel + lowWarning +
          `  🏭 ${it.warehouse_name || 'Principal'} (${it.field_name || ''})`;
      });

      return {
        messages: [`📦 *Inventario* (${items.length} productos)\n\n${lines.join('\n\n')}${summary}`],
      };
    }

    const lines = items.map(it => {
      const low = it.min_stock != null && it.current_quantity <= it.min_stock ? ' 🔴' : '';
      const grain = it.grade ? ` [G${it.grade}${it.humidity_pct != null ? ` H${it.humidity_pct}%` : ''}]` : '';
      return `  • *${it.name}*: ${it.current_quantity} ${it.unit}${grain}${low} — ${it.warehouse_name} (${it.field_name})`;
    });

    return {
      messages: [`📦 *Inventario* (${items.length} productos)\n\n${lines.join('\n')}${summary}`],
    };
  }

  private async stockHistory(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const product = cmd.product as string;
    if (!product) return { messages: ['Necesito el producto. Ej: "movimientos de glifosato"'] };

    const { item, movements } = await stockService.getStockHistory(
      userId, product, cmd.fieldName as string,
    );

    if (movements.length === 0) {
      return { messages: [`No hay movimientos de *${item.name}*.`] };
    }

    const typeEmoji: Record<string, string> = { entrada: '📥', salida: '📤', ajuste: '📊' };
    const lines = movements.map(m => {
      const emoji = typeEmoji[m.movement_type] || '📋';
      const sign = m.movement_type === 'salida' ? '-' : m.movement_type === 'entrada' ? '+' : '=';
      const date = formatDateAR(m.movement_date as string | Date);
      const reason = m.reason ? ` (${m.reason})` : '';
      const notes = m.notes ? ` | ${m.notes}` : '';
      return `  ${emoji} ${date}: ${sign}${m.quantity} ${item.unit}${reason}${notes}`;
    });

    return {
      messages: [
        `📋 *Movimientos de ${item.name}*\n` +
        `  📊 Stock actual: ${item.current_quantity} ${item.unit}\n\n` +
        lines.join('\n'),
      ],
    };
  }

  private async setMinStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const product = cmd.product as string;
    const minStock = cmd.quantity as number;

    if (!product) return { messages: ['Necesito el producto. Ej: "stock mínimo de glifosato 50lt"'] };
    if (minStock == null || minStock < 0) return { messages: ['Necesito la cantidad mínima.'] };

    const item = await stockService.setMinStock(userId, product, minStock, cmd.fieldName as string);

    return {
      messages: [
        `⚠️ *Stock mínimo configurado*\n\n` +
        `  📦 *${item.name}*\n` +
        `  ⚠️ Alerta cuando baje de: ${minStock} ${item.unit}\n` +
        `  📊 Stock actual: ${item.current_quantity} ${item.unit}`,
      ],
    };
  }

  private async checkLowStock(userId: UserId): Promise<HandlerResponse> {
    const items = await stockService.getLowStockItems(userId);

    if (items.length === 0) {
      return { messages: ['✅ No hay productos con stock bajo.'] };
    }

    const lines = items.map(it => {
      const pct = it.min_stock ? Math.round((it.current_quantity / it.min_stock) * 100) : 0;
      const color = pct <= 30 ? '🔴' : '🟡';
      return `  ${color} *${it.name}*: ${it.current_quantity} ${it.unit} (mínimo: ${it.min_stock} ${it.unit}) — ${it.warehouse_name} (${it.field_name})`;
    });

    return {
      messages: [
        `⚠️ *Alertas de stock bajo* (${items.length})\n\n${lines.join('\n')}`,
      ],
    };
  }

  // --- Unified query_stock dispatcher (same shape as financial/scouting/harvest) ---
  private async handleQueryStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { pool } = await import('../../config/db.js');
    const { StockRepository } = await import('./stock.repository.js');
    const renderers = await import('./stock-renderers.js');
    const repo = new StockRepository();

    // ── 1. Multi-turn inherit ──
    // Transient flags (boolean intents that apply ONLY to the current turn) are deliberately
    // excluded so they don't pollute subsequent queries: low_stock_only, has_min_stock, view, top_n.
    // Same for compare_* (compares are always explicit per-turn).
    const TRANSIENT_KEYS = new Set(['lowStockOnly', 'hasMinStock', 'view', 'top_n',
      'compareWarehouse', 'compareCategory', 'compareField']);
    if (cmd.inherit) {
      try {
        const { rows } = await pool.query('SELECT last_stock_query FROM conversation_state WHERE user_id = $1', [userId]);
        const prev = rows[0]?.last_stock_query;
        if (prev && typeof prev === 'object') {
          for (const [k, v] of Object.entries(prev)) {
            if (TRANSIENT_KEYS.has(k)) continue;
            if (cmd[k] == null) cmd[k] = v as never;
          }
        }
      } catch { /* non-fatal */ }
    }

    const sortBy = (cmd.sort_by as 'name' | 'quantity' | 'category' | 'warehouse') || 'name';
    const sortDesc = cmd.sort_desc != null ? !!cmd.sort_desc : false;

    // ── 2. Query ──
    const rows = await repo.queryStock({
      userId: Number(userId),
      fieldName: (cmd.fieldName as string) ?? null,
      warehouseName: (cmd.warehouseName as string) ?? null,
      category: (cmd.category as string) ?? null,
      productSearch: (cmd.product as string) ?? null,
      lowStockOnly: (cmd.lowStockOnly as boolean) ?? null,
      quantityMin: (cmd.quantityMin as number) ?? null,
      quantityMax: (cmd.quantityMax as number) ?? null,
      hasMinStock: (cmd.hasMinStock as boolean) ?? null,
      sortBy, sortDesc, limit: 200,
    });

    // ── 3. Persist for multi-turn ──
    void this.saveStockQuery(userId, cmd).catch(() => {});

    // ── 4. Build scope ──
    const scopeBits: string[] = [];
    if (cmd.fieldName) scopeBits.push(`campo ${cmd.fieldName}`);
    if (cmd.warehouseName) scopeBits.push(`depósito ${cmd.warehouseName}`);
    if (cmd.category) scopeBits.push(String(cmd.category).toLowerCase());
    if (cmd.product) scopeBits.push(`"${cmd.product}"`);
    if (cmd.lowStockOnly) scopeBits.push('bajo stock');
    if (cmd.quantityMin != null) scopeBits.push(`>${cmd.quantityMin}`);
    if (cmd.quantityMax != null) scopeBits.push(`<${cmd.quantityMax}`);
    const scope = scopeBits.length > 0 ? ` — ${scopeBits.join(', ')}` : '';

    const ctx: renderers.StockRenderCtx = {
      scope,
      filters: {
        fieldName: cmd.fieldName as string | null,
        warehouseName: cmd.warehouseName as string | null,
        category: cmd.category as string | null,
        productSearch: cmd.product as string | null,
        lowStockOnly: cmd.lowStockOnly as boolean | null,
        aggregateMetric: cmd.aggregateMetric as string | null,
        groupBy: cmd.group_by as string | null,
        sortDesc,
      },
    };

    // ── 5. Determine view ──
    const view = (cmd.view as string)
      || (cmd.compareWarehouse || cmd.compareCategory || cmd.compareField ? 'compare'
        : cmd.group_by ? 'top_locations'
        : 'detail');

    // ── 6. Compare ──
    if (view === 'compare') {
      const optsB = {
        userId: Number(userId),
        fieldName: (cmd.compareField as string) ?? (cmd.fieldName as string) ?? null,
        warehouseName: (cmd.compareWarehouse as string) ?? null,
        category: (cmd.compareCategory as string) ?? (cmd.category as string) ?? null,
        productSearch: (cmd.compareProduct as string) ?? (cmd.product as string) ?? null,
        lowStockOnly: (cmd.lowStockOnly as boolean) ?? null,
        sortBy, sortDesc, limit: 200,
      };
      // If comparing products, query A also filtered by product (the original term)
      if (cmd.compareProduct) {
        const optsA = { ...optsB, productSearch: (cmd.product as string) ?? null };
        const rowsAfiltered = await repo.queryStock(optsA);
        const rowsB = await repo.queryStock(optsB);
        const labelA = (cmd.product as string) || 'A';
        const labelB = (cmd.compareProduct as string) || 'B';
        return renderers.renderStockCompare(rowsAfiltered as renderers.StockRow[], rowsB as renderers.StockRow[], labelA, labelB);
      }
      const rowsB = await repo.queryStock(optsB);
      const labelA = (cmd.warehouseName as string) || (cmd.category as string) || (cmd.fieldName as string) || (cmd.product as string) || 'A';
      const labelB = (cmd.compareWarehouse as string) || (cmd.compareCategory as string) || (cmd.compareField as string) || (cmd.compareProduct as string) || 'B';
      return renderers.renderStockCompare(rows as renderers.StockRow[], rowsB as renderers.StockRow[], labelA, labelB);
    }

    // ── 7. Empty + proactive hint ──
    if (rows.length === 0) {
      const all = await repo.queryStock({ userId: Number(userId), limit: 200 });
      const cats = new Set<string>(); const whs = new Set<string>(); const prods = new Set<string>();
      for (const r of all) { cats.add(r.category); if (r.warehouse_name) whs.add(r.warehouse_name); prods.add(r.name); }
      return renderers.renderEmpty(ctx, { categories: [...cats], warehouses: [...whs], products: [...prods] });
    }

    // ── 8. Dispatch ──
    switch (view) {
      case 'aggregate': return renderers.renderStockAggregate(rows as renderers.StockRow[], ctx);
      case 'max': return renderers.renderStockExtreme(rows as renderers.StockRow[], ctx, 'max');
      case 'min': return renderers.renderStockExtreme(rows as renderers.StockRow[], ctx, 'min');
      case 'avg': return renderers.renderStockAvg(rows as renderers.StockRow[], ctx);
      case 'rank': return renderers.renderStockRank(rows as renderers.StockRow[], ctx, (cmd.top_n as number) || 5);
      case 'top_locations': return renderers.renderStockTopLocations(rows as renderers.StockRow[], ctx);
      case 'detail':
      default: return renderers.renderStockDetail(rows as renderers.StockRow[], ctx);
    }
  }

  private async saveStockQuery(userId: UserId, cmd: ParsedCommand): Promise<void> {
    const { pool } = await import('../../config/db.js');
    const KEEP = ['fieldName', 'warehouseName', 'category', 'product', 'lowStockOnly',
      'quantityMin', 'quantityMax', 'hasMinStock',
      'view', 'aggregateMetric', 'sort_by', 'sort_desc', 'top_n', 'group_by'];
    const persistable: Record<string, unknown> = {};
    for (const k of KEEP) if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
    await pool.query(
      `INSERT INTO conversation_state (user_id, last_stock_query, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_stock_query = $2::jsonb, updated_at = NOW()`,
      [userId, JSON.stringify(persistable)],
    );
  }
}
