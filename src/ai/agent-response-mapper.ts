import type { ParseResult, ParsedExpense, ParsedIncome, ParsedCommand, Currency } from '../types/index.js';
import { EXPENSE_CATEGORY_SET, EXPENSE_CATEGORIES, INCOME_CATEGORY_SET, INCOME_CATEGORIES, INSUMO_CATEGORIES } from '../constants/agro-terms.js';
import type { AgentResult } from './agent.service.js';

/** Strip accents for comparison */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Accent-insensitive category match against a known set */
function matchCategory(raw: string, categories: readonly string[]): string | null {
  // Exact match first
  if (new Set(categories).has(raw)) return raw;
  // Accent-insensitive
  const norm = stripAccents(raw).toLowerCase();
  for (const cat of categories) {
    if (stripAccents(cat).toLowerCase() === norm) return cat;
  }
  return null;
}

/** Known product keywords → { category, expense_type } for fallback inference */
const PRODUCT_CATEGORY_KEYWORDS: Record<string, { category: string; expenseType: 'insumo' | 'varios' }> = {
  roundup: { category: 'Agroquímicos', expenseType: 'insumo' },
  glifosato: { category: 'Agroquímicos', expenseType: 'insumo' },
  atrazina: { category: 'Agroquímicos', expenseType: 'insumo' },
  '2,4-d': { category: 'Agroquímicos', expenseType: 'insumo' },
  '24d': { category: 'Agroquímicos', expenseType: 'insumo' },
  herbicida: { category: 'Agroquímicos', expenseType: 'insumo' },
  insecticida: { category: 'Agroquímicos', expenseType: 'insumo' },
  fungicida: { category: 'Agroquímicos', expenseType: 'insumo' },
  cipermetrina: { category: 'Agroquímicos', expenseType: 'insumo' },
  fipronil: { category: 'Agroquímicos', expenseType: 'insumo' },
  urea: { category: 'Fertilizantes', expenseType: 'insumo' },
  dap: { category: 'Fertilizantes', expenseType: 'insumo' },
  map: { category: 'Fertilizantes', expenseType: 'insumo' },
  fosfato: { category: 'Fertilizantes', expenseType: 'insumo' },
  fertilizante: { category: 'Fertilizantes', expenseType: 'insumo' },
  semilla: { category: 'Semillas', expenseType: 'insumo' },
  semillas: { category: 'Semillas', expenseType: 'insumo' },
  gasoil: { category: 'Combustible', expenseType: 'insumo' },
  nafta: { category: 'Combustible', expenseType: 'insumo' },
  diesel: { category: 'Combustible', expenseType: 'insumo' },
  combustible: { category: 'Combustible', expenseType: 'insumo' },
};

