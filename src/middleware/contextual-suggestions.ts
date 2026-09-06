// Sugerencias post-acción ("¿Y ahora?"): después de cada acción, hasta 3
// botones con los próximos pasos más probables. Enseñan capacidades sin tirar
// el menú entero.
//
// Reglas (Sep 2026, tras el análisis con datos de prod):
// - Cada id de botón tiene ruta en CALLBACK_MAP y título de ≤20 caracteres
//   (límite de WhatsApp: un título más largo tira el mensaje ENTERO con 400).
//   `validateCatalog()` lo verifica y el test falla si se rompe.
// - Un botón que abre ayuda dice "Ejemplos", nunca finge ser una acción.
// - Los botones se filtran por plan (BUTTON_FEATURE) antes de enviarse.
// - Kill switch, tope diario, claves apagadas y overrides viven en settings
//   (grupo bot): se arreglan sin deploy. Ver buildSuggestion().
// - Sin fallback al menú: un comando sin clave mapeada no muestra nada.
import type { InteractiveMessage, InteractiveButton } from '../types/index.js';
import { CALLBACK_MAP } from '../domain/interactive/interactive.router.js';

export const WHATSAPP_BUTTON_TITLE_MAX = 20;

// ─── Generic menu (solo para claves que lo piden explícitamente; el render
// de sugerencias dibuja botones, no listas) ─────────────────────────────
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

const b = (id: string, title: string): InteractiveButton => ({ id, title });
const buttons = (body: string, ...items: InteractiveButton[]): InteractiveMessage => ({ type: 'buttons', body, buttons: items });

