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
  Currency,
} from '../../types/index.js';

/** Format a group's location for display */
function fmtLoc(group: LivestockGroupRow): string {
  return LivestockService.formatLocation(group);
}

/** Format a monetary amount for WhatsApp/Telegram messages */
function fmtAmount(amount: number, currency: Currency): string {
  const nf = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
  return currency === 'USD' ? `USD ${nf.format(amount)}` : `$${nf.format(amount)}`;
}

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
        case 'adjust_livestock': return await this.adjustLivestock(cmd, userId);
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

    const { group, created, financial } = await this.service.addAnimals(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      corralName: cmd.corralName as string,
      breed: cmd.breed as string,
      avg_weight_kg: cmd.avg_weight_kg as number,
      unit_price_ars: cmd.unit_price_ars as number,
      unit_price_usd: cmd.unit_price_usd as number,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    const newLabel = created ? ' (nuevo grupo)' : '';
    const breed = group.breed ? ` ${group.breed}` : '';
    const financialLine = financial
      ? `\n  💸 Gasto registrado: ${fmtAmount(financial.amount, financial.currency)} (Hacienda)`
      : '';
    return {
      messages: [
        `🐄 *Hacienda actualizada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}${newLabel}\n` +
        `  ➕ ${count} animales\n` +
        `  📊 Total: *${group.count}*\n` +
        `  📍 ${fmtLoc(group)}` +
        financialLine,
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

    const { group, financial } = await this.service.removeAnimals(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      corralName: cmd.corralName as string,
      breed: cmd.breed as string,
      unit_price_ars: cmd.unit_price_ars as number,
      unit_price_usd: cmd.unit_price_usd as number,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    const financialLine = financial
      ? `\n  💰 Ingreso registrado: ${fmtAmount(financial.amount, financial.currency)} (Hacienda)`
      : '';
    return {
      messages: [
        `🐄 *Hacienda descontada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➖ ${count} animales\n` +
        `  📊 Quedan: *${group.count}*\n` +
        `  📍 ${fmtLoc(group)}` +
        financialLine,
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
    const sourceCorral = cmd.sourceCorral as string;
    const destCorral = cmd.destCorral as string;
    if (!category) return { messages: ['Necesito la categoría. Ej: "mové 10 vacas del lote A1 al lote B2".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad.'] };
    if (!sourcePlot && !sourceCorral) return { messages: ['Necesito el origen (lote o corral).'] };
    if (!destPlot && !destCorral) return { messages: ['Necesito el destino (lote o corral).'] };

    const { sourceGroup, destGroup, movement } = await this.service.transferAnimals(userId, {
      category,
      count,
      sourceField: cmd.sourceField as string,
      sourcePlot: sourcePlot || undefined,
      sourceCorral: sourceCorral || undefined,
      destField: cmd.destField as string,
      destPlot: destPlot || undefined,
      destCorral: destCorral || undefined,
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
        `  Desde: *${fmtLoc(sourceGroup)}* (quedan ${sourceGroup.count})\n` +
        `  Hacia: *${fmtLoc(destGroup)}* (ahora ${destGroup.count})`,
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
      corralName: cmd.corralName as string,
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
        `  📍 ${fmtLoc(group)}` +
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
      corralName: cmd.corralName as string,
      breed: cmd.breed as string,
      movement_date: cmd.eventDate as string,
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `🐣 *Nacimiento registrado*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➕ ${count} animales\n` +
        `  📊 Total: *${group.count}*\n` +
        `  📍 ${fmtLoc(group)}`,
      ],
    };
  }

  // ========================
  // ADJUST
  // ========================

  private async adjustLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "en el lote A1 hay 50 vacas".'] };
    if (count == null || count < 0) return { messages: ['Necesito la cantidad (0 o más). Ej: "en el lote A1 hay 50 vacas".'] };

    const { group, previousCount } = await this.service.adjustAnimals(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      corralName: cmd.corralName as string,
      breed: cmd.breed as string,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    const diff = count - previousCount;
    const diffLabel = diff > 0 ? `+${diff}` : `${diff}`;
    return {
      messages: [
        `🔄 *Hacienda corregida*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  📊 Antes: ${previousCount} → Ahora: *${group.count}*` +
        (diff !== 0 ? ` (${diffLabel})` : '') + `\n` +
        `  📍 ${fmtLoc(group)}`,
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
      corralName: cmd.corralName as string,
      category: cmd.category as string,
    });

    if (groups.length === 0) {
      return { messages: ['🐄 No tenés hacienda registrada. Cargá animales con "agregué 20 vacas al lote A1".'] };
    }

    // Group by location for readability
    const byLocation = new Map<string, LivestockGroupRow[]>();
    for (const g of groups) {
      const key = g.corral_name
        ? `🔲 Corral ${g.corral_name} (${g.feedlot_name || 'Feedlot'} — ${g.field_name || ''})`
        : `📍 ${g.field_name || '—'} / ${g.plot_name || '—'}`;
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key)!.push(g);
    }

    const sections: string[] = [];
    for (const [locKey, locGroups] of byLocation.entries()) {
      let locWeight = 0;
      const lines = locGroups.map(g => {
        const breed = g.breed ? ` ${g.breed}` : '';
        const weight = g.avg_weight_kg ? ` (${g.avg_weight_kg} kg prom.)` : '';
        if (g.avg_weight_kg) locWeight += g.avg_weight_kg * g.count;
        return `    • ${LIVESTOCK_CATEGORY_LABEL[g.category]}${breed}: *${g.count}*${weight}`;
      });
      const weightLabel = locWeight > 0 ? `\n    ⚖️ Peso estimado: ${Math.round(locWeight).toLocaleString('es-AR')} kg` : '';
      sections.push(`  ${locKey}\n${lines.join('\n')}${weightLabel}`);
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
    const corral = cmd.corralName as string;
    if (!category || (!plot && !corral)) {
      return { messages: ['Necesito categoría y lote/corral. Ej: "historial vacas lote A1" o "historial novillos corral 1".'] };
    }

    const { group, movements } = await this.service.getHistory(userId, {
      category,
      fieldName: cmd.fieldName as string,
      plotName: plot || undefined,
      corralName: corral || undefined,
      breed: cmd.breed as string,
    });

    if (movements.length === 0) {
      return { messages: [`No hay movimientos de *${LIVESTOCK_CATEGORY_LABEL[group.category]}* en ${fmtLoc(group)}.`] };
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
        `  📍 ${fmtLoc(group)}\n` +
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
