import {
  saveExpense as _saveExpense,
  saveIncome as _saveIncome,
  getLastExpense as _getLastExpense,
  getLastIncome as _getLastIncome,
  deleteExpense as _deleteExpense,
  deleteIncome as _deleteIncome,
  updateExpenseAmount as _updateExpenseAmount,
  findExpenseByFilter as _findExpenseByFilter,
  getMonthlyReport as _getMonthlyReport,
  getMonthlyReportByPlot as _getMonthlyReportByPlot,
  getMonthlyReportForMonth as _getMonthlyReportForMonth,
  getWeeklyReport as _getWeeklyReport,
  getDateRangeReport as _getDateRangeReport,
  getMonthlyExpenses as _getMonthlyExpenses,
  getMonthlyIncomeReport as _getMonthlyIncomeReport,
  getMonthlyIncomeForMonth as _getMonthlyIncomeForMonth,
  getMonthlyResult as _getMonthlyResult,
  getFieldResult as _getFieldResult,
  getFieldReport as _getFieldReport,
  setBudget as _setBudget,
  getBudget as _getBudget,
  getCategoryMonthlyTotal as _getCategoryMonthlyTotal,
  checkBudgetAlert as _checkBudgetAlert,
  saveUnparsedMessage as _saveUnparsedMessage,
} from '../../services/expenses.js';
import { PlotRepository } from '../plots/plot.repository.js';
import type {
  UserId,
  ParsedExpense,
  ParsedIncome,
  ExpenseRow,
  IncomeRow,
  FieldRow,
  PlotRow,
  CategoryTotal,
  MonthlyResult,
  FieldInfoData,
  PlotInfoData,
} from '../../types/index.js';

export class FinancialRepository {
  private plots: PlotRepository;

  constructor(plotRepo?: PlotRepository) {
    this.plots = plotRepo ?? new PlotRepository();
  }

  // --- Expenses ---

  async saveExpense(userId: UserId, data: ParsedExpense, fieldId: number | null = null, plotId: number | null = null): Promise<{ id: number }> {
    const result = await _saveExpense(userId, data, fieldId, plotId);
    return { id: result.id };
  }

  async getLastExpense(userId: UserId): Promise<ExpenseRow | null> {
    const row = await _getLastExpense(userId);
    if (!row) return null;
    row.amount = Number(row.amount);
    return row as ExpenseRow;
  }

  async deleteExpense(expenseId: number): Promise<void> {
    await _deleteExpense(expenseId);
  }

  async updateExpenseAmount(expenseId: number, newAmount: number): Promise<void> {
    await _updateExpenseAmount(expenseId, newAmount);
  }

  async findExpenseByFilter(userId: UserId, filter: string): Promise<ExpenseRow | null> {
    const row = await _findExpenseByFilter(userId, filter);
    if (!row) return null;
    row.amount = Number(row.amount);
    return row as ExpenseRow;
  }

  // --- Incomes ---

  async saveIncome(userId: UserId, data: ParsedIncome, fieldId: number | null = null, plotId: number | null = null): Promise<{ id: number }> {
    const result = await _saveIncome(userId, data, fieldId, plotId);
    return { id: result.id };
  }

  async getLastIncome(userId: UserId): Promise<IncomeRow | null> {
    const row = await _getLastIncome(userId);
    if (!row) return null;
    row.amount = Number(row.amount);
    return row as IncomeRow;
  }

  async deleteIncome(incomeId: number): Promise<void> {
    await _deleteIncome(incomeId);
  }

  // --- Reports ---

  async getMonthlyReport(userId: UserId): Promise<CategoryTotal[]> {
    const rows = await _getMonthlyReport(userId);
    return rows.map((r: CategoryTotal) => ({ category: r.category, total: Number(r.total) }));
  }

  async getMonthlyReportByPlot(userId: UserId): Promise<Array<{ plot_name: string; field_name: string; expense_total: number; income_total: number }>> {
    const rows = await _getMonthlyReportByPlot(userId);
    return rows.map((r: any) => ({
      plot_name: r.plot_name,
      field_name: r.field_name,
      expense_total: Number(r.expense_total),
      income_total: Number(r.income_total),
    }));
  }

  async getMonthlyReportForMonth(userId: UserId, month: number, year: number): Promise<CategoryTotal[]> {
    const rows = await _getMonthlyReportForMonth(userId, month, year);
    return rows.map((r: CategoryTotal) => ({ category: r.category, total: Number(r.total) }));
  }

  async getWeeklyReport(userId: UserId): Promise<CategoryTotal[]> {
    const rows = await _getWeeklyReport(userId);
    return rows.map((r: CategoryTotal) => ({ category: r.category, total: Number(r.total) }));
  }

  async getDateRangeReport(userId: UserId, desde: Date, hasta: Date, opts?: { fieldName?: string | null; plotName?: string | null; category?: string | null; type?: string }): Promise<any> {
    return _getDateRangeReport(userId, desde, hasta, opts);
  }

  async getMonthlyExpenses(userId: UserId): Promise<ExpenseRow[]> {
    const rows = await _getMonthlyExpenses(userId);
    return rows as unknown as ExpenseRow[];
  }

  async getMonthlyIncomeReport(userId: UserId): Promise<CategoryTotal[]> {
    const rows = await _getMonthlyIncomeReport(userId);
    return rows.map((r: CategoryTotal) => ({ category: r.category, total: Number(r.total) }));
  }

  async getMonthlyIncomeForMonth(userId: UserId, month: number, year: number): Promise<CategoryTotal[]> {
    const rows = await _getMonthlyIncomeForMonth(userId, month, year);
    return rows.map((r: CategoryTotal) => ({ category: r.category, total: Number(r.total) }));
  }

