import { PlanRepository } from './plan.repository.js';
import type { UserId, FeatureKey, PlanRow } from '../../types/index.js';

/**
 * FeatureGate checks whether a user's subscription plan
 * includes a given feature. Uses in-memory caching to avoid
 * hitting the database on every message.
 */
/** Dueños de campos compartidos de los que el usuario hereda funciones. */
export type InheritedOwnersResolver = (userId: UserId) => Promise<number[]>;

/**
 * Funciones que NO se heredan del dueño: compartir es de quien paga Pro+, y
 * heredarlo dejaría al miembro compartir SUS campos a cuenta del dueño.
 */
const NON_INHERITABLE: ReadonlySet<FeatureKey> = new Set<FeatureKey>(['sharing' as FeatureKey]);

export class FeatureGate {
  private repo: PlanRepository;
  private inheritedOwners: InheritedOwnersResolver;

  /** planId → Set<FeatureKey> */
  private cache = new Map<number, Set<FeatureKey>>();

  /** Cache TTL in ms (5 minutes) */
  private readonly TTL = 5 * 60 * 1000;
  private lastRefresh = 0;

  /** Default plan name when user has no plan assigned */
  private static readonly DEFAULT_PLAN = 'free';

  constructor(repo?: PlanRepository, inheritedOwners?: InheritedOwnersResolver) {
    this.repo = repo ?? new PlanRepository();
    this.inheritedOwners = inheritedOwners ?? (async (userId) => {
      const { fullAccessOwnersOf } = await import('../../services/access-gate.service.js');
      return fullAccessOwnersOf(Number(userId));
    });
  }

  /**
   * Check if a user has access to a feature: their own plan, or — for a member
   * of a shared field — the plan of an owner who is up to date (CTA-8). The
   * access mode was already inherited, the features were not: a `free`
   * employee of a Pro+ owner could not log a sowing in the owner's field.
   */
  async hasFeature(userId: UserId, feature: FeatureKey): Promise<boolean> {
    const own = await this._ownFeatures(userId);
    if (own.has(feature)) return true;
    if (NON_INHERITABLE.has(feature)) return false;
    for (const set of await this._inheritedFeatureSets(userId)) {
      if (set.has(feature)) {
        console.log(`[FEATURE] user=${userId} ${feature} heredado del dueño`);
        return true;
      }
    }
    return false;
  }

  /**
   * Get all features available to a user (own plan + inherited, see hasFeature).
   */
  async getUserFeatures(userId: UserId): Promise<FeatureKey[]> {
    const all = new Set(await this._ownFeatures(userId));
    for (const set of await this._inheritedFeatureSets(userId)) {
      for (const f of set) if (!NON_INHERITABLE.has(f)) all.add(f);
    }
    return [...all];
  }

  private async _ownFeatures(userId: UserId): Promise<Set<FeatureKey>> {
    const plan = await this.repo.getUserPlan(userId);
    const planId = plan?.id ?? await this._getDefaultPlanId();
    if (planId === null) return new Set();
    return this._getFeatures(planId);
  }

  /** Feature sets of the plans of up-to-date owners of the user's shared fields. */
  private async _inheritedFeatureSets(userId: UserId): Promise<Set<FeatureKey>[]> {
    let owners: number[];
    try {
      owners = await this.inheritedOwners(userId);
    } catch (err) {
      console.error('[FEATURE] no pude resolver dueños heredados:', (err as Error).message);
      return [];
    }
    const sets: Set<FeatureKey>[] = [];
    for (const ownerId of owners) {
      const plan = await this.repo.getUserPlan(ownerId as UserId);
      const planId = plan?.id ?? await this._getDefaultPlanId();
      if (planId !== null) sets.push(await this._getFeatures(planId));
    }
    return sets;
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
      edit_last_amount: 'expenses', // alias for edit_last (same feature gate)
      create_expense_template: 'expenses',
      list_expense_templates: 'expenses',
      delete_expense_template: 'expenses',
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
      add_plots_batch: 'fields',
      set_plot_grupo: 'fields',
      // Weather
      weather_full: 'weather',
      weather_forecast: 'weather',
      weather_field: 'weather',
      weather_all: 'weather',
      // Rainfall
      log_rainfall: 'rainfall',
      log_rainfall_batch: 'rainfall',
      delete_last_rainfall: 'rainfall',
      rainfall_report: 'rainfall',
      rainfall_range: 'rainfall',
      compare_rainfall_months: 'rainfall',
      compare_rainfall_years: 'rainfall',
      // Agronomy
      open_form: 'agronomy',
      open_form_sow: 'agronomy',
      open_form_harvest: 'agronomy',
      // Antes solo siembra/cosecha estaban gateados: el formulario de gasto,
      // ingreso, labor y hacienda se abría aunque el plan no tuviera la feature.
      open_form_expense: 'expenses',
      open_form_income: 'incomes',
      open_form_activity: 'agronomy',
      open_form_livestock: 'livestock',
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
      query_observations: 'agronomy',
      generate_agro_report: 'agronomy',
      log_tacto: 'agronomy',
      tacto_summary: 'agronomy',
      edit_last_activity: 'agronomy',
      delete_last_activity: 'agronomy',
      close_campaign: 'agronomy',
      campaign_stats: 'agronomy',
      compare_campaigns: 'agronomy',
      activity_stats: 'agronomy',
      query_plot_history: 'agronomy',
      query_harvest_loads: 'agronomy',
      delete_harvest_loads: 'agronomy',
      log_harvest_costs: 'agronomy',
      edit_harvest_load: 'agronomy',
      set_expected_yield: 'agronomy',
      log_grain_withdrawal: 'agronomy',
      crop_report: 'agronomy',
      campaign_report: 'agronomy',
      share_report: 'agronomy',
      log_activity: 'agronomy',
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
      // Escribe precio y crea el gasto/ingreso vinculado: es una escritura real,
      // no un botón de seguimiento. Faltaba en este mapa y pasaba sin gate.
      set_livestock_price: 'livestock',

      // Capa individual (animal + caravana/RFID). Mismo feature que el resto de
      // hacienda: es la misma función del producto, no un plan aparte.
      register_animal: 'livestock',
      identify_animal: 'livestock',
      update_animal: 'livestock',
      query_animal: 'livestock',
      list_animals: 'livestock',
      move_animals: 'livestock',
      revert_livestock_movement: 'livestock',
      // Livestock — Health / Repro / Weighing
      log_health_event: 'livestock',
      query_health_events: 'livestock',
      log_repro_event: 'livestock',
      query_repro_events: 'livestock',
      log_weighing: 'livestock',
      query_weighings: 'livestock',
      // Feedlot / Corrals
      create_feedlot: 'livestock',
      list_feedlots: 'livestock',
      delete_feedlot: 'livestock',
      create_corral: 'livestock',
      list_corrals: 'livestock',
      delete_corral: 'livestock',
      rename_corral: 'livestock',
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
