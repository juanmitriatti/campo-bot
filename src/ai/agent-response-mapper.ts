import type { ParseResult, ParsedExpense, ParsedIncome, ParsedCommand, Currency } from '../types/index.js';
import { EXPENSE_CATEGORY_SET, INCOME_CATEGORY_SET } from '../constants/agro-terms.js';
import type { AgentResult } from './agent.service.js';

/**
 * Converts AgentResult (tool_use output) → ParseResult[] for backward compatibility
 * with the existing DomainRouter / handlers pipeline.
 */
export class AgentResponseMapper {
  /**
   * Map agent result to ParseResult array.
   * - Each tool call becomes one ParseResult.
   * - If no tool calls and there's conversational text, returns a single 'unknown' ParseResult
   *   with _conversationalResponse attached.
   */
  mapToParseResults(result: AgentResult, originalText: string): ParseResult[] {
    if (result.toolCalls.length === 0) {
      if (result.conversationalText) {
        return [{
          intent: { type: 'unknown', raw: originalText },
          confidence: 0.90,
          aiUsed: true,
          source: 'ai',
          missingFields: [],
          _conversationalResponse: result.conversationalText,
        } as ParseResult & { _conversationalResponse: string }];
      }
      return [];
    }

    return result.toolCalls.map(tc => this.mapToolCall(tc, originalText));
  }

  private mapToolCall(
    toolCall: AgentResult['toolCalls'][0],
    originalText: string,
  ): ParseResult {
    const { toolName, toolInput } = toolCall;
    const input = toolInput as Record<string, unknown>;

    if (toolName === 'log_expense') {
      return this.mapExpense(input, originalText);
    }

    if (toolName === 'log_income') {
      return this.mapIncome(input, originalText);
    }

    // respond_text → conversational response (same as no-tool text)
    if (toolName === 'respond_text') {
      const text = typeof input.text === 'string' ? input.text : '';
      return {
        intent: { type: 'unknown', raw: originalText },
        confidence: 0.90,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
        _conversationalResponse: text,
      } as ParseResult & { _conversationalResponse: string };
    }

    // Everything else → command
    return this.mapCommand(toolName, input);
  }

  private mapExpense(input: Record<string, unknown>, originalText: string): ParseResult {
    const amount = typeof input.amount === 'number' ? input.amount : 0;

    if (amount > 0) {
      const rawCategory = typeof input.category === 'string' ? input.category : '';
      const category = EXPENSE_CATEGORY_SET.has(rawCategory) ? rawCategory : 'Otros';
      const currency: Currency = input.currency === 'USD' ? 'USD' : 'ARS';
      const data: ParsedExpense & { field?: string; plot?: string } = {
        type: 'expense',
        amount,
        category,
        description: typeof input.description === 'string' ? input.description : originalText,
        currency,
      };
      if (typeof input.field === 'string') data.field = input.field;
      if (typeof input.plot === 'string') data.plot = input.plot;

      return {
        intent: { type: 'expense', data },
        confidence: 0.95,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
      };
    }

    // Partial expense — no amount
    const missingFields: string[] = [];
    if (!input.amount) missingFields.push('amount');
    if (!input.category) missingFields.push('category');

    return {
      intent: {
        type: 'expense_partial',
        data: {
          type: 'expense',
          ...(amount > 0 ? { amount } : {}),
          ...(input.category ? { category: input.category as string } : {}),
          ...(input.currency === 'USD' ? { currency: 'USD' as Currency } : { currency: 'ARS' as Currency }),
        },
      },
      confidence: 0.60,
      aiUsed: true,
      source: 'ai',
      missingFields,
    };
  }

  private mapIncome(input: Record<string, unknown>, originalText: string): ParseResult {
    const amount = typeof input.amount === 'number' ? input.amount : 0;

    if (amount > 0) {
      const rawCategory = typeof input.category === 'string' ? input.category : '';
      const category = INCOME_CATEGORY_SET.has(rawCategory) ? rawCategory : 'Otros';
      const currency: Currency = input.currency === 'USD' ? 'USD' : 'ARS';
      const data: ParsedIncome & { field?: string; plot?: string } = {
        type: 'income',
        amount,
        category,
        description: typeof input.description === 'string' ? input.description : originalText,
        currency,
        quantity: typeof input.quantity === 'number' ? input.quantity : null,
        unit: typeof input.unit === 'string' ? input.unit : null,
        unit_price: typeof input.unit_price === 'number' ? input.unit_price : null,
      };
      if (typeof input.field === 'string') data.field = input.field;
      if (typeof input.plot === 'string') data.plot = input.plot;

      return {
        intent: { type: 'income', data },
        confidence: 0.95,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
      };
    }

    // Partial income
    const missingFields: string[] = [];
    if (!input.amount) missingFields.push('amount');
    if (!input.category) missingFields.push('category');

    return {
      intent: {
        type: 'income_partial',
        data: {
          type: 'income',
          ...(amount > 0 ? { amount } : {}),
          ...(input.category ? { category: input.category as string } : {}),
          ...(input.currency === 'USD' ? { currency: 'USD' as Currency } : { currency: 'ARS' as Currency }),
        },
      },
      confidence: 0.60,
      aiUsed: true,
      source: 'ai',
      missingFields,
    };
  }

  private mapCommand(toolName: string, input: Record<string, unknown>): ParseResult {
    const cmd: ParsedCommand = { command: toolName };

    // Map field/plot names (tool schema uses 'field'/'plot', handlers expect 'fieldName'/'plotName')
    if (input.field != null) cmd.fieldName = input.field;
    if (input.plot != null) cmd.plotName = input.plot;
    if (input.plotName != null) cmd.plotName = input.plotName;
    if (input.plotNames != null) cmd.plotNames = input.plotNames;
    if (input.city != null) cmd.city = input.city;
    if (input.hectares != null) cmd.hectares = input.hectares;

    // Activity fields
    if (input.product != null) cmd.product = input.product;
    if (input.product_type != null) cmd.productType = input.product_type;
    if (input.quantity != null) cmd.quantity = input.quantity;
    if (input.unit != null) cmd.unit = input.unit;
    if (input.crop != null) cmd.crop = input.crop;
    if (input.event_date != null) cmd.eventDate = input.event_date;

    // Observation
    if (input.observation != null) cmd.observation = input.observation;

    // Report fields
    if (input.period != null) cmd.period = input.period;
    if (input.date_range != null) cmd.date_range = input.date_range;
    if (input.timeRef != null) cmd.timeRef = input.timeRef;
    if (input.activityFilter != null) cmd.activityFilter = input.activityFilter;
    if (input.desde != null) cmd.desde = input.desde;
    if (input.hasta != null) cmd.hasta = input.hasta;
    if (input.days != null) cmd.days = input.days;
    if (input.category != null) cmd.category = input.category;
    if (input.type != null) cmd.reportType = input.type;

    // Rainfall: quantity → mm (handler expects cmd.mm)
    if (toolName === 'log_rainfall' && input.quantity != null) {
      cmd.mm = input.quantity;
    }

    return {
      intent: { type: 'command', data: cmd },
      confidence: 0.95,
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
  }
}
