import {
  createPlotCrop,
  closePlotCrop,
  getActiveCrop,
  getPlotCropHistory,
  setPlotCropHarvested,
  getAllActiveCrops,
} from '../../services/expenses.js';
import type { UserId, PlotCropRow } from '../../types/index.js';
import { CROPS, CROP_SEASON } from '../../constants/agro-terms.js';

const GRUESA = CROP_SEASON.GRUESA;
const FINA = CROP_SEASON.FINA;
const PERENNE = CROP_SEASON.PERENNE;

// --- Pure functions ---

export function detectCropFromText(text: string): string | null {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '');
  const words = normalized.split(/\s+/);

  for (const word of words) {
    if (CROPS[word]) return CROPS[word];
  }

  for (const word of words) {
    if (word.length < 3) continue;
    for (const key of Object.keys(CROPS)) {
      if (word.startsWith(key) || key.startsWith(word)) return CROPS[key];
    }
  }

  return null;
}

export function getSeasonTypeForCrop(crop: string): 'gruesa' | 'fina' | 'perenne' {
  if (GRUESA.has(crop)) return 'gruesa';
  if (FINA.has(crop)) return 'fina';
  if (PERENNE.has(crop)) return 'perenne';
  return 'gruesa'; // default
}

export function getSeasonYear(date: Date, seasonType: string): number {
  const month = date.getMonth(); // 0-based: 0=Jan, 11=Dec
  const year = date.getFullYear();

  if (seasonType === 'gruesa') {
    // Gruesa planted Sep-Jan, harvested Feb-Jul
    // Season year = year of September. If Jan-Aug → previous year
    if (month <= 7) return year - 1; // Jan(0)–Aug(7)
    return year; // Sep(8)–Dec(11)
  }

  if (seasonType === 'fina') {
    // Fina planted May-Jul, harvested Nov-Jan
    // Season year = year of planting. If Jan → previous year
    if (month === 0) return year - 1; // Jan harvest belongs to prev year campaign
    return year;
  }

  // perenne
  return year;
}

export function formatSeasonLabel(seasonYear: number, seasonType: string): string {
  if (seasonType === 'gruesa') {
    const nextYear = (seasonYear + 1) % 100;
    return `${seasonYear}/${String(nextYear).padStart(2, '0')}`;
  }
  return `${seasonYear}`;
}

export type CampaignState = 'active' | 'harvested' | 'closed';

export function getCampaignState(row: PlotCropRow): CampaignState {
  if (row.end_date) return 'closed';
  if (row.harvested_at) return 'harvested';
  return 'active';
}

export function getCampaignStateLabel(row: PlotCropRow): string {
  const state = getCampaignState(row);
  if (state === 'closed') return '✅ Cerrada';
  if (state === 'harvested') return '🌾 Cosechada (abierta)';
  return '🌱 Activa';
}

// --- CropService class ---

export class CropService {
  async startCrop(
    userId: UserId,
    plotId: number,
    crop: string,
    date?: Date,
    sowedHectares?: number | null,
    variety?: string | null,
  ): Promise<{ cropRow: PlotCropRow; closedPrevious: PlotCropRow | null }> {
    const effectiveDate = date || new Date();
    const seasonType = getSeasonTypeForCrop(crop);
    const seasonYear = getSeasonYear(effectiveDate, seasonType);

    const active = await getActiveCrop(plotId) as PlotCropRow | null;

    let closedPrevious: PlotCropRow | null = null;

    if (active) {
      // Same crop already active → return existing. Use case-insensitive
      // match so "Soja" / "soja" / "SOJA" don't create duplicate campaigns
      // when the agent re-fires sow_crop with different casing.
      if (active.crop.toLowerCase() === crop.toLowerCase()) {
        return { cropRow: active, closedPrevious: null };
      }
      // Different crop → close the previous one
      closedPrevious = await closePlotCrop(active.id, effectiveDate) as PlotCropRow | null;
    }

    const cropRow = await createPlotCrop(
      plotId, crop, seasonYear, seasonType, effectiveDate, sowedHectares ?? null, variety ?? null
    ) as PlotCropRow;

    return { cropRow, closedPrevious };
  }

  async harvestCrop(
    plotId: number,
    crop: string,
    date?: Date,
    yieldKg?: number | null,
    yieldNotes?: string | null,
  ): Promise<PlotCropRow | null> {
    const active = await getActiveCrop(plotId) as PlotCropRow | null;
    if (!active) return null;
    if (active.crop.toLowerCase() !== crop.toLowerCase()) return null;

    const effectiveDate = date || new Date();
    // Set harvested_at instead of closing the campaign
    return await setPlotCropHarvested(active.id, effectiveDate, yieldKg ?? null, yieldNotes ?? null) as PlotCropRow | null;
  }

  /** Find the most recent campaign on a plot that has been harvested but has
   * no yield_kg recorded. Used to support "cosechamos X kg en lote Y" as a
   * retroactive yield-load even on closed campaigns. Window configurable in
   * admin (agronomy → RETRO_YIELD_WINDOW_DAYS); explicit `withinDays` wins. */
  async findRecentHarvestedNoYield(plotId: number, withinDays?: number): Promise<PlotCropRow | null> {
    let days = withinDays;
    if (days == null) {
      const { getSettingNumber } = await import('../../services/settings.service.js');
      days = (await getSettingNumber('RETRO_YIELD_WINDOW_DAYS')) ?? 60;
    }
    const history = await getPlotCropHistory(plotId) as PlotCropRow[];
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const row of history) {
      if (!row.harvested_at) continue;
      if (row.yield_kg != null && Number(row.yield_kg) > 0) continue;
      const harvestedTs = new Date(row.harvested_at).getTime();
      if (harvestedTs >= cutoff) return row;
    }
    return null;
  }

  /** Update only yield_kg + yield_notes on an existing campaign (active or
   * closed). Does NOT change dates or campaign state. */
  async updateYield(cropId: number, yieldKg: number, yieldNotes?: string | null): Promise<PlotCropRow | null> {
    const { updatePlotCropYield } = await import('../../services/expenses.js');
    return await updatePlotCropYield(cropId, yieldKg, yieldNotes ?? null) as PlotCropRow | null;
  }

  async closeCampaign(
    plotCropId: number,
  ): Promise<PlotCropRow | null> {
    return await closePlotCrop(plotCropId) as PlotCropRow | null;
  }

  async getActive(plotId: number): Promise<PlotCropRow | null> {
    return await getActiveCrop(plotId) as PlotCropRow | null;
  }

  async getHistory(plotId: number): Promise<PlotCropRow[]> {
    return await getPlotCropHistory(plotId) as PlotCropRow[];
  }

  // Las tres columnas de actividad salen del LEFT JOIN agregado de la query
  // (expenses.js → getAllActiveCrops); faltaban en el tipo aunque siempre
  // vinieron en la fila, así que los consumidores las leían "a ciegas".
  async listActiveCrops(userId: UserId, cropFilter?: string | null, grupo?: string | null): Promise<(PlotCropRow & {
    plot_name: string;
    field_name: string;
    area_hectares: number | null;
    activity_count: number | null;
    last_activity_date: Date | null;
    last_activity_type: string | null;
  })[]> {
    return await getAllActiveCrops(userId, cropFilter ?? null, grupo ?? null) as any[];
  }
}
