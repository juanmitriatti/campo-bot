import type { ParseResult, ParsedExpense, ParsedIncome, ParsedCommand, Currency } from '../types/index.js';
import { EXPENSE_CATEGORY_SET, INCOME_CATEGORY_SET } from '../constants/agro-terms.js';

/**
 * All known intent strings the LLM can return.
 * Grouped by domain for the prompt, but flat here for validation.
 */
const KNOWN_INTENTS = new Set([
  // Financial
  'log_expense', 'log_income',
  // Agronomy
  'log_spraying', 'log_fertilization', 'log_tillage', 'log_irrigation',
  'sow_crop', 'harvest_crop', 'active_crop', 'crop_history',
  'plot_activities', 'query_plot_history', 'log_observation', 'generate_agro_report',
  'log_rainfall', 'delete_last_rainfall', 'rainfall_report', 'rainfall_range',
  'compare_rainfall_months', 'compare_rainfall_years',
  // Field/plot management
  'list_fields', 'add_field', 'delete_field', 'rename_field', 'field_info',
  'set_field_city', 'add_field_city',
  'list_plots', 'add_plot', 'delete_plot', 'plot_info',
  'set_plot_area', 'set_plot_coords', 'restore_field',
  // Reports
  'monthly_result', 'field_result', 'weekly_report', 'monthly_report',
  'field_report', 'plot_report', 'date_range_report', 'compare_months',
  // Weather
  'weather_full', 'weather_forecast', 'weather_field', 'weather_all',
  // System
  'greeting', 'help', 'thanks', 'ack', 'menu', 'dollar',
  'show_expense_menu', 'show_income_menu', 'show_agro_menu',
  'show_fields_menu', 'show_rain_menu', 'show_reports_menu',
  'set_name', 'set_city',
  'show_alerts', 'set_rain_threshold', 'enable_rain_alerts', 'disable_rain_alerts',
  'enable_budget_alerts', 'disable_budget_alerts',
  'enable_weekly_summary', 'disable_weekly_summary',
  'set_budget', 'export_csv',
  // Confirmation
  'confirm', 'cancel',
  // Deletion
  'delete_last', 'delete_last_income', 'delete_specific',
  'edit_specific', 'edit_last',
  // Prompts
  'prompt_rainfall', 'prompt_add_field',
]);

export interface LlmResponse {
  intent: string;
  confidence: number;
  // Financial fields
  amount?: number;
  category?: string;
  description?: string;
  currency?: string;
  quantity?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  // Entity fields
  field?: string | null;
  plot?: string | null;
  city?: string | null;
  // Activity fields
  product?: string | null;
  product_type?: string | null;
  crop?: string | null;
  event_date?: string | null;
  // Report fields
  period?: string | null;
  date_range?: string | null;
  timeRef?: string | null;
  activityFilter?: string | null;
  desde?: string | null;
  hasta?: string | null;
  days?: number | null;
  // Generic
  [key: string]: unknown;
}

export class IntentValidator {
  /**
   * Parse raw LLM text output into a validated ParseResult.
   * Returns null if the output cannot be parsed or validated.
   */
  validate(rawText: string, originalMessage: string): ParseResult | null {
    const parsed = this.extractJson(rawText);
    if (!parsed) return null;

    // Must have a valid intent string
    if (typeof parsed.intent !== 'string' || !KNOWN_INTENTS.has(parsed.intent)) {
      return null;
    }

    // Must have a numeric confidence 0-1
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.80;

    // Map to ParseResult based on intent
    if (parsed.intent === 'log_expense') {
      return this.mapExpense(parsed, originalMessage, confidence);
    }

    if (parsed.intent === 'log_income') {
      return this.mapIncome(parsed, originalMessage, confidence);
    }

    // Everything else is a command
    return this.mapCommand(parsed, confidence);
  }

  private extractJson(rawText: string): LlmResponse | null {
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }

