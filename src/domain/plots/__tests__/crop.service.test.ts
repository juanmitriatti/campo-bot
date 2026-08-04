import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';

// Mock expenses.js functions
const mocks = {
  createPlotCrop: vi.fn(),
  closePlotCrop: vi.fn(),
  getActiveCrop: vi.fn(),
  getPlotCropHistory: vi.fn(),
  getPlotCropBySeason: vi.fn(),
  setPlotCropHarvested: vi.fn(),
  getAllActiveCrops: vi.fn(),
};

vi.mock('../../../services/expenses.js', () => mocks);

// Must import after vi.mock
const {
  CropService,
  detectCropFromText,
  getSeasonTypeForCrop,
  getSeasonYear,
  formatSeasonLabel,
} = await import('../crop.service.js');

const userId = 1 as UserId;

// ============================================================================
// Pure functions
// ============================================================================

describe('detectCropFromText', () => {
  it('soja → Soja', () => expect(detectCropFromText('soja')).toBe('Soja'));
  it('maiz → Maíz', () => expect(detectCropFromText('maiz')).toBe('Maíz'));
  it('trigo → Trigo', () => expect(detectCropFromText('trigo')).toBe('Trigo'));
  it('girasol → Girasol', () => expect(detectCropFromText('girasol')).toBe('Girasol'));
  it('alfalfa → Alfalfa', () => expect(detectCropFromText('alfalfa')).toBe('Alfalfa'));
  it('gasoil → null', () => expect(detectCropFromText('gasoil')).toBeNull());
  it('hola → null', () => expect(detectCropFromText('hola')).toBeNull());
});

describe('getSeasonTypeForCrop', () => {
  it('Soja → gruesa', () => expect(getSeasonTypeForCrop('Soja')).toBe('gruesa'));
  it('Maíz → gruesa', () => expect(getSeasonTypeForCrop('Maíz')).toBe('gruesa'));
  it('Trigo → fina', () => expect(getSeasonTypeForCrop('Trigo')).toBe('fina'));
  it('Cebada → fina', () => expect(getSeasonTypeForCrop('Cebada')).toBe('fina'));
  it('Alfalfa → perenne', () => expect(getSeasonTypeForCrop('Alfalfa')).toBe('perenne'));
  it('Unknown → gruesa (default)', () => expect(getSeasonTypeForCrop('Quinoa')).toBe('gruesa'));
});

describe('getSeasonYear', () => {
  it('gruesa Oct 2025 → 2025', () => {
    expect(getSeasonYear(new Date(2025, 9, 15), 'gruesa')).toBe(2025); // Oct=9
  });

  it('gruesa Jan 2026 → 2025 (prev year)', () => {
    expect(getSeasonYear(new Date(2026, 0, 15), 'gruesa')).toBe(2025); // Jan=0
  });

  it('gruesa Sep 2025 → 2025', () => {
    expect(getSeasonYear(new Date(2025, 8, 1), 'gruesa')).toBe(2025); // Sep=8
  });

  it('gruesa Aug 2026 → 2025 (harvest period)', () => {
    expect(getSeasonYear(new Date(2026, 7, 1), 'gruesa')).toBe(2025); // Aug=7
  });

  it('fina Jun 2025 → 2025', () => {
    expect(getSeasonYear(new Date(2025, 5, 15), 'fina')).toBe(2025); // Jun=5
  });

  it('fina Jan 2026 → 2025 (harvest period)', () => {
    expect(getSeasonYear(new Date(2026, 0, 10), 'fina')).toBe(2025); // Jan=0
  });

  it('fina Nov 2025 → 2025 (harvest within same year)', () => {
    expect(getSeasonYear(new Date(2025, 10, 15), 'fina')).toBe(2025); // Nov=10
  });

  it('perenne → current year', () => {
    expect(getSeasonYear(new Date(2025, 5, 1), 'perenne')).toBe(2025);
  });
});

describe('formatSeasonLabel', () => {
  it('gruesa 2025 → 2025/26', () => {
    expect(formatSeasonLabel(2025, 'gruesa')).toBe('2025/26');
  });

  it('gruesa 2099 → 2099/00', () => {
    expect(formatSeasonLabel(2099, 'gruesa')).toBe('2099/00');
  });

  it('fina 2025 → 2025', () => {
    expect(formatSeasonLabel(2025, 'fina')).toBe('2025');
  });

  it('perenne 2025 → 2025', () => {
    expect(formatSeasonLabel(2025, 'perenne')).toBe('2025');
  });
});

// ============================================================================
// CropService class
// ============================================================================

