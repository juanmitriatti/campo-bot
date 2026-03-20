import type { InteractiveMessage } from '../types/index.js';

const DEFAULT_MENU: InteractiveMessage = {
  type: 'buttons',
  body: '¿Qué querés hacer?',
  buttons: [
    { id: 'flow_new_expense', title: 'Registrar Gasto' },
    { id: 'flow_new_activity', title: 'Registrar Actividad' },
    { id: 'back_menu', title: 'Menú' },
  ],
};

const SUGGESTIONS: Record<string, InteractiveMessage> = {
  default_menu: DEFAULT_MENU,
  expense_saved: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_expense', title: 'Otro Gasto' },
      { id: 'cmd_resumen_mensual', title: 'Resumen Mes' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  income_saved: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_income', title: 'Otro Ingreso' },
      { id: 'cmd_resumen_mensual', title: 'Resultado Mes' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  field_created: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_expense', title: 'Registrar Gasto' },
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  rainfall_logged: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'cmd_reporte_lluvia', title: 'Reporte Lluvia' },
      { id: 'menu_clima', title: 'Clima' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  activity_logged: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_activity', title: 'Otra Actividad' },
      { id: 'cmd_reporte_agro', title: 'Reporte Agro' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  plot_created: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_expense', title: 'Registrar Gasto' },
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  field_deleted: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  plot_deleted: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  observation_logged: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_activity', title: 'Registrar Actividad' },
      { id: 'cmd_reporte_agro', title: 'Reporte Agro' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  query_result: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_activity', title: 'Registrar Actividad' },
      { id: 'cmd_reporte_agro', title: 'Reporte Agro' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  query_empty: {
    type: 'buttons',
    body: '¿Querés hacer algo más?',
    buttons: [
      { id: 'flow_new_activity', title: 'Registrar Actividad' },
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  field_info_shown: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'flow_new_expense', title: 'Registrar Gasto' },
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  report_shown: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'cmd_resumen_mensual', title: 'Otro Reporte' },
      { id: 'flow_new_expense', title: 'Registrar Gasto' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
  weather_shown: {
    type: 'buttons',
    body: '¿Qué querés hacer ahora?',
    buttons: [
      { id: 'cmd_registrar_lluvia', title: 'Registrar Lluvia' },
      { id: 'cmd_reporte_lluvia', title: 'Reporte Lluvia' },
      { id: 'back_menu', title: 'Menú' },
    ],
  },
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
  return DEFAULT_MENU;
}
