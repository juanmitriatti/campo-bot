import { FinancialHandler } from './financial/financial.handler.js';
import { AgronomyHandler } from './agronomy/agronomy.handler.js';
import { SystemHandler } from './system/system.handler.js';
import { SharingHandler } from './sharing/sharing.handler.js';
import { StockHandler } from './stock/stock.handler.js';
import { DocumentHandler } from './documents/document.handler.js';
import { LivestockHandler } from './livestock/livestock.handler.js';
import { FeedlotHandler } from './feedlot/feedlot.handler.js';
import { FeatureGate } from './billing/feature-gate.js';
import type { UserId, User, UserSettings, ParsedCommand, HandlerResponse } from '../types/index.js';

// --- Command routing sets ---

const FINANCIAL_COMMANDS = new Set([
  'financial_report',
  'monthly_result', 'field_result', 'compare_months',
  'weekly_report', 'monthly_report', 'field_report', 'plot_report', 'date_range_report',
  'set_budget',
  // edit_last: regex/trivial path → quick amount-only edit of the latest expense.
  // edit_last_expense: AI agent tool → full editor (category, amount, plot, etc.).
  // Both route through FinancialHandler; the naming gap is historical, but they
  // are NOT duplicates — different scopes and different code paths.
  'delete_last', 'delete_last_income', 'delete_specific', 'edit_specific', 'edit_last',
  'edit_last_amount', // alias for edit_last (clearer name, same behavior)
  'edit_last_expense',
  // May 28 — agent-driven edit/delete tools (full editor support: amount,
  // category, date, plot, field). See utils/financial-edit.md if needed.
  'delete_last_expense', 'delete_specific_expense', 'delete_specific_income',
  'edit_specific_expense', 'edit_last_income', 'edit_specific_income',
  'export_csv',
  'set_field_city', 'add_field_city', 'add_field', 'list_fields',
  'delete_field', 'rename_field', 'field_info',
  'list_plots', 'add_plot', 'add_plots_batch', 'delete_plot', 'plot_info', 'set_plot_area', 'set_plot_grupo',
  'restore_field', 'rename_plot', 'restore_plot',
  'create_expense_template', 'list_expense_templates', 'delete_expense_template',
  'pick_category', 'create_category',
  'category_similar_use', 'category_similar_new', 'category_similar_cancel',
  'assign_bulk_plot',
  'log_income', 'log_expense',
]);

const AGRONOMY_COMMANDS = new Set([
  'weather_full', 'weather_forecast', 'weather_field', 'weather_all',
  'log_rainfall', 'log_rainfall_batch', 'delete_last_rainfall', 'edit_last_rainfall',
  'edit_last_observation', 'delete_last_observation',
  'delete_last_scouting',
  'rainfall_report', 'rainfall_range',
  'compare_rainfall_months', 'compare_rainfall_years',
  'sow_crop', 'harvest_crop', 'active_crop', 'crop_history', 'close_campaign', 'campaign_stats', 'compare_campaigns', 'activity_stats',
  'log_spraying', 'log_fertilization', 'log_tillage', 'log_irrigation', 'plot_activities',
  'query_plot_history', 'log_observation', 'generate_agro_report',
  'log_tacto', 'tacto_summary', 'edit_last_activity', 'delete_last_activity',
  'share_report',
  'log_crop_scouting', 'query_scoutings',
  'query_harvest_loads', 'delete_harvest_loads',
]);

const SHARING_COMMANDS = new Set([
  'share_field', 'accept_invite', 'list_field_members', 'remove_field_member',
]);

const STOCK_COMMANDS = new Set([
  'create_warehouse', 'list_warehouses',
  'add_stock', 'remove_stock', 'adjust_stock',
  'check_stock', 'stock_history',
  'set_min_stock', 'check_low_stock',
]);

const DOCUMENT_COMMANDS = new Set([
  'list_documents', 'link_document_to_expense',
]);

const LIVESTOCK_COMMANDS = new Set([
  'add_livestock', 'remove_livestock', 'transfer_livestock',
  'record_livestock_death', 'record_livestock_birth', 'adjust_livestock',
  'list_livestock', 'livestock_history',
  'log_health_event', 'query_health_events',
  'log_repro_event', 'query_repro_events',
  'log_weighing', 'query_weighings',
  'livestock_pick_location', 'livestock_apply_animals',
  'livestock_create_continue', 'livestock_create_cancel',
  'livestock_post_stock', 'livestock_post_weigh', 'livestock_post_gdpv',
  'livestock_post_health_hist', 'livestock_post_repro_hist',
  'livestock_post_resumen_mes', 'livestock_post_new_event',
  'livestock_post_undo_movement', 'livestock_post_undo_event',
]);

