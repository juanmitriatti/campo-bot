import { FinancialRepository } from './financial.repository.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { getGlobalSettings } from '../../services/expenses.js';
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

  async resolveFieldAndPlot(userId: UserId, text: string, claudeField?: string | null): Promise<FieldInfo> {
    const result = await this.plotDiscovery.resolve(userId, text, claudeField);
    return { fieldId: result.fieldId, fieldName: result.fieldName, plotId: result.plotId, plotName: result.plotName };
  }

  // Backward compat wrapper
  async resolveField(userId: UserId, text: string, claudeField?: string | null): Promise<FieldInfo> {
    return this.resolveFieldAndPlot(userId, text, claudeField);
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

  async getMonthlyReportForMonth(userId: UserId, month: number, year: number): Promise<CategoryTotal[]> {
    return this.repo.getMonthlyReportForMonth(userId, month, year);
  }

  async getWeeklyReport(userId: UserId): Promise<CategoryTotal[]> {
    return this.repo.getWeeklyReport(userId);
  }

  async getDateRangeReport(userId: UserId, desde: Date, hasta: Date): Promise<CategoryTotal[]> {
    return this.repo.getDateRangeReport(userId, desde, hasta);
  }

  async getFieldReport(userId: UserId, fieldName: string): Promise<CategoryTotal[]> {
    return this.repo.getFieldReport(userId, fieldName);
  }

  async getPlotReport(userId: UserId, plotName: string): Promise<{ rows: CategoryTotal[]; plotName: string; fieldName: string } | null> {
    return this.repo.getPlotReport(userId, plotName);
  }

  async getMonthlyResult(userId: UserId): Promise<MonthlyResult> {
    return this.repo.getMonthlyResult(userId);
  }

  async getFieldResult(userId: UserId, fieldName: string): Promise<MonthlyResult> {
    return this.repo.getFieldResult(userId, fieldName);
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

  async setFieldCity(userId: UserId, fieldName: string, city: string) {
    await this.repo.setFieldCity(userId, fieldName, city);
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

  async setPlotCoords(plotId: number, lat: number, lng: number) {
    return this.repo.setPlotCoords(plotId, lat, lng);
  }

  async getPlotInfo(userId: UserId, plotName: string): Promise<PlotInfoData | null> {
    return this.repo.getPlotInfo(userId, plotName);
  }

  // --- Unparsed ---

  async saveUnparsedMessage(userId: UserId, message: string) {
    await this.repo.saveUnparsedMessage(userId, message);
  }
}
