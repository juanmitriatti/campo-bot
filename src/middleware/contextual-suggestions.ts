import type { InteractiveMessage } from '../types/index.js';

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

const SUGGESTIONS: Record<string, InteractiveMessage> = {
  default_menu: MENU_LIST,
  expense_saved: MENU_LIST,
  income_saved: MENU_LIST,
  field_created: MENU_LIST,
  rainfall_logged: MENU_LIST,
  activity_logged: MENU_LIST,
  plot_created: MENU_LIST,
  field_deleted: MENU_LIST,
  plot_deleted: MENU_LIST,
  observation_logged: MENU_LIST,
  query_result: MENU_LIST,
  query_empty: MENU_LIST,
  field_info_shown: MENU_LIST,
  report_shown: MENU_LIST,
  weather_shown: MENU_LIST,
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
