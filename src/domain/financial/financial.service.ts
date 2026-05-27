import { FinancialRepository } from './financial.repository.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { getGlobalSettings, getConversationState } from '../../services/expenses.js';
import type {
  UserId,
  ParsedExpense,
  ParsedIncome,
  FieldInfo,
  CategoryTotal,
  MonthlyResult,
  FieldInfoData,
  PlotInfoData,
} from '../../types/index.js';

export class FinancialService {
  private plotDiscovery = new PlotDiscoveryService();

  constructor(private repo: FinancialRepository) {}

  // --- Field + Plot resolution ---

  async resolveFieldAndPlot(userId: UserId, fieldName?: string | null, plotName?: string | null): Promise<FieldInfo> {
    const result = await this.plotDiscovery.resolve(userId, fieldName, plotName);
    return {
      fieldId: result.fieldId, fieldName: result.fieldName,
      plotId: result.plotId, plotName: result.plotName,
      notFound: result.notFound,
      needPlotSelection: result.needPlotSelection,
      needPlotCreation: result.needPlotCreation,
    };
  }

  // Backward compat wrapper
  async resolveField(userId: UserId, fieldName?: string | null, plotName?: string | null): Promise<FieldInfo> {
    return this.resolveFieldAndPlot(userId, fieldName, plotName);
  }

  // --- Expense operations ---

  async saveExpense(userId: UserId, data: ParsedExpense, fieldId: number | null, plotId: number | null = null): Promise<{ id: number }> {
    return this.repo.saveExpense(userId, data, fieldId, plotId);
  }

  async deleteLastExpense(userId: UserId): Promise<{ category: string; amount: number } | null> {
    const last = await this.repo.getLastExpense(userId);
    if (!last) return null;
    await this.repo.deleteExpense(last.id);
    return { category: last.category, amount: Number(last.amount) };
  }

  async deleteExpense(expenseId: number): Promise<void> {
    await this.repo.deleteExpense(expenseId);
  }

  async findLastExpenseByCategory(userId: UserId, categoryFilter: string | null) {
    return this.repo.findLastExpenseByCategory(userId, categoryFilter);
  }

  async updateExpensePlot(expenseId: number, fieldId: number | null, plotId: number | null): Promise<void> {
    return this.repo.updateExpensePlot(expenseId, fieldId, plotId);
  }

  async deleteSpecificExpense(userId: UserId, filter: string): Promise<{ category: string; amount: number } | null> {
    const expense = await this.repo.findExpenseByFilter(userId, filter);
    if (!expense) return null;
    await this.repo.deleteExpense(expense.id);
    return { category: expense.category, amount: Number(expense.amount) };
  }

  async editSpecificExpense(userId: UserId, filter: string, newAmount: number): Promise<{ category: string; oldAmount: number } | null> {
    const expense = await this.repo.findExpenseByFilter(userId, filter);
    if (!expense) return null;
    const oldAmount = Number(expense.amount);
    await this.repo.updateExpenseAmount(expense.id, newAmount);
    return { category: expense.category, oldAmount };
  }

  async editLastExpense(userId: UserId, newAmount: number): Promise<{ category: string; oldAmount: number } | null> {
    const last = await this.repo.getLastExpense(userId);
    if (!last) return null;
    const oldAmount = Number(last.amount);
    await this.repo.updateExpenseAmount(last.id, newAmount);
    return { category: last.category, oldAmount };
  }

  // --- Income operations ---

  async saveIncome(userId: UserId, data: ParsedIncome, fieldId: number | null, plotId: number | null = null): Promise<{ id: number }> {
    return this.repo.saveIncome(userId, data, fieldId, plotId);
  }

  async deleteLastIncome(userId: UserId): Promise<{ category: string; amount: number } | null> {
    const last = await this.repo.getLastIncome(userId);
    if (!last) return null;
    await this.repo.deleteIncome(last.id);
    return { category: last.category, amount: Number(last.amount) };
  }

