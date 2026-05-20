import { describe, it, expect, vi } from 'vitest';
import { LivestockService } from '../livestock.service.js';
import type { LivestockRepository } from '../livestock.repository.js';
import type { PlotDiscoveryService } from '../../plots/plot-discovery.service.js';
import type { FeedlotService } from '../../feedlot/feedlot.service.js';

function buildService(repoOverrides: Partial<LivestockRepository>): LivestockService {
  const repo = {
    findMovementById: vi.fn(),
    getGroupById: vi.fn(),
    applySingleMovement: vi.fn(),
    applyTransferMovement: vi.fn(),
    softDeleteDomainEvent: vi.fn(),
    ...repoOverrides,
  } as unknown as LivestockRepository;
  return new LivestockService(
    repo,
    {} as PlotDiscoveryService,
    {} as FeedlotService,
  );
}

describe('LivestockService.undoMovement', () => {
  it('refuses when reversal would leave group count negative', async () => {
    const svc = buildService({
      findMovementById: vi.fn().mockResolvedValue({
        id: 'm1', movement_type: 'entrada', count: 10,
        dest_group_id: 'g1', source_group_id: null, avg_weight_kg: null,
      }),
      getGroupById: vi.fn().mockResolvedValue({ id: 'g1', category: 'vaca', count: 5, plot_id: 1, corral_id: null }),
    });
    await expect(svc.undoMovement(1 as never, 'm1')).rejects.toThrow(/no se puede deshacer/i);
  });

  it('reverses an entrada by issuing a compensating salida', async () => {
    const applySingleMovement = vi.fn().mockResolvedValue({});
    const svc = buildService({
      findMovementById: vi.fn().mockResolvedValue({
        id: 'm2', movement_type: 'entrada', count: 5,
        dest_group_id: 'g1', source_group_id: null, avg_weight_kg: null,
      }),
      getGroupById: vi.fn().mockResolvedValue({ id: 'g1', category: 'vaca', count: 20, plot_id: 1, corral_id: null }),
      applySingleMovement,
    });
    const r = await svc.undoMovement(1 as never, 'm2');
    expect(r.reversed).toBe(true);
    expect(applySingleMovement).toHaveBeenCalledWith(
      1, 'salida', 'g1', 5,
      expect.objectContaining({ reason: expect.stringMatching(/Reversa del movimiento m2/) }),
    );
  });

  it('refuses to undo an ajuste', async () => {
    const svc = buildService({
      findMovementById: vi.fn().mockResolvedValue({
        id: 'm3', movement_type: 'ajuste', count: 1,
        dest_group_id: 'g1', source_group_id: null, avg_weight_kg: null,
      }),
    });
    await expect(svc.undoMovement(1 as never, 'm3')).rejects.toThrow(/no se pueden deshacer/i);
  });

  it('throws when movement does not exist', async () => {
    const svc = buildService({
      findMovementById: vi.fn().mockResolvedValue(null),
    });
    await expect(svc.undoMovement(1 as never, 'nope')).rejects.toThrow(/No encontré el movimiento/);
  });
});
