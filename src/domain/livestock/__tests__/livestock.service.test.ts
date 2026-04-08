import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';
import { LivestockService } from '../livestock.service.js';
import type { LivestockCategory, LivestockGroupRow, LivestockMovementRow } from '../livestock.types.js';

const userId = 42 as UserId;

// ---- Repo mock ----
const makeRepoMock = () => ({
  findGroup: vi.fn(),
  getGroupById: vi.fn(),
  listGroups: vi.fn(),
  countTotal: vi.fn(),
  createGroup: vi.fn(),
  updateGroupMetadata: vi.fn(),
  getMovementsForGroup: vi.fn(),
  getRecentMovements: vi.fn(),
  applySingleMovement: vi.fn(),
  applyTransferMovement: vi.fn(),
});

// ---- PlotDiscoveryService mock ----
const makePlotDiscoveryMock = () => ({
  resolve: vi.fn(),
  resolveFromNames: vi.fn(),
});

// ---- Helpers ----
const makeGroup = (overrides: Partial<LivestockGroupRow> = {}): LivestockGroupRow => ({
  id: 'group-1',
  user_id: 42,
  field_id: 1,
  plot_id: 10,
  category: 'vaca' as LivestockCategory,
  breed: null,
  count: 0,
  avg_weight_kg: null,
  notes: null,
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
  ...overrides,
});

const makeMovement = (overrides: Partial<LivestockMovementRow> = {}): LivestockMovementRow => ({
  id: 'mv-1',
  user_id: 42,
  movement_type: 'entrada',
  source_group_id: null,
  dest_group_id: 'group-1',
  count: 10,
  avg_weight_kg: null,
  unit_price_ars: null,
  unit_price_usd: null,
  reason: null,
  notes: null,
  movement_date: new Date(),
  created_at: new Date(),
  ...overrides,
});

const resolvedPlot = {
  fieldId: 1,
  fieldName: 'Norte',
  plotId: 10,
  plotName: 'A1',
  autoCreated: false,
};

describe('LivestockService.normalizeCategory', () => {
  it('accepts canonical names', () => {
    expect(LivestockService.normalizeCategory('vaca')).toBe('vaca');
    expect(LivestockService.normalizeCategory('novillo')).toBe('novillo');
  });

  it('normalizes plural + accents', () => {
    expect(LivestockService.normalizeCategory('VACAS')).toBe('vaca');
    expect(LivestockService.normalizeCategory('vaquillas')).toBe('vaquillona');
    expect(LivestockService.normalizeCategory('terneros')).toBe('ternero');
  });

  it('returns null for unknown categories', () => {
    expect(LivestockService.normalizeCategory('perro')).toBeNull();
    expect(LivestockService.normalizeCategory(null)).toBeNull();
    expect(LivestockService.normalizeCategory('')).toBeNull();
  });
});

describe('LivestockService.addAnimals', () => {
  let repo: ReturnType<typeof makeRepoMock>;
  let plotDiscovery: ReturnType<typeof makePlotDiscoveryMock>;
  let service: LivestockService;

  beforeEach(() => {
    repo = makeRepoMock();
    plotDiscovery = makePlotDiscoveryMock();
    service = new LivestockService(repo as any, plotDiscovery as any);
    plotDiscovery.resolve.mockResolvedValue(resolvedPlot);
  });

  it('creates a group on first add and applies an entrada movement', async () => {
    repo.findGroup.mockResolvedValueOnce(null);
    const group = makeGroup({ id: 'g1' });
    repo.createGroup.mockResolvedValue(group);
    repo.applySingleMovement.mockResolvedValue({
      group: { ...group, count: 20 },
      movement: makeMovement({ count: 20 }),
    });

    const result = await service.addAnimals(userId, {
      category: 'vaca',
      count: 20,
      fieldName: 'Norte',
      plotName: 'A1',
    });

    expect(result.created).toBe(true);
    expect(result.group.count).toBe(20);
    expect(repo.createGroup).toHaveBeenCalledWith(42, 1, 10, 'vaca', null, expect.any(Object));
    expect(repo.applySingleMovement).toHaveBeenCalledWith(
      42,
      'entrada',
      'g1',
      20,
      expect.objectContaining({ reason: 'Compra / ingreso' })
    );
  });

  it('adds to existing group without creating', async () => {
    const existing = makeGroup({ id: 'g1', count: 10 });
    repo.findGroup.mockResolvedValueOnce(existing);
    repo.createGroup.mockResolvedValue(existing);
    repo.applySingleMovement.mockResolvedValue({
      group: { ...existing, count: 15 },
      movement: makeMovement({ count: 5 }),
    });

    const result = await service.addAnimals(userId, {
      category: 'vaca',
      count: 5,
      fieldName: 'Norte',
      plotName: 'A1',
    });

    expect(result.created).toBe(false);
    expect(result.group.count).toBe(15);
  });

  it('rejects zero or negative counts', async () => {
    await expect(
      service.addAnimals(userId, { category: 'vaca', count: 0, plotName: 'A1' })
    ).rejects.toThrow('mayor a 0');
    await expect(
      service.addAnimals(userId, { category: 'vaca', count: -5, plotName: 'A1' })
    ).rejects.toThrow('mayor a 0');
  });

  it('rejects unknown category', async () => {
    await expect(
      service.addAnimals(userId, { category: 'perro', count: 10, plotName: 'A1' })
    ).rejects.toThrow('Categoría no reconocida');
  });

  it('throws when plot cannot be resolved', async () => {
    plotDiscovery.resolve.mockResolvedValueOnce({
      ...resolvedPlot,
      plotId: null,
      fieldId: null,
      notFound: { type: 'plot', name: 'Z9' },
    });
    await expect(
      service.addAnimals(userId, { category: 'vaca', count: 10, plotName: 'Z9' })
    ).rejects.toThrow('No encontré el lote');
  });
});

