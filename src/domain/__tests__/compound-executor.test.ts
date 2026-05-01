import { describe, it, expect, vi } from 'vitest';
import { CompoundExecutor } from '../compound-executor.js';
import type { ParseResult, HandlerResponse, UserId, User, UserSettings, ParsedCommand } from '../../types/index.js';

// --- Helpers ---

function makeCommandResult(command: string, extra: Record<string, unknown> = {}): ParseResult {
  return {
    intent: { type: 'command', data: { command, ...extra } as ParsedCommand },
    confidence: 0.95,
    aiUsed: true,
    source: 'ai',
    missingFields: [],
  };
}

function makeExpenseResult(extra: Record<string, unknown> = {}): ParseResult {
  return {
    intent: {
      type: 'expense',
      data: { type: 'expense', amount: 1000, category: 'insumos', description: 'herbicida', currency: 'ARS', ...extra },
    },
    confidence: 0.95,
    aiUsed: true,
    source: 'ai',
    missingFields: [],
  };
}

function makeIncomeResult(extra: Record<string, unknown> = {}): ParseResult {
  return {
    intent: {
      type: 'income',
      data: { type: 'income', amount: 5000, category: 'venta_granos', description: 'soja', currency: 'ARS', ...extra },
    },
    confidence: 0.95,
    aiUsed: true,
    source: 'ai',
    missingFields: [],
  };
}

const mockUser: User = { id: 1 as UserId, phone_number: '123', name: 'Test', city: null };
const mockSettings: UserSettings = {
  weekly_summary: false, weekly_summary_day: 1, weekly_summary_hour: 8,
  budget_alerts: false, rain_alerts: false, confirm_before_save: true,
  claude_daily_limit: 20, rain_alert_mm: 10,
};

