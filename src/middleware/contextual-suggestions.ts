import type { InteractiveMessage } from '../types/index.js';

const SUGGESTIONS: Record<string, InteractiveMessage> = {
  expense_saved: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'flow_new_expense', title: 'Otro Gasto' },
      { id: 'cmd_resumen_mensual', title: 'Resumen Mes' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  income_saved: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'flow_new_income', title: 'Otro Ingreso' },
      { id: 'cmd_resumen_mensual', title: 'Resultado Mes' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  field_created: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'flow_new_expense', title: 'Registrar Gasto' },
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  rainfall_logged: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'cmd_reporte_lluvia', title: 'Reporte Lluvia' },
      { id: 'menu_clima', title: 'Clima' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  activity_logged: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'flow_new_activity', title: 'Otra Actividad' },
      { id: 'cmd_reporte_agro', title: 'Reporte Agro' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  plot_created: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'flow_new_expense', title: 'Registrar Gasto' },
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  field_deleted: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  plot_deleted: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'cmd_listar_campos', title: 'Ver Campos' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
  observation_logged: {
    type: 'buttons',
    body: '\u00bfQu\u00e9 quer\u00e9s hacer ahora?',
    buttons: [
      { id: 'flow_new_activity', title: 'Registrar Actividad' },
      { id: 'cmd_reporte_agro', title: 'Reporte Agro' },
      { id: 'back_menu', title: 'Men\u00fa' },
    ],
  },
};

export function getSuggestions(completedAction: string): InteractiveMessage | null {
  return SUGGESTIONS[completedAction] ?? null;
}