  // --- Results ---

  async getMonthlyResult(userId: UserId): Promise<MonthlyResult> {
    const result = await _getMonthlyResult(userId);
    return { ingresos: Number(result.ingresos), gastos: Number(result.gastos) };
  }

  async getFieldResult(userId: UserId, fieldName: string): Promise<MonthlyResult> {
    const result = await _getFieldResult(userId, fieldName);
    return { ingresos: Number(result.ingresos), gastos: Number(result.gastos) };
  }

  async getFieldReport(userId: UserId, fieldName: string): Promise<CategoryTotal[]> {
    const rows = await _getFieldReport(userId, fieldName);
    return rows.map((r: CategoryTotal) => ({ category: r.category, total: Number(r.total) }));
  }

  // --- Budgets ---

  async setBudget(userId: UserId, category: string, amount: number): Promise<void> {
    await _setBudget(userId, category, amount);
  }

  async getBudget(userId: UserId, category: string): Promise<{ monthly_limit: string } | null> {
    return _getBudget(userId, category);
  }

  async getCategoryMonthlyTotal(userId: UserId, category: string): Promise<number> {
    return _getCategoryMonthlyTotal(userId, category);
  }

  async checkBudgetAlert(total: number, limit: number, category: string, userName: string | null, userId: UserId, globalSettings?: { budget_alert_80?: boolean; budget_alert_100?: boolean } | null): Promise<string | null> {
    return _checkBudgetAlert(total, limit, category, userName, userId, globalSettings);
  }

  // --- Fields (delegated to PlotRepository) ---

  async getOrCreateField(userId: UserId, name: string): Promise<FieldRow> {
    return this.plots.getOrCreateField(userId, name);
  }

  async setFieldCity(userId: UserId, fieldName: string, city: string, province?: string | null): Promise<void> {
    await this.plots.setFieldCity(userId, fieldName, city, province);
  }

  async getFieldByName(userId: UserId, fieldName: string): Promise<FieldRow | null> {
    return this.plots.getFieldByName(userId, fieldName);
  }

  async getUserFieldsWithCity(userId: UserId): Promise<{ name: string; city: string; province: string | null }[]> {
    return this.plots.getUserFieldsWithCity(userId);
  }

  async getUserFields(userId: UserId): Promise<{ name: string; city: string | null; province: string | null }[]> {
    return this.plots.getUserFields(userId);
  }

  async getUserFieldCount(userId: UserId): Promise<number> {
    return this.plots.getUserFieldCount(userId);
  }

  async deleteField(userId: UserId, fieldName: string): Promise<boolean> {
    return this.plots.deleteField(userId, fieldName);
  }

  async restoreField(userId: UserId, fieldName: string): Promise<FieldRow | null> {
    return this.plots.restoreField(userId, fieldName);
  }

  async renameField(userId: UserId, oldName: string, newName: string): Promise<boolean> {
    return this.plots.renameField(userId, oldName, newName);
  }

  async renamePlot(userId: UserId, oldName: string, newName: string, fieldName?: string | null): Promise<{ id: number; oldName: string; newName: string; fieldName: string } | null> {
    return this.plots.renamePlot(userId, oldName, newName, fieldName);
  }

  async getFieldInfo(userId: UserId, fieldName: string): Promise<FieldInfoData | null> {
    return this.plots.getFieldInfo(userId, fieldName);
  }

  // --- Plots (delegated to PlotRepository) ---

  async getOrCreatePlot(fieldId: number, name: string): Promise<PlotRow> {
    return this.plots.getOrCreatePlot(fieldId, name);
  }

  async getPlotsByField(fieldId: number): Promise<PlotRow[]> {
    return this.plots.getPlotsByField(fieldId);
  }

  async findPlotByNameAcrossFields(userId: UserId, plotName: string): Promise<Array<PlotRow & { field_name: string }>> {
    return this.plots.findPlotByNameAcrossFields(userId, plotName);
  }

  async findAllUserPlots(userId: UserId): Promise<Array<{ id: number; name: string; field_name: string }>> {
    return this.plots.findAllUserPlots(userId);
  }

  async deletePlot(plotId: number, userId?: UserId | null): Promise<boolean> {
    return this.plots.deletePlot(plotId, userId);
  }

  async restorePlot(userId: UserId, plotName: string, fieldName: string): Promise<PlotRow | null> {
    return this.plots.restorePlot(userId, plotName, fieldName);
  }

  async setPlotArea(plotId: number, hectares: number): Promise<void> {
    return this.plots.setPlotArea(plotId, hectares);
  }

  async setPlotGrupo(plotId: number, grupo: string): Promise<void> {
    return this.plots.setPlotGrupo(plotId, grupo);
  }

  async getPlotInfo(userId: UserId, plotName: string): Promise<PlotInfoData | null> {
    return this.plots.getPlotInfo(userId, plotName);
  }

  async getPlotReport(userId: UserId, plotName: string): Promise<{ rows: CategoryTotal[]; plotName: string; fieldName: string; incomeTotal: number } | null> {
    return this.plots.getPlotReport(userId, plotName);
  }

  async getPlotResult(userId: UserId, plotName: string): Promise<{ ingresos: number; gastos: number; plotName: string; fieldName: string } | null> {
    return this.plots.getPlotResult(userId, plotName);
  }

  // --- Unparsed ---

  async saveUnparsedMessage(userId: UserId, message: string): Promise<void> {
    await _saveUnparsedMessage(userId, message);
  }
}
