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

    // Filter: if agent returned log_expense alongside an agro activity, drop the expense
    // (Haiku sometimes hallucinates an expense for activity messages like "hoy sembramos soja")
    const AGRO_ACTIVITY_TOOLS = new Set([
      'sow_crop', 'harvest_crop', 'log_spraying', 'log_fertilization',
      'log_tillage', 'log_irrigation', 'log_activity',
    ]);
    let filteredCalls = result.toolCalls;
    const hasAgroActivity = filteredCalls.some(tc => AGRO_ACTIVITY_TOOLS.has(tc.toolName));
    if (hasAgroActivity) {
      // Only drop spurious expense/income calls that have NO explicit amount
      // (Haiku hallucination). Keep them if the user mentioned a real amount.
      filteredCalls = filteredCalls.filter(tc => {
        if (tc.toolName !== 'log_expense' && tc.toolName !== 'log_income') return true;
        const input = tc.toolInput as Record<string, unknown>;
        const amount = typeof input.amount === 'number' ? input.amount : 0;
        return amount > 0; // keep if agent extracted a real amount
      });
      if (filteredCalls.length === 0) filteredCalls = result.toolCalls; // safety: don't drop everything
    }

    return filteredCalls.map(tc => this.mapToolCall(tc, originalText));
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
      if (typeof input.event_date === 'string') data.expenseDate = input.event_date;

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
      if (typeof input.event_date === 'string') data.incomeDate = input.event_date;

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
    if (input.include_activities != null) cmd.include_activities = input.include_activities;
    if (input.activity_filter != null) cmd.activity_filter = input.activity_filter;

    // Rainfall: quantity → mm (handler expects cmd.mm)
    if (toolName === 'log_rainfall' && input.quantity != null) {
      cmd.mm = input.quantity;
    }

    // Sharing
    if (input.phone != null) cmd.phone = input.phone;
    if (input.code != null) cmd.code = input.code;
    if (input.member != null) { cmd.memberName = input.member; cmd.phone = input.member; }

    return {
      intent: { type: 'command', data: cmd },
      confidence: 0.95,
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
  }
}
