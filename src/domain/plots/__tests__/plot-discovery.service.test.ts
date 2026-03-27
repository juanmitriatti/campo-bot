import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';

// Mock expenses.js functions
const mocks = {
  findPlotByNameAcrossFields: vi.fn(),
  getFieldByName: vi.fn(),
  getPlotByName: vi.fn(),
  findPlotByAlias: vi.fn(),
  addPlotAlias: vi.fn(),
  getConversationState: vi.fn(),
  updateConversationState: vi.fn(),
  getPlotById: vi.fn(),
  getUserFields: vi.fn().mockResolvedValue([]),
  getPlotsByField: vi.fn().mockResolvedValue([]),
  findAllUserPlots: vi.fn().mockResolvedValue([]),
};

vi.mock('../../../services/expenses.js', () => mocks);

// Must import after vi.mock
const { PlotDiscoveryService } = await import('../plot-discovery.service.js');

const userId = 1 as UserId;

describe('PlotDiscoveryService', () => {
  let service: InstanceType<typeof PlotDiscoveryService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PlotDiscoveryService();
    mocks.addPlotAlias.mockResolvedValue(undefined);
    mocks.updateConversationState.mockResolvedValue(undefined);
  });

  describe('resolveFromNames — both campo + plot', () => {
    it('resolves both when they exist', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotByName.mockResolvedValue({ id: 20, field_id: 10, name: '3' });

      const result = await service.resolveFromNames(userId, 'norte', '3');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: 20, plotName: '3',
        autoCreated: false,
      });
      expect(mocks.getFieldByName).toHaveBeenCalledWith(userId, 'norte');
      expect(mocks.getPlotByName).toHaveBeenCalledWith(10, '3');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, '3');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'lote 3'); // numeric alias
      expect(mocks.updateConversationState).toHaveBeenCalledWith(userId, 10, 20);
    });

    it('returns notFound when field does not exist', async () => {
      mocks.getFieldByName.mockResolvedValue(null);

      const result = await service.resolveFromNames(userId, 'norte', '3');

      expect(result.fieldId).toBeNull();
      expect(result.notFound).toEqual({ type: 'field', name: 'norte' });
      expect(mocks.getPlotByName).not.toHaveBeenCalled();
    });

    it('returns notFound when plot does not exist in field', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotByName.mockResolvedValue(null);

      const result = await service.resolveFromNames(userId, 'norte', '3');

      expect(result.fieldId).toBe(10);
      expect(result.plotId).toBeNull();
      expect(result.notFound).toEqual({ type: 'plot', name: '3' });
    });
  });

  describe('resolveFromNames — plot only', () => {
    it('finds direct name match across fields', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([
        { id: 20, field_id: 10, name: 'bajo', field_name: 'norte' },
      ]);

      const result = await service.resolveFromNames(userId, null, 'bajo');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: 20, plotName: 'bajo',
        autoCreated: false,
      });
      expect(mocks.updateConversationState).toHaveBeenCalledWith(userId, 10, 20);
    });

    it('finds via alias when no direct match', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([]);
      mocks.findPlotByAlias.mockResolvedValue({
        id: 20, field_id: 10, name: 'bajo', field_name: 'norte',
      });

      const result = await service.resolveFromNames(userId, null, 'bajo');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: 20, plotName: 'bajo',
        autoCreated: false,
      });
    });

    it('backward compat: returns existing field if name matches field', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([]);
      mocks.findPlotByAlias.mockResolvedValue(null);
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });

      const result = await service.resolveFromNames(userId, null, 'norte');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: null, plotName: null,
        autoCreated: false,
      });
    });

    it('returns notFound instead of auto-creating', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([]);
      mocks.findPlotByAlias.mockResolvedValue(null);
      mocks.getFieldByName.mockResolvedValue(null);

      const result = await service.resolveFromNames(userId, null, 'bajo');

      expect(result.fieldId).toBeNull();
      expect(result.plotId).toBeNull();
      expect(result.autoCreated).toBe(false);
      expect(result.notFound).toEqual({ type: 'plot', name: 'bajo' });
    });
  });

  describe('resolveFromNames — __last__ sentinel', () => {
    it('returns last plot from conversation state', async () => {
      mocks.getConversationState.mockResolvedValue({
        user_id: 1, last_plot_id: 20, last_field_id: 10,
        plot_name: 'bajo', field_name: 'norte',
      });
      mocks.getPlotById.mockResolvedValue({
        id: 20, field_id: 10, name: 'bajo', field_name: 'norte',
      });

      const result = await service.resolveFromNames(userId, null, '__last__');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: 20, plotName: 'bajo',
        autoCreated: false,
      });
    });

    it('returns last field when no last plot', async () => {
      mocks.getConversationState.mockResolvedValue({
        user_id: 1, last_plot_id: null, last_field_id: 10,
        plot_name: null, field_name: 'norte',
      });

      const result = await service.resolveFromNames(userId, null, '__last__');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: null, plotName: null,
        autoCreated: false,
      });
    });

    it('returns nulls when no conversation state', async () => {
      mocks.getConversationState.mockResolvedValue(null);

      const result = await service.resolveFromNames(userId, null, '__last__');

      expect(result).toEqual({
        fieldId: null, fieldName: null,
        plotId: null, plotName: null,
        autoCreated: false,
      });
    });
  });

  describe('resolveFromNames — campo only', () => {
    it('resolves field with 0 plots and signals needPlotCreation', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotsByField.mockResolvedValue([]);

      const result = await service.resolveFromNames(userId, 'norte', null);

      expect(result.fieldId).toBe(10);
      expect(result.fieldName).toBe('norte');
      expect(result.plotId).toBeNull();
      expect(result.needPlotCreation).toEqual({ fieldId: 10, fieldName: 'norte' });
      expect(mocks.updateConversationState).toHaveBeenCalledWith(userId, 10, null);
    });

    it('auto-assigns single plot in field', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotsByField.mockResolvedValue([{ id: 20, name: 'bajo' }]);

      const result = await service.resolveFromNames(userId, 'norte', null);

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: 20, plotName: 'bajo',
        autoCreated: false,
      });
      expect(mocks.updateConversationState).toHaveBeenCalledWith(userId, 10, 20);
    });

    it('signals needPlotSelection with 2+ plots', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotsByField.mockResolvedValue([
        { id: 20, name: 'bajo' },
        { id: 21, name: 'alto' },
      ]);

      const result = await service.resolveFromNames(userId, 'norte', null);

      expect(result.fieldId).toBe(10);
      expect(result.plotId).toBeNull();
      expect(result.needPlotSelection).toEqual({
        fieldId: 10, fieldName: 'norte',
        plots: [{ id: 20, name: 'bajo' }, { id: 21, name: 'alto' }],
      });
    });

    it('returns notFound when field does not exist', async () => {
      mocks.getFieldByName.mockResolvedValue(null);

      const result = await service.resolveFromNames(userId, 'norte', null);

      expect(result.fieldId).toBeNull();
      expect(result.notFound).toEqual({ type: 'field', name: 'norte' });
      expect(mocks.updateConversationState).not.toHaveBeenCalled();
    });
  });

  describe('resolveFromNames — nothing', () => {
    it('returns all nulls when no plots and no fields', async () => {
      mocks.findAllUserPlots.mockResolvedValue([]);
      mocks.getUserFields.mockResolvedValue([]);

      const result = await service.resolveFromNames(userId, null, null);

      expect(result).toEqual({
        fieldId: null, fieldName: null,
        plotId: null, plotName: null,
        autoCreated: false,
      });
    });

    it('auto-assigns when user has exactly 1 plot total', async () => {
      mocks.findAllUserPlots.mockResolvedValue([
        { id: 20, name: 'bajo', field_id: 10, field_name: 'norte' },
      ]);
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });

      const result = await service.resolveFromNames(userId, null, null);

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: 20, plotName: 'bajo',
        autoCreated: false,
      });
      expect(mocks.updateConversationState).toHaveBeenCalledWith(userId, 10, 20);
    });
  });

  describe('resolve — accepts pre-extracted names', () => {
    it('resolves with field + plot names', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotByName.mockResolvedValue({ id: 20, field_id: 10, name: '3' });

      const result = await service.resolve(userId, 'norte', '3');

      expect(result.plotId).toBe(20);
      expect(result.fieldId).toBe(10);
    });

    it('resolves with only field name', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'sur' });
      mocks.getPlotsByField.mockResolvedValue([{ id: 20, name: '3' }]);

      const result = await service.resolve(userId, 'sur');

      expect(result.fieldName).toBe('sur');
      expect(result.plotId).toBe(20);
    });
  });

  describe('alias registration', () => {
    it('registers "lote N" alias for numeric plot names', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotByName.mockResolvedValue({ id: 20, field_id: 10, name: '5' });

      await service.resolveFromNames(userId, 'norte', '5');

      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, '5');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'lote 5');
    });

    it('registers stripped alias for "lote X" names', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getPlotByName.mockResolvedValue({ id: 20, field_id: 10, name: 'lote norte' });

      await service.resolveFromNames(userId, 'norte', 'lote norte');

      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'lote norte');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'norte');
    });
  });
});
