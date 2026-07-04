import type { Intent, ParsedCommand } from '../../types/index.js';
import { callbackPayloadStore } from '../../middleware/callback-payload-store.js';

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
  'cmd_ingresos_mes': { command: 'monthly_result' },
  'cmd_reporte_ingresos': { command: 'monthly_report' },
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
  // Post-acción hacienda / stock (botones de "¿y ahora?")
  'cmd_listar_hacienda': { command: 'list_livestock' },
  'cmd_ver_stock': { command: 'check_stock' },
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

    // Weather city pick: wcity_<token> → weather_full with the chosen locality +
    // provincia (resuelve a exact). El token apunta a {c,p} en callbackPayloadStore
    // (respeta el límite de 64 bytes de callback_data de Telegram).
    const wcityMatch = callbackId.match(/^wcity_([A-Za-z0-9_-]+)$/);
    if (wcityMatch) {
      const payload = callbackPayloadStore.get(wcityMatch[1]);
      if (payload) {
        try {
          const { c, p } = JSON.parse(payload) as { c: string; p: string };
          if (c) return { type: 'command', data: { command: 'weather_full', city: c, province: p ?? null } };
        } catch {
          // fall through to null
        }
      }
    }

    // Dynamic callbacks: rain_field_<fieldName>_<mm> → log_rainfall with field + mm
    const rainMatch = callbackId.match(/^rain_field_(.+)_(\d+(?:\.\d+)?)$/);
    if (rainMatch) {
      return { type: 'command', data: { command: 'log_rainfall', fieldName: rainMatch[1], mm: parseFloat(rainMatch[2]) } };
    }

    // Batched callbacks: rain_batch_<fieldName>_<tokenOrBase64> → log_rainfall_batch.
    // El builder ahora registra el payload en callbackPayloadStore (límite de 64
    // bytes de Telegram); el fallback inline-base64 cubre botones en vuelo.
    const rainBatchMatch = callbackId.match(/^rain_batch_(.+)_([A-Za-z0-9_-]+)$/);
    if (rainBatchMatch) {
      try {
        const resolved = callbackPayloadStore.get(rainBatchMatch[2]) ?? rainBatchMatch[2];
        const json = Buffer.from(resolved, 'base64url').toString('utf-8');
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

    // Sow+harvest offer: sowharv_<base64url> → harvest_crop with _autoSow so the
    // handler registers the missing siembra first (P1-3: harvest with no prior sow).
    const sowHarvMatch = callbackId.match(/^sowharv_([A-Za-z0-9_-]+)$/);
    if (sowHarvMatch) {
      try {
        const p = JSON.parse(Buffer.from(sowHarvMatch[1], 'base64url').toString('utf-8')) as { plot?: string; field?: string; crop?: string; yieldKg?: number | null; yieldNotes?: string | null };
        if (p.crop) {
          return {
            type: 'command',
            data: {
              command: 'harvest_crop',
              plotName: p.plot ?? null, fieldName: p.field ?? null,
              crop: p.crop,
              ...(p.yieldKg != null ? { yieldKg: p.yieldKg } : {}),
              ...(p.yieldNotes ? { yieldNotes: p.yieldNotes } : {}),
              _autoSow: true,
            },
          };
        }
      } catch {
        // fall through
      }
    }

    // Category pick: cat_pick_exp_<token-or-payload>_<categoryId> → pick_category (expense)
    // Since May 28: the first part is normally a short token (~8 chars) that
    // resolves to a payload via callbackPayloadStore. We fall back to treating
    // it as the inline payload itself for backward-compat with in-flight
    // buttons issued before the fix.
    if (callbackId.startsWith('cat_pick_exp_')) {
      const rest = callbackId.slice('cat_pick_exp_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        const tokenOrPayload = rest.slice(0, lastUnderscore);
        const payload = callbackPayloadStore.get(tokenOrPayload) ?? tokenOrPayload;
        return {
          type: 'command',
          data: { command: 'pick_category', kind: 'expense', payload, categoryId: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category pick: cat_pick_inc_<token-or-payload>_<categoryId> → pick_category (income)
    if (callbackId.startsWith('cat_pick_inc_')) {
      const rest = callbackId.slice('cat_pick_inc_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        const tokenOrPayload = rest.slice(0, lastUnderscore);
        const payload = callbackPayloadStore.get(tokenOrPayload) ?? tokenOrPayload;
        return {
          type: 'command',
          data: { command: 'pick_category', kind: 'income', payload, categoryId: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    // Category create inline: cat_new_exp_<token-or-payload> → create_category (expense)
    if (callbackId.startsWith('cat_new_exp_')) {
      const tokenOrPayload = callbackId.slice('cat_new_exp_'.length);
      const payload = callbackPayloadStore.get(tokenOrPayload) ?? tokenOrPayload;
      return {
        type: 'command',
        data: { command: 'create_category', kind: 'expense', payload },
      };
    }

    // Category create inline: cat_new_inc_<token-or-payload> → create_category (income)
    if (callbackId.startsWith('cat_new_inc_')) {
      const tokenOrPayload = callbackId.slice('cat_new_inc_'.length);
      const payload = callbackPayloadStore.get(tokenOrPayload) ?? tokenOrPayload;
      return {
        type: 'command',
        data: { command: 'create_category', kind: 'income', payload },
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

    // Bulk plot assignment after a compound — V2 (any kind, any count).
    // Format: bap2_<tokenOrBase64>_<plotId>
    //   plotId="0" → leave at field-level
    //   byKindMap = { expense?: number[], income?: number[], activity?: number[], ... }
    // El builder registra el payload en callbackPayloadStore y embebe solo el
    // token (límite Telegram 64 bytes); fallback inline-base64 para botones viejos.
    const bap2Match = callbackId.match(/^bap2_([A-Za-z0-9_-]+)_(\d+)$/);
    if (bap2Match) {
      try {
        const resolvedBap2 = callbackPayloadStore.get(bap2Match[1]) ?? bap2Match[1];
        const byKind = JSON.parse(Buffer.from(resolvedBap2, 'base64url').toString('utf-8')) as Record<string, number[]>;
        const plotId = parseInt(bap2Match[2], 10);
        return {
          type: 'command',
          data: {
            command: 'assign_bulk_plot',
            plotId: plotId === 0 ? null : plotId,
            records: byKind,
          },
        };
      } catch {
        // fall through
      }
    }

    // Legacy bulk plot assignment (V1 — expenses + incomes only). Kept for
    // in-flight buttons rendered before V2 ship.
    const bapMatch = callbackId.match(/^bap_(\d+)_([\d,]+|n)_([\d,]+|n)$/);
    if (bapMatch) {
      const plotId = parseInt(bapMatch[1], 10);
      const expenseIds = bapMatch[2] === 'n' ? [] : bapMatch[2].split(',').map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n));
      const incomeIds = bapMatch[3] === 'n' ? [] : bapMatch[3].split(',').map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n));
      return {
        type: 'command',
        data: {
          command: 'assign_bulk_plot',
          plotId: plotId === 0 ? null : plotId,
          records: { expense: expenseIds, income: incomeIds },
        },
      };
    }

    // Gap 4 — pick location for sanidad/repro/pesaje
    // Format: lv_pick_loc_<kind>_<payload>_<plotIdOrNull>_<corralIdOrNull>
    const pickLocMatch = callbackId.match(/^lv_pick_loc_(health|repro|weigh)_/);
    if (pickLocMatch) {
      const kind = pickLocMatch[1];
      const rest = callbackId.slice(`lv_pick_loc_${kind}_`.length);
      const parts = rest.split('_');
      if (parts.length >= 3) {
        const corralIdStr = parts[parts.length - 1];
        const plotIdStr = parts[parts.length - 2];
        const payload = parts.slice(0, -2).join('_');
        return {
          type: 'command',
          data: { command: 'livestock_pick_location', kind, payload, plotIdStr, corralIdStr },
        };
      }
    }

    // Gap 5 — apply animals_affected (all/skip)
    // Format: lv_animals_<mode>_<kind>_<payload>
    if (callbackId.startsWith('lv_animals_all_') || callbackId.startsWith('lv_animals_skip_')) {
      const mode = callbackId.startsWith('lv_animals_all_') ? 'all' : 'skip';
      const prefix = `lv_animals_${mode}_`;
      const rest = callbackId.slice(prefix.length);
      const underscoreIdx = rest.indexOf('_');
      if (underscoreIdx > 0) {
        return {
          type: 'command',
          data: {
            command: 'livestock_apply_animals',
            kind: rest.slice(0, underscoreIdx),
            payload: rest.slice(underscoreIdx + 1),
            mode,
          },
        };
      }
    }

    // Gap 3 — create-and-continue (corral / plot / feedlot / field)
    const createMatch = callbackId.match(/^lv_create_(corral|plot|feedlot|field)_continue_/);
    if (createMatch) {
      const subType = createMatch[1];
      return {
        type: 'command',
        data: {
          command: 'livestock_create_continue',
          subType,
          payload: callbackId.slice(`lv_create_${subType}_continue_`.length),
        },
      };
    }
    if (callbackId === 'lv_create_cancel') {
      return { type: 'command', data: { command: 'livestock_create_cancel' } };
    }

    // Deterministic lote-vs-feedlot choice (token from callbackPayloadStore).
    const locTypeMatch = callbackId.match(/^lv_loc_(lote|feedlot)_(.+)$/);
    if (locTypeMatch) {
      return {
        type: 'command',
        data: {
          command: 'livestock_place_choice',
          placeChoice: locTypeMatch[1] === 'feedlot' ? 'feedlot' : 'lote',
          payload: locTypeMatch[2],
        },
      };
    }
    // Specific corral choice: lv_loc_corralpick_<token> (token carries the corral).
    if (callbackId.startsWith('lv_loc_corralpick_')) {
      return {
        type: 'command',
        data: {
          command: 'livestock_place_corral',
          payload: callbackId.slice('lv_loc_corralpick_'.length),
        },
      };
    }

    // Gap 8 — post-action shortcuts
    if (callbackId.startsWith('lv_post_stock_')) {
      const rest = callbackId.slice('lv_post_stock_'.length);
      const parts = rest.split('_');
      return { type: 'command', data: { command: 'livestock_post_stock', plotIdStr: parts[0], corralIdStr: parts[1] } };
    }
    if (callbackId.startsWith('lv_post_weigh_')) {
      return { type: 'command', data: { command: 'livestock_post_weigh', groupId: callbackId.slice('lv_post_weigh_'.length) } };
    }
    if (callbackId.startsWith('lv_post_gdpv_')) {
      return { type: 'command', data: { command: 'livestock_post_gdpv', groupId: callbackId.slice('lv_post_gdpv_'.length) } };
    }
    if (callbackId.startsWith('lv_post_health_hist_')) {
      return { type: 'command', data: { command: 'livestock_post_health_hist', groupId: callbackId.slice('lv_post_health_hist_'.length) } };
    }
    if (callbackId.startsWith('lv_post_repro_hist_')) {
      return { type: 'command', data: { command: 'livestock_post_repro_hist', groupId: callbackId.slice('lv_post_repro_hist_'.length) } };
    }
    if (callbackId === 'lv_post_resumen_mes') {
      return { type: 'command', data: { command: 'livestock_post_resumen_mes' } };
    }
    if (callbackId.startsWith('lv_post_undo_movement_')) {
      return { type: 'command', data: { command: 'livestock_post_undo_movement', movementId: callbackId.slice('lv_post_undo_movement_'.length) } };
    }
    if (callbackId.startsWith('lv_post_undo_event_')) {
      return { type: 'command', data: { command: 'livestock_post_undo_event', eventId: callbackId.slice('lv_post_undo_event_'.length) } };
    }
    if (callbackId.startsWith('lv_post_new_event_')) {
      // format: lv_post_new_event_<groupId>_<subKind>
      const rest = callbackId.slice('lv_post_new_event_'.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        return {
          type: 'command',
          data: { command: 'livestock_post_new_event', groupId: rest.slice(0, lastUnderscore), subKind: rest.slice(lastUnderscore + 1) },
        };
      }
    }

    return null;
  }
}
