// Type declarations for expenses.js functions where TS inference from `= null` defaults
// produces `null | undefined` instead of accepting `number | null`.

export function saveExpense(userId: number, data: Record<string, unknown> | { amount: number; category: string; description: string; currency: string; type?: string }, fieldId?: number | null, plotId?: number | null): Promise<{ id: number }>;
export function saveIncome(userId: number, data: Record<string, unknown> | { amount: number; category: string; description: string; currency: string; type?: string; quantity?: number | null; unit?: string | null; unit_price?: number | null }, fieldId?: number | null, plotId?: number | null): Promise<{ id: number }>;
export const RAINFALL_REJECTED_DUPLICATE: { _rejected: string };
export function saveRainfall(userId: number, mm: number, fieldId?: number | null): Promise<unknown>;
export function getRainfallPeriod(userId: number, period: string, fieldId?: number | null): Promise<{ total: string | number; registros: string | number }>;

// Re-declare the rest so the .d.ts doesn't shadow them — let TS infer from .js
export function getOrCreateUser(phone: string): Promise<{ id: number; phone_number: string; name: string | null; city: string | null }>;
export function setUserName(userId: number, name: string): Promise<void>;
export function setUserCity(userId: number, city: string, province?: string | null): Promise<void>;
export function getUserSettings(userId: number): Promise<{
  weekly_summary?: boolean;
  weekly_summary_day?: number;
  weekly_summary_hour?: number;
  budget_alerts?: boolean;
  rain_alerts?: boolean;
  confirm_before_save?: boolean;
  claude_daily_limit?: number;
  rain_alert_mm?: number;
  [key: string]: unknown;
}>;
export function updateUserSetting(userId: number, field: string, value: unknown): Promise<void>;
export function getLastExpense(userId: number): Promise<{ id: number; category: string; amount: string | number; description: string; currency: string; user_id: number; field_id: number | null; plot_id: number | null; expense_date: Date; created_at: Date; deleted_at: Date | null } | null>;
export function getLastIncome(userId: number): Promise<{ id: number; category: string; amount: string | number; description: string; currency: string; user_id: number; quantity: number | null; unit: string | null; unit_price: number | null; field_id: number | null; plot_id: number | null; income_date: Date; created_at: Date; deleted_at: Date | null } | null>;
export function deleteExpense(expenseId: number): Promise<void>;
export function deleteIncome(incomeId: number): Promise<void>;
export function updateExpenseAmount(expenseId: number, newAmount: number): Promise<void>;
export function findExpenseByFilter(userId: number, filter: string): Promise<{ id: number; category: string; amount: string | number; description: string; currency: string; user_id: number; field_id: number | null; plot_id: number | null; expense_date: Date; created_at: Date; deleted_at: Date | null } | null>;
export function getMonthlyReport(userId: number): Promise<Array<{ category: string; total: string | number }>>;
export function getMonthlyReportForMonth(userId: number, month: number, year: number): Promise<Array<{ category: string; total: string | number }>>;
export function getWeeklyReport(userId: number): Promise<Array<{ category: string; total: string | number }>>;
export function getDateRangeReport(userId: number, desde: Date, hasta: Date): Promise<Array<{ category: string; total: string | number }>>;
export function getMonthlyExpenses(userId: number): Promise<Array<{ id: number; category: string; amount: string | number; description: string; currency: string; user_id: number; field_id: number | null; expense_date: Date; created_at: Date; deleted_at: Date | null }>>;
export function getMonthlyIncomeReport(userId: number): Promise<Array<{ category: string; total: string | number }>>;
export function getMonthlyIncomeForMonth(userId: number, month: number, year: number): Promise<Array<{ category: string; total: string | number }>>;
export function getMonthlyResult(userId: number): Promise<{ ingresos: string | number; gastos: string | number }>;
export function getFieldResult(userId: number, fieldName: string): Promise<{ ingresos: string | number; gastos: string | number }>;
export function getFieldReport(userId: number, fieldName: string): Promise<Array<{ category: string; total: string | number }>>;
export function getPlotReport(userId: number, plotName: string): Promise<{ rows: Array<{ category: string; total: string | number }>; plotName: string; fieldName: string; incomeTotal: number } | null>;
export function getPlotResult(userId: number, plotName: string): Promise<{ ingresos: number; gastos: number; plotName: string; fieldName: string } | null>;
export function setBudget(userId: number, category: string, amount: number): Promise<void>;
export function getBudget(userId: number, category: string): Promise<{ monthly_limit: string } | null>;
export function getCategoryMonthlyTotal(userId: number, category: string): Promise<number>;
export function checkBudgetAlert(total: number, limit: number, category: string, userName: string | null, userId: number, globalSettings?: { budget_alert_80?: boolean; budget_alert_100?: boolean } | null): Promise<string | null>;
export function getOrCreateField(userId: number, name: string): Promise<{ id: number; user_id: number; name: string; city: string | null; province: string | null }>;
export function setFieldCity(userId: number, fieldName: string, city: string, province?: string | null): Promise<void>;
export function getFieldByName(userId: number, fieldName: string): Promise<{ id: number; user_id: number; name: string; city: string | null; province: string | null } | null>;
export function getUserFieldsWithCity(userId: number): Promise<Array<{ name: string; city: string; province: string | null }>>;
export function getUserFields(userId: number): Promise<Array<{ name: string; city: string | null; province: string | null }>>;
export function getUserFieldCount(userId: number): Promise<number>;
export function deleteField(userId: number, fieldName: string): Promise<boolean>;
export function restoreField(userId: number, fieldName: string): Promise<{ id: number; user_id: number; name: string; city: string | null; province: string | null } | null>;
export function renameField(userId: number, oldName: string, newName: string): Promise<boolean>;
export function getFieldInfo(userId: number, fieldName: string): Promise<{ name: string; city: string | null; province: string | null; expenses: { total: number; count: number }; incomes: { total: number; count: number }; rainfall: { total: number; count: number }; plotCount: number } | null>;
export function saveUnparsedMessage(userId: number, message: string): Promise<void>;
export function getDailyClaudeCount(userId: number): Promise<number>;
export function saveAiUsage(userId: number, usage: { input_tokens: number; output_tokens: number }): Promise<void>;
export function saveAiFallbackLog(userId: number, inputText: string, claudeResponse: unknown, usage: unknown): Promise<void>;
export function saveAudioTranscriptionLog(userId: number, data: { durationSeconds: number; provider: string; model: string; costUsd: number }): Promise<void>;
export function getHourlyAudioCount(userId: number): Promise<number>;
export function getDailyRainfallTotal(userId: number, fieldId?: number | null): Promise<number>;
export function deleteLastRainfall(userId: number): Promise<{ millimeters: string | number } | null>;
export function getRainfallAllLocations(userId: number, period: string): Promise<Array<{ field_name: string | null; total: string | number; registros: string | number }>>;
export function getRainfallForMonth(userId: number, month: number, year: number): Promise<{ total: string | number; registros: string | number }>;
export function getRainfallForYear(userId: number, year: number): Promise<{ total: string | number; registros: string | number }>;
export function getRainfallRange(userId: number, desde: Date, hasta: Date): Promise<{ total: string | number; registros: string | number }>;

