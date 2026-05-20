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
  // Help category sections
  'help_gastos': { command: 'help_section', helpSection: 'help_gastos' },
  'help_actividades': { command: 'help_section', helpSection: 'help_actividades' },
  'help_lluvia': { command: 'help_section', helpSection: 'help_lluvia' },
  'help_cosecha': { command: 'help_section', helpSection: 'help_cosecha' },
  'help_hacienda': { command: 'help_section', helpSection: 'help_hacienda' },
  'help_campos': { command: 'help_section', helpSection: 'help_campos' },
  'help_reportes': { command: 'help_section', helpSection: 'help_reportes' },
  'help_editar': { command: 'help_section', helpSection: 'help_editar' },
  'help_config': { command: 'help_section', helpSection: 'help_config' },
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

    // Category pick: cat_pick_exp_<payload>_<categoryId> → pick_category (expense)
    if (callbackId.startsWith('cat_pick_exp_')) {
      const rest = callbackId.slice('cat_pick_exp_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        return {
          type: 'command',
          data: { command: 'pick_category', kind: 'expense', payload: rest.slice(0, lastUnderscore), categoryId: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category pick: cat_pick_inc_<payload>_<categoryId> → pick_category (income)
    if (callbackId.startsWith('cat_pick_inc_')) {
      const rest = callbackId.slice('cat_pick_inc_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        return {
          type: 'command',
          data: { command: 'pick_category', kind: 'income', payload: rest.slice(0, lastUnderscore), categoryId: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category create inline: cat_new_exp_<payload> → create_category (expense)
    if (callbackId.startsWith('cat_new_exp_')) {
      return {
        type: 'command',
        data: { command: 'create_category', kind: 'expense', payload: callbackId.slice('cat_new_exp_'.length) },
      };
    }

    // Category create inline: cat_new_inc_<payload> → create_category (income)
    if (callbackId.startsWith('cat_new_inc_')) {
      return {
        type: 'command',
        data: { command: 'create_category', kind: 'income', payload: callbackId.slice('cat_new_inc_'.length) },
      };
    }

    // Category similarity: use existing (expense)
    if (callbackId.startsWith('cat_sim_use_exp_')) {
      const rest = callbackId.slice('cat_sim_use_exp_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        return {
          type: 'command',
          data: { command: 'category_similar_use', kind: 'expense', payload: rest.slice(0, lastUnderscore), categoryId: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category similarity: use existing (income)
    if (callbackId.startsWith('cat_sim_use_inc_')) {
      const rest = callbackId.slice('cat_sim_use_inc_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        return {
          type: 'command',
          data: { command: 'category_similar_use', kind: 'income', payload: rest.slice(0, lastUnderscore), categoryId: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category similarity: create new anyway (expense)
    if (callbackId.startsWith('cat_sim_new_exp_')) {
      const rest = callbackId.slice('cat_sim_new_exp_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        return {
          type: 'command',
          data: { command: 'category_similar_new', kind: 'expense', payload: rest.slice(0, lastUnderscore), newName: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category similarity: create new anyway (income)
    if (callbackId.startsWith('cat_sim_new_inc_')) {
      const rest = callbackId.slice('cat_sim_new_inc_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        return {
          type: 'command',
          data: { command: 'category_similar_new', kind: 'income', payload: rest.slice(0, lastUnderscore), newName: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category similarity: cancel
    if (callbackId === 'cat_sim_cancel') {
      return {
        type: 'command',
        data: { command: 'category_similar_cancel' },
      };
    }

    return null;
  }
}
