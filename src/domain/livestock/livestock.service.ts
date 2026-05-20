import { LivestockRepository } from './livestock.repository.js';
import type {
  LivestockCategory,
  LivestockGroupRow,
  LivestockMovementRow,
  LivestockMovementType,
} from './livestock.types.js';
import { LIVESTOCK_CATEGORIES, LIVESTOCK_CATEGORY_LABEL } from './livestock.types.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { FeedlotService, type ResolvedCorralRef } from '../feedlot/feedlot.service.js';
import { saveExpense, saveIncome } from '../../services/expenses.js';
import type { UserId, Currency } from '../../types/index.js';

export interface ResolvedPlotRef {
  fieldId: number;
  fieldName: string;
  plotId: number;
  plotName: string;
}

export type ResolvedLocation =
  | { type: 'plot'; fieldId: number; fieldName: string; plotId: number; plotName: string }
  | { type: 'corral'; fieldId: number; fieldName: string; feedlotId: number;
      feedlotName: string; corralId: number; corralName: string };

export interface MovementFinancials {
  unit_price_ars?: number | null;
  unit_price_usd?: number | null;
}

export interface LinkedFinancialRecord {
  type: 'expense' | 'income';
  id: number;
  amount: number;
  currency: Currency;
}

/**
 * Livestock (hacienda) business logic.
 * All mutations are delegated to the repository's atomic methods
 * so that group counts and the movement ledger stay in sync.
 */
export class LivestockService {
  private repo: LivestockRepository;
  private plotDiscovery: PlotDiscoveryService;
  private feedlotService: FeedlotService;

  constructor(repo?: LivestockRepository, plotDiscovery?: PlotDiscoveryService, feedlotService?: FeedlotService) {
    this.repo = repo ?? new LivestockRepository();
    this.plotDiscovery = plotDiscovery ?? new PlotDiscoveryService();
    this.feedlotService = feedlotService ?? new FeedlotService();
  }

  // ========================
  // INTAKE VALIDATION
  // ========================

  /** Normalize + validate a category string from user input */
  static normalizeCategory(raw: string | null | undefined): LivestockCategory | null {
    if (!raw) return null;
    const normalized = raw.toLowerCase().trim()
      .replace(/[áä]/g, 'a')
      .replace(/[éë]/g, 'e')
      .replace(/[íï]/g, 'i')
      .replace(/[óö]/g, 'o')
      .replace(/[úü]/g, 'u');
    // Common aliases
    const aliases: Record<string, LivestockCategory> = {
      vaca: 'vaca',
      vacas: 'vaca',
      vaquillona: 'vaquillona',
      vaquillonas: 'vaquillona',
      vaquilla: 'vaquillona',
      vaquillas: 'vaquillona',
      ternero: 'ternero',
      terneros: 'ternero',
      ternera: 'ternera',
      terneras: 'ternera',
      novillo: 'novillo',
      novillos: 'novillo',
      novillito: 'novillito',
      novillitos: 'novillito',
      toro: 'toro',
      toros: 'toro',
      torito: 'torito',
      toritos: 'torito',
      buey: 'buey',
      bueyes: 'buey',
    };
    if (aliases[normalized]) return aliases[normalized];
    if (LIVESTOCK_CATEGORIES.includes(normalized as LivestockCategory)) {
      return normalized as LivestockCategory;
    }
    return null;
  }

  // ========================
  // LOCATION RESOLUTION
  // ========================

  /**
   * Resolve a location (plot OR corral) for livestock operations.
   * If corralName is provided, resolves via feedlot service.
   * If plotName is provided, resolves via plot discovery service.
   */
  async resolveLocation(
    userId: UserId,
    fieldName?: string | null,
    plotName?: string | null,
    corralName?: string | null,
  ): Promise<ResolvedLocation> {
    if (corralName) {
      const ref = await this.feedlotService.resolveCorral(userId, corralName, fieldName);
      return {
        type: 'corral',
        fieldId: ref.fieldId,
        fieldName: ref.fieldName,
        feedlotId: ref.feedlotId,
        feedlotName: ref.feedlotName,
        corralId: ref.corralId,
        corralName: ref.corralName,
      };
    }

    if (plotName) {
      const plot = await this.resolvePlot(userId, fieldName, plotName);
      return {
        type: 'plot',
        fieldId: plot.fieldId,
        fieldName: plot.fieldName,
        plotId: plot.plotId,
        plotName: plot.plotName,
      };
    }

    // Neither specified — try auto-resolve via plot (existing behavior)
    const plot = await this.resolvePlot(userId, fieldName, null);
    return {
      type: 'plot',
      fieldId: plot.fieldId,
      fieldName: plot.fieldName,
      plotId: plot.plotId,
      plotName: plot.plotName,
    };
  }

