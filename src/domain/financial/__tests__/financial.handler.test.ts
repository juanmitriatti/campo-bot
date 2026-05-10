import { describe, it, expect, vi } from 'vitest';
import { FinancialHandler } from '../financial.handler.js';
import type { ParsedExpense, ParsedIncome, UserSettings, User, UserId } from '../../../types/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockService(overrides: Record<string, any> = {}) {
  return {
    resolveField: vi.fn().mockResolvedValue({ fieldId: 1, fieldName: 'Campo Test', plotId: 1, plotName: 'Lote 1' }),
    saveExpense: vi.fn().mockResolvedValue({ id: 1 }),
    saveIncome: vi.fn().mockResolvedValue({ id: 1 }),
    checkBudgetAlert: vi.fn().mockResolvedValue(null),
    getMonthlyReport: vi.fn().mockResolvedValue([]),
    getWeeklyReport: vi.fn().mockResolvedValue([]),
    getMonthlyResult: vi.fn().mockResolvedValue({ ingresos: 0, gastos: 0 }),
    getMonthlyResultByCurrency: vi.fn().mockResolvedValue({ ARS: { ingresos: 0, gastos: 0 } }),
    getMonthlyReportByPlot: vi.fn().mockResolvedValue([]),
    getFieldResult: vi.fn().mockResolvedValue({ ingresos: 0, gastos: 0 }),
    deleteLastExpense: vi.fn().mockResolvedValue(null),
    deleteLastIncome: vi.fn().mockResolvedValue(null),
    deleteSpecificExpense: vi.fn().mockResolvedValue(null),
    editSpecificExpense: vi.fn().mockResolvedValue(null),
    editLastExpense: vi.fn().mockResolvedValue(null),
    setBudget: vi.fn(),
    getMonthlyReportForMonth: vi.fn().mockResolvedValue([]),
    getDateRangeReport: vi.fn().mockResolvedValue([]),
    getFieldReport: vi.fn().mockResolvedValue([]),
    getMonthlyExpenses: vi.fn().mockResolvedValue([]),
    getMonthlyIncomeForMonth: vi.fn().mockResolvedValue([]),
    getUserFields: vi.fn().mockResolvedValue([{ name: 'Campo Test', city: null }]),
    getOrCreateField: vi.fn().mockResolvedValue({ id: 1, name: 'test' }),
    setFieldCity: vi.fn(),
    deleteField: vi.fn().mockResolvedValue(false),
    renameField: vi.fn().mockResolvedValue(false),
    renamePlot: vi.fn().mockResolvedValue(null),
    restorePlot: vi.fn().mockResolvedValue(null),
    getFieldInfo: vi.fn().mockResolvedValue(null),
    getPlotsByField: vi.fn().mockResolvedValue([]),
    findAllUserPlots: vi.fn().mockResolvedValue([{ id: 1, name: 'Lote 1', field_name: 'Campo Test', field_id: 1 }]),
    getMonthlyReportByPlot: vi.fn().mockResolvedValue([]),
    findPlotByNameAcrossFields: vi.fn().mockResolvedValue([]),
    getRecentFinancialContext: vi.fn().mockResolvedValue(null),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const defaultSettings = {
  confirm_before_save: false,
  budget_alerts: false,
} as UserSettings;

const defaultUser = { id: 1 as UserId, name: 'Juan', phone_number: '123', city: null } as User;
const userId = 1 as UserId;

const sampleExpense: ParsedExpense = {
  type: 'expense',
  amount: 50000,
  category: 'Combustible',
  description: 'gasoil',
  currency: 'ARS',
};

const sampleIncome: ParsedIncome = {
  type: 'income',
  amount: 2000000,
  category: 'Soja',
  description: 'venta soja',
  currency: 'ARS',
  quantity: 30,
  unit: 'tn',
  unit_price: null,
};

describe('FinancialHandler.handleExpense', () => {
  it('saves and returns confirmation message', async () => {
    const service = mockService();
    const handler = new FinancialHandler(service);

    const response = await handler.handleExpense(userId, sampleExpense, 'pagué 50mil en gasoil', defaultSettings, defaultUser);

    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]).toMatch(/Listo|Anotado|guardado|Registrado/);
    expect(response.messages[0]).toContain('Combustible');
    expect(response.sideEffects?.setPending).toBeUndefined();
    expect(service.saveExpense).toHaveBeenCalledOnce();
  });

  it('returns setPending with interactive buttons when confirm_before_save is true', async () => {
    const service = mockService();
    const handler = new FinancialHandler(service);

    const response = await handler.handleExpense(
      userId, sampleExpense, 'pagué 50mil en gasoil',
      { ...defaultSettings, confirm_before_save: true },
      defaultUser,
    );

    expect(response.sideEffects?.setPending).toBeDefined();
    expect(response.sideEffects!.setPending!.type).toBe('expense');
    expect(response.messages).toEqual([]);
    expect(response.interactive).toBeDefined();
    expect(response.interactive!.body).toContain('Confirmo');
    expect(response.interactive!.buttons).toEqual([
      { id: 'confirm_pending', title: 'Confirmar' },
      { id: 'cancel_pending', title: 'Cancelar' },
    ]);
    expect(service.saveExpense).not.toHaveBeenCalled();
  });

  it('includes budget alert when enabled and triggered', async () => {
    const service = mockService({
      checkBudgetAlert: vi.fn().mockResolvedValue('⚠️ Combustible al 90% del presupuesto'),
    });
    const handler = new FinancialHandler(service);

    const response = await handler.handleExpense(
      userId, sampleExpense, 'pagué 50mil en gasoil',
      { ...defaultSettings, budget_alerts: true },
      defaultUser,
    );

    expect(response.messages).toHaveLength(2);
    expect(response.messages[0]).toMatch(/Listo|Anotado|guardado|Registrado/);
    expect(response.messages[1]).toContain('90%');
  });

  it('does not include budget alert when no budget set', async () => {
    const service = mockService();
    const handler = new FinancialHandler(service);

    const response = await handler.handleExpense(
      userId, sampleExpense, 'pagué 50mil en gasoil',
      { ...defaultSettings, budget_alerts: true },
      defaultUser,
    );

    expect(response.messages).toHaveLength(1);
  });
});