describe('LivestockService.removeAnimals', () => {
  let repo: ReturnType<typeof makeRepoMock>;
  let plotDiscovery: ReturnType<typeof makePlotDiscoveryMock>;
  let service: LivestockService;

  beforeEach(() => {
    repo = makeRepoMock();
    plotDiscovery = makePlotDiscoveryMock();
    service = new LivestockService(repo as any, plotDiscovery as any);
    plotDiscovery.resolve.mockResolvedValue(resolvedPlot);
  });

  it('removes from existing group', async () => {
    const group = makeGroup({ id: 'g1', count: 20 });
    repo.findGroup.mockResolvedValue(group);
    repo.applySingleMovement.mockResolvedValue({
      group: { ...group, count: 15 },
      movement: makeMovement({ movement_type: 'salida', count: 5 }),
    });

    const result = await service.removeAnimals(userId, {
      category: 'vaca',
      count: 5,
      plotName: 'A1',
    });

    expect(result.group.count).toBe(15);
    expect(repo.applySingleMovement).toHaveBeenCalledWith(
      42,
      'salida',
      'g1',
      5,
      expect.objectContaining({ reason: 'Venta / egreso' })
    );
  });

  it('throws when no group exists for that category', async () => {
    repo.findGroup.mockResolvedValue(null);
    await expect(
      service.removeAnimals(userId, { category: 'vaca', count: 5, plotName: 'A1' })
    ).rejects.toThrow(/No hay vaca/);
  });

  it('propagates insufficient-stock error from the repo', async () => {
    repo.findGroup.mockResolvedValue(makeGroup({ id: 'g1', count: 3 }));
    repo.applySingleMovement.mockRejectedValue(new Error('Cantidad insuficiente. Disponible: 3 animales'));

    await expect(
      service.removeAnimals(userId, { category: 'vaca', count: 10, plotName: 'A1' })
    ).rejects.toThrow('Cantidad insuficiente');
  });
});

describe('LivestockService.transferAnimals', () => {
  let repo: ReturnType<typeof makeRepoMock>;
  let plotDiscovery: ReturnType<typeof makePlotDiscoveryMock>;
  let service: LivestockService;

  beforeEach(() => {
    repo = makeRepoMock();
    plotDiscovery = makePlotDiscoveryMock();
    service = new LivestockService(repo as any, plotDiscovery as any);
  });

  it('transfers between two different plots atomically', async () => {
    plotDiscovery.resolve
      .mockResolvedValueOnce({ ...resolvedPlot, plotId: 10, plotName: 'A1' })
      .mockResolvedValueOnce({ ...resolvedPlot, plotId: 20, plotName: 'B2' });

    const source = makeGroup({ id: 'gs', plot_id: 10, count: 30 });
    const dest = makeGroup({ id: 'gd', plot_id: 20, count: 0 });
    repo.findGroup.mockResolvedValueOnce(source);
    repo.findGroup.mockResolvedValueOnce(dest);
    repo.createGroup.mockResolvedValue(dest);

    repo.applyTransferMovement.mockResolvedValue({
      sourceGroup: { ...source, count: 20 },
      destGroup: { ...dest, count: 10 },
      movement: makeMovement({ movement_type: 'transferencia', source_group_id: 'gs', dest_group_id: 'gd', count: 10 }),
    });

    const result = await service.transferAnimals(userId, {
      category: 'vaca',
      count: 10,
      sourcePlot: 'A1',
      destPlot: 'B2',
    });

    expect(result.sourceGroup.count).toBe(20);
    expect(result.destGroup.count).toBe(10);
    expect(repo.applyTransferMovement).toHaveBeenCalledWith(
      42,
      'transferencia',
      'gs',
      'gd',
      10,
      expect.any(Object)
    );
  });

  it('classifies as recategorizacion when same plot but different category', async () => {
    const plot = { ...resolvedPlot, plotId: 10, plotName: 'A1' };
    plotDiscovery.resolve.mockResolvedValue(plot);

    const source = makeGroup({ id: 'gs', plot_id: 10, category: 'ternero', count: 15 });
    const dest = makeGroup({ id: 'gd', plot_id: 10, category: 'novillito', count: 0 });
    repo.findGroup.mockResolvedValueOnce(source);
    repo.findGroup.mockResolvedValueOnce(dest);
    repo.createGroup.mockResolvedValue(dest);

    repo.applyTransferMovement.mockResolvedValue({
      sourceGroup: { ...source, count: 5 },
      destGroup: { ...dest, count: 10 },
      movement: makeMovement({ movement_type: 'recategorizacion' }),
    });

    const result = await service.transferAnimals(userId, {
      category: 'ternero',
      destCategory: 'novillito',
      count: 10,
      sourcePlot: 'A1',
      destPlot: 'A1',
    });

    expect(result.movement.movement_type).toBe('recategorizacion');
    expect(repo.applyTransferMovement).toHaveBeenCalledWith(
      42,
      'recategorizacion',
      'gs',
      'gd',
      10,
      expect.any(Object)
    );
  });

  it('rejects transfer when source group does not exist', async () => {
    plotDiscovery.resolve
      .mockResolvedValueOnce({ ...resolvedPlot, plotId: 10, plotName: 'A1' })
      .mockResolvedValueOnce({ ...resolvedPlot, plotId: 20, plotName: 'B2' });
    repo.findGroup.mockResolvedValueOnce(null);

    await expect(
      service.transferAnimals(userId, {
        category: 'vaca',
        count: 5,
        sourcePlot: 'A1',
        destPlot: 'B2',
      })
    ).rejects.toThrow(/No hay vaca/);
  });

  it('rejects identical source/dest with no recategorization', async () => {
    const plot = { ...resolvedPlot, plotId: 10, plotName: 'A1' };
    plotDiscovery.resolve.mockResolvedValue(plot);

    await expect(
      service.transferAnimals(userId, {
        category: 'vaca',
        count: 5,
        sourcePlot: 'A1',
        destPlot: 'A1',
      })
    ).rejects.toThrow(/origen y destino son iguales/);
  });
});

