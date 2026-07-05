import { FinancialHandler } from './financial/financial.handler.js';
import { AgronomyHandler } from './agronomy/agronomy.handler.js';
import { SystemHandler } from './system/system.handler.js';
import { SharingHandler } from './sharing/sharing.handler.js';
import { StockHandler } from './stock/stock.handler.js';
import { DocumentHandler } from './documents/document.handler.js';
import { LivestockHandler } from './livestock/livestock.handler.js';
import { FeedlotHandler } from './feedlot/feedlot.handler.js';
import { FeatureGate } from './billing/feature-gate.js';
import { TOOL_NAMES } from '../ai/tool-definitions.js';
import { invalidateUserContext } from '../ai/user-context.service.js';
import { tipEngine } from '../services/tip-engine.js';
import type { UserId, User, UserSettings, ParsedCommand, HandlerResponse } from '../types/index.js';

// --- Command routing sets ---

// Commands that mutate the user's stable entity lists (fields/plots/corrals/
// feedlots) cached by UserContextService. After any of these runs, the cache
// MUST be invalidated so the NEXT message's anti-hallucination validator sees
// the new entity — otherwise it strips the just-created plot the user named and
// the activity is silently dropped (multi-siembra data-loss bug, Jun 2026).
const ENTITY_LIST_MUTATING_COMMANDS = new Set([
  'add_field', 'add_plot', 'add_plots_batch',
  'create_feedlot', 'create_corral',
  'add_livestock', // can auto-create a feedlot + corral when none exist
]);

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
  'add_livestock', 'remove_livestock', 'transfer_livestock', 'set_livestock_price',
  'record_livestock_death', 'record_livestock_birth', 'adjust_livestock',
  'list_livestock', 'livestock_history',
  'log_health_event', 'query_health_events',
  'log_repro_event', 'query_repro_events',
  'log_weighing', 'query_weighings',
  'livestock_pick_location', 'livestock_apply_animals',
  'livestock_create_continue', 'livestock_create_cancel',
  'livestock_place_choice', 'livestock_place_corral',
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
  'greeting', 'help', 'help_section', 'thanks', 'ack', 'dollar', 'grain_prices',
  'create_reminder', 'list_reminders', 'complete_reminder',
  'disable_tips', 'enable_tips',
  'menu', 'show_expense_menu', 'show_income_menu', 'show_agro_menu',
  'show_fields_menu', 'show_rain_menu', 'show_reports_menu',
  'prompt_rainfall', 'prompt_add_field', 'prompt_add_plot',
  'show_alerts', 'set_rain_threshold',
  'enable_rain_alerts', 'disable_rain_alerts',
  'enable_budget_alerts', 'disable_budget_alerts',
  'enable_weekly_summary', 'disable_weekly_summary',
  'set_name', 'set_city',
]);

// Financial-handler commands dispatched ahead of the *_COMMANDS sets (category
// inline flow). Mirrored here only so router telemetry can attribute them.
const FINANCIAL_SPECIAL_COMMANDS = new Set([
  'pick_category', 'create_category',
  'category_similar_use', 'category_similar_new', 'category_similar_cancel',
]);

/**
 * Read-only mirror of the dispatch chain in routeCommand(), used ONLY for
 * tool-selection telemetry. Returns the domain a command routes to, or null if
 * no *_COMMANDS set claims it (→ unrouted). Must stay in sync with the dispatch
 * order in routeCommand(); a divergence only mislabels a log line, it never
 * changes routing behavior.
 */
function classifyDomain(command: string): string | null {
  if (SYSTEM_COMMANDS.has(command)) return 'system';
  if (FINANCIAL_SPECIAL_COMMANDS.has(command) || FINANCIAL_COMMANDS.has(command)) return 'financial';
  if (AGRONOMY_COMMANDS.has(command)) return 'agronomy';
  if (SHARING_COMMANDS.has(command)) return 'sharing';
  if (STOCK_COMMANDS.has(command)) return 'stock';
  if (DOCUMENT_COMMANDS.has(command)) return 'document';
  if (LIVESTOCK_COMMANDS.has(command)) return 'livestock';
  if (FEEDLOT_COMMANDS.has(command)) return 'feedlot';
  return null;
}