/** Infer category/expense_type from product name */
function inferFromProduct(product: string): { category: string; expenseType: 'insumo' | 'varios' } | null {
  const norm = stripAccents(product).toLowerCase();
  for (const [keyword, info] of Object.entries(PRODUCT_CATEGORY_KEYWORDS)) {
    if (norm.includes(keyword)) return info;
  }
  return null;
}

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
      'log_tillage', 'log_irrigation', 'log_activity', 'log_tacto',
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
      let category = matchCategory(rawCategory, EXPENSE_CATEGORIES) ?? 'Otros';
      const currency: Currency = input.currency === 'USD' ? 'USD' : 'ARS';
      // Determine expense_type: explicit from agent, or infer from category, or infer from product
      let expenseType: 'insumo' | 'varios' = 'varios';
      if (input.expense_type === 'insumo' || input.expense_type === 'varios') {
        expenseType = input.expense_type;
      } else if (INSUMO_CATEGORIES.has(category)) {
        expenseType = 'insumo';
      }

      // Fallback: infer from product name when category is Otros or expense_type is missing
      const productStr = typeof input.product === 'string' ? input.product : '';
      if (productStr && (category === 'Otros' || expenseType === 'varios')) {
        const inferred = inferFromProduct(productStr);
        if (inferred) {
          if (category === 'Otros') category = inferred.category;
          if (expenseType === 'varios') expenseType = inferred.expenseType;
        }
      }

      const data: ParsedExpense & { field?: string; plot?: string } = {
        type: 'expense',
        amount,
        category,
        description: typeof input.description === 'string' ? input.description : originalText,
        currency,
        expenseType,
      };
      if (typeof input.product === 'string') data.product = input.product;
      if (typeof input.quantity === 'number') data.quantity = input.quantity;
      if (typeof input.unit === 'string') data.unit = input.unit;
      if (typeof input.unit_price === 'number') data.unit_price = input.unit_price;
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
      const category = matchCategory(rawCategory, INCOME_CATEGORIES) ?? 'Otros';
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
    if (input.fieldName != null) cmd.fieldName = input.fieldName;
    if (input.plot != null) cmd.plotName = input.plot;
    if (input.plotName != null) cmd.plotName = input.plotName;
    if (input.plotNames != null) cmd.plotNames = input.plotNames;
    if (input.city != null) cmd.city = input.city;
    if (input.province != null) cmd.province = input.province;
    if (input.hectares != null) cmd.hectares = input.hectares;
    if (input.oldName != null) cmd.oldName = input.oldName;
    if (input.newName != null) cmd.newName = input.newName;
    if (input.entityKeyword != null) cmd.entityKeyword = input.entityKeyword;

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
    if (input.report_type != null) cmd.reportType = input.report_type;
    if (input.include_activities != null) cmd.include_activities = input.include_activities;
    if (input.activity_filter != null) cmd.activity_filter = input.activity_filter;

    // Rainfall: quantity → mm (handler expects cmd.mm)
    if (toolName === 'log_rainfall' && input.quantity != null) {
      cmd.mm = input.quantity;
    }

    // Stock
    if (input.warehouse != null) cmd.warehouseName = input.warehouse;
    if (input.reason != null) cmd.reason = input.reason;
    if (input.name != null && !cmd.product) cmd.warehouseName = input.name; // create_warehouse: name → warehouseName

    // Sharing
    if (input.phone != null) cmd.phone = input.phone;
    if (input.code != null) cmd.code = input.code;
    if (input.member != null) { cmd.memberName = input.member; cmd.phone = input.member; }

    // Documents
    if (input.documentId != null) cmd.documentId = input.documentId;
    if (input.expenseId != null) cmd.expenseId = input.expenseId;
    if (input.context != null) cmd.context = input.context;

    // Campaign / harvest yield
    if (input.yield_kg != null) cmd.yieldKg = input.yield_kg;
    if (input.yield_notes != null) cmd.yieldNotes = input.yield_notes;
    if (input.season_year != null) cmd.seasonYear = input.season_year;
    if (input.season_year_1 != null) cmd.seasonYear1 = input.season_year_1;
    if (input.season_year_2 != null) cmd.seasonYear2 = input.season_year_2;

    // Edit activity
    if (input.new_plot != null) cmd.newPlotName = input.new_plot;
    if (input.new_field != null) cmd.newFieldName = input.new_field;
    if (input.new_crop != null) cmd.newCrop = input.new_crop;
    if (input.new_date != null) cmd.newDate = input.new_date;
    if (input.activity_filter != null && toolName === 'edit_last_activity') cmd.activityFilter = input.activity_filter;

    // Livestock
    if (input.count != null) cmd.count = input.count;
    if (input.breed != null) cmd.breed = input.breed;
    if (input.avg_weight_kg != null) cmd.avg_weight_kg = input.avg_weight_kg;
    if (input.unit_price_ars != null) cmd.unit_price_ars = input.unit_price_ars;
    if (input.unit_price_usd != null) cmd.unit_price_usd = input.unit_price_usd;
    if (input.source_field != null) cmd.sourceField = input.source_field;
    if (input.source_plot != null) cmd.sourcePlot = input.source_plot;
    if (input.source_corral != null) cmd.sourceCorral = input.source_corral;
    if (input.dest_field != null) cmd.destField = input.dest_field;
    if (input.dest_plot != null) cmd.destPlot = input.dest_plot;
    if (input.dest_corral != null) cmd.destCorral = input.dest_corral;
    if (input.dest_category != null) cmd.destCategory = input.dest_category;
    if (input.corral != null) cmd.corralName = input.corral;

    // Grupo (sociedad)
    if (input.grupo != null) cmd.grupo = input.grupo;

    // Feedlot
    if (input.capacity != null) cmd.capacity = input.capacity;
    if (input.name != null && !cmd.fieldName && !cmd.warehouseName) cmd.feedlotName = input.name;

    // Tacto (pregnancy check)
    if (input.total_checked != null) cmd.totalChecked = input.total_checked;
    if (input.pregnant_count != null) cmd.pregnantCount = input.pregnant_count;
    if (input.open_count != null) cmd.openCount = input.open_count;
    if (input.uncertain_count != null) cmd.uncertainCount = input.uncertain_count;
    if (input.veterinarian != null) cmd.implement = input.veterinarian;
    if (input.notes != null) cmd.notes = input.notes;

    // Harvest loads
    if (input.loads != null) cmd.loads = input.loads;
    if (input.driver_name != null) cmd.driverName = input.driver_name;
    if (input.destinatario != null) cmd.destinatario = input.destinatario;
    if (input.driver_names != null) cmd.driverNames = input.driver_names;
    if (input.only_without_destination != null) cmd.onlyWithoutDestination = input.only_without_destination;

    // Expense templates (recurring)
    if (input.template_id != null) cmd.templateId = input.template_id;
    if (input.recurrence_type != null) cmd.recurrenceType = input.recurrence_type;
    if (input.recurrence_day != null) cmd.recurrenceDay = input.recurrence_day;
    if (toolName.includes('expense_template')) {
      if (input.name != null) cmd.name = input.name;
      if (input.amount != null) cmd.amount = input.amount;
      if (input.currency != null) cmd.currency = input.currency;
      if (input.description != null) cmd.description = input.description;
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