describe('LivestockService.recordDeath & recordBirth', () => {
  let repo: ReturnType<typeof makeRepoMock>;
  let plotDiscovery: ReturnType<typeof makePlotDiscoveryMock>;
  let service: LivestockService;

  beforeEach(() => {
    repo = makeRepoMock();
    plotDiscovery = makePlotDiscoveryMock();
    service = new LivestockService(repo as any, plotDiscovery as any);
    plotDiscovery.resolve.mockResolvedValue(resolvedPlot);
  });

  it('records a death against an existing group', async () => {
    const group = makeGroup({ id: 'g1', count: 25 });
    repo.findGroup.mockResolvedValue(group);
    repo.applySingleMovement.mockResolvedValue({
      group: { ...group, count: 23 },
      movement: makeMovement({ movement_type: 'muerte', count: 2 }),
    });

    const result = await service.recordDeath(userId, {
      category: 'vaca',
      count: 2,
      plotName: 'A1',
      reason: 'enfermedad',
    });

    expect(result.group.count).toBe(23);
    expect(repo.applySingleMovement).toHaveBeenCalledWith(
      42,
      'muerte',
      'g1',
      2,
      expect.objectContaining({ reason: 'enfermedad' })
    );
  });

  it('records a birth, creating group if needed', async () => {
    repo.findGroup.mockResolvedValueOnce(null);
    const group = makeGroup({ id: 'g1', count: 0 });
    repo.createGroup.mockResolvedValue(group);
    repo.applySingleMovement.mockResolvedValue({
      group: { ...group, count: 3 },
      movement: makeMovement({ movement_type: 'nacimiento', count: 3 }),
    });

    const result = await service.recordBirth(userId, {
      category: 'ternero',
      count: 3,
      plotName: 'A1',
    });

    expect(result.created).toBe(true);
    expect(result.group.count).toBe(3);
    expect(repo.applySingleMovement).toHaveBeenCalledWith(
      42,
      'nacimiento',
      'g1',
      3,
      expect.any(Object)
    );
  });
});

describe('LivestockService.listInventory', () => {
  let repo: ReturnType<typeof makeRepoMock>;
  let plotDiscovery: ReturnType<typeof makePlotDiscoveryMock>;
  let service: LivestockService;

  beforeEach(() => {
    repo = makeRepoMock();
    plotDiscovery = makePlotDiscoveryMock();
    service = new LivestockService(repo as any, plotDiscovery as any);
  });

  it('sums counts across groups', async () => {
    repo.listGroups.mockResolvedValue([
      makeGroup({ id: 'g1', category: 'vaca', count: 30 }),
      makeGroup({ id: 'g2', category: 'ternero', count: 15 }),
      makeGroup({ id: 'g3', category: 'toro', count: 2 }),
    ]);

    const result = await service.listInventory(userId);

    expect(result.total).toBe(47);
    expect(result.groups).toHaveLength(3);
  });

  it('filters by plot', async () => {
    plotDiscovery.resolve.mockResolvedValue(resolvedPlot);
    repo.listGroups.mockResolvedValue([makeGroup({ id: 'g1', count: 30 })]);

    const result = await service.listInventory(userId, { fieldName: 'Norte', plotName: 'A1' });

    expect(repo.listGroups).toHaveBeenCalledWith(42, expect.objectContaining({
      fieldId: 1,
      plotId: 10,
    }));
    expect(result.total).toBe(30);
  });
});
