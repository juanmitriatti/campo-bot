// Type declarations for expenses.js functions where TS inference from `= null` defaults
// produces `null | undefined` instead of accepting `number | null`.

export function saveExpense(userId: number, data: Record<string, unknown> | { amount: number; category: string; description: string; currency: string; type?: string }, fieldId?: number | null, plotId?: number | null): Promise<{ id: number }>;
export function saveIncome(userId: number, data: Record<string, unknown> | { amount: number; category: string; description: string; currency: string; type?: string; quantity?: number | null; unit?: string | null; unit_price?: number | null }, fieldId?: number | null, plotId?: number | null): Promise<{ id: number }>;
export const RAINFALL_REJECTED_DUPLICATE: { _rejected: string };
export function saveRainfall(userId: number, mm: number, fieldId?: number | null, rainfallDate?: Date | string | null): Promise<unknown>;
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
// Declaraba 3 params y un array plano; en realidad acepta filtros y devuelve
// gastos + ingresos agrupados por categoría y moneda, con sus totales.
export function getDateRangeReport(userId: number, desde: Date, hasta: Date, opts?: {
  fieldName?: string | null;
  plotName?: string | null;
  category?: string | null;
  type?: 'expenses' | 'incomes' | 'both';
}): Promise<{
  expenses: Array<{ category: string; currency: string; total: string | number }>;
  incomes: Array<{ category: string; currency: string; total: string | number }>;
  expenseTotal: number;
  incomeTotal: number;
}>;
export function getMonthlyExpenses(userId: number): Promise<Array<{ id: number; category: string; amount: string | number; description: string; currency: string; user_id: number; field_id: number | null; expense_date: Date; created_at: Date; deleted_at: Date | null }>>;
export interface MovementRow { id: number; date: Date | string; category: string; description: string | null; product?: string | null; amount: string | number; currency: string; quantity?: string | number | null; unit?: string | null; field_name: string | null; plot_name: string | null }
export function getMovementsInRange(userId: number, desde: Date | string, hasta: Date | string, opts?: { fieldName?: string | null; plotName?: string | null; category?: string | null; type?: 'expenses' | 'incomes' | 'both'; limit?: number }): Promise<{ expenses: MovementRow[]; incomes: MovementRow[] }>;
export interface MovementsFilter {
  fieldName?: string | null; plotName?: string | null;
  desde?: Date | string | null; hasta?: Date | string | null;
  category?: string | null; categories?: string[]; excludeCategories?: string[];
  currency?: string | null;
  amountMin?: number | null; amountMax?: number | null;
  descriptionSearch?: string | null;
  type?: 'expenses' | 'incomes' | 'both';
  sortBy?: 'date' | 'amount'; sortDesc?: boolean;
  limit?: number;
  // queryMovements lo ignora — el handler arma UN solo objeto de filtros y usa
  // groupBy para agrupar/renderizar del lado suyo. Se declara para que ese
  // objeto compilable no falle por exceso de propiedades.
  groupBy?: 'category' | 'plot' | 'field' | 'month';
}
export function queryMovements(userId: number, opts?: MovementsFilter): Promise<{ expenses: MovementRow[]; incomes: MovementRow[] }>;
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
// El SELECT trae id, location_method, plot_count y total_hectares además del
// nombre y la ubicación; los consumidores ya leían .id sin que el tipo lo dijera.
export function getUserFields(userId: number): Promise<Array<{ id: number; name: string; city: string | null; province: string | null; location_method: string | null; plot_count: number; total_hectares: string | number }>>;
export function getMonthlyResultByCurrency(userId: number): Promise<Record<string, { ingresos: number; gastos: number }>>;
export function getUserFieldCount(userId: number): Promise<number>;
export function deleteField(userId: number, fieldName: string): Promise<boolean>;
export function restoreField(userId: number, fieldName: string): Promise<{ id: number; user_id: number; name: string; city: string | null; province: string | null } | null>;
export function renameField(userId: number, oldName: string, newName: string): Promise<boolean>;
export function getFieldInfo(userId: number, fieldName: string): Promise<{ name: string; city: string | null; province: string | null; expenses: { total: number; count: number }; incomes: { total: number; count: number }; rainfall: { total: number; count: number }; plotCount: number } | null>;
export function saveUnparsedMessage(userId: number, message: string): Promise<void>;
export function getDailyClaudeCount(userId: number): Promise<number>;
// El INSERT guarda los 4 tipos de token; la declaración cubría 2.
export function saveAiUsage(userId: number, usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number }): Promise<void>;
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
// userId es opcional y scopea la búsqueda al dueño; el .js siempre lo aceptó.
export function getPlotById(plotId: number, userId?: number | null): Promise<{ id: number; field_id: number; name: string; field_name: string; area_hectares: number | null; soil_type: string | null; created_at: Date } | null>;