  private mapExpense(parsed: LlmResponse, originalMessage: string, confidence: number): ParseResult {
    if (parsed.amount && typeof parsed.amount === 'number' && parsed.amount > 0) {
      const category = (parsed.category && EXPENSE_CATEGORY_SET.has(parsed.category))
        ? parsed.category
        : 'Otros';
      const currency: Currency = parsed.currency === 'USD' ? 'USD' : 'ARS';
      const data: ParsedExpense = {
        type: 'expense',
        amount: parsed.amount,
        category,
        description: parsed.description || originalMessage,
        currency,
      };
      return {
        intent: { type: 'expense', data },
        confidence,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
      };
    }

    // Partial expense — has intent but no amount
    const missingFields: string[] = [];
    if (!parsed.amount) missingFields.push('amount');
    if (!parsed.category) missingFields.push('category');

    return {
      intent: {
        type: 'expense_partial',
        data: {
          type: 'expense',
          ...(parsed.amount ? { amount: parsed.amount } : {}),
          ...(parsed.category ? { category: parsed.category } : {}),
          ...(parsed.currency === 'USD' ? { currency: 'USD' as Currency } : { currency: 'ARS' as Currency }),
        },
      },
      confidence: Math.min(confidence, 0.60),
      aiUsed: true,
      source: 'ai',
      missingFields,
    };
  }

  private mapIncome(parsed: LlmResponse, originalMessage: string, confidence: number): ParseResult {
    if (parsed.amount && typeof parsed.amount === 'number' && parsed.amount > 0) {
      const category = (parsed.category && INCOME_CATEGORY_SET.has(parsed.category))
        ? parsed.category
        : 'Otros';
      const currency: Currency = parsed.currency === 'USD' ? 'USD' : 'ARS';
      const data: ParsedIncome = {
        type: 'income',
        amount: parsed.amount,
        category,
        description: parsed.description || originalMessage,
        currency,
        quantity: parsed.quantity ?? null,
        unit: parsed.unit ?? null,
        unit_price: parsed.unit_price ?? null,
      };
      return {
        intent: { type: 'income', data },
        confidence,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
      };
    }

    // Partial income — has intent but no amount
    const missingFields: string[] = [];
    if (!parsed.amount) missingFields.push('amount');
    if (!parsed.category) missingFields.push('category');

    return {
      intent: {
        type: 'income_partial',
        data: {
          type: 'income',
          ...(parsed.amount ? { amount: parsed.amount } : {}),
          ...(parsed.category ? { category: parsed.category } : {}),
          ...(parsed.currency === 'USD' ? { currency: 'USD' as Currency } : { currency: 'ARS' as Currency }),
        },
      },
      confidence: Math.min(confidence, 0.60),
      aiUsed: true,
      source: 'ai',
      missingFields,
    };
  }

  private mapCommand(parsed: LlmResponse, confidence: number): ParseResult {
    const cmd: ParsedCommand = { command: parsed.intent };

    // Copy relevant fields based on intent type
    if (parsed.field != null) cmd.fieldName = parsed.field;
    if (parsed.plot != null) cmd.plotName = parsed.plot;
    if (parsed.city != null) cmd.city = parsed.city;
    if (parsed.product != null) cmd.product = parsed.product;
    if (parsed.product_type != null) cmd.productType = parsed.product_type;
    if (parsed.quantity != null) cmd.quantity = parsed.quantity;
    if (parsed.unit != null) cmd.unit = parsed.unit;
    if (parsed.crop != null) cmd.crop = parsed.crop;
    if (parsed.event_date != null) cmd.eventDate = parsed.event_date;
    if (parsed.observation != null) cmd.observation = parsed.observation;
    if (parsed.period != null) cmd.period = parsed.period;
    if (parsed.date_range != null) cmd.date_range = parsed.date_range;
    if (parsed.timeRef != null) cmd.timeRef = parsed.timeRef;
    if (parsed.activityFilter != null) cmd.activityFilter = parsed.activityFilter;
    if (parsed.desde != null) cmd.desde = parsed.desde;
    if (parsed.hasta != null) cmd.hasta = parsed.hasta;
    if (parsed.days != null) cmd.days = parsed.days;

    // Map quantity → mm for rainfall (handler expects cmd.mm)
    if (parsed.intent === 'log_rainfall' && parsed.quantity != null) {
      cmd.mm = parsed.quantity;
    }

    return {
      intent: { type: 'command', data: cmd },
      confidence,
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
  }
}
