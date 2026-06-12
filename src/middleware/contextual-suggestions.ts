import type { InteractiveMessage } from '../types/index.js';

// ─── Generic fallback menu ─────────────────────────────────────────────
const MENU_LIST: InteractiveMessage = {
  type: 'list',
  body: '¿Seguimos?',
  buttonText: 'Menú',
  sections: [
    {
      title: 'Registrar',
      rows: [
        { id: 'flow_new_expense', title: '💰 Nuevo Gasto', description: 'Registrar paso a paso' },
        { id: 'flow_new_income', title: '💸 Nuevo Ingreso', description: 'Registrar paso a paso' },
        { id: 'flow_new_activity', title: '🌾 Nueva Actividad', description: 'Siembra, fumigación, etc.' },
      ],
    },
    {
      title: 'Finanzas',
      rows: [
        { id: 'cmd_resumen_mensual', title: '📈 Resultado Mes', description: 'Ingresos vs gastos' },
        { id: 'menu_reportes', title: '📊 Reportes', description: 'Semanal, CSV, agronómico' },
        { id: 'menu_dolar', title: '💵 Dólar', description: 'Cotización actual' },
      ],
    },
    {
      title: 'Campo',
      rows: [
        { id: 'menu_clima', title: '☀️ Clima', description: 'Pronóstico del tiempo' },
        { id: 'menu_lluvia', title: '🌧️ Lluvia', description: 'Registrar, ver reportes' },
        { id: 'menu_campos', title: '🏡 Campos', description: 'Listar, agregar campos' },
      ],
    },
    {
      title: 'Sistema',
      rows: [
        { id: 'menu_config', title: '⚙️ Configuración', description: 'Alertas y preferencias' },
        { id: 'menu_ayuda', title: '❓ Ayuda', description: 'Ver todos los comandos' },
      ],
    },
  ],
};

// ─── Per-action suggestions ────────────────────────────────────────────
// After each completed action, surface the 2–3 most likely NEXT moves.
// Goal: teach the bot's capabilities by showing useful follow-ups
// instead of dumping the full menu every turn.

const POST_EXPENSE: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_resumen_mensual', title: '📈 Resultado mes' },
    { id: 'doc_upload_factura', title: '🧾 Cargar factura' },
    { id: 'cmd_borrar_ultimo_gasto', title: '↩️ Borrar último' },
  ],
};

const POST_INCOME: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_resumen_mensual', title: '📈 Resultado mes' },
    { id: 'flow_new_income', title: '💸 Otro ingreso' },
    { id: 'cmd_borrar_ultimo_ingreso', title: '↩️ Borrar último' },
  ],
};

const POST_FIELD: InteractiveMessage = {
  type: 'buttons',
  body: '¿Próximo paso?',
  buttons: [
    { id: 'cmd_agregar_lote', title: '🌾 Crear lote' },
    { id: 'cmd_listar_campos', title: '🏡 Mis campos' },
    { id: 'menu_ayuda', title: '❓ Ayuda' },
  ],
};

const POST_PLOT: InteractiveMessage = {
  type: 'buttons',
  body: '¿Próximo paso?',
  buttons: [
    { id: 'flow_new_activity', title: '🌱 Sembrar/fumigar' },
    { id: 'flow_new_expense', title: '💰 Cargar gasto' },
    { id: 'cmd_listar_campos', title: '🏡 Mis campos' },
  ],
};

const POST_ACTIVITY: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_reporte_agro', title: '📊 Reporte agro PDF' },
    { id: 'flow_new_activity', title: '🌾 Otra actividad' },
    { id: 'menu_lluvia', title: '🌧️ Registrar lluvia' },
  ],
};

const POST_RAINFALL: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_reporte_lluvia', title: '📊 Lluvia este mes' },
    { id: 'menu_clima', title: '☀️ Clima 7 días' },
    { id: 'flow_new_rainfall', title: '🌧️ Otra lluvia' },
  ],
};