// --- Domain events ---
// El INSERT real escribe 18 columnas; la declaración cubría 11. Faltaban las de
// hacienda (corral/categoría/afectados) y las de tacto. eventDate acepta string
// ISO además de Date: va directo a una columna DATE.
export function saveDomainEvent(userId: number, data: {
  plotId?: number | null;
  plotCropId?: number | null;
  corralId?: number | null;
  eventType: string;
  eventDate?: Date | string | null;
  crop?: string | null;
  product?: string | null;
  productType?: string | null;
  quantity?: number | null;
  unit?: string | null;
  implement?: string | null;
  notes?: string | null;
  pregnantCount?: number | null;
  openCount?: number | null;
  uncertainCount?: number | null;
  animalCategory?: string | null;
  animalsAffected?: number | null;
}): Promise<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date }>;

export function getDomainEventsByPlot(plotId: number, limit?: number): Promise<Array<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date; plot_name: string | null; field_name: string | null }>>;

export function getDomainEventsByUser(userId: number, limit?: number): Promise<Array<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date; plot_name: string | null; field_name: string | null }>>;

export function getLastDomainEvent(userId: number): Promise<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date; plot_name: string | null; field_name: string | null } | null>;

export function deleteDomainEvent(eventId: number): Promise<{ id: number; user_id: number; plot_id: number | null; plot_crop_id: number | null; event_type: string; event_date: Date; crop: string | null; product: string | null; product_type: string | null; quantity: number | null; unit: string | null; implement: string | null; notes: string | null; created_at: Date } | null>;

// --- Plot crops ---
export function createPlotCrop(plotId: number, crop: string, seasonYear: number, seasonType: string, startDate?: Date | null, sowedHectares?: number | null, variety?: string | null): Promise<{ id: number; plot_id: number; crop: string; season_year: number; season_type: string; start_date: Date; end_date: Date | null; created_at: Date }>;
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
  humidity_pct: number | null;
  quality_metrics: Record<string, unknown> | null;
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
export function findHarvestsToday(userId: number): Promise<Array<{ plot_id: number; plot_name: string; field_name: string; crop: string | null }>>;
export function updateYieldFromLoads(plotCropId: number): Promise<void>;
export interface HarvestLoadQueryRow extends HarvestLoadRow {
  event_date: Date;
  crop: string | null;
  // El SELECT hace `de.plot_id` junto a plot_name/field_name; faltaba acá.
  plot_id: number | null;
  plot_name: string | null;
  field_name: string | null;
}
// Declaraba 6 filtros; el destructuring real acepta 22 (calidad por cultivo,
// rangos de peso y humedad, orden y límite).
export function queryHarvestLoads(userId: number, opts?: {
  plotId?: number | null;
  fieldId?: number | null;
  crop?: string | null;
  eventDate?: Date | string | null;
  desde?: Date | string | null;
  hasta?: Date | string | null;
  driverName?: string | null;
  destinatario?: string | null;
  truckPlate?: string | null;
  weightMinKg?: number | null; weightMaxKg?: number | null;
  humidityMinPct?: number | null; humidityMaxPct?: number | null;
  proteinMinPct?: number | null; proteinMaxPct?: number | null;
  oilMinPct?: number | null; oilMaxPct?: number | null;
  glutenMinPct?: number | null; glutenMaxPct?: number | null;
  sortBy?: 'date' | 'weight' | 'humidity' | 'protein' | 'oil' | 'gluten';
  sortDesc?: boolean;
  limit?: number;
}): Promise<HarvestLoadQueryRow[]>;
export function getHarvestLoadsByCampaign(plotCropId: number): Promise<Array<HarvestLoadRow & { event_date: Date }>>;
export function deleteHarvestLoads(userId: number, plotId: number, opts?: {
  eventDate?: string;
  driverNames?: string[];
  onlyWithoutDestination?: boolean;
}): Promise<HarvestLoadRow[]>;

// ---------------------------------------------------------------------------
// Superficie legacy que faltaba declarar. Este .d.ts hace shadow de
// expenses.js, así que TODO lo que el .js exporta y no esté acá se ve como
// "has no exported member" aunque exista. Los tipos de retorno son
// permisivos a propósito: el .js devuelve filas crudas de pg y declarar
// formas inventadas sería peor que declararlas abiertas. Ajustar de a una
// cuando se toque el handler correspondiente.
// ---------------------------------------------------------------------------

// Usuarios / canal
export function getOrCreateUserByTelegramId(telegramId: string | number, name?: string | null): Promise<any>;

// Settings
export function getGlobalSettings(): Promise<any>;

// Observaciones
export function getLastObservation(userId: number): Promise<any | null>;
export function deleteObservation(observationId: number): Promise<any>;
export function updateObservationFields(observationId: number, fields?: {
  observationText?: string | null;
  observationDate?: string | null;
  fieldId?: number | null;
  plotId?: number | null;
}): Promise<any>;