describe('CropService', () => {
  let service: InstanceType<typeof CropService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CropService();
  });

  describe('startCrop', () => {
    it('no active crop → creates new', async () => {
      mocks.getActiveCrop.mockResolvedValue(null);
      mocks.createPlotCrop.mockResolvedValue({
        id: 1, plot_id: 10, crop: 'Soja', season_year: 2025,
        season_type: 'gruesa', start_date: new Date(), end_date: null, created_at: new Date(),
      });

      const result = await service.startCrop(userId, 10, 'Soja', new Date(2025, 9, 15));

      expect(result.closedPrevious).toBeNull();
      expect(result.cropRow.crop).toBe('Soja');
      expect(mocks.createPlotCrop).toHaveBeenCalledWith(10, 'Soja', 2025, 'gruesa', expect.any(Date), null, null);
    });

    it('same crop active → returns existing', async () => {
      const existing = {
        id: 1, plot_id: 10, crop: 'Soja', season_year: 2025,
        season_type: 'gruesa', start_date: new Date(), end_date: null, created_at: new Date(),
      };
      mocks.getActiveCrop.mockResolvedValue(existing);

      const result = await service.startCrop(userId, 10, 'Soja', new Date(2025, 9, 15));

      expect(result.cropRow).toBe(existing);
      expect(result.closedPrevious).toBeNull();
      expect(mocks.createPlotCrop).not.toHaveBeenCalled();
    });

    it('different crop active → closes old + creates new', async () => {
      const oldCrop = {
        id: 1, plot_id: 10, crop: 'Trigo', season_year: 2025,
        season_type: 'fina', start_date: new Date(), end_date: null, created_at: new Date(),
      };
      const closedOld = { ...oldCrop, end_date: new Date() };
      const newCrop = {
        id: 2, plot_id: 10, crop: 'Soja', season_year: 2025,
        season_type: 'gruesa', start_date: new Date(), end_date: null, created_at: new Date(),
      };

      mocks.getActiveCrop.mockResolvedValue(oldCrop);
      mocks.closePlotCrop.mockResolvedValue(closedOld);
      mocks.createPlotCrop.mockResolvedValue(newCrop);

      const result = await service.startCrop(userId, 10, 'Soja', new Date(2025, 9, 15));

      expect(result.closedPrevious).toBe(closedOld);
      expect(result.cropRow.crop).toBe('Soja');
      expect(mocks.closePlotCrop).toHaveBeenCalledWith(1, expect.any(Date));
    });
  });

  describe('harvestCrop', () => {
    it('active matches → sets harvested_at (campaign stays open)', async () => {
      const active = {
        id: 1, plot_id: 10, crop: 'Soja', season_year: 2025,
        season_type: 'gruesa', start_date: new Date(), end_date: null, harvested_at: null, created_at: new Date(),
      };
      const harvested = { ...active, harvested_at: new Date() };
      mocks.getActiveCrop.mockResolvedValue(active);
      mocks.setPlotCropHarvested.mockResolvedValue(harvested);

      const result = await service.harvestCrop(10, 'Soja');

      expect(result).toBe(harvested);
      expect(result!.end_date).toBeNull(); // campaign stays open
      expect(result!.harvested_at).toBeTruthy();
      expect(mocks.setPlotCropHarvested).toHaveBeenCalledWith(1, expect.any(Date), null, null);
      expect(mocks.closePlotCrop).not.toHaveBeenCalled();
    });

    it('active matches with yield → stores yield data', async () => {
      const active = {
        id: 1, plot_id: 10, crop: 'Soja', season_year: 2025,
        season_type: 'gruesa', start_date: new Date(), end_date: null, harvested_at: null, created_at: new Date(),
      };
      const harvested = { ...active, harvested_at: new Date(), yield_kg: 5000, yield_notes: 'Buen rinde' };
      mocks.getActiveCrop.mockResolvedValue(active);
      mocks.setPlotCropHarvested.mockResolvedValue(harvested);

      const result = await service.harvestCrop(10, 'Soja', undefined, 5000, 'Buen rinde');

      expect(result!.yield_kg).toBe(5000);
      expect(mocks.setPlotCropHarvested).toHaveBeenCalledWith(1, expect.any(Date), 5000, 'Buen rinde');
    });

    it('active does not match → null', async () => {
      mocks.getActiveCrop.mockResolvedValue({
        id: 1, plot_id: 10, crop: 'Trigo', season_year: 2025,
        season_type: 'fina', start_date: new Date(), end_date: null, created_at: new Date(),
      });

      const result = await service.harvestCrop(10, 'Soja');
      expect(result).toBeNull();
    });

    it('no active → null', async () => {
      mocks.getActiveCrop.mockResolvedValue(null);

      const result = await service.harvestCrop(10, 'Soja');
      expect(result).toBeNull();
    });
  });

  describe('closeCampaign', () => {
    it('closes campaign by setting end_date', async () => {
      const closed = {
        id: 1, plot_id: 10, crop: 'Soja', season_year: 2025,
        season_type: 'gruesa', start_date: new Date(), end_date: new Date(), harvested_at: new Date(), created_at: new Date(),
      };
      mocks.closePlotCrop.mockResolvedValue(closed);

      const result = await service.closeCampaign(1);

      expect(result).toBe(closed);
      expect(mocks.closePlotCrop).toHaveBeenCalledWith(1);
    });
  });

  describe('getHistory', () => {
    it('delegates to getPlotCropHistory', async () => {
      const rows = [
        { id: 1, crop: 'Soja', season_year: 2025 },
        { id: 2, crop: 'Trigo', season_year: 2024 },
      ];
      mocks.getPlotCropHistory.mockResolvedValue(rows);

      const result = await service.getHistory(10);
      expect(result).toBe(rows);
      expect(mocks.getPlotCropHistory).toHaveBeenCalledWith(10);
    });
  });
});
