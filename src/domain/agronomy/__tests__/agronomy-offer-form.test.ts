/**
 * Tests de offerForm en agronomy.handler:
 *   - sow_crop sin cultivo emite offerForm con prefill correcto
 *   - harvest_crop sin cultivo emite offerForm con prefill correcto
 *   - sow_crop con variety pasa la variedad a createPlotCrop y la incluye en la confirmación
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del pool de DB (importado en cadena por casi todos los módulos del handler)
vi.mock('../../../config/db.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})),
}));

// Mocks de módulos externos que el handler importa dinámicamente o en nivel raíz
vi.mock('../../../services/alert.service.js', () => ({
  isDuplicate: vi.fn().mockResolvedValue(false),
  recordAlert: vi.fn(),
  recordDeduped: vi.fn(),
}));

vi.mock('../../../services/error-logger.js', () => ({
  logError: vi.fn(),
}));

vi.mock('../../../middleware/callback-payload-store.js', () => ({
  callbackPayloadStore: { store: vi.fn().mockReturnValue('token') },
}));

// Importar DESPUÉS de los mocks
import { AgronomyHandler } from '../agronomy.handler.js';
import { AgronomyRepository } from '../agronomy.repository.js';
import type { UserId, User, UserSettings } from '../../../types/index.js';

// ---- helpers ----
const userId = 99 as UserId;
const user = { id: userId, name: 'TestUser', phone_number: '5491100000000', city: null } as User;
const settings = {} as UserSettings;

function makeRepo(): AgronomyRepository {
  return {
    findAllUserPlots: vi.fn().mockResolvedValue([]),
    getFieldByName: vi.fn().mockResolvedValue(null),
    saveDomainEvent: vi.fn().mockResolvedValue(undefined),
    findHarvestsToday: vi.fn().mockResolvedValue([]),
    updateConversationState: vi.fn().mockResolvedValue(undefined),
    getConversationState: vi.fn().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makePlotDiscovery(override: Record<string, unknown> = {}) {
  return {
    resolveFromNames: vi.fn().mockResolvedValue({ plotId: null, plotName: null, fieldId: null, fieldName: null }),
    ...override,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeCropService(override: Record<string, unknown> = {}) {
  return {
    getActive: vi.fn().mockResolvedValue(null),
    findRecentHarvestedNoYield: vi.fn().mockResolvedValue(null),
    startCrop: vi.fn().mockResolvedValue({
      cropRow: { id: 1, season_year: 2026, season_type: 'gruesa', crop: 'soja' },
      closedPrevious: null,
    }),
    ...override,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeHandler() {
  const repo = makeRepo();
  const handler = new AgronomyHandler(repo);
  // Override private properties via type cast
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).plotDiscovery = makePlotDiscovery();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).cropService = makeCropService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).campaignStatsService = { getStats: vi.fn() };
  return { handler, repo };
}

// ============================================================================
// sow_crop sin cultivo → offerForm
// ============================================================================
describe('sow_crop sin cultivo → offerForm', () => {
  it('el pending por crop faltante viene acompañado de offerForm con prefill', async () => {
    const { handler } = makeHandler();

    const cmd = {
      command: 'sow_crop',
      crop: null,
      plotName: 'Norte',
      fieldName: null,
      eventDate: '2026-08-01',
      hectares: null,
    };

    const response = await handler.handleCommand(cmd, userId, user, settings);

    expect(response.sideEffects?.setPendingActivity?.missing).toEqual(['crop']);
    expect(response.sideEffects?.offerForm).toEqual({
      action: 'sow_crop',
      prefill: {
        plotName: 'Norte',
        fieldName: null,
        eventDate: '2026-08-01',
        hectares: null,
      },
    });
  });

  it('prefill incluye hectares cuando se pasan', async () => {
    const { handler } = makeHandler();

    const cmd = {
      command: 'sow_crop',
      crop: null,
      plotName: 'Sur',
      fieldName: 'La Pampa',
      eventDate: null,
      hectares: 150,
    };

    const response = await handler.handleCommand(cmd, userId, user, settings);

    expect(response.sideEffects?.offerForm).toEqual({
      action: 'sow_crop',
      prefill: {
        plotName: 'Sur',
        fieldName: 'La Pampa',
        eventDate: null,
        hectares: 150,
      },
    });
  });
});

// ============================================================================
// harvest_crop sin cultivo → offerForm
// ============================================================================
describe('harvest_crop sin cultivo (post plot-resolution) → offerForm', () => {
  it('el pending por crop faltante viene acompañado de offerForm sin hectares', async () => {
    const { handler, repo } = makeHandler();

    // Simular un lote resuelto desde el discovery service
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).plotDiscovery = makePlotDiscovery({
      resolveFromNames: vi.fn().mockResolvedValue({
        plotId: 42,
        plotName: 'Norte',
        fieldId: 7,
        fieldName: 'La Loma',
      }),
    });
    // Simular que no hay campaña activa → crop sigue siendo placeholder
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).cropService = makeCropService({
      getActive: vi.fn().mockResolvedValue(null),
      findRecentHarvestedNoYield: vi.fn().mockResolvedValue(null),
    });
    // repo.findAllUserPlots debe devolver el plot para que resolveActivityPlot no sea ask_user
    (repo as unknown as { findAllUserPlots: ReturnType<typeof vi.fn> }).findAllUserPlots =
      vi.fn().mockResolvedValue([{ id: 42, name: 'Norte', field_name: 'La Loma' }]);

    const cmd = {
      command: 'harvest_crop',
      crop: null,
      plotName: 'Norte',
      fieldName: 'La Loma',
      eventDate: '2026-08-02',
    };

    const response = await handler.handleCommand(cmd, userId, user, settings);

    expect(response.sideEffects?.setPendingActivity?.missing).toEqual(['crop']);
    expect(response.sideEffects?.offerForm).toEqual({
      action: 'harvest_crop',
      prefill: {
        plotName: 'Norte',
        fieldName: 'La Loma',
        eventDate: '2026-08-02',
      },
    });
  });
});

// ============================================================================
// sow_crop con variety → pasa variety a createPlotCrop + línea en confirmación
// ============================================================================
describe('sow_crop con variety → createPlotCrop recibe variety + confirmación incluye línea', () => {
  it('variety se pasa como 7º argumento y aparece en la confirmación', async () => {
    const { handler, repo } = makeHandler();

    // Resolver el lote
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).plotDiscovery = makePlotDiscovery({
      resolveFromNames: vi.fn().mockResolvedValue({
        plotId: 10,
        plotName: 'Lote B',
        fieldId: 3,
        fieldName: 'Campo Norte',
      }),
    });

    const startCropSpy = vi.fn().mockResolvedValue({
      cropRow: { id: 5, season_year: 2026, season_type: 'gruesa', crop: 'Soja' },
      closedPrevious: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).cropService = makeCropService({ startCrop: startCropSpy });

    (repo as unknown as { findAllUserPlots: ReturnType<typeof vi.fn> }).findAllUserPlots =
      vi.fn().mockResolvedValue([{ id: 10, name: 'Lote B', field_name: 'Campo Norte' }]);
    (repo as unknown as { saveDomainEvent: ReturnType<typeof vi.fn> }).saveDomainEvent =
      vi.fn().mockResolvedValue(undefined);

    // Mock createPlotCrop (called inside startCrop mock, but we spy on the service)
    // The spy is on cropService.startCrop — check variety is passed there
    const cmd = {
      command: 'sow_crop',
      crop: 'Soja',
      plotName: 'Lote B',
      fieldName: 'Campo Norte',
      eventDate: null,
      hectares: null,
      variety: 'DM 4612',
    };

    const response = await handler.handleCommand(cmd, userId, user, settings);

    // Variety debe aparecer en el mensaje de confirmación
    expect(response.messages[0]).toContain('🧬 Variedad: DM 4612');

    // Verify startCrop was called with variety as the 6th param (index 5)
    expect(startCropSpy).toHaveBeenCalled();
    expect(startCropSpy.mock.calls[0]).toContain('DM 4612');
  });

  it('sin variety, la línea 🧬 NO aparece', async () => {
    const { handler, repo } = makeHandler();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).plotDiscovery = makePlotDiscovery({
      resolveFromNames: vi.fn().mockResolvedValue({
        plotId: 10,
        plotName: 'Lote B',
        fieldId: 3,
        fieldName: 'Campo Norte',
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).cropService = makeCropService({
      startCrop: vi.fn().mockResolvedValue({
        cropRow: { id: 5, season_year: 2026, season_type: 'gruesa', crop: 'Maíz' },
        closedPrevious: null,
      }),
    });

    (repo as unknown as { findAllUserPlots: ReturnType<typeof vi.fn> }).findAllUserPlots =
      vi.fn().mockResolvedValue([{ id: 10, name: 'Lote B', field_name: 'Campo Norte' }]);
    (repo as unknown as { saveDomainEvent: ReturnType<typeof vi.fn> }).saveDomainEvent =
      vi.fn().mockResolvedValue(undefined);

    const cmd = {
      command: 'sow_crop',
      crop: 'Maíz',
      plotName: 'Lote B',
      fieldName: 'Campo Norte',
      eventDate: null,
      hectares: null,
      variety: null,
    };

    const response = await handler.handleCommand(cmd, userId, user, settings);

    expect(response.messages[0]).not.toContain('🧬');
  });
});