// Monitoreos (scouting)
export function getLastScouting(userId: number): Promise<any | null>;
export function deleteScouting(scoutingId: number): Promise<any>;
export function getScoutingsForPlotCampaign(plotCropId: number): Promise<any[]>;

// Lluvias
export function updateRainfallFields(rainfallId: number, fields?: {
  millimeters?: number | null;
  rainfallDate?: string | null;
  fieldId?: number | null;
  plotId?: number | null;
}): Promise<any>;

// Gastos e ingresos
export function updateExpenseFields(expenseId: number, fields?: {
  amount?: number | null;
  category?: string | null;
  expenseDate?: string | null;
  fieldId?: number | null;
  plotId?: number | null;
  currency?: string | null;
}): Promise<any>;
export function updateIncomeFields(incomeId: number, fields?: {
  amount?: number | null;
  category?: string | null;
  incomeDate?: string | null;
  fieldId?: number | null;
  plotId?: number | null;
}): Promise<any>;
export function findIncomeByCriteria(userId: number, criteria?: {
  amount?: number | null;
  category?: string | null;
  date?: string | null;
}): Promise<any | null>;

// Domain events
export function findLastDomainEventFiltered(userId: number, filters?: Record<string, any>): Promise<any | null>;
export function getDomainEventsByFieldDateRange(fieldId: number, desde: string, hasta: string): Promise<any[]>;
export function updateDomainEventPlot(eventId: number, plotId: number | null, editedBy: number, extraFields?: Record<string, any>): Promise<any>;

// Campañas
export function getCampaignActivities(plotCropId: number): Promise<any[]>;
export function getCampaignExpenses(plotId: number, startDate: Date | string, endDate?: Date | string | null): Promise<any[]>;
export function getCampaignIncomes(plotId: number, startDate: Date | string, endDate?: Date | string | null): Promise<any[]>;
export function getCampaignObservations(plotId: number, startDate: Date | string, endDate?: Date | string | null): Promise<any[]>;
export function setPlotCropHarvested(cropId: number, harvestedAt: Date | string, yieldKg?: number | null, yieldNotes?: string | null): Promise<any>;

// Lotes
export function renamePlot(userId: number, oldName: string, newName: string, fieldName?: string | null): Promise<any>;

// Actividades
export function getActivityStats(userId: number, opts?: {
  fieldId?: number | null;
  plotId?: number | null;
  activityFilter?: string | null;
  desde?: string | null;
  hasta?: string | null;
  grupo?: string | null;
}): Promise<any>;

// Hacienda
export function queryLivestockEvents(userId: number, eventType: string, opts?: {
  fieldId?: number | null;
  plotId?: number | null;
  corralId?: number | null;
  category?: string | null;
  subtype?: string | null;
  desde?: string | null;
  hasta?: string | null;
  limit?: number;
}): Promise<any[]>;
export function getTactoSummary(userId: number, opts?: {
  fieldId?: number | null;
  plotId?: number | null;
  corralId?: number | null;
  desde?: string | null;
  hasta?: string | null;
}): Promise<any>;
export function updateLivestockGroupWeight(userId: number, params: {
  category: string;
  plotId?: number | null;
  corralId?: number | null;
  avgWeightKg: number;
}): Promise<any>;

// Query builders de los dominios unificados (se consumen vía `await import()`,
// por eso faltaban como propiedades del módulo y no como named imports).
export function queryActivities(opts?: Record<string, any>): Promise<any[]>;
export function queryRainfall(opts?: Record<string, any>): Promise<any[]>;
export function queryScoutings(opts?: Record<string, any>): Promise<any[]>;
export function saveCropScouting(userId: number, data: Record<string, any>): Promise<any>;
export function syncPlotCropFromEdit(plotCropId: number, fields?: {
  crop?: string | null;
  plotId?: number | null;
  sowedHectares?: number | null;
}): Promise<any>;
export function updatePlotCropYield(cropId: number, yieldKg: number, yieldNotes?: string | null): Promise<any>;

// Existían en el .js pero no acá, así que TS las reportaba como inexistentes
// (con un "did you mean" que apuntaba a la función equivocada).
export function getLastRainfall(userId: number): Promise<any | null>;
export function getDomainEventsByPlotDateRange(plotId: number, desde: string, hasta: string): Promise<any[]>;
export function findExpenseByCriteria(userId: number, criteria?: {
  amount?: number | null;
  category?: string | null;
  date?: string | null;
}): Promise<any | null>;
export function getMonthlyReportByPlot(userId: number): Promise<any>;
export function getAllActiveCrops(userId: number, cropFilter?: string | null, grupo?: string | null): Promise<any[]>;
