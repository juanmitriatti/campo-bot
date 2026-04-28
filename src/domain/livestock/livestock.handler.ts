import { LivestockService } from './livestock.service.js';
import {
  LIVESTOCK_CATEGORY_LABEL,
  LIVESTOCK_MOVEMENT_LABEL,
  HEALTH_TYPE_LABEL,
  REPRO_TYPE_LABEL,
} from './livestock.types.js';
import type { LivestockCategory, LivestockGroupRow } from './livestock.types.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { FeedlotService } from '../feedlot/feedlot.service.js';
import { saveDomainEvent, queryLivestockEvents, updateLivestockGroupWeight } from '../../services/expenses.js';
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
  private plotDiscovery = new PlotDiscoveryService();

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
        case 'log_health_event': return await this.logHealthEvent(cmd, userId);
        case 'query_health_events': return await this.queryHealthEvents(cmd, userId);
        case 'log_repro_event': return await this.logReproEvent(cmd, userId);
        case 'query_repro_events': return await this.queryReproEvents(cmd, userId);
        case 'log_weighing': return await this.logWeighing(cmd, userId);
        case 'query_weighings': return await this.queryWeighings(cmd, userId);
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
    const isPurchase = cmd.isPurchase === true;
    const hasPrice = !!(cmd.unit_price_ars || cmd.unit_price_usd);
    const askPriceLine = (isPurchase && !hasPrice && !financial)
      ? '\n\n¿A cuánto fue la compra? Así registro el gasto.'
      : '';
    return {
      messages: [
        `🐄 *Hacienda actualizada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}${newLabel}\n` +
        `  ➕ ${count} animales\n` +
        `  📊 Total: *${group.count}*\n` +
        `  📍 ${fmtLoc(group)}` +
        financialLine +
        askPriceLine,
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
    const isSale = cmd.isSale === true;
    const hasPrice = !!(cmd.unit_price_ars || cmd.unit_price_usd);
    const askPriceLine = (isSale && !hasPrice && !financial)
      ? '\n\n¿A cuánto fue la venta? Así registro el ingreso.'
      : '';
    return {
      messages: [
        `🐄 *Hacienda descontada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➖ ${count} animales\n` +
        `  📊 Quedan: *${group.count}*\n` +
        `  📍 ${fmtLoc(group)}` +
        financialLine +
        askPriceLine,
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
    const destCategory = cmd.destCategory as string;
    if (!category) return { messages: ['Necesito la categoría. Ej: "mové 10 vacas del lote A1 al lote B2".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad.'] };

    // Auto-resolve source: if not specified, look for a unique group of this category
    let effectiveSourcePlot = sourcePlot;
    let effectiveSourceCorral = sourceCorral;
    if (!sourcePlot && !sourceCorral) {
      try {
        const { groups } = await this.service.listInventory(userId, { category });
        const nonEmpty = groups.filter((g) => g.count > 0);
        if (nonEmpty.length === 1) {
          // Unique group — auto-resolve source location
          const g = nonEmpty[0];
          if (g.plot_name) effectiveSourcePlot = g.plot_name;
          if (g.corral_name) effectiveSourceCorral = g.corral_name;
        } else if (nonEmpty.length === 0) {
          return { messages: [`❌ No hay ${category} registrados.`] };
        } else {
          return { messages: ['Necesito el origen (lote o corral).'] };
        }
      } catch {
        return { messages: ['Necesito el origen (lote o corral).'] };
      }
    }
    if (!effectiveSourcePlot && !effectiveSourceCorral) return { messages: ['Necesito el origen (lote o corral).'] };
    // Recategorización in-situ: si hay destCategory pero no destino explícito, usar el mismo origen
    let effectiveDestPlot = destPlot;
    let effectiveDestCorral = destCorral;
    if (!destPlot && !destCorral && destCategory) {
      effectiveDestPlot = effectiveSourcePlot;
      effectiveDestCorral = effectiveSourceCorral;
    } else if (!destPlot && !destCorral) {
      return { messages: ['Necesito el destino (lote o corral).'] };
    }

    const { sourceGroup, destGroup, movement } = await this.service.transferAnimals(userId, {
      category,
      count,
      sourceField: cmd.sourceField as string,
      sourcePlot: effectiveSourcePlot || undefined,
      sourceCorral: effectiveSourceCorral || undefined,
      destField: cmd.destField as string,
      destPlot: effectiveDestPlot || undefined,
      destCorral: effectiveDestCorral || undefined,
      breed: cmd.breed as string,
      destCategory: destCategory || undefined,
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

  // ========================
  // HEALTH EVENTS (sanidad)
  // ========================

  /**
   * Resolve location for domain_events: returns plotId OR corralId (same pattern as tacto in agronomy).
   */
  private async resolveEventLocation(
    cmd: ParsedCommand,
    userId: UserId,
  ): Promise<{ plotId: number | null; corralId: number | null; label: string } | { error: string }> {
    const corralName = cmd.corralName as string | null;
    if (corralName) {
      try {
        const feedlotService = new FeedlotService();
        const ref = await feedlotService.resolveCorral(userId, corralName, cmd.fieldName as string | null);
        return { plotId: null, corralId: ref.corralId, label: `Feedlot ${ref.feedlotName} > ${ref.corralName}` };
      } catch (err: unknown) {
        return { error: (err as Error).message };
      }
    }

    const resolved = await this.plotDiscovery.resolveFromNames(
      userId,
      cmd.fieldName as string | null,
      cmd.plotName as string | null,
    );

    if (resolved.plotId) {
      const label = resolved.fieldName
        ? `${resolved.fieldName} > ${resolved.plotName}`
        : resolved.plotName || '—';
      return { plotId: resolved.plotId, corralId: null, label };
    }

    // No specific plot — return null (event without location is OK for these)
    return { plotId: null, corralId: null, label: 'Sin ubicación' };
  }

  private async logHealthEvent(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const healthType = cmd.healthType as string;
    if (!healthType) return { messages: ['Necesito el tipo de evento sanitario (vacunación, desparasitación, tratamiento).'] };

    const loc = await this.resolveEventLocation(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const category = cmd.category as string | null;
    const animalsAffected = typeof cmd.animalsAffected === 'number' ? cmd.animalsAffected : null;
    const diseaseOrVaccine = cmd.diseaseOrVaccine as string | null;
    const doseQuantity = typeof cmd.doseQuantity === 'number' ? cmd.doseQuantity : null;
    const doseUnit = cmd.doseUnit as string | null;
    const veterinarian = cmd.implement as string | null;

    await saveDomainEvent(userId, {
      plotId: loc.plotId,
      corralId: loc.corralId,
      eventType: 'health_event',
      eventDate: cmd.eventDate || null,
      productType: healthType,
      product: diseaseOrVaccine,
      animalCategory: category,
      animalsAffected,
      quantity: doseQuantity,
      unit: doseUnit,
      implement: veterinarian,
      notes: cmd.notes || null,
    });

    const typeLabel = HEALTH_TYPE_LABEL[healthType] || healthType;
    const lines: string[] = [`💉 *Evento sanitario registrado*`];
    lines.push(`  Tipo: ${typeLabel}`);
    if (diseaseOrVaccine) lines.push(`  🦠 ${diseaseOrVaccine}`);
    if (animalsAffected && category) {
      lines.push(`  🐄 ${animalsAffected} ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}${animalsAffected > 1 ? 's' : ''}`);
    } else if (animalsAffected) {
      lines.push(`  🐄 ${animalsAffected} animales`);
    }
    if (doseQuantity) lines.push(`  💊 ${doseQuantity} ${doseUnit || ''}/animal`);
    if (veterinarian) lines.push(`  👨‍⚕️ ${veterinarian}`);
    lines.push(`  📍 ${loc.label}`);
    if (cmd.notes) lines.push(`  📝 ${cmd.notes}`);
    if (cmd.eventDate) {
      const dateStr = new Date(cmd.eventDate as string).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      lines.push(`  📅 ${dateStr}`);
    }

    return { messages: [lines.join('\n')] };
  }

  private async queryHealthEvents(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const loc = await this.resolveEventLocation(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const rows = await queryLivestockEvents(userId, 'health_event', {
      plotId: loc.plotId,
      corralId: loc.corralId,
      category: cmd.category as string | null,
      subtype: cmd.healthType as string | null,
      desde: cmd.desde as string | null,
      hasta: cmd.hasta as string | null,
    });

    if (rows.length === 0) {
      return { messages: ['💉 No hay eventos sanitarios registrados con esos filtros.'] };
    }

    const lines = rows.map((r: Record<string, unknown>) => {
      const date = new Date(r.event_date as string).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const typeLabel = HEALTH_TYPE_LABEL[r.product_type as string] || r.product_type;
      const disease = r.product ? ` — ${r.product}` : '';
      const count = r.animals_affected ? ` (${r.animals_affected} ${r.animal_category || 'animales'})` : '';
      const location = r.corral_name
        ? `Corral ${r.corral_name}`
        : r.plot_name
        ? `${r.field_name || ''} > ${r.plot_name}`
        : '';
      return `  📅 ${date}: ${typeLabel}${disease}${count}${location ? ` — 📍 ${location}` : ''}`;
    });

    return { messages: [`💉 *Historial sanitario*\n\n${lines.join('\n')}`] };
  }

  // ========================
  // REPRO EVENTS (reproducción)
  // ========================

  private async logReproEvent(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const reproType = cmd.reproType as string;
    if (!reproType) return { messages: ['Necesito el tipo de evento reproductivo (servicio, destete, inseminación, detección de celo).'] };

    const loc = await this.resolveEventLocation(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const category = cmd.category as string | null;
    const animalsAffected = typeof cmd.animalsAffected === 'number' ? cmd.animalsAffected : null;
    const sireInfo = cmd.sireInfo as string | null;
    const method = cmd.method as string | null;

    await saveDomainEvent(userId, {
      plotId: loc.plotId,
      corralId: loc.corralId,
      eventType: 'repro_event',
      eventDate: cmd.eventDate || null,
      productType: reproType,
      product: sireInfo,
      implement: method,
      animalCategory: category,
      animalsAffected,
      notes: cmd.notes || null,
    });

    const typeLabel = REPRO_TYPE_LABEL[reproType] || reproType;
    const emoji = reproType === 'destete' ? '🍼' : reproType === 'inseminacion' ? '💉' : '🐂';
    const lines: string[] = [`${emoji} *Evento reproductivo registrado*`];
    lines.push(`  Tipo: ${typeLabel}`);
    if (animalsAffected && category) {
      lines.push(`  🐄 ${animalsAffected} ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}${animalsAffected > 1 ? 's' : ''}`);
    } else if (animalsAffected) {
      lines.push(`  🐄 ${animalsAffected} animales`);
    }
    if (sireInfo) lines.push(`  🐂 ${sireInfo}`);
    if (method) lines.push(`  🔬 Método: ${method}`);
    lines.push(`  📍 ${loc.label}`);
    if (cmd.notes) lines.push(`  📝 ${cmd.notes}`);
    if (cmd.eventDate) {
      const dateStr = new Date(cmd.eventDate as string).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      lines.push(`  📅 ${dateStr}`);
    }

    return { messages: [lines.join('\n')] };
  }

  private async queryReproEvents(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const loc = await this.resolveEventLocation(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const rows = await queryLivestockEvents(userId, 'repro_event', {
      plotId: loc.plotId,
      corralId: loc.corralId,
      category: cmd.category as string | null,
      subtype: cmd.reproType as string | null,
      desde: cmd.desde as string | null,
      hasta: cmd.hasta as string | null,
    });

    if (rows.length === 0) {
      return { messages: ['🐂 No hay eventos reproductivos registrados con esos filtros.'] };
    }

    const lines = rows.map((r: Record<string, unknown>) => {
      const date = new Date(r.event_date as string).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const typeLabel = REPRO_TYPE_LABEL[r.product_type as string] || r.product_type;
      const sire = r.product ? ` — ${r.product}` : '';
      const count = r.animals_affected ? ` (${r.animals_affected} ${r.animal_category || 'animales'})` : '';
      const location = r.corral_name
        ? `Corral ${r.corral_name}`
        : r.plot_name
        ? `${r.field_name || ''} > ${r.plot_name}`
        : '';
      return `  📅 ${date}: ${typeLabel}${sire}${count}${location ? ` — 📍 ${location}` : ''}`;
    });

    return { messages: [`🐂 *Historial reproductivo*\n\n${lines.join('\n')}`] };
  }

  // ========================
  // WEIGHING (pesaje)
  // ========================

  private async logWeighing(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const avgWeightKg = typeof cmd.avg_weight_kg === 'number' ? cmd.avg_weight_kg : null;
    if (!avgWeightKg) return { messages: ['Necesito el peso promedio en kg. Ej: "pesé los novillos, 380 kg promedio".'] };

    const loc = await this.resolveEventLocation(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const category = cmd.category as string | null;
    const animalsWeighed = typeof cmd.animalsWeighed === 'number' ? cmd.animalsWeighed : null;

    await saveDomainEvent(userId, {
      plotId: loc.plotId,
      corralId: loc.corralId,
      eventType: 'weighing',
      eventDate: cmd.eventDate || null,
      quantity: avgWeightKg,
      unit: 'kg',
      animalCategory: category,
      animalsAffected: animalsWeighed,
      notes: cmd.notes || null,
    });

    // Update livestock_groups.avg_weight_kg if matching group found
    if (category) {
      await updateLivestockGroupWeight(userId, {
        category,
        plotId: loc.plotId,
        corralId: loc.corralId,
        avgWeightKg,
      });
    }

    const lines: string[] = ['⚖️ *Pesaje registrado*'];
    if (animalsWeighed && category) {
      lines.push(`  🐄 ${animalsWeighed} ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}${animalsWeighed > 1 ? 's' : ''}`);
    } else if (category) {
      lines.push(`  🐄 ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}`);
    }
    lines.push(`  📊 Peso promedio: *${avgWeightKg} kg*`);
    lines.push(`  📍 ${loc.label}`);
    if (cmd.notes) lines.push(`  📝 ${cmd.notes}`);
    if (cmd.eventDate) {
      const dateStr = new Date(cmd.eventDate as string).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      lines.push(`  📅 ${dateStr}`);
    }

    return { messages: [lines.join('\n')] };
  }

  private async queryWeighings(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const loc = await this.resolveEventLocation(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const rows = await queryLivestockEvents(userId, 'weighing', {
      plotId: loc.plotId,
      corralId: loc.corralId,
      category: cmd.category as string | null,
      desde: cmd.desde as string | null,
      hasta: cmd.hasta as string | null,
    });

    if (rows.length === 0) {
      return { messages: ['⚖️ No hay pesajes registrados con esos filtros.'] };
    }

    const lines = rows.map((r: Record<string, unknown>) => {
      const date = new Date(r.event_date as string).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const weight = r.quantity ? `${r.quantity} kg` : '—';
      const count = r.animals_affected ? ` (${r.animals_affected} ${r.animal_category || 'animales'})` : '';
      const location = r.corral_name
        ? `Corral ${r.corral_name}`
        : r.plot_name
        ? `${r.field_name || ''} > ${r.plot_name}`
        : '';
      return `  📅 ${date}: ${weight}${count}${location ? ` — 📍 ${location}` : ''}`;
    });

    // Calculate GDPV if 2+ weighings for same category+location
    let gdpvLine = '';
    if (rows.length >= 2) {
      const latest = rows[0] as Record<string, unknown>;
      const previous = rows[1] as Record<string, unknown>;
      const w1 = Number(latest.quantity);
      const w2 = Number(previous.quantity);
      if (w1 > 0 && w2 > 0) {
        const d1 = new Date(latest.event_date as string);
        const d2 = new Date(previous.event_date as string);
        const daysBetween = Math.abs(Math.round((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24)));
        if (daysBetween > 0) {
          const gdpv = ((w1 - w2) / daysBetween).toFixed(2);
          gdpvLine = `\n\n  📈 GDPV (últimos 2 pesajes): *${gdpv} kg/día* (${daysBetween} días)`;
        }
      }
    }

    return { messages: [`⚖️ *Pesajes*\n\n${lines.join('\n')}${gdpvLine}`] };
  }

  // ========================
  // LIST / HISTORY (existing)
  // ========================

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
