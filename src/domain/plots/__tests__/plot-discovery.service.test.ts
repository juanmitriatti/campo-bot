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

  describe('resolveFromNames — article-prefixed plot names (regression Jun 2026)', () => {
    it('resolves a plot whose real name starts with an article ("El Bajo") via direct match', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'El Ombú' });
      // getPlotByName matches "El Bajo" on the FIRST (un-stripped) call
      mocks.getPlotByName.mockResolvedValue({ id: 30, field_id: 10, name: 'El Bajo' });

      const result = await service.resolveFromNames(userId, 'El Ombú', 'El Bajo');

      expect(result.plotId).toBe(30);
      expect(result.notFound).toBeUndefined();
      // The un-stripped name was tried first
      expect(mocks.getPlotByName).toHaveBeenCalledWith(10, 'El Bajo');
    });

    it('still resolves "el norte" → "Lote Norte" by stripping the article as a FALLBACK', async () => {
      mocks.getFieldByName.mockResolvedValue({ id: 10, name: 'El Ombú' });
      // Un-stripped "el norte" misses; stripped "norte" hits (repo "Lote X" convention)
      mocks.getPlotByName.mockImplementation(async (_fieldId: number, name: string) =>
        name === 'norte' ? { id: 40, field_id: 10, name: 'Lote Norte' } : null,
      );

      const result = await service.resolveFromNames(userId, 'El Ombú', 'el norte');

      expect(result.plotId).toBe(40);
      expect(mocks.getPlotByName).toHaveBeenCalledWith(10, 'el norte'); // tried original
      expect(mocks.getPlotByName).toHaveBeenCalledWith(10, 'norte');    // then stripped
    });

    it('plot-only: resolves "La Loma" directly without stripping it to "Loma"', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([
        { id: 50, field_id: 10, name: 'La Loma', field_name: 'El Ombú' },
      ]);

      const result = await service.resolveFromNames(userId, null, 'La Loma');

      expect(result.plotId).toBe(50);
      expect(mocks.findPlotByNameAcrossFields).toHaveBeenCalledWith(userId, 'La Loma');
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

    it('returns needPlotSelection when same plot name exists in multiple campos', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([
        { id: 20, field_id: 10, name: '2Z', field_name: 'Norte' },
        { id: 30, field_id: 11, name: '2Z', field_name: 'Sur' },
      ]);
      mocks.getConversationState.mockResolvedValue(null);

      const result = await service.resolveFromNames(userId, null, '2Z');

      expect(result.fieldId).toBeNull();
      expect(result.plotId).toBeNull();
      expect(result.needPlotSelection).toEqual({
        fieldId: null, fieldName: null,
        plots: [
          { id: 20, name: '2Z (Norte)' },
          { id: 30, name: '2Z (Sur)' },
        ],
      });
    });

    it('nombre ambiguo SIEMPRE pregunta, aunque el contexto matchee un campo', async () => {
      // Decisión de producto (Ago 2026): cuando el usuario nombra un lote
      // ambiguo (2 "Norte" en campos distintos) SIN decir el campo, preguntamos
      // cuál — nunca heredamos el campo del contexto en silencio (agarraba el
      // que no era y ofrecía pisar el cultivo del otro). Invariante 5.
      mocks.findPlotByNameAcrossFields.mockResolvedValue([
        { id: 20, field_id: 10, name: '2Z', field_name: 'Norte' },
        { id: 30, field_id: 11, name: '2Z', field_name: 'Sur' },
      ]);
      mocks.getConversationState.mockResolvedValue({ last_field_id: 11 });

      const result = await service.resolveFromNames(userId, null, '2Z');

      expect(result.plotId).toBeNull();
      expect(result.needPlotSelection).toEqual({
        fieldId: null, fieldName: null,
        plots: [
          { id: 20, name: '2Z (Norte)' },
          { id: 30, name: '2Z (Sur)' },
        ],
      });
      expect(mocks.updateConversationState).not.toHaveBeenCalled();
    });

    it('returns needPlotSelection when conversation state does not match any campo', async () => {
      mocks.findPlotByNameAcrossFields.mockResolvedValue([
        { id: 20, field_id: 10, name: '2Z', field_name: 'Norte' },
        { id: 30, field_id: 11, name: '2Z', field_name: 'Sur' },
      ]);
      mocks.getConversationState.mockResolvedValue({ last_field_id: 99 });

      const result = await service.resolveFromNames(userId, null, '2Z');

      expect(result.needPlotSelection).toBeDefined();
      expect(result.needPlotSelection!.plots).toHaveLength(2);
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
