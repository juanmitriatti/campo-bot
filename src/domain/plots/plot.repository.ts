import {
  getOrCreateField as _getOrCreateField,
  getFieldByName as _getFieldByName,
  getUserFieldsWithCity as _getUserFieldsWithCity,
  getUserFields as _getUserFields,
  getUserFieldCount as _getUserFieldCount,
  setFieldCity as _setFieldCity,
  deleteField as _deleteField,
  restoreField as _restoreField,
  renameField as _renameField,
  renamePlot as _renamePlot,
  getFieldInfo as _getFieldInfo,
  getOrCreatePlot as _getOrCreatePlot,
  getPlotsByField as _getPlotsByField,
  findPlotByNameAcrossFields as _findPlotByNameAcrossFields,
  findAllUserPlots as _findAllUserPlots,
  deletePlot as _deletePlot,
  restorePlot as _restorePlot,
  setPlotArea as _setPlotArea,
  setPlotGrupo as _setPlotGrupo,
  findPlotsByGrupo as _findPlotsByGrupo,
  getPlotInfo as _getPlotInfo,
  getPlotReport as _getPlotReport,
  getPlotResult as _getPlotResult,
} from '../../services/expenses.js';
import type { UserId, FieldRow, PlotRow, CategoryTotal, FieldInfoData, PlotInfoData } from '../../types/index.js';

/**
 * Shared repository for field and plot operations.
 * Eliminates duplication between FinancialRepository and AgronomyRepository.
 */
export class PlotRepository {
  // --- Fields ---

  async getOrCreateField(userId: UserId, name: string): Promise<FieldRow> {
    return _getOrCreateField(userId, name) as Promise<FieldRow>;
  }

  async getFieldByName(userId: UserId, fieldName: string): Promise<FieldRow | null> {
    return _getFieldByName(userId, fieldName) as Promise<FieldRow | null>;
  }

  async getUserFieldsWithCity(userId: UserId): Promise<{ name: string; city: string; province: string | null }[]> {
    return _getUserFieldsWithCity(userId);
  }

  async getUserFields(userId: UserId): Promise<{ name: string; city: string | null; province: string | null }[]> {
    return _getUserFields(userId);
  }

  async setFieldCity(userId: UserId, fieldName: string, city: string, province?: string | null): Promise<void> {
    await _setFieldCity(userId, fieldName, city, province);
  }

  async getUserFieldCount(userId: UserId): Promise<number> {
    return _getUserFieldCount(userId);
  }

  async deleteField(userId: UserId, fieldName: string): Promise<boolean> {
    return _deleteField(userId, fieldName);
  }

  async restoreField(userId: UserId, fieldName: string): Promise<FieldRow | null> {
    return _restoreField(userId, fieldName) as Promise<FieldRow | null>;
  }

  async renameField(userId: UserId, oldName: string, newName: string): Promise<boolean> {
    return _renameField(userId, oldName, newName);
  }

  async renamePlot(userId: UserId, oldName: string, newName: string, fieldName?: string | null): Promise<{ id: number; oldName: string; newName: string; fieldName: string } | null> {
    return _renamePlot(userId, oldName, newName, fieldName);
  }

  async getFieldInfo(userId: UserId, fieldName: string): Promise<FieldInfoData | null> {
    return _getFieldInfo(userId, fieldName) as Promise<FieldInfoData | null>;
  }

  // --- Plots ---

  async getOrCreatePlot(fieldId: number, name: string): Promise<PlotRow> {
    return _getOrCreatePlot(fieldId, name) as Promise<PlotRow>;
  }

  async getPlotsByField(fieldId: number): Promise<PlotRow[]> {
    return _getPlotsByField(fieldId) as Promise<PlotRow[]>;
  }

  async findPlotByNameAcrossFields(userId: UserId, plotName: string): Promise<Array<PlotRow & { field_name: string }>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return _findPlotByNameAcrossFields(userId, plotName) as Promise<any>;
  }

  async findAllUserPlots(userId: UserId): Promise<Array<{ id: number; name: string; field_name: string }>> {
    return _findAllUserPlots(userId);
  }

  async deletePlot(plotId: number, userId?: UserId | null): Promise<boolean> {
    return _deletePlot(plotId, userId);
  }

  async restorePlot(userId: UserId, plotName: string, fieldName: string): Promise<PlotRow | null> {
    return _restorePlot(userId, plotName, fieldName) as Promise<PlotRow | null>;
  }

  async setPlotArea(plotId: number, hectares: number): Promise<void> {
    await _setPlotArea(plotId, hectares);
  }

  async setPlotGrupo(plotId: number, grupo: string): Promise<void> {
    await _setPlotGrupo(plotId, grupo);
  }

  async findPlotsByGrupo(userId: UserId, grupo: string): Promise<Array<PlotRow & { field_name: string }>> {
    return _findPlotsByGrupo(userId, grupo) as Promise<Array<PlotRow & { field_name: string }>>;
  }

  async getPlotInfo(userId: UserId, plotName: string): Promise<PlotInfoData | null> {
    return _getPlotInfo(userId, plotName) as Promise<PlotInfoData | null>;
  }

  async getPlotReport(userId: UserId, plotName: string): Promise<{ rows: CategoryTotal[]; plotName: string; fieldName: string; incomeTotal: number } | null> {
    const result = await _getPlotReport(userId, plotName);
    if (!result) return null;
    return {
      rows: result.rows.map((r: CategoryTotal) => ({ category: r.category, total: Number(r.total) })),
      plotName: result.plotName,
      fieldName: result.fieldName,
      incomeTotal: result.incomeTotal,
    };
  }

  async getPlotResult(userId: UserId, plotName: string): Promise<{ ingresos: number; gastos: number; plotName: string; fieldName: string } | null> {
    return _getPlotResult(userId, plotName);
  }
}