// Lightweight per-process tool-selection telemetry so the router stops being a
// black box. Every successful route bumps its command counter; every
// fallthrough bumps `unrouted`, split by whether the command is a real tool
// missing from a *_COMMANDS set (a registration bug) vs an unknown/hallucinated
// name. Exposed via getRouterStats() for an admin endpoint / eval harness.
export interface RouterStats {
  selected: Record<string, number>;
  unrouted: Record<string, number>;
  unroutedKnownTool: number;
  unroutedUnknown: number;
}
const routerStats: RouterStats = { selected: {}, unrouted: {}, unroutedKnownTool: 0, unroutedUnknown: 0 };
export function getRouterStats(): RouterStats { return routerStats; }
export function resetRouterStats(): void {
  routerStats.selected = {};
  routerStats.unrouted = {};
  routerStats.unroutedKnownTool = 0;
  routerStats.unroutedUnknown = 0;
}

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

    // Tool-selection telemetry (additive — never changes routing). Emitted at
    // the router so ALL six callers (pipeline single/flow/pending/destructive +
    // compound-executor) are covered, not just the main path.
    const routedDomain = classifyDomain(command);
    if (routedDomain) {
      routerStats.selected[command] = (routerStats.selected[command] ?? 0) + 1;
      console.log(`ROUTER_SELECT command=${command} domain=${routedDomain} bulk=${bulkMode ? 1 : 0}`);
    }

    const response = await this.dispatchCommand(cmd, userId, user, settings, bulkMode);

    // Tips contextuales de primera vez (descubrimiento por goteo) — un solo
    // hook acá cubre los 3 canales, pendings re-ruteados y botones. Fail-open:
    // un tip jamás rompe la respuesta. Ver services/tip-engine.ts.
    if (response) {
      const tip = await tipEngine.maybeGetTip(cmd, response, Number(userId), user);
      if (tip) response.messages = [...(response.messages ?? []), tip];
    }

    return response;
  }

  private async dispatchCommand(
    cmd: ParsedCommand,
    userId: UserId,
    user: User,
    settings: UserSettings,
    bulkMode?: boolean,
  ): Promise<HandlerResponse | null> {
    const command = cmd.command;

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
      const res = await this.financialHandler.handleCommand(cmd, userId, user, settings);
      if (ENTITY_LIST_MUTATING_COMMANDS.has(command)) invalidateUserContext(userId);
      return res;
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
      const res = await this.livestockHandler.handleCommand(cmd, userId, user, settings);
      if (ENTITY_LIST_MUTATING_COMMANDS.has(command)) invalidateUserContext(userId);
      return res;
    }

    if (FEEDLOT_COMMANDS.has(command)) {
      const res = await this.feedlotHandler.handleCommand(cmd, userId, user, settings);
      if (ENTITY_LIST_MUTATING_COMMANDS.has(command)) invalidateUserContext(userId);
      return res;
    }

    // No *_COMMANDS set claimed this command. NEVER fail silently here — each of
    // the six routeCommand callers consumes a bare null differently and some
    // dropped it without a trace. Log at the SOURCE so every unrouted case is
    // observable, and distinguish a real-but-unregistered tool (a registration
    // bug — add it to the right *_COMMANDS set) from an unknown/hallucinated
    // name. Callers still receive null; the contract is unchanged.
    const isKnownTool = TOOL_NAMES.has(command);
    routerStats.unrouted[command] = (routerStats.unrouted[command] ?? 0) + 1;
    if (isKnownTool) routerStats.unroutedKnownTool++;
    else routerStats.unroutedUnknown++;
    console.error(
      `ROUTER_UNROUTED command=${command} known_tool=${isKnownTool} bulk=${bulkMode ? 1 : 0}` +
        (isKnownTool ? ' — REGISTRATION BUG: tool exists but no *_COMMANDS set claims it' : ''),
    );
    return null;
  }
}