  // --- Structured edit / delete (handle the new agent tools) ---

  async deleteSpecificExpenseByCriteria(userId: UserId, criteria: { amount?: number | null; category?: string | null; date?: string | null }): Promise<{ category: string; amount: number } | null> {
    const row = await this.repo.findExpenseByCriteria(userId, criteria);
    if (!row) return null;
    await this.repo.deleteExpense(row.id);
    return { category: row.category, amount: Number(row.amount) };
  }

  async deleteSpecificIncomeByCriteria(userId: UserId, criteria: { amount?: number | null; category?: string | null; date?: string | null }): Promise<{ category: string; amount: number } | null> {
    const row = await this.repo.findIncomeByCriteria(userId, criteria);
    if (!row) return null;
    await this.repo.deleteIncome(row.id);
    return { category: row.category, amount: Number(row.amount) };
  }

  /**
   * Full edit of the most-recent expense — supports any combination of new
   * amount, category, date, plot or field. Replaces the narrow editLastExpense
   * (amount-only) and updateExpensePlot (plot-only) for agent callers.
   */
  async editLastExpenseFull(
    userId: UserId,
    fields: { newAmount?: number | null; newCategory?: string | null; newDate?: string | null; newFieldId?: number | null; newPlotId?: number | null },
    categoryFilter: string | null = null,
  ): Promise<{ id: number; category: string; oldAmount: number; newAmount: number | null; oldCategory: string; newCategory: string | null } | null> {
    const last = categoryFilter
      ? await this.repo.findLastExpenseByCategory(userId, categoryFilter)
      : await this.repo.getLastExpense(userId);
    if (!last) return null;
    await this.repo.updateExpenseFields(last.id, {
      amount: fields.newAmount ?? null,
      category: fields.newCategory ?? null,
      expenseDate: fields.newDate ?? null,
      fieldId: fields.newFieldId === undefined ? undefined : fields.newFieldId,
      plotId: fields.newPlotId === undefined ? undefined : fields.newPlotId,
    });
    return {
      id: last.id,
      category: last.category,
      oldAmount: Number(last.amount),
      newAmount: fields.newAmount ?? null,
      oldCategory: last.category,
      newCategory: fields.newCategory ?? null,
    };
  }

  async editSpecificExpenseFull(
    userId: UserId,
    criteria: { amount?: number | null; category?: string | null; date?: string | null },
    fields: { newAmount?: number | null; newCategory?: string | null; newDate?: string | null; newFieldId?: number | null; newPlotId?: number | null },
  ): Promise<{ id: number; oldAmount: number; oldCategory: string } | null> {
    const row = await this.repo.findExpenseByCriteria(userId, criteria);
    if (!row) return null;
    await this.repo.updateExpenseFields(row.id, {
      amount: fields.newAmount ?? null,
      category: fields.newCategory ?? null,
      expenseDate: fields.newDate ?? null,
      fieldId: fields.newFieldId === undefined ? undefined : fields.newFieldId,
      plotId: fields.newPlotId === undefined ? undefined : fields.newPlotId,
    });
    return { id: row.id, oldAmount: Number(row.amount), oldCategory: row.category };
  }

  async editLastIncomeFull(
    userId: UserId,
    fields: { newAmount?: number | null; newCategory?: string | null; newDate?: string | null; newFieldId?: number | null; newPlotId?: number | null },
  ): Promise<{ id: number; category: string; oldAmount: number } | null> {
    const last = await this.repo.getLastIncome(userId);
    if (!last) return null;
    await this.repo.updateIncomeFields(last.id, {
      amount: fields.newAmount ?? null,
      category: fields.newCategory ?? null,
      incomeDate: fields.newDate ?? null,
      fieldId: fields.newFieldId === undefined ? undefined : fields.newFieldId,
      plotId: fields.newPlotId === undefined ? undefined : fields.newPlotId,
    });
    return { id: last.id, category: last.category, oldAmount: Number(last.amount) };
  }

