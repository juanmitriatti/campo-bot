import { LivestockRepository } from './livestock.repository.js';
import type {
  LivestockCategory,
  LivestockGroupRow,
  LivestockMovementRow,
  LivestockMovementType,
} from './livestock.types.js';
import { LIVESTOCK_CATEGORIES } from './livestock.types.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import type { UserId } from '../../types/index.js';

export interface ResolvedPlotRef {
  fieldId: number;
  fieldName: string;
  plotId: number;
  plotName: string;
}

export interface MovementFinancials {
  unit_price_ars?: number | null;
  unit_price_usd?: number | null;
}

/**
 * Livestock (hacienda) business logic.
 * All mutations are delegated to the repository's atomic methods
 * so that group counts and the movement ledger stay in sync.
 */
export class LivestockService {
  private repo: LivestockRepository;
  private plotDiscovery: PlotDiscoveryService;

  constructor(repo?: LivestockRepository, plotDiscovery?: PlotDiscoveryService) {
    this.repo = repo ?? new LivestockRepository();
    this.plotDiscovery = plotDiscovery ?? new PlotDiscoveryService();
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
  // PLOT RESOLUTION
  // ========================

  /**
   * Resolve a plot reference for livestock operations.
   * Throws a user-friendly error if plot cannot be uniquely resolved
   * (livestock always needs an explicit plot — no auto-creation).
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
      throw new Error('Necesito que me digas en qué lote. Ej: "agregá 20 vacas al lote A1".');
    }

    return {
      fieldId: result.fieldId,
      fieldName: result.fieldName!,
      plotId: result.plotId,
      plotName: result.plotName!,
    };
  }

  /** Find-or-create the group for a given (plot, category, breed) triple */
  private async ensureGroup(
    userId: UserId,
    plot: ResolvedPlotRef,
    category: LivestockCategory,
    breed: string | null,
    opts: { avg_weight_kg?: number | null; notes?: string | null } = {}
  ): Promise<LivestockGroupRow> {
    const existing = await this.repo.findGroup(plot.plotId, category, breed);
    if (existing) {
      if (opts.avg_weight_kg !== undefined || opts.notes !== undefined) {
        await this.repo.updateGroupMetadata(existing.id, {
          avg_weight_kg: opts.avg_weight_kg,
          notes: opts.notes,
        });
      }
      return existing;
    }
    return this.repo.createGroup(Number(userId), plot.fieldId, plot.plotId, category, breed, opts);
  }

  // ========================
  // PUBLIC API
  // ========================

  /**
   * Add animals to a plot (compra o ingreso externo).
   * Creates the group on demand. Returns the updated group + movement.
   */
  async addAnimals(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      breed?: string | null;
      avg_weight_kg?: number | null;
      unit_price_ars?: number | null;
      unit_price_usd?: number | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    },
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow; created: boolean }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}". Usá vaca, vaquillona, ternero, novillo, toro, etc.`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const plot = await this.resolvePlot(userId, opts.fieldName, opts.plotName);

    const existing = await this.repo.findGroup(plot.plotId, category, opts.breed ?? null);
    const created = !existing;

    const group = await this.ensureGroup(userId, plot, category, opts.breed ?? null, {
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

    updated.field_name = plot.fieldName;
    updated.plot_name = plot.plotName;
    return { group: updated, movement, created };
  }

  /**
   * Remove animals from a plot (venta o egreso externo).
   */
  async removeAnimals(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      fieldName?: string | null;
      plotName?: string | null;
      breed?: string | null;
      unit_price_ars?: number | null;
      unit_price_usd?: number | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    },
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const plot = await this.resolvePlot(userId, opts.fieldName, opts.plotName);

    const group = await this.repo.findGroup(plot.plotId, category, opts.breed ?? null);
    if (!group) {
      throw new Error(
        `No hay ${category}${opts.breed ? ` (${opts.breed})` : ''} en el lote ${plot.plotName}.`
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

    updated.field_name = plot.fieldName;
    updated.plot_name = plot.plotName;
    return { group: updated, movement };
  }

  /**
   * Move animals between two plots (or recategorize within the same plot).
   * Atomic: both groups are locked in a single transaction.
   */
  async transferAnimals(
    userId: UserId,
    opts: {
      category: string;
      count: number;
      sourceField?: string | null;
      sourcePlot: string;
      destField?: string | null;
      destPlot: string;
      breed?: string | null;
      destCategory?: string | null; // if set, this is a recategorization
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

    const source = await this.resolvePlot(userId, opts.sourceField, opts.sourcePlot);
    const dest = await this.resolvePlot(userId, opts.destField, opts.destPlot);

    const isRecategorization =
      source.plotId === dest.plotId && category !== destCategory;
    const movementType: 'transferencia' | 'recategorizacion' =
      isRecategorization ? 'recategorizacion' : 'transferencia';

    if (source.plotId === dest.plotId && category === destCategory) {
      throw new Error('El lote origen y destino son iguales y no hay recategorización.');
    }

    const sourceGroup = await this.repo.findGroup(source.plotId, category, opts.breed ?? null);
    if (!sourceGroup) {
      throw new Error(
        `No hay ${category}${opts.breed ? ` (${opts.breed})` : ''} en el lote ${source.plotName}.`
      );
    }

    const destGroup = await this.ensureGroup(userId, dest, destCategory, opts.breed ?? null);

    const result = await this.repo.applyTransferMovement(
      Number(userId),
      movementType,
      sourceGroup.id,
      destGroup.id,
      opts.count,
      {
        reason: opts.reason ?? (isRecategorization ? 'Recategorización' : 'Transferencia entre lotes'),
        notes: opts.notes,
        movement_date: opts.movement_date,
      }
    );

    result.sourceGroup.field_name = source.fieldName;
    result.sourceGroup.plot_name = source.plotName;
    result.destGroup.field_name = dest.fieldName;
    result.destGroup.plot_name = dest.plotName;

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
      breed?: string | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    }
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow; created: boolean }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const plot = await this.resolvePlot(userId, opts.fieldName, opts.plotName);
    const existing = await this.repo.findGroup(plot.plotId, category, opts.breed ?? null);
    const created = !existing;
    const group = await this.ensureGroup(userId, plot, category, opts.breed ?? null);

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

    updated.field_name = plot.fieldName;
    updated.plot_name = plot.plotName;
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
      breed?: string | null;
      reason?: string | null;
      notes?: string | null;
      movement_date?: string | null;
    }
  ): Promise<{ group: LivestockGroupRow; movement: LivestockMovementRow }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);
    if (!opts.count || opts.count <= 0) throw new Error('La cantidad debe ser mayor a 0.');

    const plot = await this.resolvePlot(userId, opts.fieldName, opts.plotName);
    const group = await this.repo.findGroup(plot.plotId, category, opts.breed ?? null);
    if (!group) {
      throw new Error(
        `No hay ${category}${opts.breed ? ` (${opts.breed})` : ''} en el lote ${plot.plotName}.`
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

    updated.field_name = plot.fieldName;
    updated.plot_name = plot.plotName;
    return { group: updated, movement };
  }

  /** List current livestock inventory */
  async listInventory(
    userId: UserId,
    opts: { fieldName?: string | null; plotName?: string | null; category?: string | null } = {}
  ): Promise<{ groups: LivestockGroupRow[]; total: number }> {
    const filters: { fieldId?: number; plotId?: number; category?: LivestockCategory } = {};

    if (opts.fieldName || opts.plotName) {
      const plot = opts.plotName
        ? await this.resolvePlot(userId, opts.fieldName ?? null, opts.plotName)
        : null;
      if (plot) {
        filters.fieldId = plot.fieldId;
        filters.plotId = plot.plotId;
      } else if (opts.fieldName) {
        // Field-only filter: resolve field
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

  /** Get movement history for a plot/category group */
  async getHistory(
    userId: UserId,
    opts: { fieldName?: string | null; plotName: string; category: string; breed?: string | null }
  ): Promise<{ group: LivestockGroupRow; movements: LivestockMovementRow[] }> {
    const category = LivestockService.normalizeCategory(opts.category);
    if (!category) throw new Error(`Categoría no reconocida: "${opts.category}".`);

    const plot = await this.resolvePlot(userId, opts.fieldName, opts.plotName);
    const group = await this.repo.findGroup(plot.plotId, category, opts.breed ?? null);
    if (!group) {
      throw new Error(`No hay ${category} en el lote ${plot.plotName}.`);
    }
    group.field_name = plot.fieldName;
    group.plot_name = plot.plotName;

    const movements = await this.repo.getMovementsForGroup(group.id, 50);
    return { group, movements };
  }
}