describe('FinancialHandler.handleIncome', () => {
  it('saves and returns confirmation', async () => {
    const service = mockService();
    const handler = new FinancialHandler(service);

    const response = await handler.handleIncome(userId, sampleIncome, 'vendí soja', defaultSettings);

    expect(response.messages[0]).toMatch(/Listo|Anotado|guardado|Registrado/);
    expect(response.messages[0]).toContain('Soja');
    expect(service.saveIncome).toHaveBeenCalledOnce();
  });

  it('returns setPending when confirm_before_save', async () => {
    const service = mockService();
    const handler = new FinancialHandler(service);

    const response = await handler.handleIncome(
      userId, sampleIncome, 'vendí soja',
      { ...defaultSettings, confirm_before_save: true },
    );

    expect(response.sideEffects?.setPending).toBeDefined();
    expect(response.sideEffects!.setPending!.type).toBe('income');
  });
});

describe('FinancialHandler.handleConfirm', () => {
  it('confirms expense and returns message', async () => {
    const service = mockService();
    const handler = new FinancialHandler(service);

    const response = await handler.handleConfirm(userId, {
      type: 'expense', data: sampleExpense, fieldId: null, fieldName: null, timestamp: Date.now(),
    }, defaultSettings, defaultUser);

    expect(response.messages[0]).toMatch(/Listo|Anotado|guardado|Registrado/);
    expect(service.saveExpense).toHaveBeenCalledOnce();
  });

  it('confirms income and returns message', async () => {
    const service = mockService();
    const handler = new FinancialHandler(service);

    const response = await handler.handleConfirm(userId, {
      type: 'income', data: sampleIncome, fieldId: null, fieldName: null, timestamp: Date.now(),
    }, defaultSettings, defaultUser);

    expect(response.messages[0]).toMatch(/Listo|Anotado|guardado|Registrado/);
    expect(service.saveIncome).toHaveBeenCalledOnce();
  });
});

