import { LivestockService } from './livestock.service.js';
import {
  LIVESTOCK_CATEGORY_LABEL,
  LIVESTOCK_MOVEMENT_LABEL,
} from './livestock.types.js';
import type { LivestockCategory, LivestockGroupRow } from './livestock.types.js';
import type {
  UserId,
  User,
  UserSettings,
  ParsedCommand,
  HandlerResponse,
} from '../../types/index.js';

export class LivestockHandler {
  private service: LivestockService;

  constructor(service?: LivestockService) {
    this.service = service ?? new LivestockService();
  }

  async handleCommand(
    cmd: ParsedCommand,
    userId: UserId,
    _user: User,
    _settings: UserSettings,
  ): Promise<HandlerResponse> {
    try {
      switch (cmd.command) {
        case 'add_livestock': return await this.addLivestock(cmd, userId);
        case 'remove_livestock': return await this.removeLivestock(cmd, userId);
        case 'transfer_livestock': return await this.transferLivestock(cmd, userId);
        case 'record_livestock_death': return await this.recordDeath(cmd, userId);
        case 'record_livestock_birth': return await this.recordBirth(cmd, userId);
        case 'list_livestock': return await this.listLivestock(cmd, userId);
        case 'livestock_history': return await this.livestockHistory(cmd, userId);
        default:
          return { messages: ['Comando de hacienda no reconocido.'] };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error en operación de hacienda';
      return { messages: [`❌ ${msg}`] };
    }
  }

  // ========================
  // ADD
  // ========================

  private async addLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito saber la categoría. Ej: "agregué 20 vacas al lote A1".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad. Ej: "agregué 20 vacas al lote A1".'] };

    const { group, created } = await this.service.addAnimals(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      breed: cmd.breed as string,
      avg_weight_kg: cmd.avg_weight_kg as number,
      unit_price_ars: cmd.unit_price_ars as number,
      unit_price_usd: cmd.unit_price_usd as number,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    const newLabel = created ? ' (nuevo grupo)' : '';
    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `🐄 *Hacienda actualizada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}${newLabel}\n` +
        `  ➕ ${count} animales\n` +
        `  📊 Total en lote: *${group.count}*\n` +
        `  📍 ${group.plot_name || '—'} (${group.field_name || ''})`,
      ],
    };
  }

  // ========================
  // REMOVE
  // ========================

  private async removeLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "vendí 5 vacas del lote A1".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad. Ej: "vendí 5 vacas del lote A1".'] };

    const { group } = await this.service.removeAnimals(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      breed: cmd.breed as string,
      unit_price_ars: cmd.unit_price_ars as number,
      unit_price_usd: cmd.unit_price_usd as number,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `🐄 *Hacienda descontada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➖ ${count} animales\n` +
        `  📊 Quedan: *${group.count}*\n` +
        `  📍 ${group.plot_name || '—'} (${group.field_name || ''})`,
      ],
    };
  }

  // ========================
  // TRANSFER
  // ========================

  private async transferLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    const sourcePlot = cmd.sourcePlot as string;
    const destPlot = cmd.destPlot as string;
    if (!category) return { messages: ['Necesito la categoría. Ej: "mové 10 vacas del lote A1 al lote B2".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad.'] };
    if (!sourcePlot || !destPlot) return { messages: ['Necesito el lote de origen y destino.'] };

    const { sourceGroup, destGroup, movement } = await this.service.transferAnimals(userId, {
      category,
      count,
      sourceField: cmd.sourceField as string,
      sourcePlot,
      destField: cmd.destField as string,
      destPlot,
      breed: cmd.breed as string,
      destCategory: cmd.destCategory as string,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    const mvLabel = LIVESTOCK_MOVEMENT_LABEL[movement.movement_type];
    const breed = sourceGroup.breed ? ` ${sourceGroup.breed}` : '';
    return {
      messages: [
        `${mvLabel.emoji} *${mvLabel.label}*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[sourceGroup.category]}${breed}\n` +
        `  ↗️ ${count} animales\n` +
        `  Desde: *${sourceGroup.plot_name || '—'}* (quedan ${sourceGroup.count})\n` +
        `  Hacia: *${destGroup.plot_name || '—'}* (ahora ${destGroup.count})`,
      ],
    };
  }

  // ========================
  // DEATH / BIRTH
  // ========================

  private async recordDeath(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "se murieron 2 terneros en el lote A1".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad.'] };

    const { group } = await this.service.recordDeath(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      breed: cmd.breed as string,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `💀 *Baja registrada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➖ ${count} animales\n` +
        `  📊 Quedan: *${group.count}*\n` +
        `  📍 ${group.plot_name || '—'} (${group.field_name || ''})` +
        (cmd.reason ? `\n  📝 ${cmd.reason}` : ''),
      ],
    };
  }

  private async recordBirth(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "nacieron 5 terneros en el lote A1".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad.'] };

    const { group } = await this.service.recordBirth(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      breed: cmd.breed as string,
      movement_date: cmd.eventDate as string,
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `🐣 *Nacimiento registrado*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➕ ${count} animales\n` +
        `  📊 Total en lote: *${group.count}*\n` +
        `  📍 ${group.plot_name || '—'} (${group.field_name || ''})`,
      ],
    };
  }

  // ========================
  // LIST / HISTORY
  // ========================

  private async listLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { groups, total } = await this.service.listInventory(userId, {
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      category: cmd.category as string,
    });

    if (groups.length === 0) {
      return { messages: ['🐄 No tenés hacienda registrada. Cargá animales con "agregué 20 vacas al lote A1".'] };
    }

    // Group by plot for readability
    const byPlot = new Map<string, LivestockGroupRow[]>();
    for (const g of groups) {
      const key = `${g.field_name || '—'} / ${g.plot_name || '—'}`;
      if (!byPlot.has(key)) byPlot.set(key, []);
      byPlot.get(key)!.push(g);
    }

    const sections: string[] = [];
    for (const [plotKey, plotGroups] of byPlot.entries()) {
      let plotWeight = 0;
      const lines = plotGroups.map(g => {
        const breed = g.breed ? ` ${g.breed}` : '';
        const weight = g.avg_weight_kg ? ` (${g.avg_weight_kg} kg prom.)` : '';
        if (g.avg_weight_kg) plotWeight += g.avg_weight_kg * g.count;
        return `    • ${LIVESTOCK_CATEGORY_LABEL[g.category]}${breed}: *${g.count}*${weight}`;
      });
      const plotWeightLabel = plotWeight > 0 ? `\n    ⚖️ Peso estimado: ${Math.round(plotWeight).toLocaleString('es-AR')} kg` : '';
      sections.push(`  📍 *${plotKey}*\n${lines.join('\n')}${plotWeightLabel}`);
    }

    return {
      messages: [
        `🐄 *Hacienda total: ${total} animales*\n\n${sections.join('\n\n')}`,
      ],
    };
  }

  private async livestockHistory(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const plot = cmd.plotName as string;
    if (!category || !plot) {
      return { messages: ['Necesito categoría y lote. Ej: "historial vacas lote A1".'] };
    }

    const { group, movements } = await this.service.getHistory(userId, {
      category,
      fieldName: cmd.fieldName as string,
      plotName: plot,
      breed: cmd.breed as string,
    });

    if (movements.length === 0) {
      return { messages: [`No hay movimientos de *${LIVESTOCK_CATEGORY_LABEL[group.category]}* en ${group.plot_name}.`] };
    }

    const lines = movements.map(m => {
      const mv = LIVESTOCK_MOVEMENT_LABEL[m.movement_type];
      const date = new Date(m.movement_date).toLocaleDateString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
      });
      const sign = ['entrada', 'nacimiento'].includes(m.movement_type)
        ? '+'
        : ['salida', 'muerte'].includes(m.movement_type)
        ? '-'
        : '↔';
      const weight = m.avg_weight_kg ? ` (${m.avg_weight_kg}kg)` : '';
      const price = m.unit_price_ars
        ? ` — $${Number(m.unit_price_ars).toLocaleString('es-AR')}/cab`
        : m.unit_price_usd
        ? ` — US$${Number(m.unit_price_usd).toLocaleString('es-AR')}/cab`
        : '';
      const reason = m.reason ? ` — ${m.reason}` : '';
      const notes = m.notes ? ` | ${m.notes}` : '';
      return `  ${mv.emoji} ${date}: ${sign}${m.count}${weight}${price}${reason}${notes}`;
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `🐄 *Historial ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}*\n` +
        `  📍 ${group.plot_name} (${group.field_name})\n` +
        `  📊 Stock actual: *${group.count}*\n\n` +
        lines.join('\n'),
      ],
    };
  }
}

/** Category coercion helper — exported for tests */
export function coerceCategory(raw: unknown): LivestockCategory | null {
  if (typeof raw !== 'string') return null;
  return LivestockService.normalizeCategory(raw);
}
