import {
  createPlotCrop,
  closePlotCrop,
  getActiveCrop,
  getPlotCropHistory,
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

// --- CropService class ---

export class CropService {
  async startCrop(
    userId: UserId,
    plotId: number,
    crop: string,
    date?: Date
  ): Promise<{ cropRow: PlotCropRow; closedPrevious: PlotCropRow | null }> {
    const effectiveDate = date || new Date();
    const seasonType = getSeasonTypeForCrop(crop);
    const seasonYear = getSeasonYear(effectiveDate, seasonType);

    const active = await getActiveCrop(plotId) as PlotCropRow | null;

    let closedPrevious: PlotCropRow | null = null;

    if (active) {
      // Same crop already active → return existing
      if (active.crop === crop) {
        return { cropRow: active, closedPrevious: null };
      }
      // Different crop → close the previous one
      closedPrevious = await closePlotCrop(active.id, effectiveDate) as PlotCropRow | null;
    }

    const cropRow = await createPlotCrop(
      plotId, crop, seasonYear, seasonType, effectiveDate
    ) as PlotCropRow;

    return { cropRow, closedPrevious };
  }

  async harvestCrop(
    plotId: number,
    crop: string,
    date?: Date
  ): Promise<PlotCropRow | null> {
    const active = await getActiveCrop(plotId) as PlotCropRow | null;
    if (!active) return null;
    if (active.crop !== crop) return null;

    const effectiveDate = date || new Date();
    return await closePlotCrop(active.id, effectiveDate) as PlotCropRow | null;
  }

  async getActive(plotId: number): Promise<PlotCropRow | null> {
    return await getActiveCrop(plotId) as PlotCropRow | null;
  }

  async getHistory(plotId: number): Promise<PlotCropRow[]> {
    return await getPlotCropHistory(plotId) as PlotCropRow[];
  }
}
