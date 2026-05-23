// ============================================================================
// Core Domain Types
// ============================================================================

// --- Branded types ---

export type UserId = number & { readonly __brand: 'UserId' };

export function asUserId(id: number): UserId {
  return id as UserId;
}

// --- Currency ---

export type Currency = 'ARS' | 'USD';

// --- Categories (canonical definitions in constants/agro-terms.ts) ---

export type { ExpenseCategory, IncomeCategory } from '../constants/agro-terms.js';

// --- Parsed data ---

export interface ParsedExpense {
  type: 'expense';
  amount: number;
  category: string;
  description: string;
  currency: Currency;
  expenseDate?: string | null;
  expenseType?: 'insumo' | 'varios';
  product?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unit_price?: number | null;
}

export interface ParsedIncome {
  type: 'income';
  amount: number;
  category: string;
  description: string;
  currency: Currency;
  quantity?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  incomeDate?: string | null;
}

export interface ParsedCommand {
  command: string;
  corralName?: string;
  [key: string]: unknown;
}

// --- Intent ---

export type Intent =
  | { type: 'expense'; data: ParsedExpense }
  | { type: 'income'; data: ParsedIncome }
  | { type: 'command'; data: ParsedCommand }
  | { type: 'expense_partial'; data: Partial<ParsedExpense> & { type: 'expense' } }
  | { type: 'income_partial'; data: Partial<ParsedIncome> & { type: 'income' } }
  | { type: 'ambiguous'; candidates: AmbiguousCandidate[] }
  | { type: 'unknown'; raw: string }
  /**
  | { type: 'unknown'; raw: string }
  /**
   * Phase 2 — emitted by the regex fallback when the parsed command is not
   * in SAFE_FALLBACK_INTENTS. Tells the controller to respond with a
   * user-friendly "no pude procesar esto sin IA" message instead of
   * silently degrading or guessing.
   */
  | { type: 'fallback_blocked'; reason: 'ai_required' | 'unparseable_complex'; raw: string; attemptedCommand?: string }
  /**
   * Phase 3 — emitted at the very top of the pipeline when the user's
   * trial has expired and they have no active paid subscription. The
   * controller responds with a clear "tu prueba terminó" message + CTA to
   * /dashboard/account. No data writes happen in this path — datos
   * existentes preservados.
   */
  | { type: 'trial_expired'; raw: string };

export interface AmbiguousCandidate {
  intent: Intent;
  confidence: number;
  label: string;
}

// --- Parse Result ---

export type ParseSource = 'command' | 'income_parser' | 'expense_parser' | 'claude' | 'flow' | 'ai';

export interface ParseResult {
  intent: Intent;
  confidence: number;
  aiUsed: boolean;
  source: ParseSource;
  missingFields: string[];
  matchType?: 'exact' | 'starts' | 'fuzzy';
}

// --- Field info ---

export interface FieldInfo {
  fieldId: number | null;
  fieldName: string | null;
  plotId: number | null;
  plotName: string | null;
  notFound?: { type: 'field' | 'plot'; name: string };
  needPlotSelection?: { fieldId: number; fieldName: string; plots: Array<{ id: number; name: string }> };
  needPlotCreation?: { fieldId: number; fieldName: string };
}

// --- User ---

export interface User {
  id: UserId;
  phone_number: string;
  name: string | null;
  city: string | null;
  role?: 'admin' | 'end_user';
}

// --- User Settings ---

export interface UserSettings {
  weekly_summary: boolean;
  weekly_summary_day: number;
  weekly_summary_hour: number;
  budget_alerts: boolean;
  rain_alerts: boolean;
  confirm_before_save: boolean;
  claude_daily_limit: number;
  rain_alert_mm: number;
}

// --- DB Row types ---

export interface ExpenseRow {
  id: number;
  user_id: number;
  category: string;
  description: string;
  amount: string | number;
  currency: string;
  field_id: number | null;
  plot_id: number | null;
  expense_date: Date;
  created_at: Date;
  deleted_at: Date | null;
  expense_type?: 'insumo' | 'varios';
  product?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unit_price?: number | null;
}