  /**
   * Resolve a plot reference for livestock operations.
   * Throws a user-friendly error if plot cannot be uniquely resolved.
   */
  private async resolvePlot(
    userId: UserId,
    fieldName: string | null | undefined,
    plotName: string | null | undefined,
  ): Promise<ResolvedPlotRef> {
    const result = await this.plotDiscovery.resolve(userId, fieldName, plotName);

    if (result.notFound) {
      throw new Error(
        result.notFound.type === 'field'
          ? `No encontré el campo "${result.notFound.name}". Creá el campo primero con "nuevo campo ${result.notFound.name}".`
          : `No encontré el lote "${result.notFound.name}". Creá el lote primero con "nuevo lote ${result.notFound.name}".`
      );
    }
    if (result.needPlotCreation) {
      throw new Error(
        `El campo "${result.fieldName}" no tiene lotes. Creá un lote primero con "nuevo lote A1 en ${result.fieldName}".`
      );
    }
    if (result.needPlotSelection) {
      const names = result.needPlotSelection.plots.map(p => p.name).join(', ');
      throw new Error(`Decime en qué lote. Opciones: ${names}.`);
    }
    if (!result.plotId || !result.fieldId) {
      throw new Error('Necesito que me digas en qué lote o corral. Ej: "agregá 20 vacas al lote A1" o "al corral 1".');
    }

    return {
      fieldId: result.fieldId,
      fieldName: result.fieldName!,
      plotId: result.plotId,
      plotName: result.plotName!,
    };
  }

  /** Find-or-create the group for a given location + category + breed */
  private async ensureGroupAtLocation(
    userId: UserId,
    loc: ResolvedLocation,
    category: LivestockCategory,
    breed: string | null,
    opts: { avg_weight_kg?: number | null; notes?: string | null } = {}
  ): Promise<LivestockGroupRow> {
    if (loc.type === 'corral') {
      const existing = await this.repo.findGroupInCorral(loc.corralId, category, breed);
      if (existing) {
        if (opts.avg_weight_kg !== undefined || opts.notes !== undefined) {
          await this.repo.updateGroupMetadata(existing.id, {
            avg_weight_kg: opts.avg_weight_kg,
            notes: opts.notes,
          });
        }
        return existing;
      }
      return this.repo.createGroupInCorral(Number(userId), loc.fieldId, loc.corralId, category, breed, opts);
    }
    // Plot
    const existing = await this.repo.findGroup(loc.plotId, category, breed);
    if (existing) {
      if (opts.avg_weight_kg !== undefined || opts.notes !== undefined) {
        await this.repo.updateGroupMetadata(existing.id, {
          avg_weight_kg: opts.avg_weight_kg,
          notes: opts.notes,
        });
      }
      return existing;
    }
    return this.repo.createGroup(Number(userId), loc.fieldId, loc.plotId, category, breed, opts);
  }

  /**
   * Find group at a resolved location.
   * When `breed` is provided, performs a strict match (breed-aware).
   * When `breed` is null (user didn't mention raza), falls back to a lenient
   * match: returns the unique group at that location with that category, or
   * throws if multiple breeds coexist so the user can disambiguate.
   */
  private async findGroupAtLocation(
    loc: ResolvedLocation,
    category: LivestockCategory,
    breed: string | null
  ): Promise<LivestockGroupRow | null> {
    if (breed) {
      if (loc.type === 'corral') {
        return this.repo.findGroupInCorral(loc.corralId, category, breed);
      }
      return this.repo.findGroup(loc.plotId, category, breed);
    }
    const candidates = await this.repo.listGroupsAtLocation(
      loc.type === 'corral' ? { corralId: loc.corralId } : { plotId: loc.plotId },
      category,
    );
    const nonEmpty = candidates.filter((g) => g.count > 0);
    if (nonEmpty.length === 0) return null;
    if (nonEmpty.length === 1) return nonEmpty[0];
    const breedList = nonEmpty
      .map((g) => `${g.breed ?? 'sin raza'} (${g.count})`)
      .join(', ');
    const locLabel = loc.type === 'corral' ? `corral ${loc.corralName}` : `lote ${loc.plotName}`;
    throw new Error(
      `Hay ${LIVESTOCK_CATEGORY_LABEL[category] ?? category} de varias razas en el ${locLabel}: ${breedList}. ¿De cuál? Decime la raza.`
    );
  }

