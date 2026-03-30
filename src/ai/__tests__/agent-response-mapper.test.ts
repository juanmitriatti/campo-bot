import { describe, it, expect } from 'vitest';
import { AgentResponseMapper } from '../agent-response-mapper.js';
import type { AgentResult } from '../agent.service.js';

describe('AgentResponseMapper', () => {
  const mapper = new AgentResponseMapper();

  const makeResult = (toolCalls: AgentResult['toolCalls'], text: string | null = null): AgentResult => ({
    toolCalls,
    conversationalText: text,
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  describe('expense mapping', () => {
    it('maps log_expense tool call to expense ParseResult', () => {
      const result = makeResult([{
        toolName: 'log_expense',
        toolInput: { amount: 50000, category: 'Combustible', description: 'gasoil', currency: 'ARS' },
        toolUseId: 'test_1',
      }]);

      const parsed = mapper.mapToParseResults(result, 'gasté 50mil en gasoil');
      expect(parsed).toHaveLength(1);
      expect(parsed[0].intent.type).toBe('expense');
      if (parsed[0].intent.type === 'expense') {
        expect(parsed[0].intent.data.amount).toBe(50000);
        expect(parsed[0].intent.data.category).toBe('Combustible');
        expect(parsed[0].intent.data.currency).toBe('ARS');
        expect(parsed[0].intent.data.description).toBe('gasoil');
      }
      expect(parsed[0].confidence).toBe(0.95);
      expect(parsed[0].aiUsed).toBe(true);
      expect(parsed[0].source).toBe('ai');
    });

    it('maps expense with USD currency', () => {
      const result = makeResult([{
        toolName: 'log_expense',
        toolInput: { amount: 200, category: 'Agroquímicos', description: 'roundup', currency: 'USD' },
        toolUseId: 'test_2',
      }]);

      const parsed = mapper.mapToParseResults(result, 'compré roundup 200 usd');
      expect(parsed[0].intent.type).toBe('expense');
      if (parsed[0].intent.type === 'expense') {
        expect(parsed[0].intent.data.currency).toBe('USD');
      }
    });

    it('maps expense with field and plot', () => {
      const result = makeResult([{
        toolName: 'log_expense',
        toolInput: { amount: 30000, category: 'Combustible', description: 'gasoil', field: 'Norte', plot: 'A1' },
        toolUseId: 'test_3',
      }]);

      const parsed = mapper.mapToParseResults(result, 'gasté 30mil gasoil lote A1');
      const data = parsed[0].intent.data as any;
      expect(data.field).toBe('Norte');
      expect(data.plot).toBe('A1');
    });

    it('maps expense without amount as expense_partial', () => {
      const result = makeResult([{
        toolName: 'log_expense',
        toolInput: { category: 'Combustible', description: 'gasoil' },
        toolUseId: 'test_4',
      }]);

      const parsed = mapper.mapToParseResults(result, 'compré gasoil');
      expect(parsed[0].intent.type).toBe('expense_partial');
      expect(parsed[0].missingFields).toContain('amount');
    });

    it('defaults unknown category to Otros', () => {
      const result = makeResult([{
        toolName: 'log_expense',
        toolInput: { amount: 1000, category: 'Almuerzo', description: 'almuerzo' },
        toolUseId: 'test_5',
      }]);

      const parsed = mapper.mapToParseResults(result, 'almuerzo');
      if (parsed[0].intent.type === 'expense') {
        expect(parsed[0].intent.data.category).toBe('Otros');
      }
    });
  });

  describe('income mapping', () => {
    it('maps log_income tool call to income ParseResult', () => {
      const result = makeResult([{
        toolName: 'log_income',
        toolInput: { amount: 900000, category: 'Soja', description: 'venta soja', currency: 'USD', quantity: 30, unit: 'tn', unit_price: 300 },
        toolUseId: 'test_6',
      }]);

      const parsed = mapper.mapToParseResults(result, 'vendí 30 tn soja a 300 usd');
      expect(parsed[0].intent.type).toBe('income');
      if (parsed[0].intent.type === 'income') {
        expect(parsed[0].intent.data.amount).toBe(900000);
        expect(parsed[0].intent.data.category).toBe('Soja');
        expect(parsed[0].intent.data.quantity).toBe(30);
        expect(parsed[0].intent.data.unit).toBe('tn');
        expect(parsed[0].intent.data.unit_price).toBe(300);
      }
    });

    it('maps income without amount as income_partial', () => {
      const result = makeResult([{
        toolName: 'log_income',
        toolInput: { category: 'Soja', description: 'soja' },
        toolUseId: 'test_7',
      }]);

      const parsed = mapper.mapToParseResults(result, 'vendí soja');
      expect(parsed[0].intent.type).toBe('income_partial');
    });
  });

  describe('command mapping', () => {
    it('maps log_spraying to command with product fields', () => {
      const result = makeResult([{
        toolName: 'log_spraying',
        toolInput: { product: 'glifosato', product_type: 'herbicida', quantity: 3, unit: 'lt/ha', plot: 'A1' },
        toolUseId: 'test_8',
      }]);

      const parsed = mapper.mapToParseResults(result, 'fumigué lote A1 con glifosato 3lt/ha');
      expect(parsed[0].intent.type).toBe('command');
      if (parsed[0].intent.type === 'command') {
        expect(parsed[0].intent.data.command).toBe('log_spraying');
        expect(parsed[0].intent.data.product).toBe('glifosato');
        expect(parsed[0].intent.data.productType).toBe('herbicida');
        expect(parsed[0].intent.data.plotName).toBe('A1');
      }
    });

    it('maps log_rainfall with quantity to mm', () => {
      const result = makeResult([{
        toolName: 'log_rainfall',
        toolInput: { quantity: 25, field: 'Norte' },
        toolUseId: 'test_9',
      }]);

      const parsed = mapper.mapToParseResults(result, 'llovieron 25mm');
      if (parsed[0].intent.type === 'command') {
        expect(parsed[0].intent.data.command).toBe('log_rainfall');
        expect(parsed[0].intent.data.mm).toBe(25);
        expect(parsed[0].intent.data.fieldName).toBe('Norte');
      }
    });

    it('maps query_plot_history with filter', () => {
      const result = makeResult([{
        toolName: 'query_plot_history',
        toolInput: { plot: 'A1', activityFilter: 'log_spraying', timeRef: 'últimos 30 días' },
        toolUseId: 'test_10',
      }]);

      const parsed = mapper.mapToParseResults(result, 'cuándo se fumigó el lote A1');
      if (parsed[0].intent.type === 'command') {
        expect(parsed[0].intent.data.command).toBe('query_plot_history');
        expect(parsed[0].intent.data.plotName).toBe('A1');
        expect(parsed[0].intent.data.activityFilter).toBe('log_spraying');
      }
    });

    it('maps add_plot with plotName and hectares', () => {
      const result = makeResult([{
        toolName: 'add_plot',
        toolInput: { plotName: 'B1', field: 'Norte', hectares: 50 },
        toolUseId: 'test_11',
      }]);

      const parsed = mapper.mapToParseResults(result, 'agregar lote B1 de 50ha en campo Norte');
      if (parsed[0].intent.type === 'command') {
        expect(parsed[0].intent.data.command).toBe('add_plot');
        expect(parsed[0].intent.data.plotName).toBe('B1');
        expect(parsed[0].intent.data.fieldName).toBe('Norte');
        expect(parsed[0].intent.data.hectares).toBe(50);
      }
    });

    it('maps financial_report with all params', () => {
      const result = makeResult([{
        toolName: 'financial_report',
        toolInput: { field: 'Norte', plot: 'A1', period: 'month', category: 'Combustible', type: 'expenses', include_activities: true, activity_filter: 'spraying' },
        toolUseId: 'test_fr',
      }]);

      const parsed = mapper.mapToParseResults(result, 'gastos en combustible del lote A1');
      expect(parsed[0].intent.type).toBe('command');
      if (parsed[0].intent.type === 'command') {
        expect(parsed[0].intent.data.command).toBe('financial_report');
        expect(parsed[0].intent.data.fieldName).toBe('Norte');
        expect(parsed[0].intent.data.plotName).toBe('A1');
        expect(parsed[0].intent.data.period).toBe('month');
        expect(parsed[0].intent.data.category).toBe('Combustible');
        expect(parsed[0].intent.data.reportType).toBe('expenses');
        expect(parsed[0].intent.data.include_activities).toBe(true);
        expect(parsed[0].intent.data.activity_filter).toBe('spraying');
      }
    });

    it('maps add_plots_batch with plotNames array', () => {
      const result = makeResult([{
        toolName: 'add_plots_batch',
        toolInput: { plotNames: ['A1', 'A2', 'A3'], field: 'Norte' },
        toolUseId: 'test_12',
      }]);

      const parsed = mapper.mapToParseResults(result, 'agregar lotes A1, A2, A3 en campo Norte');
      if (parsed[0].intent.type === 'command') {
        expect(parsed[0].intent.data.plotNames).toEqual(['A1', 'A2', 'A3']);
      }
    });
  });

  describe('conversational response', () => {
    it('maps no-tool response with text to unknown + _conversationalResponse', () => {
      const result = makeResult([], '¡Hola! Soy MIA, tu asistente agrícola.');

      const parsed = mapper.mapToParseResults(result, 'hola');
      expect(parsed).toHaveLength(1);
      expect(parsed[0].intent.type).toBe('unknown');
      expect((parsed[0] as any)._conversationalResponse).toBe('¡Hola! Soy MIA, tu asistente agrícola.');
      expect(parsed[0].confidence).toBe(0.90);
    });

    it('returns empty array when no tools and no text', () => {
      const result = makeResult([], null);
      const parsed = mapper.mapToParseResults(result, 'test');
      expect(parsed).toHaveLength(0);
    });
  });

  describe('multiple tool calls', () => {
    it('maps multiple tool calls to multiple ParseResults', () => {
      const result = makeResult([
        { toolName: 'add_plot', toolInput: { plotName: 'Testing', field: 'Norte' }, toolUseId: 'tc_1' },
        { toolName: 'log_rainfall', toolInput: { quantity: 25, field: 'Norte' }, toolUseId: 'tc_2' },
      ]);

      const parsed = mapper.mapToParseResults(result, 'crear lote testing y registrar 25mm lluvia');
      expect(parsed).toHaveLength(2);
      expect(parsed[0].intent.type).toBe('command');
      expect(parsed[1].intent.type).toBe('command');
      if (parsed[0].intent.type === 'command' && parsed[1].intent.type === 'command') {
        expect(parsed[0].intent.data.command).toBe('add_plot');
        expect(parsed[1].intent.data.command).toBe('log_rainfall');
      }
    });
  });
});