export interface IncomeRow {
  id: number;
  user_id: number;
  category: string;
  description: string;
  amount: string | number;
  currency: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  field_id: number | null;
  plot_id: number | null;
  income_date: Date;
  created_at: Date;
  deleted_at: Date | null;
}

export interface FieldRow {
  id: number;
  user_id: number;
  name: string;
  city: string | null;
  province: string | null;
}

export interface PlotRow {
  id: number;
  field_id: number;
  name: string;
  area_hectares: number | null;
  soil_type: string | null;
  grupo: string | null;
  created_at: Date;
}

export interface CategoryTotal {
  category: string;
  total: string | number;
}

export interface MonthlyResult {
  ingresos: number;
  gastos: number;
}

export interface RainfallData {
  total: number;
  registros: number;
}

export interface FieldInfoData {
  name: string;
  city: string | null;
  province: string | null;
  expenses: { total: number; count: number };
  incomes: { total: number; count: number };
  rainfall: { total: number; count: number };
  plotCount?: number;
  observations?: Array<{ observation_text: string; category: string; created_at: Date; plot_name: string | null }>;
}

export interface PlotInfoData {
  name: string;
  field_name: string;
  area_hectares: number | null;
  soil_type: string | null;
  expenses: { total: number; count: number };
  incomes: { total: number; count: number };
  rainfall: { total: number; count: number };
  activeCrop?: { crop: string; season_year: number } | null;
  recentActivities?: Array<{ event_type: string; event_date: Date; product: string | null; crop: string | null }>;
}

// --- Plot Crops ---

export interface PlotCropRow {
  id: number;
  plot_id: number;
  crop: string;
  season_year: number;
  season_type: string;
  start_date: Date;
  end_date: Date | null;
  harvested_at: Date | null;
  yield_kg: number | null;
  yield_notes: string | null;
  sowed_hectares: number | null;
  created_at: Date;
}

// --- Domain Events ---

export type ActivityType = 'planting' | 'harvest' | 'spraying' | 'fertilization' | 'tillage' | 'irrigation' | 'observation' | 'tacto';

export interface DomainEventRow {
  id: number;
  user_id: number;
  plot_id: number | null;
  plot_crop_id: number | null;
  event_type: ActivityType;
  event_date: Date;
  crop: string | null;
  product: string | null;
  product_type: string | null;
  quantity: number | null;
  unit: string | null;
  implement: string | null;
  notes: string | null;
  pregnant_count: number | null;
  open_count: number | null;
  uncertain_count: number | null;
  created_at: Date;
}

// --- Plot History (unified timeline) ---

export interface PlotHistoryRow {
  source: 'activity' | 'observation' | 'rainfall';
  id: number;
  type: string;
  date: Date;
  detail: string | null;
  quantity: number | null;
  unit: string | null;
  crop: string | null;
  plot_id: number | null;
  plot_name: string | null;
  field_name: string | null;
}

// --- Agro Observations ---

export type { ObservationCategory } from '../constants/agro-terms.js';

export interface ObservationRow {
  id: number;
  user_id: number;
  field_id: number | null;
  plot_id: number | null;
  observation_text: string;
  category: ObservationCategory;
  source: 'text' | 'audio';
  created_at: Date;
  updated_at: Date | null;
}

// --- Plot Discovery ---

export interface PlotAliasRow {
  id: number;
  plot_id: number;
  alias: string;
  created_at: Date;
}

export interface ConversationStateRow {
  user_id: number;
  last_plot_id: number | null;
  last_field_id: number | null;
  updated_at: Date;
}

export interface PlotDiscoveryResult {
  fieldId: number | null;
  fieldName: string | null;
  plotId: number | null;
  plotName: string | null;
  autoCreated: boolean;
  notFound?: { type: 'field' | 'plot'; name: string };
  needPlotSelection?: { fieldId: number; fieldName: string; plots: Array<{ id: number; name: string }> };
  needPlotCreation?: { fieldId: number; fieldName: string };
}

// --- AI Usage ---