  async editSpecificIncomeFull(
    userId: UserId,
    criteria: { amount?: number | null; category?: string | null; date?: string | null },
    fields: { newAmount?: number | null; newCategory?: string | null; newDate?: string | null; newFieldId?: number | null; newPlotId?: number | null },
  ): Promise<{ id: number; oldAmount: number; oldCategory: string } | null> {
    const row = await this.repo.findIncomeByCriteria(userId, criteria);
    if (!row) return null;
    await this.repo.updateIncomeFields(row.id, {
      amount: fields.newAmount ?? null,
      category: fields.newCategory ?? null,
      incomeDate: fields.newDate ?? null,
      fieldId: fields.newFieldId === undefined ? undefined : fields.newFieldId,
      plotId: fields.newPlotId === undefined ? undefined : fields.newPlotId,
    });
    return { id: row.id, oldAmount: Number(row.amount), oldCategory: row.category };
  }

  // --- Budget operations ---

  async setBudget(userId: UserId, category: string, amount: number): Promise<void> {
    await this.repo.setBudget(userId, category, amount);
  }

  async checkBudgetAlert(userId: UserId, category: string, userName: string | null): Promise<string | null> {
    const budget = await this.repo.getBudget(userId, category);
    if (!budget) return null;
    const total = await this.repo.getCategoryMonthlyTotal(userId, category);
    const globalSettings = await getGlobalSettings();
    return this.repo.checkBudgetAlert(total, Number(budget.monthly_limit), category, userName, userId, globalSettings);
  }

  // --- Reports (delegating to repository) ---

  async getMonthlyReport(userId: UserId): Promise<CategoryTotal[]> {
    return this.repo.getMonthlyReport(userId);
  }

  async getMonthlyReportByPlot(userId: UserId): Promise<Array<{ plot_name: string; field_name: string; expense_total: number; income_total: number }>> {
    return this.repo.getMonthlyReportByPlot(userId);
  }

  async getMonthlyReportForMonth(userId: UserId, month: number, year: number): Promise<CategoryTotal[]> {
    return this.repo.getMonthlyReportForMonth(userId, month, year);
  }

  async getWeeklyReport(userId: UserId): Promise<CategoryTotal[]> {
    return this.repo.getWeeklyReport(userId);
  }

  async getDateRangeReport(userId: UserId, desde: Date, hasta: Date, opts?: { fieldName?: string | null; plotName?: string | null; category?: string | null; type?: string }): Promise<any> {
    return this.repo.getDateRangeReport(userId, desde, hasta, opts);
  }

  async getFieldReport(userId: UserId, fieldName: string): Promise<CategoryTotal[]> {
    return this.repo.getFieldReport(userId, fieldName);
  }

  async getPlotReport(userId: UserId, plotName: string): Promise<{ rows: CategoryTotal[]; plotName: string; fieldName: string; incomeTotal: number } | null> {
    return this.repo.getPlotReport(userId, plotName);
  }

  async getMonthlyResult(userId: UserId): Promise<MonthlyResult> {
    return this.repo.getMonthlyResult(userId);
  }

  async getMonthlyResultByCurrency(userId: UserId): Promise<Record<string, { ingresos: number; gastos: number }>> {
    return this.repo.getMonthlyResultByCurrency(userId);
  }

  async getFieldResult(userId: UserId, fieldName: string): Promise<MonthlyResult> {
    return this.repo.getFieldResult(userId, fieldName);
  }

  async getPlotResult(userId: UserId, plotName: string): Promise<{ ingresos: number; gastos: number; plotName: string; fieldName: string } | null> {
    return this.repo.getPlotResult(userId, plotName);
  }

  async getMonthlyExpenses(userId: UserId) {
    return this.repo.getMonthlyExpenses(userId);
  }

  async getMonthlyIncomeForMonth(userId: UserId, month: number, year: number): Promise<CategoryTotal[]> {
    return this.repo.getMonthlyIncomeForMonth(userId, month, year);
  }