const FEEDLOT_COMMANDS = new Set([
  'create_feedlot', 'list_feedlots', 'delete_feedlot',
  'create_corral', 'list_corrals', 'delete_corral', 'rename_corral',
]);

const SYSTEM_COMMANDS = new Set([
  'greeting', 'help', 'help_section', 'thanks', 'ack', 'dollar',
  'menu', 'show_expense_menu', 'show_income_menu', 'show_agro_menu',
  'show_fields_menu', 'show_rain_menu', 'show_reports_menu',
  'prompt_rainfall', 'prompt_add_field', 'prompt_add_plot',
  'show_alerts', 'set_rain_threshold',
  'enable_rain_alerts', 'disable_rain_alerts',
  'enable_budget_alerts', 'disable_budget_alerts',
  'enable_weekly_summary', 'disable_weekly_summary',
  'set_name', 'set_city',
]);

export class DomainRouter {
  private featureGate: FeatureGate;
  private sharingHandler: SharingHandler;
  private stockHandler: StockHandler;
  private documentHandler: DocumentHandler;
  private livestockHandler: LivestockHandler;
  private feedlotHandler: FeedlotHandler;

  constructor(
    private financialHandler: FinancialHandler,
    private agronomyHandler: AgronomyHandler,
    private systemHandler: SystemHandler,
    featureGate?: FeatureGate,
    sharingHandler?: SharingHandler,
    stockHandler?: StockHandler,
    documentHandler?: DocumentHandler,
    livestockHandler?: LivestockHandler,
    feedlotHandler?: FeedlotHandler,
  ) {
    this.featureGate = featureGate ?? new FeatureGate();
    this.sharingHandler = sharingHandler ?? new SharingHandler();
    this.stockHandler = stockHandler ?? new StockHandler();
    this.documentHandler = documentHandler ?? new DocumentHandler();
    this.livestockHandler = livestockHandler ?? new LivestockHandler();
    this.feedlotHandler = feedlotHandler ?? new FeedlotHandler();
  }

  async routeCommand(
    cmd: ParsedCommand,
    userId: UserId,
    user: User,
    settings: UserSettings,
    bulkMode?: boolean,
  ): Promise<HandlerResponse | null> {
    const command = cmd.command;
    // Surface bulkMode to every downstream handler so they can skip flows /
    // pending prompts when running inside a compound action. Handlers that
    // don't care about it can ignore the flag.
    if (bulkMode) (cmd as ParsedCommand & { _bulkMode?: boolean })._bulkMode = true;

    // System commands are always allowed (help, greeting, settings)
    if (SYSTEM_COMMANDS.has(command)) {
      return this.systemHandler.handleCommand(cmd, userId, user, settings);
    }

    // Check feature gating for non-system commands
    const requiredFeature = FeatureGate.commandToFeature(command);
    if (requiredFeature) {
      const hasAccess = await this.featureGate.hasFeature(userId, requiredFeature);
      if (!hasAccess) {
        return {
          messages: [
            `🔒 Esta función no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones disponibles.`
          ],
        };
      }
    }

    if (command === 'pick_category') {
      return this.financialHandler.pickCategory(cmd, userId);
    }
    if (command === 'create_category') {
      return this.financialHandler.createCategoryInline(cmd, userId);
    }
    if (command === 'category_similar_use') {
      return this.financialHandler.categorySimilarUse(cmd, userId);
    }
    if (command === 'category_similar_new') {
      return this.financialHandler.categorySimilarNew(cmd, userId);
    }
    if (command === 'category_similar_cancel') {
      return this.financialHandler.categorySimilarCancel(cmd, userId);
    }

    if (FINANCIAL_COMMANDS.has(command)) {
      return this.financialHandler.handleCommand(cmd, userId, user, settings);
    }

    if (AGRONOMY_COMMANDS.has(command)) {
      return this.agronomyHandler.handleCommand(cmd, userId, user, settings);
    }

    if (SHARING_COMMANDS.has(command)) {
      return this.sharingHandler.handleCommand(cmd, userId, user, settings);
    }

    if (STOCK_COMMANDS.has(command)) {
      return this.stockHandler.handleCommand(cmd, userId, user, settings);
    }

    if (DOCUMENT_COMMANDS.has(command)) {
      return this.documentHandler.handleCommand(cmd, userId, user, settings);
    }

    if (LIVESTOCK_COMMANDS.has(command)) {
      return this.livestockHandler.handleCommand(cmd, userId, user, settings);
    }

    if (FEEDLOT_COMMANDS.has(command)) {
      return this.feedlotHandler.handleCommand(cmd, userId, user, settings);
    }

    return null;
  }
}