export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
  /** Non-cached input tokens read from cache (billed at 10% of input rate). */
  cache_read_tokens?: number;
  /** Input tokens written to the prompt cache (billed at 125% of input rate for 5-min TTL, 200% for 1h). */
  cache_write_tokens?: number;
}

// --- Claude analysis result ---

export interface ClaudeAnalysisResult {
  data: {
    type: string;
    category?: string;
    amount?: number;
    description?: string;
    currency?: string;
    field?: string | null;
    quantity?: number | null;
    unit?: string | null;
    unit_price?: number | null;
    task?: string | null;
    product?: string | null;
    product_type?: string | null;
    crop?: string | null;
    plot?: string | null;
    command?: string | null;
    city?: string | null;
  };
  usage: AiUsage;
}

// --- Flow types ---

export type FlowState =
  | 'idle'
  | 'expense_flow'
  | 'income_flow'
  | 'field_flow'
  | 'activity_flow'
  | 'rainfall_flow'
  | 'confirming';

export interface FlowContext {
  state: FlowState;
  step: number;
  data: Record<string, unknown>;
  startedAt: Date | null;
  expiresAt: Date | null;
  /** When in 'confirming', tracks which flow to execute */
  originFlow?: FlowState;
  /** Consecutive validation failures at current step */
  stepFailCount?: number;
}

export interface ConversationLogRow {
  id: number;
  user_id: number;
  phone: string;
  direction: 'inbound' | 'outbound';
  message_text: string | null;
  intent_type: string | null;
  intent_command: string | null;
  flow_state: string | null;
  flow_step: number | null;
  ai_used: boolean;
  response_text: string | null;
  response_interactive: boolean;
  processing_time_ms: number | null;
  created_at: Date;
}

// --- Pending transaction ---

export interface PendingTransaction {
  type: 'expense' | 'income';
  data: ParsedExpense | ParsedIncome;
  fieldId: number | null;
  fieldName: string | null;
  plotId: number | null;
  plotName: string | null;
  timestamp: number;
}

// --- Handler Response ---

export interface AttachmentPayload {
  buffer: Buffer;
  filename: string;
  mime: string;
  caption: string;
}

// --- Learning layer ---

export type VocabularyCategory = 'lot_name' | 'crop' | 'product' | 'fuel' | 'task' | 'slang' | 'unit';