const POST_OBSERVATION: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_reporte_agro', title: '📊 Reporte agro PDF' },
    { id: 'flow_new_activity', title: '🌾 Registrar actividad' },
    { id: 'menu_lluvia', title: '🌧️ Registrar lluvia' },
  ],
};

const POST_REPORT: InteractiveMessage = {
  type: 'buttons',
  body: '¿Más?',
  buttons: [
    { id: 'cmd_exportar_csv', title: '📥 Exportar CSV' },
    { id: 'cmd_reporte_agro', title: '📊 Reporte agro PDF' },
    { id: 'back_menu', title: '📋 Menú' },
  ],
};

const POST_WEATHER: InteractiveMessage = {
  type: 'buttons',
  body: '¿Más?',
  buttons: [
    { id: 'menu_lluvia', title: '🌧️ Registrar lluvia' },
    { id: 'cmd_reporte_lluvia', title: '📊 Lluvia este mes' },
    { id: 'back_menu', title: '📋 Menú' },
  ],
};

const POST_FIELD_INFO: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_reporte_agro', title: '📊 Reporte agro PDF' },
    { id: 'flow_new_activity', title: '🌾 Nueva actividad' },
    { id: 'flow_new_expense', title: '💰 Cargar gasto' },
  ],
};

const POST_QUERY_EMPTY: InteractiveMessage = {
  type: 'buttons',
  body: '¿Qué querés hacer?',
  buttons: [
    { id: 'back_menu', title: '📋 Ver menú' },
    { id: 'menu_ayuda', title: '❓ Ayuda' },
  ],
};

// Empty states — when a query lands on "no hay X". Offer the most common
// next steps so the user has a clear path instead of a dead-end message.
const POST_CROP_EMPTY: InteractiveMessage = {
  type: 'buttons',
  body: '¿Querés empezar?',
  buttons: [
    { id: 'flow_new_activity', title: '🌱 Sembrar' },
    { id: 'cmd_listar_campos', title: '🏡 Mis campos' },
    { id: 'help_actividades', title: '❓ Ver ejemplos' },
  ],
};

const POST_LIVESTOCK_EMPTY: InteractiveMessage = {
  type: 'buttons',
  body: '¿Querés empezar?',
  buttons: [
    { id: 'help_hacienda', title: '🐄 Ver ejemplos' },
    { id: 'cmd_listar_campos', title: '🏡 Mis campos' },
    { id: 'back_menu', title: '📋 Menú' },
  ],
};

const POST_STOCK_EMPTY: InteractiveMessage = {
  type: 'buttons',
  body: '¿Querés empezar?',
  buttons: [
    { id: 'help_cosecha', title: '📦 Ver ejemplos' },
    { id: 'back_menu', title: '📋 Menú' },
  ],
};

// Post-acción para registros de hacienda (alta/baja/transfer/sanidad/repro/peso).
const POST_LIVESTOCK: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_listar_hacienda', title: '🐄 Ver hacienda' },
    { id: 'help_hacienda', title: '💉 Sanidad / pesaje' },
    { id: 'back_menu', title: '📋 Menú' },
  ],
};

// Post-acción para movimientos de stock (carga/uso).
const POST_STOCK: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_ver_stock', title: '📦 Ver stock' },
    { id: 'help_cosecha', title: '➕ Cargar / usar más' },
    { id: 'back_menu', title: '📋 Menú' },
  ],
};

// Post-cosecha: lo más útil es ver la campaña y su rinde.
const POST_HARVEST: InteractiveMessage = {
  type: 'buttons',
  body: '¿Y ahora?',
  buttons: [
    { id: 'cmd_reporte_agro', title: '📊 Reporte agro PDF' },
    { id: 'flow_new_activity', title: '🌾 Otra actividad' },
    { id: 'back_menu', title: '📋 Menú' },
  ],
};

