import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';

// Mock expenses.js functions
const mocks = {
  getOrCreateField: vi.fn(),
  getOrCreatePlot: vi.fn(),
  findPlotByNameAcrossFields: vi.fn(),
  getFieldByName: vi.fn(),
  findPlotByAlias: vi.fn(),
  addPlotAlias: vi.fn(),
  getConversationState: vi.fn(),
  updateConversationState: vi.fn(),
  getUserSingleField: vi.fn(),
  getPlotById: vi.fn(),
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
    it('creates both and registers alias', async () => {
      mocks.getOrCreateField.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getOrCreatePlot.mockResolvedValue({ id: 20, field_id: 10, name: '3' });

      const result = await service.resolveFromNames(userId, 'norte', '3');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: 20, plotName: '3',
        autoCreated: false,
      });
      expect(mocks.getOrCreateField).toHaveBeenCalledWith(userId, 'norte');
      expect(mocks.getOrCreatePlot).toHaveBeenCalledWith(10, '3');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, '3');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'lote 3'); // numeric alias
      expect(mocks.updateConversationState).toHaveBeenCalledWith(userId, 10, 20);
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

    it('auto-creates under single field when user has exactly 1', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([]);
      mocks.findPlotByAlias.mockResolvedValue(null);
      mocks.getFieldByName.mockResolvedValue(null);
      mocks.getUserSingleField.mockResolvedValue({ id: 10, name: 'mi campo' });
      mocks.getOrCreatePlot.mockResolvedValue({ id: 30, field_id: 10, name: 'bajo' });

      const result = await service.resolveFromNames(userId, null, 'bajo');

      expect(result).toEqual({
        fieldId: 10, fieldName: 'mi campo',
        plotId: 30, plotName: 'bajo',
        autoCreated: true,
      });
      expect(mocks.getOrCreatePlot).toHaveBeenCalledWith(10, 'bajo');
    });

    it('auto-creates under "General" when user has 0 fields', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([]);
      mocks.findPlotByAlias.mockResolvedValue(null);
      mocks.getFieldByName.mockResolvedValue(null);
      mocks.getUserSingleField.mockResolvedValue(null);
      mocks.getOrCreateField.mockResolvedValue({ id: 99, name: 'General' });
      mocks.getOrCreatePlot.mockResolvedValue({ id: 30, field_id: 99, name: 'bajo' });

      const result = await service.resolveFromNames(userId, null, 'bajo');

      expect(result).toEqual({
        fieldId: 99, fieldName: 'General',
        plotId: 30, plotName: 'bajo',
        autoCreated: true,
      });
      expect(mocks.getOrCreateField).toHaveBeenCalledWith(userId, 'General');
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
    it('creates field and updates state', async () => {
      mocks.getOrCreateField.mockResolvedValue({ id: 10, name: 'norte' });

      const result = await service.resolveFromNames(userId, 'norte', null);

      expect(result).toEqual({
        fieldId: 10, fieldName: 'norte',
        plotId: null, plotName: null,
        autoCreated: false,
      });
      expect(mocks.updateConversationState).toHaveBeenCalledWith(userId, 10, null);
    });
  });

  describe('resolveFromNames — nothing', () => {
    it('returns all nulls', async () => {
      const result = await service.resolveFromNames(userId, null, null);

      expect(result).toEqual({
        fieldId: null, fieldName: null,
        plotId: null, plotName: null,
        autoCreated: false,
      });
    });
  });

  describe('resolve — parses text', () => {
    it('parses lote + campo from text', async () => {
      mocks.getOrCreateField.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getOrCreatePlot.mockResolvedValue({ id: 20, field_id: 10, name: '3' });

      const result = await service.resolve(userId, 'pagué 50mil en lote 3 campo norte');

      expect(result.plotId).toBe(20);
      expect(result.fieldId).toBe(10);
    });

    it('uses claudeField as fallback for campo', async () => {
      mocks.getOrCreateField.mockResolvedValue({ id: 10, name: 'sur' });
      mocks.getOrCreatePlot.mockResolvedValue({ id: 20, field_id: 10, name: '3' });

      const result = await service.resolve(userId, 'pagué 50mil lote 3', 'sur');

      expect(result.fieldName).toBe('sur');
      expect(result.plotName).toBe('3');
    });
  });

  describe('alias registration', () => {
    it('registers "lote N" alias for numeric plot names', async () => {
      mocks.getOrCreateField.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getOrCreatePlot.mockResolvedValue({ id: 20, field_id: 10, name: '5' });

      await service.resolveFromNames(userId, 'norte', '5');

      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, '5');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'lote 5');
    });

    it('registers stripped alias for "lote X" names', async () => {
      mocks.getOrCreateField.mockResolvedValue({ id: 10, name: 'norte' });
      mocks.getOrCreatePlot.mockResolvedValue({ id: 20, field_id: 10, name: 'lote norte' });

      await service.resolveFromNames(userId, 'norte', 'lote norte');

      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'lote norte');
      expect(mocks.addPlotAlias).toHaveBeenCalledWith(20, 'norte');
    });
  });
});