export interface VocabularyEntry {
  id: string;
  user_id: number;
  phrase: string;
  normalized_phrase: string;
  resolved_value: string;
  category: VocabularyCategory;
  confidence: number;
  hit_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface MessagePatternRow {
  id: string;
  user_id: number;
  message: string;
  normalized_message: string;
  intent: string;
  entities: Record<string, unknown>;
  source: string;
  created_at: Date;
}

export interface LearningContext {
  lots: VocabularyEntry[];
  crops: VocabularyEntry[];
  products: VocabularyEntry[];
  slang: VocabularyEntry[];
}

// --- Interactive messages (WhatsApp buttons & lists) ---

export interface InteractiveButton {
  id: string;       // callback ID, e.g. "menu_gastos"
  title: string;    // display text, max 20 chars
}

export interface InteractiveListRow {
  id: string;
  title: string;        // max 24 chars
  description?: string; // max 72 chars
}

export interface InteractiveListSection {
  title: string;         // max 24 chars
  rows: InteractiveListRow[];
}

export type InteractiveMessage =
  | { type: 'buttons'; body: string; buttons: InteractiveButton[] }
  | { type: 'list'; body: string; buttonText: string; sections: InteractiveListSection[] };

export interface HandlerResponse {
  messages: string[];
  attachment?: AttachmentPayload;
  interactive?: InteractiveMessage;
  suggestionKey?: string;
  /**
   * Set by any handler that saved a record in BULK mode (compound action)
   * WITHOUT a plot — either because the user didn't specify, or because the
   * field has 2+ plots and we can't auto-resolve. The CompoundExecutor
   * collects these and, after the loop, asks ONCE "¿a qué lote los asigno?"
   * so all bulk-saved records get a plot via a single tap.
   *
   * `kind` controls which table assign_bulk_plot UPDATEs:
   *   - expense / income → expenses / incomes
   *   - activity         → domain_events (sow/harvest/spray/fertil/tillage/irrigation)
   *   - observation      → agro_observations
   *   - scouting         → crop_scoutings
   *   - livestock        → livestock_groups (location_id = plot_id)
   *   - rainfall         → rainfall
   *   - stock_movement   → stock_movements (no plot — included for completeness; assignment is no-op)
   */
  savedRecordsWithoutPlot?: Array<{
    kind: 'expense' | 'income' | 'activity' | 'observation' | 'scouting' | 'livestock' | 'rainfall' | 'stock_movement';
    id: number;
    fieldId: number;
  }>;
  /** @deprecated Use `savedRecordsWithoutPlot` instead. Kept for legacy callers. */
  savedFinanceWithoutPlot?: { kind: 'expense' | 'income'; id: number; fieldId: number };
  sideEffects?: {
    setPending?: PendingTransaction;
    startFlow?: { state: FlowState; data?: Record<string, unknown> };
    setPendingObservation?: { text: string; category: string };
    setPendingFieldCity?: { fieldName: string };
    setPendingPlotArea?: { plotId: number; plotName: string; fieldName: string };
    setPendingPlotAreaQueue?: Array<{ plotId: number; plotName: string; fieldName: string }>;
    setFieldDuplicate?: { name: string; city: string | null };
    setPendingActivity?: {
      command: string;
      data: Record<string, unknown>;
      /** Unified multi-slot completion: required slots that are still missing. */
      missing?: string[];
      /** Optional Spanish prompt to show the user when asking for the missing slots. */
      askPrompt?: string;
    };
    setPendingStockEntry?: {
      expenseId: number;
      product: string;
      quantity: number;
      unit: string;
      fieldId: number;
      warehouseId: number;
      warehouseName: string;
    };
    setPendingDocumentAction?: {
      documentId: number;
      extraction: DocumentExtraction;
      suggestedExpenses: Array<Partial<ParsedExpense> & { field?: string; plot?: string }>;
    };
    setPendingStockDeduction?: {
      domainEventId: number;
      stockItemId: number;
      product: string;
      totalQuantity: number;
      unit: string;
      fieldId: number;
      warehouseName: string;
      currentStock: number;
    };
    setPendingFieldLocation?: {
      fieldId: number;
      fieldName: string;
    };
    setPendingCampaignClose?: {
      plotCropId: number;
      crop: string;
      plotName: string;
    };
  };
}

// ============================================================================
// Billing & Feature Gating
// ============================================================================

export type PlanName = 'free' | 'pro' | 'pro_plus' | 'enterprise';

export type FeatureKey =
  | 'expenses'
  | 'incomes'
  | 'fields'
  | 'budgets'
  | 'rainfall'
  | 'agronomy'
  | 'csv_export'
  | 'weather'
  | 'audio'
  | 'sharing'
  | 'stock'
  | 'documents'
  | 'livestock';

export interface PlanRow {
  id: number;
  name: PlanName;
  display_name: string;
  price_ars: number;
  is_active: boolean;
  daily_ai_limit: number | null;
  created_at: Date;
}

export interface FeatureRow {
  id: number;
  key: FeatureKey;
  description: string;
  created_at: Date;
}

// --- Document Processing ---

export interface DocumentLineItem {
  product: string;
  quantity?: number;
  unit?: string;
  unit_price?: number;
  total?: number;
  category?: string;
}

export interface DocumentExtraction {
  supplier?: string;
  date?: string;
  total_amount?: number;
  currency?: 'ARS' | 'USD';
  tax_amount?: number;
  document_number?: string;
  line_items?: DocumentLineItem[];
  raw_text_summary?: string;
}

export interface DocumentRow {
  id: number;
  user_id: number;
  document_type: string;
  original_filename: string | null;
  mime_type: string;
  file_size_bytes: number;
  compressed_path: string | null;
  file_hash: string | null;
  extracted_data: DocumentExtraction | null;
  processing_status: string;
  processing_error: string | null;
  linked_expense_id: number | null;
  source_channel: string;
  processing_time_ms: number | null;
  created_at: Date;
  deleted_at: Date | null;
}