describe('CompoundExecutor', () => {
  it('executes two commands sequentially and combines messages', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['Campo "Norte" creado.'] } as HandlerResponse)
        .mockResolvedValueOnce({ messages: ['Lote "A1" creado en Norte.'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_field', { fieldName: 'Norte' }),
      makeCommandResult('add_plot', { plotName: 'A1', field: 'Norte' }),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    expect(result!.messages).toEqual(['Campo "Norte" creado.', 'Lote "A1" creado en Norte.']);
    expect(result!.stoppedAtFlow).toBe(false);
    expect(mockRouter.routeCommand).toHaveBeenCalledTimes(2);
  });

  it('skips null responses from unknown commands', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['OK 1'] } as HandlerResponse)
        .mockResolvedValueOnce(null) // unknown command
        .mockResolvedValueOnce({ messages: ['OK 3'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_field'),
      makeCommandResult('unknown_cmd'),
      makeCommandResult('log_rainfall'),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    expect(result!.messages).toEqual(['OK 1', 'OK 3']);
  });

  it('stops at startFlow sideEffect', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['Campo creado.'] } as HandlerResponse)
        .mockResolvedValueOnce({
          messages: ['Iniciando flujo...'],
          sideEffects: { startFlow: { state: 'field_flow', data: { name: 'Test' } } },
        } as HandlerResponse)
        .mockResolvedValueOnce({ messages: ['Should not execute'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_field'),
      makeCommandResult('add_field_city'),
      makeCommandResult('add_plot'),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    expect(result!.stoppedAtFlow).toBe(true);
    expect(result!.messages).toEqual(['Campo creado.', 'Iniciando flujo...']);
    expect(result!.lastSideEffects?.startFlow?.state).toBe('field_flow');
    expect(mockRouter.routeCommand).toHaveBeenCalledTimes(2);
  });

  it('returns null for single command (fall through)', async () => {
    const mockRouter = { routeCommand: vi.fn() };
    const executor = new CompoundExecutor(mockRouter as any);
    const results = [makeCommandResult('add_field')];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);
    expect(result).toBeNull();
    expect(mockRouter.routeCommand).not.toHaveBeenCalled();
  });

  it('returns null for empty results', async () => {
    const mockRouter = { routeCommand: vi.fn() };
    const executor = new CompoundExecutor(mockRouter as any);

    const result = await executor.execute([], 1 as UserId, mockUser, mockSettings);
    expect(result).toBeNull();
  });

  it('rolls back compound when any step throws and shows user-friendly message', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['OK 1'] } as HandlerResponse)
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({ messages: ['OK 3'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_field'),
      makeCommandResult('set_field_city'),
      makeCommandResult('add_plot'),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0]).toMatch(/No pude registrar todas las acciones/);
    // Step 3 is never reached — execution aborted at step 2
    expect(mockRouter.routeCommand).toHaveBeenCalledTimes(2);
    expect(result!.stoppedAtFlow).toBe(false);
    expect(result!.lastSideEffects).toBeUndefined();
    expect(result!.lastInteractive).toBeUndefined();
  });

  it('tracks last sideEffects from non-flow steps', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['Campo creado.'] } as HandlerResponse)
        .mockResolvedValueOnce({
          messages: ['Lote creado.'],
          sideEffects: { setPendingPlotArea: { plotId: 5, plotName: 'A1', fieldName: 'Norte' } },
        } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_field'),
      makeCommandResult('add_plot'),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    expect(result!.lastSideEffects?.setPendingPlotArea).toEqual({
      plotId: 5, plotName: 'A1', fieldName: 'Norte',
    });
  });

  it('preserves last interactive and suggestionKey', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({
          messages: ['Step 1'],
          interactive: { type: 'buttons', body: 'Choose', buttons: [{ id: 'a', title: 'A' }] },
        } as HandlerResponse)
        .mockResolvedValueOnce({
          messages: ['Step 2'],
          suggestionKey: 'after_add_plot',
        } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_field'),
      makeCommandResult('add_plot'),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result!.lastSuggestionKey).toBe('after_add_plot');
    expect(result!.lastInteractive?.type).toBe('buttons');
  });

  it('handles command + expense compound (activity + cost)', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['🌱 soja sembrada en A1'] } as HandlerResponse),
    };
    const mockFinancial = {
      handleExpense: vi.fn()
        .mockResolvedValueOnce({ messages: ['💰 Gasto registrado: $100,000 (Semillas)'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any, mockFinancial as any);
    const results = [
      makeCommandResult('sow_crop', { crop: 'soja', plot: 'A1' }),
      makeExpenseResult({ field: 'Norte', plot: 'A1' }),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    expect(result!.messages).toEqual([
      '🌱 soja sembrada en A1',
      '💰 Gasto registrado: $100,000 (Semillas)',
    ]);
    expect(mockRouter.routeCommand).toHaveBeenCalledTimes(1);
    expect(mockFinancial.handleExpense).toHaveBeenCalledTimes(1);
    // confirm_before_save should be forced to false in compound context
    const passedSettings = mockFinancial.handleExpense.mock.calls[0][3];
    expect(passedSettings.confirm_before_save).toBe(false);
  });

  it('handles command + income compound', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['🌾 cosecha registrada'] } as HandlerResponse),
    };
    const mockFinancial = {
      handleIncome: vi.fn()
        .mockResolvedValueOnce({ messages: ['💵 Ingreso registrado: $500,000'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any, mockFinancial as any);
    const results = [
      makeCommandResult('harvest_crop', { crop: 'soja' }),
      makeIncomeResult({ field: 'Norte' }),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(mockFinancial.handleIncome).toHaveBeenCalledTimes(1);
    const passedSettings = mockFinancial.handleIncome.mock.calls[0][3];
    expect(passedSettings.confirm_before_save).toBe(false);
  });

  it('consolidates livestock compound into single message', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({
          messages: ['🐄 *Hacienda actualizada*\n\n  Vaca (nuevo grupo)\n  ➕ 141 animales\n  📊 Total en lote: *141*\n  📍 schiavi (Don Aurelio)'],
        } as HandlerResponse)
        .mockResolvedValueOnce({
          messages: ['🐄 *Hacienda actualizada*\n\n  Ternero (nuevo grupo)\n  ➕ 141 animales\n  📊 Total en lote: *141*\n  📍 schiavi (Don Aurelio)'],
        } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_livestock', { category: 'vaca', count: 141, plotName: 'schiavi', fieldName: 'Don Aurelio' }),
      makeCommandResult('add_livestock', { category: 'ternero', count: 141, plotName: 'schiavi', fieldName: 'Don Aurelio' }),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    // Should be consolidated into a single message
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0]).toContain('141 Vaca');
    expect(result!.messages[0]).toContain('141 Ternero');
    expect(result!.messages[0]).toContain('schiavi');
  });

  it('does not consolidate livestock on different plots', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['🐄 vacas en A1'] } as HandlerResponse)
        .mockResolvedValueOnce({ messages: ['🐄 terneros en B2'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_livestock', { category: 'vaca', count: 10, plotName: 'A1', fieldName: 'Norte' }),
      makeCommandResult('add_livestock', { category: 'ternero', count: 10, plotName: 'B2', fieldName: 'Norte' }),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    // Different plots → no consolidation
    expect(result!.messages).toHaveLength(2);
  });

  it('does not consolidate mixed livestock + non-livestock compound', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['🐄 vacas cargadas'] } as HandlerResponse),
    };
    const mockFinancial = {
      handleExpense: vi.fn()
        .mockResolvedValueOnce({ messages: ['💰 Gasto registrado'] } as HandlerResponse),
    };

    const executor = new CompoundExecutor(mockRouter as any, mockFinancial as any);
    const results = [
      makeCommandResult('add_livestock', { category: 'vaca', count: 10, plotName: 'A1' }),
      makeExpenseResult(),
    ];

    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);

    expect(result).not.toBeNull();
    // Mixed types → no consolidation
    expect(result!.messages).toHaveLength(2);
  });

  it('falls back without financialHandler — only commands execute', async () => {
    const mockRouter = {
      routeCommand: vi.fn()
        .mockResolvedValueOnce({ messages: ['Campo creado.'] } as HandlerResponse),
    };

    // No financialHandler passed
    const executor = new CompoundExecutor(mockRouter as any);
    const results = [
      makeCommandResult('add_field'),
      makeExpenseResult(),
    ];

    // command + expense = 2 actionable, but expense can't execute without handler → only 1 message
    const result = await executor.execute(results, 1 as UserId, mockUser, mockSettings);
    expect(result).not.toBeNull();
    expect(result!.messages).toEqual(['Campo creado.']);
  });
});