// ─── Per-action suggestions ────────────────────────────────────────────
const POST_EXPENSE = buttons('¿Y ahora?',
  b('cmd_resumen_mensual', '📈 Resultado mes'),
  b('doc_upload_factura', '🧾 Cargar factura'),
  b('cmd_borrar_ultimo_gasto', '↩️ Borrar último'), // pide confirmación (destructivo)
);
const POST_INCOME = buttons('¿Y ahora?',
  b('cmd_resumen_mensual', '📈 Resultado mes'),
  b('flow_new_income', '💸 Otro ingreso'),
  b('cmd_borrar_ultimo_ingreso', '↩️ Borrar último'),
);
const POST_FIELD = buttons('¿Próximo paso?',
  b('cmd_agregar_lote', '🌾 Crear lote'),
  b('cmd_listar_campos', '🏡 Mis campos'),
  b('menu_ayuda', '❓ Ayuda'),
);
const POST_PLOT = buttons('¿Próximo paso?',
  b('form_open_sow', '🌱 Sembrar'),          // formulario de siembra, no el picker de 7 tipos
  b('flow_new_expense', '💰 Cargar gasto'),
  b('cmd_listar_campos', '🏡 Mis campos'),
);
const POST_ACTIVITY = buttons('¿Y ahora?',
  b('cmd_reporte_agro', '📊 Reporte agro PDF'),
  b('flow_new_activity', '🌾 Otra actividad'),
  b('menu_lluvia', '🌧️ Registrar lluvia'),
);
const POST_ACTIVITIES_SHOWN = buttons('¿Y ahora?',
  b('flow_new_activity', '🌾 Nueva actividad'),
  b('cmd_reporte_agro', '📊 Reporte agro PDF'),
  b('back_menu', '📋 Menú'),
);
const POST_RAINFALL = buttons('¿Y ahora?',
  b('cmd_reporte_lluvia', '📊 Lluvia este mes'),
  b('menu_clima', '☀️ Clima 7 días'),
  b('flow_new_rainfall', '🌧️ Otra lluvia'),
);
const POST_RAINFALL_SHOWN = buttons('¿Y ahora?',
  b('menu_lluvia', '🌧️ Registrar lluvia'),
  b('menu_clima', '☀️ Clima 7 días'),
  b('back_menu', '📋 Menú'),
);
const POST_OBSERVATION = buttons('¿Y ahora?',
  b('cmd_reporte_agro', '📊 Reporte agro PDF'),
  b('flow_new_activity', '🌾 Nueva actividad'), // era "Registrar actividad": 21 chars, WhatsApp lo rechazaba
  b('menu_lluvia', '🌧️ Registrar lluvia'),
);
const POST_REPORT = buttons('¿Más?',
  b('cmd_exportar_csv', '📥 Exportar CSV'),
  b('cmd_reporte_agro', '📊 Reporte agro PDF'),
  b('back_menu', '📋 Menú'),
);
const POST_WEATHER = buttons('¿Más?',
  b('menu_lluvia', '🌧️ Registrar lluvia'),
  b('cmd_reporte_lluvia', '📊 Lluvia este mes'),
  b('back_menu', '📋 Menú'),
);
const POST_FIELD_INFO = buttons('¿Y ahora?',
  b('cmd_reporte_agro', '📊 Reporte agro PDF'),
  b('flow_new_activity', '🌾 Nueva actividad'),
  b('flow_new_expense', '💰 Cargar gasto'),
);
// Consulta con resultados (historial de lote): próximos pasos, no "¿qué querés hacer?".
const POST_QUERY_RESULT = buttons('¿Y ahora?',
  b('cmd_reporte_agro', '📊 Reporte agro PDF'),
  b('flow_new_activity', '🌾 Nueva actividad'),
  b('back_menu', '📋 Menú'),
);
const POST_QUERY_EMPTY = buttons('¿Qué querés hacer?',
  b('back_menu', '📋 Ver menú'),
  b('menu_ayuda', '❓ Ayuda'),
);
// Estados vacíos: la mejor parte del sistema — un camino en vez de un callejón.
const POST_CROP_EMPTY = buttons('¿Querés empezar?',
  b('form_open_sow', '🌱 Sembrar'),
  b('cmd_listar_campos', '🏡 Mis campos'),
  b('help_actividades', '❓ Ver ejemplos'),
);
const POST_LIVESTOCK_EMPTY = buttons('¿Querés empezar?',
  b('form_open_livestock', '🐄 Cargar hacienda'),
  b('help_hacienda', '❓ Ver ejemplos'),
  b('back_menu', '📋 Menú'),
);
const POST_STOCK_EMPTY = buttons('¿Querés empezar?',
  b('help_cosecha', '📦 Ver ejemplos'),
  b('back_menu', '📋 Menú'),
);
const POST_LIVESTOCK = buttons('¿Y ahora?',
  b('cmd_listar_hacienda', '🐄 Ver hacienda'),
  b('help_hacienda', '❓ Ejemplos hacienda'), // era "💉 Sanidad / pesaje" y abría la ayuda
  b('back_menu', '📋 Menú'),
);
const POST_LIVESTOCK_SHOWN = buttons('¿Y ahora?',
  b('form_open_livestock', '➕ Cargar hacienda'),
  b('help_hacienda', '❓ Ejemplos hacienda'),
  b('back_menu', '📋 Menú'),
);
const POST_STOCK = buttons('¿Y ahora?',
  b('cmd_ver_stock', '📦 Ver stock'),
  b('help_cosecha', '❓ Ejemplos stock'),     // era "➕ Cargar / usar más" y abría la ayuda de cosecha
  b('back_menu', '📋 Menú'),
);
const POST_STOCK_SHOWN = buttons('¿Y ahora?',
  b('help_cosecha', '❓ Ejemplos stock'),
  b('back_menu', '📋 Menú'),
);
const POST_HARVEST = buttons('¿Y ahora?',
  b('cmd_reporte_agro', '📊 Reporte agro PDF'),
  b('flow_new_activity', '🌾 Otra actividad'),
  b('back_menu', '📋 Menú'),
);

export const SUGGESTIONS: Record<string, InteractiveMessage> = {
  default_menu: MENU_LIST,
  expense_saved: POST_EXPENSE,
  income_saved: POST_INCOME,
  field_created: POST_FIELD,
  plot_created: POST_PLOT,
  activity_logged: POST_ACTIVITY,
  activities_shown: POST_ACTIVITIES_SHOWN,
  rainfall_logged: POST_RAINFALL,
  rainfall_shown: POST_RAINFALL_SHOWN,
  observation_logged: POST_OBSERVATION,
  query_result: POST_QUERY_RESULT,
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
  livestock_shown: POST_LIVESTOCK_SHOWN,
  stock_logged: POST_STOCK,
  stock_shown: POST_STOCK_SHOWN,
  harvest_logged: POST_HARVEST,
};

