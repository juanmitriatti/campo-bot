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
  'cmd_agregar_lote': { command: 'prompt_add_plot' },
  // Sub-menu: Reportes
  'cmd_reporte_semanal': { command: 'weekly_report' },
  'cmd_exportar_csv': { command: 'export_csv' },
  'cmd_reporte_agro': { command: 'generate_agro_report' },
  'cmd_historial_lote': { command: 'query_plot_history' },
  // Back to main menu
  'back_menu': { command: 'menu' },
  // Document upload entry points
  'doc_upload_factura': { command: 'start_document_upload', documentType: 'factura' },
  'doc_upload_remito': { command: 'start_document_upload', documentType: 'remito' },
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
    if (cmd) return { type: 'command', data: cmd };

    // Dynamic callbacks: cmd_historial_<plotId> → query_plot_history with plotId
    const historialMatch = callbackId.match(/^cmd_historial_(\d+)$/);
    if (historialMatch) {
      return { type: 'command', data: { command: 'query_plot_history', plotId: parseInt(historialMatch[1], 10) } };
    }

    // Dynamic callbacks: rain_field_<fieldName>_<mm> → log_rainfall with field + mm
    const rainMatch = callbackId.match(/^rain_field_(.+)_(\d+(?:\.\d+)?)$/);
    if (rainMatch) {
      return { type: 'command', data: { command: 'log_rainfall', fieldName: rainMatch[1], mm: parseFloat(rainMatch[2]) } };
    }

    // Batched callbacks: rain_batch_<fieldName>_<base64> → log_rainfall_batch
    const rainBatchMatch = callbackId.match(/^rain_batch_(.+)_([A-Za-z0-9_-]+)$/);
    if (rainBatchMatch) {
      try {
        const json = Buffer.from(rainBatchMatch[2], 'base64url').toString('utf-8');
        const items = JSON.parse(json) as Array<{ mm: number; date: string | null }>;
        if (Array.isArray(items) && items.length > 0) {
          return {
            type: 'command',
            data: { command: 'log_rainfall_batch', fieldName: rainBatchMatch[1], items },
          };
        }
      } catch {
        // fall through to null
      }
    }

    return null;
  }
}