describe('FinancialHandler.handleCommand', () => {
  it('monthly_report returns no data message', async () => {
    const handler = new FinancialHandler(mockService());
    const response = await handler.handleCommand({ command: 'monthly_report' }, userId, defaultUser, defaultSettings);
    expect(response.messages[0]).toContain('No hay movimientos');
  });

  it('monthly_report returns formatted report', async () => {
    const service = mockService({
      getMonthlyReport: vi.fn().mockResolvedValue([
        { category: 'Combustible', total: 50000 },
        { category: 'Semillas', total: 30000 },
      ]),
    });
    const handler = new FinancialHandler(service);
    const response = await handler.handleCommand({ command: 'monthly_report' }, userId, defaultUser, defaultSettings);
    expect(response.messages[0]).toContain('Movimientos del mes');
    expect(response.messages[0]).toContain('Combustible');
    expect(response.messages[0]).toContain('Semillas');
  });

  it('delete_last with nothing to delete', async () => {
    const handler = new FinancialHandler(mockService());
    const response = await handler.handleCommand({ command: 'delete_last' }, userId, defaultUser, defaultSettings);
    expect(response.messages[0]).toContain('No hay gastos para borrar');
  });

  it('delete_last with expense found', async () => {
    const service = mockService({
      deleteLastExpense: vi.fn().mockResolvedValue({ category: 'Combustible', amount: 50000 }),
    });
    const handler = new FinancialHandler(service);
    const response = await handler.handleCommand({ command: 'delete_last' }, userId, defaultUser, defaultSettings);
    expect(response.messages[0]).toContain('Gasto eliminado');
    expect(response.messages[0]).toContain('Combustible');
  });

  it('set_budget returns confirmation', async () => {
    const handler = new FinancialHandler(mockService());
    const response = await handler.handleCommand(
      { command: 'set_budget', category: 'Combustible', amount: 500000 },
      userId, defaultUser, defaultSettings,
    );
    expect(response.messages[0]).toContain('Presupuesto configurado');
    expect(response.messages[0]).toContain('Combustible');
  });

  it('export_csv with no data', async () => {
    const handler = new FinancialHandler(mockService());
    const response = await handler.handleCommand({ command: 'export_csv' }, userId, defaultUser, defaultSettings);
    expect(response.messages[0]).toContain('No hay gastos');
    expect(response.attachment).toBeUndefined();
  });

  it('list_fields with no fields', async () => {
    const handler = new FinancialHandler(mockService({ getUserFields: vi.fn().mockResolvedValue([]) }));
    const response = await handler.handleCommand({ command: 'list_fields' }, userId, defaultUser, defaultSettings);
    expect(response.messages[0]).toContain('No ten');
  });

  it('default returns empty messages', async () => {
    const handler = new FinancialHandler(mockService());
    const response = await handler.handleCommand({ command: 'nonexistent_command' }, userId, defaultUser, defaultSettings);
    expect(response.messages).toEqual([]);
  });
});

describe('FinancialHandler — conversational memory (P2)', () => {
  const twoPlots = [
    { id: 1, name: 'Lote 1', field_name: 'Norte', field_id: 1 },
    { id: 2, name: 'Lote 2', field_name: 'Norte', field_id: 1 },
  ];

  it('uses recent financial context when no field/plot resolved', async () => {
    const service = mockService({
      resolveField: vi.fn().mockResolvedValue({ fieldId: null, fieldName: null }),
      findAllUserPlots: vi.fn().mockResolvedValue(twoPlots),
      getRecentFinancialContext: vi.fn().mockResolvedValue({
        fieldId: 10, fieldName: 'Norte', plotId: 20, plotName: '1A',
      }),
    });
    const handler = new FinancialHandler(service);

    const response = await handler.handleExpense(userId, sampleExpense, 'y 30mil en semillas', defaultSettings, defaultUser);

    expect(response.messages[0]).toMatch(/Listo|Anotado|guardado|Registrado/);
    expect(service.saveExpense).toHaveBeenCalledWith(userId, sampleExpense, 10, 20);
  });

  it('does NOT use context when field already resolved', async () => {
    const service = mockService({
      resolveField: vi.fn().mockResolvedValue({ fieldId: 5, fieldName: 'Sur', plotId: 15, plotName: '2B' }),
      getRecentFinancialContext: vi.fn().mockResolvedValue({
        fieldId: 10, fieldName: 'Norte', plotId: 20, plotName: '1A',
      }),
    });
    const handler = new FinancialHandler(service);

    const response = await handler.handleExpense(userId, sampleExpense, 'gasté 50mil en gasoil en lote 2B', defaultSettings, defaultUser);

    expect(service.saveExpense).toHaveBeenCalledWith(userId, sampleExpense, 5, 15);
    expect(service.getRecentFinancialContext).not.toHaveBeenCalled();
  });

  it('uses recent context for income too', async () => {
    const service = mockService({
      resolveField: vi.fn().mockResolvedValue({ fieldId: null, fieldName: null }),
      findAllUserPlots: vi.fn().mockResolvedValue(twoPlots),
      getRecentFinancialContext: vi.fn().mockResolvedValue({
        fieldId: 10, fieldName: 'Norte', plotId: 20, plotName: '1A',
      }),
    });
    const handler = new FinancialHandler(service);

    const response = await handler.handleIncome(userId, sampleIncome, 'y vendí 10tn de trigo', defaultSettings);

    expect(service.saveIncome).toHaveBeenCalledWith(userId, sampleIncome, 10, 20);
  });
});