// --- Plot aliases & conversation state ---
export function findPlotByAlias(userId: number, normalizedAlias: string): Promise<{ id: number; field_id: number; name: string; field_name: string; area_hectares: number | null; soil_type: string | null; created_at: Date } | null>;
export function addPlotAlias(plotId: number, normalizedAlias: string): Promise<void>;
export function getConversationState(userId: number): Promise<{ user_id: number; last_plot_id: number | null; last_field_id: number | null; updated_at: Date; plot_name: string | null; field_name: string | null; last_intent: string | null; last_activity_type: string | null; last_query_type: string | null; last_time_reference: string | null } | null>;
export function updateConversationState(userId: number, fieldId: number | null, plotId: number | null): Promise<void>;
export function updateConversationMiniMemory(userId: number, data: {
  lastIntent?: string | null;
  lastActivityType?: string | null;
  lastQueryType?: string | null;
  lastTimeReference?: string | null;
}): Promise<void>;
export function getUserSingleField(userId: number): Promise<{ id: number; user_id: number; name: string; city: string | null; province: string | null } | null>;
export function getPlotById(plotId: number): Promise<{ id: number; field_id: number; name: string; field_name: string; area_hectares: number | null; soil_type: string | null; created_at: Date } | null>;

// --- Domain events ---
export function saveDomainEvent(userId: number, data: {
  plotId?: number | null;
  plotCropId?: number | null;
  eventType: string;
  eventDate?: Date | null;
  crop?: string | null;
  product?: string | null;
  productType?: string | null;
  quantity?: number | null;
  unit?: string | null;
  implement?: string | null;
  notes?: string | null;
}): Promise<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date }>;

export function getDomainEventsByPlot(plotId: number, limit?: number): Promise<Array<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date; plot_name: string | null; field_name: string | null }>>;

export function getDomainEventsByUser(userId: number, limit?: number): Promise<Array<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date; plot_name: string | null; field_name: string | null }>>;

export function getLastDomainEvent(userId: number): Promise<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date; plot_name: string | null; field_name: string | null } | null>;

export function deleteDomainEvent(eventId: number): Promise<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date } | null>;