/** Feature (plan) que necesita cada botón. Sin entrada = libre. */
export const BUTTON_FEATURE: Record<string, string> = {
  cmd_resumen_mensual: 'expenses',
  cmd_borrar_ultimo_gasto: 'expenses',
  flow_new_expense: 'expenses',
  flow_new_income: 'incomes',
  cmd_borrar_ultimo_ingreso: 'incomes',
  doc_upload_factura: 'documents',
  cmd_agregar_lote: 'fields',
  cmd_listar_campos: 'fields',
  flow_new_activity: 'agronomy',
  cmd_reporte_agro: 'agronomy',
  form_open_sow: 'agronomy',
  menu_lluvia: 'rainfall',
  cmd_reporte_lluvia: 'rainfall',
  flow_new_rainfall: 'rainfall',
  menu_clima: 'weather',
  cmd_exportar_csv: 'csv_export',
  cmd_listar_hacienda: 'livestock',
  form_open_livestock: 'livestock',
  help_hacienda: 'livestock',
  cmd_ver_stock: 'stock',
};

// Command → suggestion key para comandos que no setean la suya.
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
  rainfall_report: 'rainfall_shown',
  rainfall_range: 'rainfall_shown',
  plot_activities: 'activities_shown',
  query_plot_history: 'query_result',
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
  add_stock: 'stock_logged',
  remove_stock: 'stock_logged',
};

export function getSuggestions(completedAction: string): InteractiveMessage | null {
  return SUGGESTIONS[completedAction] ?? null;
}

/** Clave de sugerencia para un comando. Sin fallback: comando no mapeado → nada. */
export function resolveSuggestionKey(command: string, existingKey?: string | null): string | undefined {
  if (existingKey) return existingKey;
  return COMMAND_SUGGESTION_MAP[command];
}

export function getDefaultSuggestion(): InteractiveMessage {
  return MENU_LIST;
}

/** Ids de botón que pertenecen al catálogo (para reconocer taps de sugerencia). */
export const CATALOG_BUTTON_IDS: ReadonlySet<string> = new Set(
  Object.values(SUGGESTIONS).flatMap(m => (m.type === 'buttons' ? m.buttons.map(x => x.id) : [])),
);

// ─── Política (settings del admin) ─────────────────────────────────────
export interface SuggestionPolicy {
  enabled: boolean;
  maxPerDay: number;                 // 0 = sin tope
  disabledKeys: Set<string>;
  overrides: Record<string, InteractiveMessage>;
}

function validateButtonsMessage(m: unknown, where: string): string[] {
  const errs: string[] = [];
  const msg = m as { body?: unknown; buttons?: unknown } | null;
  if (!msg || typeof msg !== 'object') return [`${where}: no es un objeto`];
  if (typeof msg.body !== 'string' || !msg.body.trim()) errs.push(`${where}: body vacío`);
  const btns = Array.isArray(msg.buttons) ? (msg.buttons as Array<Partial<InteractiveButton> | null>) : null;
  if (!btns || btns.length < 1 || btns.length > 3) errs.push(`${where}: entre 1 y 3 botones`);
  for (const btn of btns ?? []) {
    if (!btn || typeof btn.id !== 'string' || typeof btn.title !== 'string') { errs.push(`${where}: botón inválido`); continue; }
    if (!(btn.id in CALLBACK_MAP)) errs.push(`${where}: el id "${btn.id}" no tiene ruta en CALLBACK_MAP`);
    if (!btn.title.trim()) errs.push(`${where}: título vacío`);
    if (btn.title.length > WHATSAPP_BUTTON_TITLE_MAX) errs.push(`${where}: "${btn.title}" supera ${WHATSAPP_BUTTON_TITLE_MAX} caracteres (WhatsApp lo rechaza)`);
  }
  return errs;
}