  // --- Fields ---

  async getOrCreateField(userId: UserId, name: string) {
    return this.repo.getOrCreateField(userId, name);
  }

  async setFieldCity(userId: UserId, fieldName: string, city: string, province?: string | null) {
    await this.repo.setFieldCity(userId, fieldName, city, province);
  }

  async getFieldByName(userId: UserId, fieldName: string) {
    return this.repo.getFieldByName(userId, fieldName);
  }

  async getUserFieldsWithCity(userId: UserId) {
    return this.repo.getUserFieldsWithCity(userId);
  }

  async getUserFields(userId: UserId) {
    return this.repo.getUserFields(userId);
  }

  async getUserFieldCount(userId: UserId): Promise<number> {
    return this.repo.getUserFieldCount(userId);
  }

  async deleteField(userId: UserId, fieldName: string) {
    return this.repo.deleteField(userId, fieldName);
  }

  async restoreField(userId: UserId, fieldName: string) {
    return this.repo.restoreField(userId, fieldName);
  }

  async renameField(userId: UserId, oldName: string, newName: string) {
    return this.repo.renameField(userId, oldName, newName);
  }

  async renamePlot(userId: UserId, oldName: string, newName: string, fieldName?: string | null) {
    return this.repo.renamePlot(userId, oldName, newName, fieldName);
  }

  async getFieldInfo(userId: UserId, fieldName: string): Promise<FieldInfoData | null> {
    return this.repo.getFieldInfo(userId, fieldName);
  }

  // --- Plots ---

  async getOrCreatePlot(fieldId: number, name: string) {
    return this.repo.getOrCreatePlot(fieldId, name);
  }

  async getPlotsByField(fieldId: number) {
    return this.repo.getPlotsByField(fieldId);
  }

  async findPlotByNameAcrossFields(userId: UserId, plotName: string) {
    return this.repo.findPlotByNameAcrossFields(userId, plotName);
  }

  async findAllUserPlots(userId: UserId) {
    return this.repo.findAllUserPlots(userId);
  }

  async deletePlot(plotId: number, userId?: UserId | null) {
    return this.repo.deletePlot(plotId, userId);
  }

  async restorePlot(userId: UserId, plotName: string, fieldName: string) {
    return this.repo.restorePlot(userId, plotName, fieldName);
  }

  async setPlotArea(plotId: number, hectares: number) {
    return this.repo.setPlotArea(plotId, hectares);
  }

  async setPlotGrupo(plotId: number, grupo: string) {
    return this.repo.setPlotGrupo(plotId, grupo);
  }

  async findPlotsByGrupo(userId: UserId, grupo: string) {
    return this.repo.findPlotsByGrupo(userId, grupo);
  }

  async getPlotInfo(userId: UserId, plotName: string): Promise<PlotInfoData | null> {
    return this.repo.getPlotInfo(userId, plotName);
  }

  // --- Conversational memory ---

  async getRecentFinancialContext(userId: UserId): Promise<{ fieldId: number; fieldName: string; plotId: number | null; plotName: string | null } | null> {
    const state = await getConversationState(userId as unknown as number);
    if (!state) return null;
    const { last_field_id, field_name, last_plot_id, plot_name, last_intent, updated_at } = state;
    if (!last_field_id || !field_name) return null;
    // Only reuse if last intent was financial and within 5 minutes
    const FINANCIAL_INTENTS = ['expense', 'income'];
    if (!last_intent || !FINANCIAL_INTENTS.includes(last_intent)) return null;
    const elapsed = Date.now() - new Date(updated_at).getTime();
    if (elapsed > 5 * 60 * 1000) return null;
    return { fieldId: last_field_id, fieldName: field_name, plotId: last_plot_id, plotName: plot_name };
  }

  // --- Unparsed ---

  async saveUnparsedMessage(userId: UserId, message: string) {
    await this.repo.saveUnparsedMessage(userId, message);
  }
}
