import { FinancialHandler } from './financial/financial.handler.js';
import { AgronomyHandler } from './agronomy/agronomy.handler.js';
import { SystemHandler } from './system/system.handler.js';
import { FeatureGate } from './billing/feature-gate.js';
import type { UserId, User, UserSettings, ParsedCommand, HandlerResponse } from '../types/index.js';

// --- Command routing sets ---

const FINANCIAL_COMMANDS = new Set([
  'monthly_result', 'field_result', 'compare_months',
  'weekly_report', 'monthly_report', 'field_report', 'plot_report', 'date_range_report',
  'set_budget',
  'delete_last', 'delete_last_income', 'delete_specific', 'edit_specific', 'edit_last',
  'export_csv',
  'set_field_city', 'add_field_city', 'add_field', 'list_fields',
  'delete_field', 'rename_field', 'field_info',
  'list_plots', 'add_plot', 'add_plots_batch', 'delete_plot', 'plot_info', 'set_plot_area', 'set_plot_coords',
  'restore_field',
]);

const AGRONOMY_COMMANDS = new Set([
  'weather_full', 'weather_forecast', 'weather_field', 'weather_all',
  'log_rainfall', 'delete_last_rainfall',
  'rainfall_report', 'rainfall_range',
  'compare_rainfall_months', 'compare_rainfall_years',
  'sow_crop', 'harvest_crop', 'active_crop', 'crop_history',
  'log_spraying', 'log_fertilization', 'log_tillage', 'log_irrigation', 'plot_activities',
  'query_plot_history', 'log_observation', 'generate_agro_report',
]);

const SYSTEM_COMMANDS = new Set([
  'greeting', 'help', 'thanks', 'ack', 'dollar',
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

  constructor(
    private financialHandler: FinancialHandler,
    private agronomyHandler: AgronomyHandler,
    private systemHandler: SystemHandler,
    featureGate?: FeatureGate,
  ) {
    this.featureGate = featureGate ?? new FeatureGate();
  }

  async routeCommand(
    cmd: ParsedCommand,
    userId: UserId,
    user: User,
    settings: UserSettings
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

    if (FINANCIAL_COMMANDS.has(command)) {
      return this.financialHandler.handleCommand(cmd, userId, user, settings);
    }

    if (AGRONOMY_COMMANDS.has(command)) {
      return this.agronomyHandler.handleCommand(cmd, userId, user, settings);
    }

    return null;
  }
}