/** Overrides JSON de settings → mensajes válidos. Lo inválido se ignora y se loguea. */
export function parseSuggestionOverrides(raw: string | null | undefined): Record<string, InteractiveMessage> {
  const out: Record<string, InteractiveMessage> = {};
  const text = (raw ?? '').trim();
  if (!text) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) {
    console.warn(`[SUGGEST] SUGGESTIONS_OVERRIDES no es JSON válido, se ignora: ${(err as Error).message}`);
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[SUGGEST] SUGGESTIONS_OVERRIDES debe ser un objeto {clave: {body, buttons}}, se ignora');
    return out;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in SUGGESTIONS)) { console.warn(`[SUGGEST] override para clave desconocida "${key}", se ignora`); continue; }
    const errs = validateButtonsMessage(value, `override ${key}`);
    if (errs.length) { console.warn(`[SUGGEST] ${errs.join('; ')} — se ignora`); continue; }
    const v = value as { body: string; buttons: InteractiveButton[] };
    out[key] = { type: 'buttons', body: v.body, buttons: v.buttons.map(x => ({ id: x.id, title: x.title })) };
  }
  return out;
}

export function parseSuggestionPolicy(raw: {
  enabled: boolean | null | undefined;
  maxPerDay: number | null | undefined;
  disabledKeys: string | null | undefined;
  overridesJson: string | null | undefined;
}): SuggestionPolicy {
  const disabled = new Set((raw.disabledKeys ?? '').split(',').map(s => s.trim()).filter(Boolean));
  return {
    enabled: raw.enabled !== false,
    maxPerDay: Math.max(0, Math.floor(Number(raw.maxPerDay) || 0)),
    disabledKeys: disabled,
    overrides: parseSuggestionOverrides(raw.overridesJson),
  };
}

export interface BuildSuggestionInput {
  key: string;
  policy: SuggestionPolicy;
  hasFeature: (feature: string) => Promise<boolean>;
  shownToday: () => Promise<number>;
}

/**
 * La sugerencia que efectivamente se manda para una clave, o null. Aplica
 * kill switch, claves apagadas, override, tope diario y gate por plan.
 * Solo devuelve mensajes de botones (las listas no se rinden como sugerencia).
 */
export async function buildSuggestion(input: BuildSuggestionInput): Promise<InteractiveMessage | null> {
  const { key, policy } = input;
  if (!policy.enabled) return null;
  if (policy.disabledKeys.has(key)) { console.log(`[SUGGEST] clave apagada por settings: ${key}`); return null; }
  const base = policy.overrides[key] ?? SUGGESTIONS[key];
  if (!base || base.type !== 'buttons' || !base.buttons?.length) return null;
  if (policy.maxPerDay > 0) {
    const n = await input.shownToday();
    if (n >= policy.maxPerDay) { console.log(`[SUGGEST] tope diario alcanzado (${n}/${policy.maxPerDay}), sin sugerencia`); return null; }
  }
  const kept: InteractiveButton[] = [];
  for (const btn of base.buttons) {
    const feature = BUTTON_FEATURE[btn.id];
    if (feature && !(await input.hasFeature(feature))) {
      console.log(`[SUGGEST] botón ${btn.id} omitido: el plan no incluye ${feature}`);
      continue;
    }
    kept.push(btn);
  }
  if (kept.length === 0) return null;
  return { type: 'buttons', body: base.body, buttons: kept };
}

/** Integridad del catálogo (lo corre el test). Vacío = todo bien. */
export function validateCatalog(): string[] {
  const errs: string[] = [];
  for (const [key, msg] of Object.entries(SUGGESTIONS)) {
    if (msg.type === 'buttons') errs.push(...validateButtonsMessage(msg, key));
    else if (msg.type === 'list') {
      for (const s of msg.sections ?? []) for (const r of s.rows) {
        if (!(r.id in CALLBACK_MAP)) errs.push(`${key}: fila "${r.id}" sin ruta en CALLBACK_MAP`);
      }
    }
  }
  for (const [cmd, key] of Object.entries(COMMAND_SUGGESTION_MAP)) {
    if (!(key in SUGGESTIONS)) errs.push(`COMMAND_SUGGESTION_MAP: ${cmd} → "${key}" no existe en el catálogo`);
  }
  return errs;
}