const SUGGESTIONS: Record<string, InteractiveMessage> = {
  default_menu: MENU_LIST,
  expense_saved: POST_EXPENSE,
  income_saved: POST_INCOME,
  field_created: POST_FIELD,
  plot_created: POST_PLOT,
  activity_logged: POST_ACTIVITY,
  rainfall_logged: POST_RAINFALL,
  observation_logged: POST_OBSERVATION,
  query_result: POST_QUERY_EMPTY,
  query_empty: POST_QUERY_EMPTY,
  field_info_shown: POST_FIELD_INFO,
  report_shown: POST_REPORT,
  weather_shown: POST_WEATHER,
  field_deleted: MENU_LIST,
  plot_deleted: MENU_LIST,
  crop_empty: POST_CROP_EMPTY,
  livestock_empty: POST_LIVESTOCK_EMPTY,
  stock_empty: POST_STOCK_EMPTY,
  livestock_logged: POST_LIVESTOCK,
  stock_logged: POST_STOCK,
  harvest_logged: POST_HARVEST,
};

// Command → suggestion key mapping for commands that don't set their own suggestionKey
const COMMAND_SUGGESTION_MAP: Record<string, string> = {
  help: 'default_menu',
  list_fields: 'field_info_shown',
  list_plots: 'field_info_shown',
  field_info: 'field_info_shown',
  plot_info: 'field_info_shown',
  weather_full: 'weather_shown',
  weather_forecast: 'weather_shown',
  weather_field: 'weather_shown',
  weather_all: 'weather_shown',
  financial_report: 'report_shown',
  monthly_report: 'report_shown',
  weekly_report: 'report_shown',
  field_report: 'report_shown',
  plot_report: 'report_shown',
  date_range_report: 'report_shown',
  monthly_result: 'report_shown',
  field_result: 'report_shown',
  compare_months: 'report_shown',
  generate_agro_report: 'report_shown',
  rainfall_report: 'rainfall_logged',
  rainfall_range: 'rainfall_logged',
  plot_activities: 'activity_logged',
  query_plot_history: 'query_result',
  // Actividades agro que antes terminaban "secas" (sin próximos pasos) — Jun 2026.
  // El handler no setea suggestionKey y caían a default_menu (tipo 'list', que el
  // render de sugerencias ignora porque solo muestra 'buttons').
  sow_crop: 'activity_logged',
  harvest_crop: 'harvest_logged',
  log_spraying: 'activity_logged',
  log_fertilization: 'activity_logged',
  log_tillage: 'activity_logged',
  log_irrigation: 'activity_logged',
  log_activity: 'activity_logged',
  log_rainfall: 'rainfall_logged',
  log_crop_scouting: 'observation_logged',
  log_observation: 'observation_logged',
  // Hacienda — los handlers que ya devuelven botones propios (buildPostActionButtons)
  // ganan; estos cubren los casos que terminaban secos.
  add_livestock: 'livestock_logged',
  remove_livestock: 'livestock_logged',
  transfer_livestock: 'livestock_logged',
  record_livestock_death: 'livestock_logged',
  record_livestock_birth: 'livestock_logged',
  adjust_livestock: 'livestock_logged',
  log_health_event: 'livestock_logged',
  log_repro_event: 'livestock_logged',
  log_weighing: 'livestock_logged',
  set_livestock_price: 'livestock_logged',
  // Stock
  add_stock: 'stock_logged',
  remove_stock: 'stock_logged',
};

export function getSuggestions(completedAction: string): InteractiveMessage | null {
  return SUGGESTIONS[completedAction] ?? null;
}

export function resolveSuggestionKey(command: string, existingKey?: string | null): string {
  if (existingKey) return existingKey;
  return COMMAND_SUGGESTION_MAP[command] ?? 'default_menu';
}

export function getDefaultSuggestion(): InteractiveMessage {
  return MENU_LIST;
}
