import type Anthropic from '@anthropic-ai/sdk';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../constants/agro-terms.js';

/**
 * Tool definitions for the AI Agent pipeline.
 * Each tool corresponds to an intent that the bot can handle.
 * Claude decides which tool(s) to call based on the user message.
 */

// Reusable field/plot properties
const FIELD_PROP = { type: 'string' as const, description: 'Nombre del campo, si mencionado.' };
const PLOT_PROP = { type: 'string' as const, description: 'Nombre del lote, si mencionado.' };
const CROP_PROP = { type: 'string' as const, description: 'Cultivo, si mencionado.' };
const QUANTITY_PROP = { type: 'number' as const, description: 'Cantidad.' };
const UNIT_PROP = { type: 'string' as const, description: 'Unidad (kg, lt, cc, tn, bolsas, kg/ha, lt/ha).' };
const DATE_PROP = { type: 'string' as const, description: 'Fecha YYYY-MM-DD si el usuario menciona una fecha distinta a hoy. Omitir si es hoy.' };

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  // ========================
  // FINANCIAL
  // ========================
  {
    name: 'log_expense',
    description: 'Registrar gasto agrícola. Verbos: gasté, pagué, compré + monto.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Monto. lucas=miles, palos=millones, mil=x1000.' },
        category: { type: 'string', enum: [...EXPENSE_CATEGORIES], description: 'Categoría del gasto.' },
        description: { type: 'string', description: 'Descripción breve del gasto.' },
        currency: { type: 'string', enum: ['ARS', 'USD'], description: 'Moneda. Default ARS. "dólares/USD"→USD.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['amount', 'description'],
    },
  },
  {
    name: 'log_income',
    description: 'Registrar ingreso. Verbos: vendí, cobré + monto.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Monto total.' },
        category: { type: 'string', enum: [...INCOME_CATEGORIES], description: 'Categoría del ingreso.' },
        description: { type: 'string', description: 'Descripción breve del ingreso.' },
        currency: { type: 'string', enum: ['ARS', 'USD'], description: 'Moneda. Default ARS.' },
        quantity: { type: 'number', description: 'Cantidad vendida (ej: 30 tn).' },
        unit: UNIT_PROP,
        unit_price: { type: 'number', description: 'Precio por unidad.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['amount', 'description'],
    },
  },

  // ========================
  // ACTIVITIES
  // ========================
  {
    name: 'log_spraying',
    description: 'Registrar fumigación/pulverización. Verbos: fumigué, pulvericé, tiré, eché, apliqué + producto químico.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Producto aplicado (glifosato, cipermetrina, etc.).' },
        product_type: { type: 'string', enum: ['herbicida', 'insecticida', 'fungicida'], description: 'Tipo de producto.' },
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        crop: CROP_PROP,
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: [],
    },
  },
  {
    name: 'log_fertilization',
    description: 'Registrar fertilización. Verbos: fertilicé, aboné, metí + fertilizante (urea, DAP, MAP, fosfato, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Producto fertilizante.' },
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        crop: CROP_PROP,
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: [],
    },
  },
  {
    name: 'log_tillage',
    description: 'Registrar labranza. Verbos: aré, pasé disco, disqueé, rastreé.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Implemento usado (disco, cincel, rastra, arado).' },
        crop: CROP_PROP,
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: [],
    },
  },
  {
    name: 'log_irrigation',
    description: 'Registrar riego. Verbos: regué.',
    input_schema: {
      type: 'object',
      properties: {
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        crop: CROP_PROP,
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: [],
    },
  },
  {
    name: 'sow_crop',
    description: 'Registrar siembra. Verbos: sembré, implanté.',
    input_schema: {
      type: 'object',
      properties: {
        crop: { type: 'string', description: 'Cultivo sembrado.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['crop'],
    },
  },
  {
    name: 'harvest_crop',
    description: 'Registrar cosecha. Verbos: coseché, levanté.',
    input_schema: {
      type: 'object',
      properties: {
        crop: { type: 'string', description: 'Cultivo cosechado.' },
        quantity: { type: 'number', description: 'Cantidad cosechada.' },
        unit: UNIT_PROP,
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['crop'],
    },
  },

  // ========================
  // OBSERVATIONS
  // ========================
  {
    name: 'log_observation',
    description: 'Registrar observación agronómica a campo. Plagas, malezas, estado de cultivo, fenología, clima.',
    input_schema: {
      type: 'object',
      properties: {
        observation: { type: 'string', description: 'Texto de la observación.' },
        crop: CROP_PROP,
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['observation'],
    },
  },
  {
    name: 'log_rainfall',
    description: 'Registrar lluvia en milímetros. "llovieron Xmm", "cayeron Xmm".',
    input_schema: {
      type: 'object',
      properties: {
        quantity: { type: 'number', description: 'Milímetros de lluvia.' },
        field: FIELD_PROP,
      },
      required: ['quantity'],
    },
  },

  // ========================
  // REPORTS
  // ========================
  {
    name: 'weather_full',
    description: 'Consultar clima/pronóstico del tiempo.',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
      },
      required: [],
    },
  },
  {
    name: 'rainfall_report',
    description: 'Consultar reporte de lluvias. "cuánto llovió", "lluvia esta semana/este mes".',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'last_week', 'last_month'], description: 'Período del reporte.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
      },
      required: [],
    },
  },
  {
    name: 'financial_report',
    description: 'Reporte financiero unificado. "reporte mensual", "gastos del campo X", "gastos del lote Y", "resumen semanal", "resultado del mes", "gastos últimos 30 días", "gastos en combustible este año", "ingresos de enero a marzo".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
        plot: PLOT_PROP,
        period: { type: 'string', enum: ['week', 'month', 'year'], description: 'Atajo de período. week=semanal, month=mensual (default), year=anual.' },
        desde: { type: 'string', description: 'Fecha inicio (YYYY-MM-DD).' },
        hasta: { type: 'string', description: 'Fecha fin (YYYY-MM-DD).' },
        days: { type: 'number', description: 'Últimos N días (ej: 30).' },
        category: { type: 'string', description: 'Categoría de gasto/ingreso a filtrar (Combustible, Semillas, Agroquímicos, etc.).' },
        type: { type: 'string', enum: ['expenses', 'incomes', 'both'], description: 'Tipo: solo gastos, solo ingresos, o ambos. Default: both.' },
        include_activities: { type: 'boolean', description: 'Incluir actividades agronómicas en el reporte.' },
        activity_filter: { type: 'string', enum: ['spraying', 'fertilization', 'planting', 'harvest', 'tillage', 'irrigation'], description: 'Filtro de tipo de actividad.' },
      },
      required: [],
    },
  },
  {
    name: 'generate_agro_report',
    description: 'Generar reporte agronómico con observaciones y actividades. "reporte agro", "reporte agronómico del lote X", "estado del lote X", "cómo va el lote X", "novedades del campo", "resumen agronómico", "informe del lote". Soporta rango de fechas.',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
        plot: PLOT_PROP,
        desde: { type: 'string', description: 'Fecha inicio YYYY-MM-DD, si mencionado.' },
        hasta: { type: 'string', description: 'Fecha fin YYYY-MM-DD, si mencionado.' },
      },
      required: [],
    },
  },
  {
    name: 'query_plot_history',
    description: 'Consultar historial de actividades. "cuándo se fumigó el lote X", "historial lote A1", "en qué lote sembré maíz". Puede buscar en todos los lotes si no se especifica uno.',
    input_schema: {
      type: 'object',
      properties: {
        plot: PLOT_PROP,
        field: FIELD_PROP,
        crop: { type: 'string', description: 'Cultivo a buscar (maíz, soja, trigo, etc.).' },
        timeRef: { type: 'string', description: 'Referencia temporal (últimos 30 días, este mes, etc.).' },
        activityFilter: { type: 'string', description: 'Filtro de actividad: log_spraying, log_fertilization, sow_crop, harvest_crop, log_tillage, log_irrigation.' },
      },
      required: [],
    },
  },

  // ========================
  // FIELD / PLOT MANAGEMENT
  // ========================
  {
    name: 'add_field',
    description: 'Crear campo nuevo. "agregar campo X", "crear campo X en Y".',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo a crear.' },
        city: { type: 'string', description: 'Localidad del campo (nombre de localidad argentina).' },
      },
      required: ['field'],
    },
  },
  {
    name: 'add_plot',
    description: 'Crear lote nuevo. "agregar lote X en campo Y".',
    input_schema: {
      type: 'object',
      properties: {
        plotName: { type: 'string', description: 'Nombre de UN SOLO lote. Si hay comas o "y" (ej: "A1, A2 y A3"), usá add_plots_batch.' },
        field: { type: 'string', description: 'Campo donde crear el lote.' },
        hectares: { type: 'number', description: 'Superficie en hectáreas.' },
      },
      required: ['plotName'],
    },
  },
  {
    name: 'add_plots_batch',
    description: 'Crear múltiples lotes a la vez. "agregar lotes A1, A2, A3 en campo X".',
    input_schema: {
      type: 'object',
      properties: {
        plotNames: { type: 'array', items: { type: 'string' }, description: 'Lista de nombres de lotes a crear.' },
        field: { type: 'string', description: 'Campo donde crear los lotes.' },
      },
      required: ['plotNames'],
    },
  },
  {
    name: 'set_plot_area',
    description: 'Asignar superficie a un lote. "lote A1 tiene 50 ha".',
    input_schema: {
      type: 'object',
      properties: {
        plot: { type: 'string', description: 'Nombre del lote.' },
        hectares: { type: 'number', description: 'Superficie en hectáreas.' },
      },
      required: ['plot', 'hectares'],
    },
  },
  {
    name: 'set_field_city',
    description: 'Asignar ubicación a campo existente. "ubicar campo X en Y", "campo X está en Y".',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo.' },
        city: { type: 'string', description: 'Localidad del campo (nombre de localidad argentina).' },
      },
      required: ['field'],
    },
  },

  // show_reports_menu and export_csv handled by regex TRIVIAL_COMMANDS — not needed here

  // ========================
  // SHARING (enterprise)
  // ========================
  {
    name: 'share_field',
    description: 'Generar código de invitación para compartir campo. "compartir campo X".',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo a compartir.' },
      },
      required: ['field'],
    },
  },
  {
    name: 'accept_invite',
    description: 'Unirse a un campo con código de invitación. "unirme ABC123", "aceptar invitación ABC123".',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Código de invitación de 6 caracteres.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'list_field_members',
    description: 'Ver miembros de un campo compartido. "miembros campo X", "quién tiene acceso al campo X".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
      },
      required: ['field'],
    },
  },
  {
    name: 'remove_field_member',
    description: 'Quitar acceso de un usuario a un campo compartido. "quitar a Juan de campo X", "quitar a +549... de campo X".',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo.' },
        member: { type: 'string', description: 'Nombre o teléfono del usuario a quitar.' },
      },
      required: ['field', 'member'],
    },
  },

  // ========================
  // CONVERSATIONAL (fallback)
  // ========================
  {
    name: 'respond_text',
    description: 'Responder con texto conversacional. SOLO para saludos, agradecimientos, preguntas generales sin datos del usuario. NUNCA usar si hay herramienta de registro o consulta aplicable.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto de respuesta al usuario.' },
      },
      required: ['text'],
    },
  },
];

/** Set of all tool names for validation */
export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => t.name));
