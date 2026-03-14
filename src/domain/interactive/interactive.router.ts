import type { Intent, ParsedCommand } from '../../types/index.js';

const CALLBACK_MAP: Record<string, ParsedCommand> = {
  // Main menu options
  'menu_gastos': { command: 'show_expense_menu' },
  'menu_ingresos': { command: 'show_income_menu' },
  'menu_agro': { command: 'show_agro_menu' },
  'menu_campos': { command: 'show_fields_menu' },
  'menu_clima': { command: 'weather_full' },
  'menu_lluvia': { command: 'show_rain_menu' },
  'menu_reportes': { command: 'show_reports_menu' },
  'menu_config': { command: 'show_alerts' },
  'menu_ayuda': { command: 'help' },
  'menu_dolar': { command: 'dollar' },
  // Sub-menu: Gastos
  'cmd_resumen_mensual': { command: 'monthly_result' },
  'cmd_reporte_mensual': { command: 'monthly_report' },
  'cmd_borrar_ultimo_gasto': { command: 'delete_last' },
  // Sub-menu: Ingresos
  'cmd_borrar_ultimo_ingreso': { command: 'delete_last_income' },
  // Sub-menu: Lluvia
  'cmd_registrar_lluvia': { command: 'prompt_rainfall' },
  'cmd_reporte_lluvia': { command: 'rainfall_report' },
  // Sub-menu: Campos
  'cmd_listar_campos': { command: 'list_fields' },
  'cmd_agregar_campo': { command: 'prompt_add_field' },
  // Sub-menu: Reportes
  'cmd_reporte_semanal': { command: 'weekly_report' },
  'cmd_exportar_csv': { command: 'export_csv' },
  'cmd_reporte_agro': { command: 'generate_agro_report' },
  // Back to main menu
  'back_menu': { command: 'menu' },
  // Flow entry points (intercepted early in controller, here as documentation/fallback)
  'flow_new_expense': { command: 'start_flow', flow: 'expense_flow' },
  'flow_new_income': { command: 'start_flow', flow: 'income_flow' },
  'flow_new_field': { command: 'start_flow', flow: 'field_flow' },
  'flow_new_rainfall': { command: 'start_flow', flow: 'rainfall_flow' },
  'flow_new_activity': { command: 'start_flow', flow: 'activity_flow' },
  // Flow control (intercepted early in controller)
  'flow_confirm': { command: 'flow_confirm' },
  'flow_cancel': { command: 'flow_cancel' },
  'flow_skip': { command: 'flow_skip' },
  'flow_back': { command: 'flow_back' },
};

export class InteractiveRouter {
  route(callbackId: string): Intent | null {
    const cmd = CALLBACK_MAP[callbackId];
    if (!cmd) return null;
    return { type: 'command', data: cmd };
  }
}
