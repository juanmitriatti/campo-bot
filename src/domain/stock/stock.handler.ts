import { StockService } from './stock.service.js';
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

    if (!product) return { messages: ['Necesito el nombre del producto. Ej: "cargué 500lt de glifosato"'] };
    if (!quantity || quantity <= 0) return { messages: ['Necesito la cantidad. Ej: "cargué 500lt de glifosato"'] };
    if (!unit) return { messages: ['Necesito la unidad. Ej: "cargué 500lt de glifosato"'] };

    const { item, created } = await stockService.addStock(userId, product, quantity, unit, {
      fieldName: cmd.fieldName as string,
      warehouseName: cmd.warehouseName as string,
      category: cmd.category as string,
      reason: cmd.reason as string,
    });

    const newLabel = created ? ' (nuevo)' : '';
    return {
      messages: [
        `📥 *Stock actualizado*\n\n` +
        `  📦 *${item.name}*${newLabel}\n` +
        `  ➕ ${quantity} ${unit}\n` +
        `  📊 Total: *${item.current_quantity} ${item.unit}*\n` +
        `  🏭 ${item.warehouse_name || 'Principal'} (${item.field_name || ''})`,
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
    const items = await stockService.checkStock(
      userId,
      cmd.product as string,
      cmd.fieldName as string,
    );

    if (items.length === 0) {
      if (cmd.product) {
        return { messages: [`No se encontró "${cmd.product}" en el stock.`] };
      }
      return { messages: ['📦 No tenés stock registrado. Cargá insumos con "cargué X de Y".'] };
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

    // Multiple items
    const lines = items.map(it => {
      const low = it.min_stock != null && it.current_quantity <= it.min_stock ? ' 🔴' : '';
      const grain = it.grade ? ` [G${it.grade}${it.humidity_pct != null ? ` H${it.humidity_pct}%` : ''}]` : '';
      return `  • *${it.name}*: ${it.current_quantity} ${it.unit}${grain}${low} — ${it.warehouse_name} (${it.field_name})`;
    });

    return {
      messages: [`📦 *Inventario* (${items.length} productos)\n\n${lines.join('\n')}`],
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
      const date = new Date(m.movement_date).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
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
}
