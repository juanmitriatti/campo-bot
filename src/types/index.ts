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

// --- Categories ---

export type ExpenseCategory =
  | 'Combustible'
  | 'Fertilizantes'
  | 'Semillas'
  | 'Agroquímicos'
  | 'Sueldos'
  | 'Maquinaria'
  | 'Arrendamiento'
  | 'Impuestos'
  | 'Otros';

export type IncomeCategory =
  | 'Soja'
  | 'Maíz'
  | 'Trigo'
  | 'Girasol'
  | 'Sorgo'
  | 'Cebada'
  | 'Hacienda'
  | 'Arrendamiento'
  | 'Otros';

// --- Parsed data ---

export interface ParsedExpense {
  type: 'expense';
  amount: number;
  category: string;
  description: string;
  currency: Currency;
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
}

export interface ParsedCommand {
  command: string;
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
  | { type: 'unknown'; raw: string };

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
}

// --- User ---

export interface User {
  id: UserId;
  phone_number: string;
  name: string | null;
  city: string | null;
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
  hectares: number | null;
  location: string | null;
}

export interface PlotRow {
  id: number;
  field_id: number;
  name: string;
  area_hectares: number | null;
  soil_type: string | null;
  lat: number | null;
  lng: number | null;
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
  expenses: { total: number; count: number };
  incomes: { total: number; count: number };
  rainfall: { total: number; count: number };
  plotCount?: number;
}

export interface PlotInfoData {
  name: string;
  field_name: string;
  area_hectares: number | null;
  soil_type: string | null;
  expenses: { total: number; count: number };
  incomes: { total: number; count: number };
  rainfall: { total: number; count: number };
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
  created_at: Date;
}

// --- Domain Events ---

export type ActivityType = 'planting' | 'harvest' | 'spraying' | 'fertilization' | 'tillage' | 'irrigation' | 'observation';

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
  created_at: Date;
}

// --- Agro Observations ---

export type ObservationCategory = 'sanidad' | 'malezas' | 'nutricion' | 'fenologia' | 'clima' | 'general';

export interface ObservationRow {
  id: number;
  user_id: number;
  field_id: number | null;
  plot_id: number | null;
  observation_text: string;
  category: ObservationCategory;
  source: 'text' | 'audio';
  created_at: Date;
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
}

// --- AI Usage ---

export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
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
  sideEffects?: {
    setPending?: PendingTransaction;
    startFlow?: { state: FlowState; data?: Record<string, unknown> };
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
  | 'ai_fallback'
  | 'audio';

export interface PlanRow {
  id: number;
  name: PlanName;
  display_name: string;
  price_ars: number;
  is_active: boolean;
  created_at: Date;
}

export interface FeatureRow {
  id: number;
  key: FeatureKey;
  description: string;
  created_at: Date;
}
