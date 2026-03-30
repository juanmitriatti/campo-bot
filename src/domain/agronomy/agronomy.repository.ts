import {
  saveRainfall as _saveRainfall,
  RAINFALL_REJECTED_DUPLICATE as _RAINFALL_REJECTED_DUPLICATE,
  getDailyRainfallTotal as _getDailyRainfallTotal,
  deleteLastRainfall as _deleteLastRainfall,
  getRainfallPeriod as _getRainfallPeriod,
  getRainfallAllLocations as _getRainfallAllLocations,
  getRainfallForMonth as _getRainfallForMonth,
  getRainfallForYear as _getRainfallForYear,
  getRainfallRange as _getRainfallRange,
  getConversationState as _getConversationState,
  createPlotCrop as _createPlotCrop,
  closePlotCrop as _closePlotCrop,
  getActiveCrop as _getActiveCrop,
  getPlotCropHistory as _getPlotCropHistory,
  getPlotCropBySeason as _getPlotCropBySeason,
  saveDomainEvent as _saveDomainEvent,
  getDomainEventsByPlot as _getDomainEventsByPlot,
  getDomainEventsByUser as _getDomainEventsByUser,
  getLastDomainEvent as _getLastDomainEvent,
  deleteDomainEvent as _deleteDomainEvent,
  queryPlotHistory as _queryPlotHistory,
  getPlotById as _getPlotById,
} from '../../services/expenses.js';
import { PlotRepository } from '../plots/plot.repository.js';
import type { UserId, FieldRow, PlotRow, PlotCropRow, DomainEventRow, PlotHistoryRow } from '../../types/index.js';

export const RAINFALL_REJECTED_DUPLICATE = _RAINFALL_REJECTED_DUPLICATE;

export interface RainfallSummary {
  total: number;
  registros: number;
}

export interface RainfallByLocation {
  field_name: string | null;
  total: number;
  registros: number;
}

export class AgronomyRepository {
  private plots: PlotRepository;

  constructor(plotRepo?: PlotRepository) {
    this.plots = plotRepo ?? new PlotRepository();
  }

  async saveRainfall(userId: UserId, mm: number, fieldId: number | null): Promise<unknown> {
    return _saveRainfall(userId, mm, fieldId);
  }

  async getConversationState(userId: UserId): Promise<{ last_field_id: number | null; field_name: string | null } | null> {
    return _getConversationState(userId) as Promise<{ last_field_id: number | null; field_name: string | null } | null>;
  }

  async getDailyRainfallTotal(userId: UserId, fieldId: number | null): Promise<number> {
    return _getDailyRainfallTotal(userId, fieldId);
  }

  async deleteLastRainfall(userId: UserId): Promise<{ millimeters: number } | null> {
    const result = await _deleteLastRainfall(userId);
    if (!result) return null;
    return { millimeters: Number(result.millimeters) };
  }

  async getRainfallPeriod(userId: UserId, period: string, fieldId: number | null): Promise<RainfallSummary> {
    const data = await _getRainfallPeriod(userId, period, fieldId);
    return { total: Number(data.total), registros: Number(data.registros) };
  }

  async getRainfallAllLocations(userId: UserId, period: string): Promise<RainfallByLocation[]> {
    const rows = await _getRainfallAllLocations(userId, period);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({
      field_name: r.field_name ?? null,
      total: Number(r.total),
      registros: Number(r.registros),
    }));
  }

  async getRainfallForMonth(userId: UserId, month: number, year: number): Promise<RainfallSummary> {
    const data = await _getRainfallForMonth(userId, month, year);
    return { total: Number(data.total), registros: Number(data.registros) };
  }

  async getRainfallForYear(userId: UserId, year: number): Promise<RainfallSummary> {
    const data = await _getRainfallForYear(userId, year);
    return { total: Number(data.total), registros: Number(data.registros) };
  }

  async getRainfallRange(userId: UserId, desde: Date, hasta: Date): Promise<RainfallSummary> {
    const data = await _getRainfallRange(userId, desde, hasta);
    return { total: Number(data.total), registros: Number(data.registros) };
  }

  // --- Fields (delegated to PlotRepository) ---

  async getOrCreateField(userId: UserId, name: string): Promise<FieldRow> {
    return this.plots.getOrCreateField(userId, name);
  }

  async getFieldByName(userId: UserId, name: string): Promise<FieldRow | null> {
    return this.plots.getFieldByName(userId, name);
  }

  async getUserFieldsWithCity(userId: UserId): Promise<{ name: string; city: string }[]> {
    return this.plots.getUserFieldsWithCity(userId);
  }

  async getUserFields(userId: UserId): Promise<{ name: string; city: string | null }[]> {
    return this.plots.getUserFields(userId);
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

  async getPlotById(plotId: number): Promise<{ id: number; name: string; field_name: string } | null> {
    return _getPlotById(plotId);
  }

  // --- Plot crops ---

  async createPlotCrop(plotId: number, crop: string, seasonYear: number, seasonType: string, startDate?: Date | null): Promise<PlotCropRow> {
    return _createPlotCrop(plotId, crop, seasonYear, seasonType, startDate) as Promise<PlotCropRow>;
  }

  async closePlotCrop(plotCropId: number, endDate?: Date | null): Promise<PlotCropRow | null> {
    return _closePlotCrop(plotCropId, endDate) as Promise<PlotCropRow | null>;
  }

  async getActiveCrop(plotId: number): Promise<PlotCropRow | null> {
    return _getActiveCrop(plotId) as Promise<PlotCropRow | null>;
  }

  async getPlotCropHistory(plotId: number): Promise<PlotCropRow[]> {
    return _getPlotCropHistory(plotId) as Promise<PlotCropRow[]>;
  }

  async getPlotCropBySeason(plotId: number, seasonYear: number, crop: string): Promise<PlotCropRow | null> {
    return _getPlotCropBySeason(plotId, seasonYear, crop) as Promise<PlotCropRow | null>;
  }

  // --- Domain events ---

  async saveDomainEvent(userId: UserId, data: {
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
  }): Promise<DomainEventRow> {
    return _saveDomainEvent(userId, data) as Promise<DomainEventRow>;
  }

  async getDomainEventsByPlot(plotId: number, limit = 20): Promise<Array<DomainEventRow & { plot_name: string | null; field_name: string | null }>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return _getDomainEventsByPlot(plotId, limit) as Promise<any>;
  }

  async getDomainEventsByUser(userId: UserId, limit = 20): Promise<Array<DomainEventRow & { plot_name: string | null; field_name: string | null }>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return _getDomainEventsByUser(userId, limit) as Promise<any>;
  }

  async getLastDomainEvent(userId: UserId): Promise<(DomainEventRow & { plot_name: string | null; field_name: string | null }) | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return _getLastDomainEvent(userId) as Promise<any>;
  }

  async deleteDomainEvent(eventId: number): Promise<DomainEventRow | null> {
    return _deleteDomainEvent(eventId) as Promise<DomainEventRow | null>;
  }

  // --- Plot history query ---

  async queryPlotHistory(userId: UserId, opts: {
    plotId?: number | null;
    fieldId?: number | null;
    desde?: Date | null;
    hasta?: Date | null;
    activityFilter?: string | null;
    crop?: string | null;
    limit?: number;
  }): Promise<PlotHistoryRow[]> {
    return _queryPlotHistory(userId, opts) as Promise<PlotHistoryRow[]>;
  }
}