// --- Plot crops ---
export function createPlotCrop(plotId: number, crop: string, seasonYear: number, seasonType: string, startDate?: Date | null): Promise<{ id: number; plot_id: number; crop: string; season_year: number; season_type: string; start_date: Date; end_date: Date | null; created_at: Date }>;
export function closePlotCrop(plotCropId: number, endDate?: Date | null): Promise<{ id: number; plot_id: number; crop: string; season_year: number; season_type: string; start_date: Date; end_date: Date | null; created_at: Date } | null>;
export function getActiveCrop(plotId: number): Promise<{ id: number; plot_id: number; crop: string; season_year: number; season_type: string; start_date: Date; end_date: Date | null; created_at: Date } | null>;
export function getPlotCropHistory(plotId: number): Promise<Array<{ id: number; plot_id: number; crop: string; season_year: number; season_type: string; start_date: Date; end_date: Date | null; created_at: Date }>>;
export function getPlotCropBySeason(plotId: number, seasonYear: number, crop: string): Promise<{ id: number; plot_id: number; crop: string; season_year: number; season_type: string; start_date: Date; end_date: Date | null; created_at: Date } | null>;

// --- Plots ---
export function getOrCreatePlot(fieldId: number, name: string): Promise<{ id: number; field_id: number; name: string; area_hectares: number | null; soil_type: string | null; created_at: Date }>;
export function getPlotByName(fieldId: number, plotName: string): Promise<{ id: number; field_id: number; name: string; area_hectares: number | null; soil_type: string | null; created_at: Date } | null>;
export function getPlotsByField(fieldId: number): Promise<Array<{ id: number; field_id: number; name: string; area_hectares: number | null; soil_type: string | null; created_at: Date }>>;
export function findPlotByNameAcrossFields(userId: number, plotName: string): Promise<Array<{ id: number; field_id: number; name: string; field_name: string; area_hectares: number | null; soil_type: string | null; created_at: Date }>>;
export function findAllUserPlots(userId: number): Promise<Array<{ id: number; name: string; field_name: string; area_hectares: number | null }>>;
export function deletePlot(plotId: number, userId?: number | null): Promise<boolean>;
export function restorePlot(userId: number, plotName: string, fieldName: string): Promise<{ id: number; field_id: number; name: string } | null>;
export function setPlotArea(plotId: number, hectares: number): Promise<void>;
export function setPlotGrupo(plotId: number, grupo: string): Promise<void>;
export function findPlotsByGrupo(userId: number, grupo: string): Promise<Array<{ id: number; field_id: number; name: string; field_name: string; area_hectares: number | null; soil_type: string | null; grupo: string | null; created_at: Date }>>;
export function getPlotInfo(userId: number, plotName: string): Promise<{ name: string; field_name: string; area_hectares: number | null; soil_type: string | null; expenses: { total: number; count: number }; incomes: { total: number; count: number }; rainfall: { total: number; count: number } } | null>;

// --- Plot history query ---
export function queryPlotHistory(userId: number, opts?: {
  plotId?: number | null;
  fieldId?: number | null;
  desde?: Date | null;
  hasta?: Date | null;
  activityFilter?: string | null;
  limit?: number;
}): Promise<Array<{
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
}>>;

// --- Harvest loads ---
export interface HarvestLoadRow {
  id: number;
  domain_event_id: number;
  plot_crop_id: number | null;
  driver_name: string;
  weight_kg: number;
  destination: string | null;
  destinatario: string | null;
  truck_plate: string | null;
  notes: string | null;
  created_at: Date;
}
export interface HarvestLoadInput {
  driver_name: string;
  weight_kg: number;
  destination?: string | null;
  destinatario?: string | null;
  truck_plate?: string | null;
}
export function saveHarvestLoads(domainEventId: number, plotCropId: number | null, loads: HarvestLoadInput[]): Promise<HarvestLoadRow[]>;
export function getHarvestLoads(domainEventId: number): Promise<HarvestLoadRow[]>;
export function findTodayHarvestEvent(userId: number, plotId: number): Promise<{ id: number; user_id: number; plot_id: number; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; created_at: Date } | null>;
export function updateYieldFromLoads(plotCropId: number): Promise<void>;
export interface HarvestLoadQueryRow extends HarvestLoadRow {
  event_date: Date;
  crop: string | null;
  plot_name: string | null;
  field_name: string | null;
}
export function queryHarvestLoads(userId: number, opts?: {
  plotId?: number | null;
  fieldId?: number | null;
  desde?: string | null;
  hasta?: string | null;
  driverName?: string | null;
  destinatario?: string | null;
}): Promise<HarvestLoadQueryRow[]>;
export function getHarvestLoadsByCampaign(plotCropId: number): Promise<Array<HarvestLoadRow & { event_date: Date }>>;