  /** Attach human-readable location names to a group */
  private attachLocationNames(group: LivestockGroupRow, loc: ResolvedLocation): void {
    group.field_name = loc.fieldName;
    if (loc.type === 'corral') {
      group.corral_name = loc.corralName;
      group.feedlot_name = loc.feedlotName;
    } else {
      group.plot_name = loc.plotName;
    }
  }

  /**
   * Resolve (amount, currency) from the unit prices supplied. Prefers ARS when both are set.
   * Returns null if no price info was provided.
   */
  private static resolvePriceTotal(
    count: number,
    opts: { unit_price_ars?: number | null; unit_price_usd?: number | null }
  ): { amount: number; currency: Currency } | null {
    if (opts.unit_price_ars && opts.unit_price_ars > 0) {
      return { amount: Math.round(count * opts.unit_price_ars * 100) / 100, currency: 'ARS' };
    }
    if (opts.unit_price_usd && opts.unit_price_usd > 0) {
      return { amount: Math.round(count * opts.unit_price_usd * 100) / 100, currency: 'USD' };
    }
    return null;
  }

  /**
   * Create an expense/income for a livestock movement that carried a unit price,
   * and link it back to the movement row. Side-effect only — does not throw the
   * livestock operation if the financial write fails (best-effort logging).
   */
  private async createLinkedFinancialRecord(
    userId: UserId,
    movement: LivestockMovementRow,
    kind: 'expense' | 'income',
    fieldId: number,
    plotId: number | null,
    category: LivestockCategory,
    count: number,
    breed: string | null,
    movementDate: string | null | undefined,
  ): Promise<LinkedFinancialRecord | null> {
    const price = LivestockService.resolvePriceTotal(count, {
      unit_price_ars: movement.unit_price_ars,
      unit_price_usd: movement.unit_price_usd,
    });
    if (!price) return null;

    const label = LIVESTOCK_CATEGORY_LABEL[category].toLowerCase();
    const breedSuffix = breed ? ` ${breed}` : '';
    const description = kind === 'expense'
      ? `Compra hacienda: ${count} ${label}${count > 1 ? 's' : ''}${breedSuffix}`
      : `Venta hacienda: ${count} ${label}${count > 1 ? 's' : ''}${breedSuffix}`;

    try {
      if (kind === 'expense') {
        const { id } = await saveExpense(
          userId,
          {
            type: 'expense',
            amount: price.amount,
            currency: price.currency,
            category: 'Hacienda',
            description,
            expenseType: 'varios',
            expenseDate: movementDate ?? null,
          },
          fieldId,
          plotId,
        );
        await this.repo.setMovementFinancialLink(movement.id, id, null);
        return { type: 'expense', id, amount: price.amount, currency: price.currency };
      }
      const { id } = await saveIncome(
        userId,
        {
          type: 'income',
          amount: price.amount,
          currency: price.currency,
          category: 'Hacienda',
          description,
          quantity: count,
          unit: label,
          unit_price: movement.unit_price_ars ?? movement.unit_price_usd,
          incomeDate: movementDate ?? null,
        },
        fieldId,
        plotId,
      );
      await this.repo.setMovementFinancialLink(movement.id, null, id);
      return { type: 'income', id, amount: price.amount, currency: price.currency };
    } catch (err) {
      // Financial write is additive — don't fail the livestock operation.
      console.error('[livestock] failed to create linked financial record', err);
      return null;
    }
  }

