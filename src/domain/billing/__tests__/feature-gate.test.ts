import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureGate } from '../feature-gate.js';
import type { UserId, FeatureKey, PlanName } from '../../../types/index.js';

const mockRepo = {
  getAllPlans: vi.fn(),
  getPlanByName: vi.fn(),
  getPlanById: vi.fn(),
  getUserPlan: vi.fn(),
  setUserPlan: vi.fn(),
  getPlanFeatures: vi.fn(),
  getAllFeatures: vi.fn(),
  setPlanFeatures: vi.fn(),
  createPlan: vi.fn(),
  updatePlan: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const userId = 1 as UserId;

describe('FeatureGate', () => {
  let gate: FeatureGate;

  beforeEach(() => {
    vi.clearAllMocks();
    gate = new FeatureGate(mockRepo);
  });

  describe('hasFeature', () => {
    it('returns true when user plan includes the feature', async () => {
      mockRepo.getUserPlan.mockResolvedValue({ id: 2, name: 'pro' as PlanName });
      mockRepo.getPlanFeatures.mockResolvedValue(['expenses', 'incomes', 'fields', 'budgets', 'rainfall', 'weather', 'csv_export'] as FeatureKey[]);

      const result = await gate.hasFeature(userId, 'budgets');
      expect(result).toBe(true);
    });

    it('returns false when user plan does not include the feature', async () => {
      mockRepo.getUserPlan.mockResolvedValue({ id: 1, name: 'free' as PlanName });
      mockRepo.getPlanFeatures.mockResolvedValue(['expenses', 'incomes', 'fields'] as FeatureKey[]);

      const result = await gate.hasFeature(userId, 'agronomy');
      expect(result).toBe(false);
    });

    it('falls back to free plan when user has no plan assigned', async () => {
      mockRepo.getUserPlan.mockResolvedValue(null);
      mockRepo.getPlanByName.mockResolvedValue({ id: 1, name: 'free' as PlanName });
      mockRepo.getPlanFeatures.mockResolvedValue(['expenses', 'incomes', 'fields'] as FeatureKey[]);

      const result = await gate.hasFeature(userId, 'expenses');
      expect(result).toBe(true);
      expect(mockRepo.getPlanByName).toHaveBeenCalledWith('free');
    });

    it('caches plan features to avoid repeated DB calls', async () => {
      mockRepo.getUserPlan.mockResolvedValue({ id: 2, name: 'pro' as PlanName });
      mockRepo.getPlanFeatures.mockResolvedValue(['expenses', 'incomes'] as FeatureKey[]);

      await gate.hasFeature(userId, 'expenses');
      await gate.hasFeature(userId, 'incomes');

      // getPlanFeatures should only be called once (cached)
      expect(mockRepo.getPlanFeatures).toHaveBeenCalledTimes(1);
    });

    it('returns false when no plan exists at all', async () => {
      mockRepo.getUserPlan.mockResolvedValue(null);
      mockRepo.getPlanByName.mockResolvedValue(null);

      const result = await gate.hasFeature(userId, 'expenses');
      expect(result).toBe(false);
    });
  });

  describe('getUserFeatures', () => {
    it('returns all features for the user plan', async () => {
      mockRepo.getUserPlan.mockResolvedValue({ id: 3, name: 'pro_plus' as PlanName });
      mockRepo.getPlanFeatures.mockResolvedValue([
        'expenses', 'incomes', 'fields', 'budgets', 'rainfall',
        'weather', 'csv_export', 'agronomy', 'audio',
      ] as FeatureKey[]);

      const features = await gate.getUserFeatures(userId);
      expect(features).toHaveLength(9);
      expect(features).toContain('agronomy');
      expect(features).toContain('audio');
    });
  });

  describe('invalidateCache', () => {
    it('clears cache so next call hits DB again', async () => {
      mockRepo.getUserPlan.mockResolvedValue({ id: 2, name: 'pro' as PlanName });
      mockRepo.getPlanFeatures.mockResolvedValue(['expenses'] as FeatureKey[]);

      await gate.hasFeature(userId, 'expenses');
      expect(mockRepo.getPlanFeatures).toHaveBeenCalledTimes(1);

      gate.invalidateCache();

      mockRepo.getPlanFeatures.mockResolvedValue(['expenses', 'budgets'] as FeatureKey[]);
      const result = await gate.hasFeature(userId, 'budgets');
      expect(result).toBe(true);
      expect(mockRepo.getPlanFeatures).toHaveBeenCalledTimes(2);
    });
  });

  describe('commandToFeature', () => {
    it('maps financial commands to expenses feature', () => {
      expect(FeatureGate.commandToFeature('monthly_report')).toBe('expenses');
      expect(FeatureGate.commandToFeature('delete_last')).toBe('expenses');
    });

    it('maps agronomy commands to agronomy feature', () => {
      expect(FeatureGate.commandToFeature('log_spraying')).toBe('agronomy');
      expect(FeatureGate.commandToFeature('sow_crop')).toBe('agronomy');
    });

    it('maps rainfall commands to rainfall feature', () => {
      expect(FeatureGate.commandToFeature('log_rainfall')).toBe('rainfall');
      expect(FeatureGate.commandToFeature('rainfall_report')).toBe('rainfall');
    });

    it('maps weather commands to weather feature', () => {
      expect(FeatureGate.commandToFeature('weather_full')).toBe('weather');
    });

    it('maps csv export to csv_export feature', () => {
      expect(FeatureGate.commandToFeature('export_csv')).toBe('csv_export');
    });

    it('maps budget commands to budgets feature', () => {
      expect(FeatureGate.commandToFeature('set_budget')).toBe('budgets');
    });

    it('maps field commands to fields feature', () => {
      expect(FeatureGate.commandToFeature('add_field')).toBe('fields');
      expect(FeatureGate.commandToFeature('list_plots')).toBe('fields');
    });

    it('maps income commands to incomes feature', () => {
      expect(FeatureGate.commandToFeature('delete_last_income')).toBe('incomes');
      expect(FeatureGate.commandToFeature('delete_specific_income')).toBe('incomes');
    });

    it('maps sharing commands to sharing feature', () => {
      expect(FeatureGate.commandToFeature('share_field')).toBe('sharing');
      expect(FeatureGate.commandToFeature('list_field_members')).toBe('sharing');
      expect(FeatureGate.commandToFeature('remove_field_member')).toBe('sharing');
    });

    it('does not gate accept_invite (always allowed)', () => {
      expect(FeatureGate.commandToFeature('accept_invite')).toBeNull();
    });

    it('returns null for system commands (always allowed)', () => {
      expect(FeatureGate.commandToFeature('help')).toBeNull();
      expect(FeatureGate.commandToFeature('greeting')).toBeNull();
      expect(FeatureGate.commandToFeature('set_name')).toBeNull();
    });

    it('returns null for unknown commands', () => {
      expect(FeatureGate.commandToFeature('nonexistent')).toBeNull();
    });
  });
});
