import { PlanRepository } from './plan.repository.js';
import type { UserId, FeatureKey, PlanRow } from '../../types/index.js';

/**
 * FeatureGate checks whether a user's subscription plan
 * includes a given feature. Uses in-memory caching to avoid
 * hitting the database on every message.
 */
export class FeatureGate {
  private repo: PlanRepository;

  /** planId → Set<FeatureKey> */
  private cache = new Map<number, Set<FeatureKey>>();

  /** Cache TTL in ms (5 minutes) */
  private readonly TTL = 5 * 60 * 1000;
  private lastRefresh = 0;

  /** Default plan name when user has no plan assigned */
  private static readonly DEFAULT_PLAN = 'free';

  constructor(repo?: PlanRepository) {
    this.repo = repo ?? new PlanRepository();
  }

  /**
   * Check if a user has access to a feature.
   * Returns true if the feature is included in their plan.
   */
  async hasFeature(userId: UserId, feature: FeatureKey): Promise<boolean> {
    const plan = await this.repo.getUserPlan(userId);
    const planId = plan?.id ?? await this._getDefaultPlanId();
    if (planId === null) return false;

    const features = await this._getFeatures(planId);
    return features.has(feature);
  }

  /**
   * Get all features available to a user.
   */
  async getUserFeatures(userId: UserId): Promise<FeatureKey[]> {
    const plan = await this.repo.getUserPlan(userId);
    const planId = plan?.id ?? await this._getDefaultPlanId();
    if (planId === null) return [];

    const features = await this._getFeatures(planId);
    return [...features];
  }

  /**
   * Get the user's current plan info.
   */
  async getUserPlan(userId: UserId): Promise<PlanRow | null> {
    return this.repo.getUserPlan(userId);
  }

  /**
   * Invalidate the cache (e.g., after plan changes).
   */
  invalidateCache(): void {
    this.cache.clear();
    this.lastRefresh = 0;
  }

  /**
   * Map a command to its required feature key.
   * Returns null if the command doesn't require feature gating
   * (e.g., help, greeting — always allowed).
   */
  static commandToFeature(command: string): FeatureKey | null {
    const map: Record<string, FeatureKey> = {
      // Financial
      financial_report: 'expenses',
      monthly_report: 'expenses',
      weekly_report: 'expenses',
      monthly_result: 'expenses',
      field_result: 'expenses',
      compare_months: 'expenses',
      field_report: 'expenses',
      date_range_report: 'expenses',
      delete_last: 'expenses',
      delete_specific: 'expenses',
      edit_specific: 'expenses',
      edit_last: 'expenses',
      export_csv: 'csv_export',
      delete_last_income: 'incomes',
      delete_specific_income: 'incomes',
      edit_last_income: 'incomes',
      edit_specific_income: 'incomes',
      // Budgets
      set_budget: 'budgets',
      // Fields
      set_field_city: 'fields',
      add_field_city: 'fields',
      add_field: 'fields',
      list_fields: 'fields',
      delete_field: 'fields',
      rename_field: 'fields',
      field_info: 'fields',
      list_plots: 'fields',
      add_plot: 'fields',
      delete_plot: 'fields',
      plot_info: 'fields',
      set_plot_area: 'fields',
      restore_field: 'fields',
      rename_plot: 'fields',
      restore_plot: 'fields',
      // Weather
      weather_full: 'weather',
      weather_forecast: 'weather',
      weather_field: 'weather',
      weather_all: 'weather',
      // Rainfall
      log_rainfall: 'rainfall',
      delete_last_rainfall: 'rainfall',
      rainfall_report: 'rainfall',
      rainfall_range: 'rainfall',
      compare_rainfall_months: 'rainfall',
      compare_rainfall_years: 'rainfall',
      // Agronomy
      sow_crop: 'agronomy',
      harvest_crop: 'agronomy',
      active_crop: 'agronomy',
      crop_history: 'agronomy',
      log_spraying: 'agronomy',
      log_fertilization: 'agronomy',
      log_tillage: 'agronomy',
      log_irrigation: 'agronomy',
      plot_activities: 'agronomy',
      log_observation: 'agronomy',
      generate_agro_report: 'agronomy',
      log_tacto: 'agronomy',
      edit_last_activity: 'agronomy',
      // Sharing
      share_field: 'sharing',
      list_field_members: 'sharing',
      remove_field_member: 'sharing',
      // Stock
      create_warehouse: 'stock',
      list_warehouses: 'stock',
      add_stock: 'stock',
      remove_stock: 'stock',
      adjust_stock: 'stock',
      check_stock: 'stock',
      stock_history: 'stock',
      set_min_stock: 'stock',
      check_low_stock: 'stock',
      // Documents
      start_document_upload: 'documents',
      list_documents: 'documents',
      link_document_to_expense: 'documents',
      // Livestock
      add_livestock: 'livestock',
      remove_livestock: 'livestock',
      transfer_livestock: 'livestock',
      record_livestock_death: 'livestock',
      record_livestock_birth: 'livestock',
      adjust_livestock: 'livestock',
      list_livestock: 'livestock',
      livestock_history: 'livestock',
    };

    return map[command] ?? null;
  }

  private async _getFeatures(planId: number): Promise<Set<FeatureKey>> {
    const now = Date.now();
    if (now - this.lastRefresh > this.TTL) {
      this.cache.clear();
      this.lastRefresh = now;
    }

    const cached = this.cache.get(planId);
    if (cached) return cached;

    const features = await this.repo.getPlanFeatures(planId);
    const featureSet = new Set(features);
    this.cache.set(planId, featureSet);
    return featureSet;
  }

  private _defaultPlanId: number | null | undefined;

  private async _getDefaultPlanId(): Promise<number | null> {
    if (this._defaultPlanId !== undefined) return this._defaultPlanId;
    const plan = await this.repo.getPlanByName(FeatureGate.DEFAULT_PLAN);
    this._defaultPlanId = plan?.id ?? null;
    return this._defaultPlanId;
  }
}