  /** Get human-readable location label */
  static formatLocation(group: LivestockGroupRow): string {
    if (group.corral_name) {
      return `Corral ${group.corral_name} (${group.feedlot_name || 'Feedlot'} — ${group.field_name || ''})`;
    }
    return `${group.plot_name || '—'} (${group.field_name || ''})`;
  }

  // ========================
  // PUBLIC API
  // ========================

  /**
   * Add animals to a plot or corral (compra o ingreso externo).
   * Creates the group on demand. Returns the updated group + movement.
   */
  async addAnimals(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      corralName?: string | null;
      breed?: string | null;
      avg_weight_kg?: number | null;
      unit_price_ars?: number | null;
      unit_price_usd?: number | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    },
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow; created: boolean; financial?: LinkedFinancialRecord }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}". Usá vaca, vaquillona, ternero, novillo, toro, etc.`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const loc = await this.resolveLocation(userId, opts.fieldName, opts.plotName, opts.corralName);

    // Use the strict (breed-aware) lookup for the existing check — when adding without
    // breed, this targets the "sin raza" group specifically and won't error out when
    // a same-category Angus group also exists. The lenient lookup is reserved for
    // remove/transfer/death/etc., where the user expects "any vaca at A1" semantics.
    const existing = loc.type === 'corral'
      ? await this.repo.findGroupInCorral(loc.corralId, category, opts.breed ?? null)
      : await this.repo.findGroup(loc.plotId, category, opts.breed ?? null);
    const created = !existing;

    const group = await this.ensureGroupAtLocation(userId, loc, category, opts.breed ?? null, {
      avg_weight_kg: opts.avg_weight_kg,
      notes: opts.notes,
    });

    const { group: updated, movement } = await this.repo.applySingleMovement(
      Number(userId),
      'entrada',
      group.id,
      opts.count,
      {
        avg_weight_kg: opts.avg_weight_kg,
        unit_price_ars: opts.unit_price_ars,
        unit_price_usd: opts.unit_price_usd,
        reason: opts.reason ?? 'Compra / ingreso',
        notes: opts.notes,
        movement_date: opts.movement_date,
      }
    );

    this.attachLocationNames(updated, loc);

    const financial = await this.createLinkedFinancialRecord(
      userId,
      movement,
      'expense',
      loc.fieldId,
      loc.type === 'plot' ? loc.plotId : null,
      category,
      opts.count,
      opts.breed ?? null,
      opts.movement_date,
    ) ?? undefined;

    return { group: updated, movement, created, financial };
  }

  /**
   * Remove animals from a plot or corral (venta o egreso externo).
   */
  async removeAnimals(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      corralName?: string | null;
      breed?: string | null;
      unit_price_ars?: number | null;
      unit_price_usd?: number | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    },
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow; financial?: LinkedFinancialRecord }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const loc = await this.resolveLocation(userId, opts.fieldName, opts.plotName, opts.corralName);
    const locLabel = loc.type === 'corral' ? `corral ${loc.corralName}` : `lote ${loc.plotName}`;

    const group = await this.findGroupAtLocation(loc, category, opts.breed ?? null);
    if (!group) {
      throw new Error(
        `No hay ${category}${opts.breed ? ` (${opts.breed})` : ''} en el ${locLabel}.`
      );
    }

    const { group: updated, movement } = await this.repo.applySingleMovement(
      Number(userId),
      'salida',
      group.id,
      opts.count,
      {
        unit_price_ars: opts.unit_price_ars,
        unit_price_usd: opts.unit_price_usd,
        reason: opts.reason ?? 'Venta / egreso',
        notes: opts.notes,
        movement_date: opts.movement_date,
      }
    );

    this.attachLocationNames(updated, loc);

    const financial = await this.createLinkedFinancialRecord(
      userId,
      movement,
      'income',
      loc.fieldId,
      loc.type === 'plot' ? loc.plotId : null,
      category,
      opts.count,
      opts.breed ?? null,
      opts.movement_date,
    ) ?? undefined;

    return { group: updated, movement, financial };
  }

  /**
   * Move animals between two locations (plot↔plot, plot↔corral, corral↔corral).
   * Or recategorize within the same location. Atomic: both groups are locked.
   */
  async transferAnimals(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      sourceField?: string | null;
      sourcePlot?: string | null;
      sourceCorral?: string | null;
      destField?: string | null;
      destPlot?: string | null;
      destCorral?: string | null;
      breed?: string | null;
      destCategory?: string | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    }
  ): Promise<{
    sourceGroup: LivestockGroupRow;
    destGroup: LivestockGroupRow;
    movement: LivestockMovementRow;
  }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const destCategory = opts.destCategory
      ? LivestockService.normalizeCategory(opts.destCategory)
      : category;
    if (!destCategory) throw new Error(`Categoría destino no reconocida: "${opts.destCategory}".`);

    const source = await this.resolveLocation(userId, opts.sourceField, opts.sourcePlot, opts.sourceCorral);
    const dest = await this.resolveLocation(userId, opts.destField, opts.destPlot, opts.destCorral);

    // Detect same location
    const sameLocation =
      (source.type === 'plot' && dest.type === 'plot' && source.plotId === dest.plotId) ||
      (source.type === 'corral' && dest.type === 'corral' && source.corralId === dest.corralId);

    const isRecategorization = sameLocation && category !== destCategory;
    const movementType: 'transferencia' | 'recategorizacion' =
      isRecategorization ? 'recategorizacion' : 'transferencia';

    if (sameLocation && category === destCategory) {
      const locLabel = source.type === 'corral' ? 'corral' : 'lote';
      throw new Error(`El ${locLabel} origen y destino son iguales y no hay recategorización.`);
    }

    const sourceLocLabel = source.type === 'corral' ? `corral ${source.corralName}` : `lote ${source.plotName}`;

    const sourceGroup = await this.findGroupAtLocation(source, category, opts.breed ?? null);
    if (!sourceGroup) {
      throw new Error(
        `No hay ${category}${opts.breed ? ` (${opts.breed})` : ''} en el ${sourceLocLabel}.`
      );
    }

    const destGroup = await this.ensureGroupAtLocation(userId, dest, destCategory, opts.breed ?? null);

    const result = await this.repo.applyTransferMovement(
      Number(userId),
      movementType,
      sourceGroup.id,
      destGroup.id,
      opts.count,
      {
        reason: opts.reason ?? (isRecategorization ? 'Recategorización' : 'Transferencia'),
        notes: opts.notes,
        movement_date: opts.movement_date,
      }
    );

    this.attachLocationNames(result.sourceGroup, source);
    this.attachLocationNames(result.destGroup, dest);

    return result;
  }

  /** Record a death (baja) */
  async recordDeath(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      corralName?: string | null;
      breed?: string | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    }
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow }> {
    return this.#singleMovement(userId, 'muerte', opts);
  }

  /** Record a birth (alta) */
  async recordBirth(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      corralName?: string | null;
      breed?: string | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    }
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow; created: boolean }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const loc = await this.resolveLocation(userId, opts.fieldName, opts.plotName, opts.corralName);
    const existing = await this.findGroupAtLocation(loc, category, opts.breed ?? null);
    const created = !existing;
    const group = await this.ensureGroupAtLocation(userId, loc, category, opts.breed ?? null);

    const { group: updated, movement } = await this.repo.applySingleMovement(
      Number(userId),
      'nacimiento',
      group.id,
      opts.count,
      {
        reason: opts.reason ?? 'Nacimiento',
        notes: opts.notes,
        movement_date: opts.movement_date,
      }
    );

    this.attachLocationNames(updated, loc);
    return { group: updated, movement, created };
  }

  /** Shared helper for death/salida-style single movements */
  async #singleMovement(
    userId: UserId,
    movementType: LivestockMovementType,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      corralName?: string | null;
      breed?: string | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    }
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const loc = await this.resolveLocation(userId, opts.fieldName, opts.plotName, opts.corralName);
    const locLabel = loc.type === 'corral' ? `corral ${loc.corralName}` : `lote ${loc.plotName}`;

    const group = await this.findGroupAtLocation(loc, category, opts.breed ?? null);
    if (!group) {
      throw new Error(
        `No hay ${category}${opts.breed ? ` (${opts.breed})` : ''} en el ${locLabel}.`
      );
    }

    const { group: updated, movement } = await this.repo.applySingleMovement(
      Number(userId),
      movementType,
      group.id,
      opts.count,
      {
        reason: opts.reason ?? null,
        notes: opts.notes,
        movement_date: opts.movement_date,
      }
    );

    this.attachLocationNames(updated, loc);
    return { group: updated, movement };
  }

  /**
   * Adjust animals to an absolute count (corrección).
   * Creates the group on demand if it doesn't exist.
   */
  async adjustAnimals(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      corralName?: string | null;
      breed?: string | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    },
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow; previousCount: number; created: boolean }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}". Usá vaca, vaquillona, ternero, novillo, toro, etc.`);
    if (opts.count == null || opts.count < 0) throw new Error('La cantidad debe ser 0 o mayor.');

    const loc = await this.resolveLocation(userId, opts.fieldName, opts.plotName, opts.corralName);

    const existing = await this.findGroupAtLocation(loc, category, opts.breed ?? null);
    const created = !existing;
    const previousCount = existing ? Number(existing.count) : 0;

    const group = await this.ensureGroupAtLocation(userId, loc, category, opts.breed ?? null, {
      notes: opts.notes,
    });

    const { group: updated, movement } = await this.repo.applySingleMovement(
      Number(userId),
      'ajuste',
      group.id,
      opts.count,
      {
        reason: opts.reason ?? 'Corrección manual',
        notes: opts.notes,
        movement_date: opts.movement_date,
      }
    );

    this.attachLocationNames(updated, loc);
    return { group: updated, movement, previousCount, created };
  }

  /** List current livestock inventory */
  async listInventory(
    userId: UserId,
    opts: { fieldName?: string | null; plotName?: string | null; corralName?: string | null; category?: string | null } = {}
  ): Promise<{ groups: LivestockGroupRow[]; total: number }> {
    const filters: { fieldId?: number; plotId?: number; corralId?: number; category?: LivestockCategory } = {};

    if (opts.corralName) {
      const ref = await this.feedlotService.resolveCorral(userId, opts.corralName, opts.fieldName);
      filters.corralId = ref.corralId;
      filters.fieldId = ref.fieldId;
    } else if (opts.fieldName || opts.plotName) {
      const plot = opts.plotName
        ? await this.resolvePlot(userId, opts.fieldName ?? null, opts.plotName)
        : null;
      if (plot) {
        filters.fieldId = plot.fieldId;
        filters.plotId = plot.plotId;
      } else if (opts.fieldName) {
        const result = await this.plotDiscovery.resolve(userId, opts.fieldName, null);
        if (result.notFound) throw new Error(`No encontré el campo "${opts.fieldName}".`);
        if (result.fieldId) filters.fieldId = result.fieldId;
      }
    }

    if (opts.category) {
      const cat = LivestockService.normalizeCategory(opts.category);
      if (cat) filters.category = cat;
    }

    const groups = await this.repo.listGroups(Number(userId), filters);
    const total = groups.reduce((sum, g) => sum + Number(g.count), 0);
    return { groups, total };
  }

  /** Get movement history for a location/category group */
  async getHistory(
    userId: UserId,
    opts: { fieldName?: string | null; plotName?: string | null; corralName?: string | null; category: string; breed?: string | null }
  ): Promise<{ group: LivestockGroupRow; movements: LivestockMovementRow[] }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);

    if (!opts.plotName && !opts.corralName) {
      throw new Error('Necesito saber el lote o corral. Ej: "historial vacas lote A1" o "historial novillos corral 1".');
    }

    const loc = await this.resolveLocation(userId, opts.fieldName, opts.plotName, opts.corralName);
    const locLabel = loc.type === 'corral' ? `corral ${loc.corralName}` : `lote ${loc.plotName}`;

    const group = await this.findGroupAtLocation(loc, category, opts.breed ?? null);
    if (!group) {
      throw new Error(`No hay ${category} en el ${locLabel}.`);
    }
    this.attachLocationNames(group, loc);

    const movements = await this.repo.getMovementsForGroup(group.id, 50);
    return { group, movements };
  }

  async countUserMovements(userId: UserId): Promise<number> {
    return this.repo.countUserMovements(Number(userId));
  }
}
