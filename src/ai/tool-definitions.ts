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
const UNIT_PROP = { type: 'string' as const, description: 'Unidad (kg, lt, cc, tn, qq, bolsas, kg/ha, lt/ha). qq=quintal=100 kg. tn=tonelada=1000 kg. Mantener la unidad como la dijo el usuario; el sistema convierte a kg cuando hace falta.' };
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
        expense_type: { type: 'string', enum: ['insumo', 'varios'], description: 'insumo=producto almacenable (Roundup,urea,semilla). varios=servicio/labranza (siembra directa,pulverización). Default: inferir de categoría.' },
        product: { type: 'string', description: 'Nombre del producto/insumo (Roundup, Urea, Gasoil). Solo si expense_type=insumo.' },
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        unit_price: { type: 'number', description: 'Precio por unidad. Usar cuando el usuario dice "a X c/u", "a X el kg/bolsa/lt". Ej: "50 bolsas de urea a 8000 c/u" → quantity=50, unit_price=8000, amount=400000.' },
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
  // EXPENSE TEMPLATES (recurring)
  // ========================
  {
    name: 'create_expense_template',
    description: 'Crear un gasto recurrente/fijo que se registra automáticamente. "gasto fijo mensual 50k combustible", "gasto recurrente semanal 10k jornales", "agendar gasto mensual de arrendamiento", "cada mes gastar 100k en combustible".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre descriptivo del gasto recurrente.' },
        amount: { type: 'number', description: 'Monto del gasto.' },
        currency: { type: 'string', enum: ['ARS', 'USD'], description: 'Moneda. Default ARS.' },
        category: { type: 'string', description: 'Categoría del gasto.' },
        recurrence_type: { type: 'string', enum: ['weekly', 'biweekly', 'monthly'], description: 'Frecuencia. Default monthly.' },
        recurrence_day: { type: 'number', description: 'Día: para monthly=día del mes (1-28), para weekly/biweekly=día semana (0=dom..6=sáb). Default: 1 para monthly, lunes (1) para weekly.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
      },
      required: ['name', 'amount'],
    },
  },
  {
    name: 'list_expense_templates',
    description: 'Ver gastos recurrentes/fijos configurados. "mis gastos fijos", "gastos recurrentes", "qué gastos automáticos tengo".',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'delete_expense_template',
    description: 'Eliminar/cancelar un gasto recurrente/fijo. "borrar gasto fijo combustible", "cancelar gasto recurrente de arrendamiento", "eliminar gasto automático".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del gasto recurrente a eliminar.' },
        template_id: { type: 'number', description: 'ID del template (si se conoce).' },
      },
      required: [],
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
    name: 'active_crop',
    description: 'Consultar cultivos ACTUALMENTE sembrados con hectáreas. USAR SIEMPRE que pregunten qué hay sembrado, dónde hay un cultivo, o hectáreas/has sembradas. Triggers: "soja?", "hay soja?", "has sembradas", "has de soja", "hectáreas sembradas de trigo", "cuántas has de maíz", "superficie sembrada", "qué tengo sembrado", "cultivo activo", "en qué lotes hay trigo", "qué hay sembrado", "tengo soja?", "soja del grupo Pérez". PRIORIDAD sobre list_plots cuando mencionan cultivo o "sembradas". NUNCA usar query_plot_history ni list_plots.',
    input_schema: {
      type: 'object',
      properties: {
        plot: PLOT_PROP,
        field: FIELD_PROP,
        crop: { type: 'string', description: 'Filtrar por cultivo (ej: soja, maíz).' },
        grupo: { type: 'string', description: 'Filtrar por grupo/sociedad de lotes.' },
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
        hectares: { type: 'number', description: 'Hectáreas sembradas (si es menos que la superficie total del lote). Omitir si se sembró todo el lote.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['crop'],
    },
  },
  {
    name: 'harvest_crop',
    description: 'Registrar cosecha o cargas de camiones. Verbos: coseché, levanté, se cargó/cargaron. Si mencionan chofer+kg → usar loads[]. Números argentinos: "31.320" = 31320 kg (punto es separador de miles). NO cierra la campaña, solo registra el hito.',
    input_schema: {
      type: 'object',
      properties: {
        crop: { type: 'string', description: 'Cultivo cosechado.' },
        quantity: { type: 'number', description: 'Cantidad cosechada (ej: 50 tn).' },
        unit: UNIT_PROP,
        warehouse: { type: 'string', description: 'Nombre del depósito/silo destino.' },
        yield_kg: { type: 'number', description: 'Rendimiento TOTAL en kg (ej: 200000). Si dicen tn→x1000, qq→x100. Solo total, NO por hectárea.' },
        yield_kg_per_ha: { type: 'number', description: 'Rendimiento en kg/ha (ej: 4100). Usar si dicen "X kilos por hectárea" o "rindió X qq/ha" (convertir qq→kg). Mutuamente excluyente con yield_kg.' },
        yield_notes: { type: 'string', description: 'Notas sobre el rendimiento.' },
        loads: {
          type: 'array',
          description: 'Cargas de camiones. Extraer de "britos 31.320 kg, contreras 31.487". Cada item: chofer + kg. Números argentinos: "31.320" = 31320 kg (punto es separador de miles).',
          items: {
            type: 'object',
            properties: {
              driver_name: { type: 'string', description: 'Nombre del chofer/transportista.' },
              weight_kg: { type: 'number', description: 'Peso en kg. "31.320" argentino = 31320 kg. Si dicen tn x1000, qq x100.' },
              destination: { type: 'string', enum: ['silo', 'acopio', 'venta_directa'], description: 'Destino de la carga.' },
              destinatario: { type: 'string', description: 'Empresa destino (Cargill, ACA, etc.).' },
              truck_plate: { type: 'string', description: 'Patente si la mencionan.' },
              humidity_pct: { type: 'number', description: 'Humedad medida % (ej: "al 14%", "13.5 de humedad"). Argentina típicamente: soja 13.5% base, trigo 14%, maíz 14.5%.' },
              quality_metrics: { type: 'object', description: 'Métricas de calidad específicas del cultivo. Soja: {oil_pct}. Trigo: {protein_pct, gluten_pct, test_weight_kg_hl}. Girasol: {oil_pct}. Pasarlas SOLO si el usuario las menciona explícitamente.' },
            },
            required: ['driver_name', 'weight_kg'],
          },
        },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['crop'],
    },
  },

  {
    name: 'query_harvest_loads',
    description: 'Consultar cargas de cosecha (camiones). "cargas del lote X", "cuánto llevó Britos", "cargas a Cargill", "detalle de cosecha", "camiones del lote X".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
        plot: PLOT_PROP,
        desde: { type: 'string', description: 'Fecha inicio YYYY-MM-DD.' },
        hasta: { type: 'string', description: 'Fecha fin YYYY-MM-DD.' },
        driver_name: { type: 'string', description: 'Filtrar por chofer/transportista.' },
        destinatario: { type: 'string', description: 'Filtrar por empresa destino (Cargill, ACA, etc.).' },
      },
      required: [],
    },
  },

  {
    name: 'delete_harvest_loads',
    description: 'Eliminar cargas de cosecha duplicadas o incorrectas. "borrar las cargas del lote X", "eliminar cargas duplicadas", "borrar camiones sin destino del 7D".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: { type: 'string', description: 'Fecha YYYY-MM-DD de las cargas a eliminar.' },
        driver_names: { type: 'array', items: { type: 'string' }, description: 'Nombres de choferes cuyas cargas eliminar. Si vacío, elimina todas las del lote+fecha.' },
        only_without_destination: { type: 'boolean', description: 'true = solo eliminar cargas SIN destino asignado (útil para duplicados).' },
      },
      required: ['plot'],
    },
  },

  {
    name: 'close_campaign',
    description: 'Cerrar una campaña de siembra. Úsala cuando el usuario diga "cerrar campaña", "terminó la campaña del trigo", "cerrar la soja", "fin de campaña".',
    input_schema: {
      type: 'object',
      properties: {
        plot: PLOT_PROP,
        field: FIELD_PROP,
        crop: { type: 'string', description: 'Cultivo a cerrar.' },
      },
      required: [],
    },
  },

  {
    name: 'campaign_stats',
    description: 'Obtener estadísticas completas de una campaña: actividades, gastos, ingresos, rendimiento, rentabilidad. "cómo va la campaña", "cuánto gasté en la soja", "rendimiento del trigo", "rentabilidad del maíz", "estadísticas de la campaña", "resultado de la soja".',
    input_schema: {
      type: 'object',
      properties: {
        plot: { type: 'string', description: 'Nombre del lote.' },
        field: { type: 'string', description: 'Nombre del campo (opcional si tiene 1).' },
        crop: { type: 'string', description: 'Cultivo (soja, maíz, trigo, etc.).' },
        season_year: { type: 'string', description: 'Campaña ej "2025/26". Si no se indica, usa la activa o última.' },
      },
      required: [],
    },
  },

  {
    name: 'compare_campaigns',
    description: 'Comparar dos campañas del mismo lote: rinde, gastos, ingresos, resultado/ha. "comparar soja 25/26 vs 24/25", "comparar campañas", "cómo salió vs la anterior", "comparar la soja con la campaña pasada".',
    input_schema: {
      type: 'object',
      properties: {
        plot: PLOT_PROP,
        field: FIELD_PROP,
        crop: { type: 'string', description: 'Cultivo (soja, maíz, trigo, etc.).' },
        season_year_1: { type: 'string', description: 'Campaña más reciente ej "2025/26". Si no se indica, usa las 2 últimas.' },
        season_year_2: { type: 'string', description: 'Campaña anterior ej "2024/25".' },
      },
      required: [],
    },
  },

  {
    name: 'activity_stats',
    description: 'Resumen/estadísticas de actividades: cuántas fumigaciones, siembras, cosechas, etc. por período. "cuántas fumigaciones hice", "resumen de actividades del mes", "actividades este año", "cuántas veces fumigué", "estadísticas de actividades", "actividades del grupo Pérez".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
        plot: PLOT_PROP,
        grupo: { type: 'string', description: 'Filtrar por grupo/sociedad de lotes.' },
        activity_filter: { type: 'string', enum: ['spraying', 'fertilization', 'planting', 'harvest', 'tillage', 'irrigation'], description: 'Tipo de actividad. Solo si el usuario pregunta por un tipo específico.' },
        desde: { type: 'string', description: 'Fecha inicio YYYY-MM-DD.' },
        hasta: { type: 'string', description: 'Fecha fin YYYY-MM-DD.' },
      },
      required: [],
    },
  },

  {
    name: 'edit_last_activity',
    description: 'Corregir/editar la última actividad registrada. Cambiar de lote, corregir cultivo o fecha. "la siembra era en lote B", "corregí la última actividad al lote norte", "me equivoqué de lote en la fumigación".',
    input_schema: {
      type: 'object',
      properties: {
        activity_filter: { type: 'string', enum: ['spraying', 'fertilization', 'planting', 'harvest', 'tillage', 'irrigation', 'tacto'], description: 'Tipo de actividad a buscar (opcional).' },
        crop: CROP_PROP,
        new_plot: { type: 'string', description: 'Nuevo lote correcto.' },
        new_field: FIELD_PROP,
        new_crop: { type: 'string', description: 'Nuevo cultivo, si se quiere corregir.' },
        new_date: { type: 'string', description: 'Nueva fecha YYYY-MM-DD, si se quiere corregir.' },
      },
      required: ['new_plot'],
    },
  },

  {
    name: 'log_tacto',
    description: 'Registrar tacto/revisión de preñez en vacas o vaquillonas. Verbos: hice tacto, palpé, revisé preñez, palpación, se hizo tacto, dio X preñadas.',
    input_schema: {
      type: 'object',
      properties: {
        total_checked: { type: 'number', description: 'Total de animales revisados. Si no lo dicen, se calcula de preñadas+vacías+dudosas.' },
        pregnant_count: { type: 'number', description: 'Cantidad de preñadas.' },
        open_count: { type: 'number', description: 'Cantidad de vacías.' },
        uncertain_count: { type: 'number', description: 'Cantidad de dudosas.' },
        category: { type: 'string', enum: ['vaca', 'vaquillona'], description: 'Categoría animal revisada.' },
        veterinarian: { type: 'string', description: 'Nombre del veterinario.' },
        notes: { type: 'string', description: 'Observaciones adicionales.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Nombre del corral (feedlot). Si el tacto es en un corral, usar esto en vez de plot.' },
        event_date: DATE_PROP,
      },
      required: ['pregnant_count'],
    },
  },
  {
    name: 'tacto_summary',
    description: 'Consultar resumen/promedio de tacto (revisión de preñez). Triggers: "promedio del tacto", "resultados del tacto", "como salió el tacto", "tasa de preñez", "cuántas preñadas", "% de preñez", "% preñes", "porcentaje de preñez", "tacto de [campo]", "tacto del campo X", "resumen tacto". SIEMPRE usar esta herramienta cuando mencionan tacto/preñez en contexto de consulta.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Campo (opcional).' },
        plot: { type: 'string', description: 'Lote específico (opcional).' },
        corral: { type: 'string', description: 'Nombre del corral (feedlot) (opcional).' },
        desde: { type: 'string', description: 'Fecha inicio YYYY-MM-DD (opcional).' },
        hasta: { type: 'string', description: 'Fecha fin YYYY-MM-DD (opcional).' },
      },
      required: [],
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
  {
    name: 'query_scoutings',
    description: 'Consultar monitoreos estructurados ya registrados (NO es para registrar). Usar cuando el usuario pregunta "cómo viene la sanidad", "presión de plagas", "evolución del cultivo", "qué malezas hubo en X", "monitoreos del lote/campo X". Filtros opcionales por lote, campo, rango de fechas, severidad mínima, estadio.',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
        plot: PLOT_PROP,
        crop: CROP_PROP,
        desde: { type: 'string', description: 'YYYY-MM-DD inicio.' },
        hasta: { type: 'string', description: 'YYYY-MM-DD fin.' },
        min_severity: { type: 'integer', description: 'Severidad mínima de plaga 1-5 para filtrar (ej: solo severas: 4).' },
        stage_code: { type: 'string', description: 'Filtrar por estadio fenológico observado.' },
      },
      required: [],
    },
  },
  {
    name: 'log_crop_scouting',
    description: 'Registrar MONITOREO ESTRUCTURADO del cultivo (no es lo mismo que log_observation que es texto libre). Usar cuando el usuario reporta métricas: estadio fenológico (V3, R5, Z3), % de cobertura de malezas, presión/severidad de plagas, % de plantas afectadas, humedad de suelo, % de emergencia, plantas/m². Ejemplo: "soja V3 con 15% de rama negra y presencia leve de chinche" → stage_code=V3, weed_coverage_pct=15, weed_species=["rama negra"], pest_species="chinche", pest_severity_1_5=2. Calibración severidad: ausente=1, leve=2, moderada=3, alta=4, severa=5. Si el mensaje no tiene métricas estructurables, usar log_observation.',
    input_schema: {
      type: 'object',
      properties: {
        crop: CROP_PROP,
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
        stage_code: { type: 'string', description: 'Código del estadio fenológico observado: soja (VE,V2..V8,R1..R7), maíz (VE,V6,VT,R1..R6), trigo (Z2..Z9). Pasarlo en mayúsculas.' },
        weed_coverage_pct: { type: 'number', description: 'Porcentaje de cobertura de malezas en el lote (0-100).' },
        weed_species: { type: 'array', items: { type: 'string' }, description: 'Especies de malezas observadas, ej: ["rama negra", "yuyo colorado"].' },
        pest_species: { type: 'string', description: 'Especie de plaga o enfermedad principal: chinche, oruga, isoca, roya, mancha, etc.' },
        pest_severity_1_5: { type: 'integer', description: 'Severidad 1-5. ausente=1, leve=2, moderada=3, alta=4, severa=5. Inferir de palabras del usuario.' },
        pest_affected_pct: { type: 'number', description: 'Porcentaje de plantas/superficie afectada por la plaga (0-100).' },
        soil_moisture_1_5: { type: 'integer', description: 'Humedad de suelo en escala 1-5: 1=seco, 2=algo seco, 3=normal, 4=húmedo, 5=saturado.' },
        emergence_pct: { type: 'number', description: 'Porcentaje de emergencia logrado post-siembra (0-100).' },
        plant_density_m2: { type: 'number', description: 'Densidad de plantas por metro cuadrado.' },
        notes: { type: 'string', description: 'Comentario adicional libre que no encaje en los campos estructurados.' },
      },
      required: [],
    },
  },

  // ========================
  // REPORTS
  // ========================
  {
    name: 'weather_full',
    description: 'Consultar clima/pronóstico del tiempo. Si el usuario menciona una ciudad distinta a su ubicación ("clima en X", "va a llover en X", "pronóstico de X"), capturar en city. Si aclara provincia ("clima en Ameghino Buenos Aires"), capturar en province.',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
        city: { type: 'string', description: 'Nombre de ciudad/localidad mencionada explícitamente. Ej: "clima en Ameghino" → city="Ameghino". Omitir si el usuario no menciona ciudad (se usa su ubicación).' },
        province: { type: 'string', description: 'Provincia, solo si el usuario la menciona para desambiguar. Ej: "clima en Ameghino Buenos Aires" → province="Buenos Aires".' },
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
    description: 'Reporte financiero unificado. "reporte mensual", "gastos del campo X", "gastos del lote Y", "resumen semanal", "resultado del mes", "gastos últimos 30 días", "gastos en combustible este año", "ingresos de enero a marzo", "gastos por hectárea", "costo/ha".',
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
    description: 'Generar reporte agronómico con observaciones y actividades. "reporte agro", "reporte agronómico del lote X", "estado del lote X", "cómo va el lote X", "novedades del campo", "resumen agronómico", "informe del lote", "reporte de actividades", "qué se hizo en el campo". Soporta rango de fechas.',
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
    name: 'share_report',
    description: 'Generar y enviar un reporte en PDF. "mandame el PDF de la campaña", "exportar reporte financiero", "PDF del reporte", "compartir reporte de la soja", "enviar reporte en PDF", "descargar reporte", "PDF campaña", "PDF financiero".',
    input_schema: {
      type: 'object',
      properties: {
        report_type: { type: 'string', enum: ['campaign', 'financial'], description: 'Tipo de reporte.' },
        plot: PLOT_PROP,
        field: FIELD_PROP,
        crop: { type: 'string', description: 'Cultivo (solo para campaign).' },
        period: { type: 'string', enum: ['week', 'month', 'year'], description: 'Período (solo para financial). Default month.' },
      },
      required: ['report_type'],
    },
  },
  {
    name: 'query_plot_history',
    description: 'Consultar historial de actividades PASADAS. "cuándo se fumigó el lote X", "historial lote A1", "qué se hizo en el lote". SOLO para historial de acciones pasadas. Para consultar cultivos actualmente sembrados ("hay soja?", "dónde hay soja", "qué tengo sembrado") usar active_crop.',
    input_schema: {
      type: 'object',
      properties: {
        plot: PLOT_PROP,
        field: FIELD_PROP,
        crop: { type: 'string', description: 'Cultivo a buscar (maíz, soja, trigo, etc.).' },
        timeRef: { type: 'string', description: 'Referencia temporal (últimos 30 días, este mes, etc.).' },
        activityFilter: { type: 'string', description: 'Filtro de actividad: log_spraying, log_fertilization, sow_crop, harvest_crop, log_tillage, log_irrigation, tacto.' },
      },
      required: [],
    },
  },

  // ========================
  // FIELD / PLOT MANAGEMENT
  // ========================
  {
    name: 'list_fields',
    description: 'Listar campos del usuario con ubicación, cantidad de lotes y hectáreas totales. "mis campos", "ver campos", "qué campos tengo".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_plots',
    description: 'Listar lotes con superficie en hectáreas. "mis lotes", "qué lotes tiene el campo", "lotes del campo X", "cuántos lotes tengo", "hectáreas del campo X", "has campo X", "superficie total". Soporta filtro por grupo/sociedad: "lotes del grupo X", "cuántas has del grupo/sociedad X", "hectáreas de la titularidad Y" → usar parámetro grupo. NO usar para "has sembradas" ni cuando mencionan un cultivo (→ active_crop).',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo para filtrar lotes. Omitir para ver todos.' },
        grupo: { type: 'string', description: 'Filtrar por grupo/sociedad/titularidad de los lotes.' },
      },
    },
  },
  {
    name: 'field_info',
    description: 'Info detallada de un campo o lote: ubicación, hectáreas, gastos/ingresos del mes, lluvia, observaciones y actividades recientes. "info campo X", "detalle lote A1", "estado del campo Norte".',
    input_schema: {
      type: 'object',
      properties: {
        entityKeyword: { type: 'string', enum: ['campo', 'lote'], description: 'Si se pregunta por campo o lote.' },
        fieldName: { type: 'string', description: 'Nombre del campo o lote.' },
      },
      required: ['fieldName'],
    },
  },
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
    name: 'set_plot_grupo',
    description: 'Asignar grupo/sociedad/titularidad a uno o varios lotes. Frases: "asignar grupo Pérez al lote 11A", "el lote A1 es del grupo Norte", "los lotes 9B y 11A son de Pérez", "titularidad de los lotes 11C y 9B es Aurelio", "lotes 11A, 11B pertenecen al grupo X", "el dueño de los lotes es X". Usar plotNames (array) para asignar a uno o varios lotes en una sola llamada; siempre pasarlo como array aunque sea un solo lote.',
    input_schema: {
      type: 'object',
      properties: {
        plotNames: { type: 'array', items: { type: 'string' }, description: 'Nombres de los lotes a asignar el grupo (uno o varios).' },
        grupo: { type: 'string', description: 'Nombre del grupo/sociedad/titular.' },
        field: FIELD_PROP,
      },
      required: ['plotNames', 'grupo'],
    },
  },
  {
    name: 'set_field_city',
    description: 'Asignar ubicación a campo existente. SOLO llamar cuando el usuario menciona EXPLÍCITAMENTE la localidad ("ubicar campo X en Y", "campo X está en Pergamino", "corregir: es en Ameghino"). Si el usuario dice "agregar ubicación" / "poner ubicación" / "cambiar ubicación" sin nombrar ciudad, NO llames esta tool — usá respond_text pidiendo la ciudad.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo.' },
        city: { type: 'string', description: 'Localidad mencionada explícitamente por el usuario. NUNCA inventar, NUNCA asumir. Si no aparece en el mensaje, omitir este parámetro.' },
      },
      required: ['field'],
    },
  },
  {
    name: 'delete_field',
    description: 'Eliminar campo. "borrar campo X", "eliminar campo X".',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo a eliminar.' },
      },
      required: ['field'],
    },
  },
  {
    name: 'delete_plot',
    description: 'Eliminar lote de un campo. "borrar lote X del campo Y", "eliminar lote X".',
    input_schema: {
      type: 'object',
      properties: {
        plot: { type: 'string', description: 'Nombre del lote a eliminar.' },
        field: { type: 'string', description: 'Nombre del campo al que pertenece el lote.' },
      },
      required: ['plot', 'field'],
    },
  },
  {
    name: 'rename_field',
    description: 'Renombrar campo. "renombrar campo X a Y", "cambiar nombre campo X por Y".',
    input_schema: {
      type: 'object',
      properties: {
        oldName: { type: 'string', description: 'Nombre actual del campo.' },
        newName: { type: 'string', description: 'Nuevo nombre del campo.' },
      },
      required: ['oldName', 'newName'],
    },
  },
  {
    name: 'rename_plot',
    description: 'Renombrar lote. "renombrar lote X a Y en campo Z", "cambiar nombre lote X por Y".',
    input_schema: {
      type: 'object',
      properties: {
        oldName: { type: 'string', description: 'Nombre actual del lote.' },
        newName: { type: 'string', description: 'Nuevo nombre del lote.' },
        field: { type: 'string', description: 'Nombre del campo al que pertenece el lote.' },
      },
      required: ['oldName', 'newName', 'field'],
    },
  },
  {
    name: 'restore_field',
    description: 'Restaurar campo eliminado. "restaurar campo X", "recuperar campo X".',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Nombre del campo a restaurar.' },
      },
      required: ['field'],
    },
  },
  {
    name: 'restore_plot',
    description: 'Restaurar lote eliminado. "restaurar lote X del campo Y", "recuperar lote X".',
    input_schema: {
      type: 'object',
      properties: {
        plot: { type: 'string', description: 'Nombre del lote a restaurar.' },
        field: { type: 'string', description: 'Nombre del campo al que pertenece el lote.' },
      },
      required: ['plot', 'field'],
    },
  },

  // show_reports_menu and export_csv handled by regex TRIVIAL_COMMANDS — not needed here

  // ========================
  // STOCK
  // ========================
  {
    name: 'create_warehouse',
    description: 'Crear depósito/galpón en un campo. "crear depósito X en campo Y".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del depósito.' },
        field: FIELD_PROP,
      },
      required: ['name'],
    },
  },
  {
    name: 'list_warehouses',
    description: 'Listar depósitos. "depósitos del campo X", "mis depósitos".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
      },
      required: [],
    },
  },
  {
    name: 'add_stock',
    description: 'Cargar stock/insumo al depósito. "cargué/entraron 500lt de glifosato", "recibí 200kg de urea".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Nombre del producto/insumo.' },
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        field: FIELD_PROP,
        warehouse: { type: 'string', description: 'Nombre del depósito, si mencionado.' },
        category: { type: 'string', description: 'Categoría: agroquimicos, fertilizantes, semillas, combustible, otros.' },
        reason: { type: 'string', description: 'Motivo de la carga.' },
      },
      required: ['product', 'quantity', 'unit'],
    },
  },
  {
    name: 'remove_stock',
    description: 'Descargar/usar stock. "usé/saqué 50lt de glifosato", "gasté 100kg de urea".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Nombre del producto.' },
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        field: FIELD_PROP,
        warehouse: { type: 'string', description: 'Nombre del depósito, si mencionado.' },
        reason: { type: 'string', description: 'Motivo.' },
      },
      required: ['product', 'quantity', 'unit'],
    },
  },
  {
    name: 'adjust_stock',
    description: 'Ajustar stock a cantidad exacta. "tengo 200lt de glifosato", "el stock de urea es 500kg".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Nombre del producto.' },
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        field: FIELD_PROP,
        warehouse: { type: 'string', description: 'Nombre del depósito, si mencionado.' },
        reason: { type: 'string', description: 'Motivo del ajuste.' },
      },
      required: ['product', 'quantity', 'unit'],
    },
  },
  {
    name: 'check_stock',
    description: 'Consultar stock/inventario con cantidad, depósito, stock mínimo y calidad de grano (grado/humedad). "cuánto glifosato tengo", "inventario", "stock del campo X".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Producto a consultar. Omitir para ver todo.' },
        field: FIELD_PROP,
      },
      required: [],
    },
  },
  {
    name: 'stock_history',
    description: 'Ver movimientos de un producto en stock. "movimientos de glifosato", "historial de stock de urea".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Producto a consultar.' },
        field: FIELD_PROP,
      },
      required: ['product'],
    },
  },
  {
    name: 'set_min_stock',
    description: 'Configurar stock mínimo para alertas. "stock mínimo de glifosato 50lt", "alertar cuando queden menos de 100kg de urea".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Nombre del producto.' },
        quantity: { type: 'number', description: 'Cantidad mínima de alerta.' },
        field: FIELD_PROP,
      },
      required: ['product', 'quantity'],
    },
  },

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
  // DOCUMENTS
  // ========================
  {
    name: 'list_documents',
    description: 'Listar facturas/comprobantes procesados. "mis facturas", "documentos procesados".',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['week', 'month', 'year'], description: 'Período.' },
      },
      required: [],
    },
  },
  {
    name: 'link_document_to_expense',
    description: 'Vincular factura a gasto existente. "vincular factura 5 al gasto 42".',
    input_schema: {
      type: 'object',
      properties: {
        documentId: { type: 'number', description: 'ID del documento.' },
        expenseId: { type: 'number', description: 'ID del gasto.' },
      },
      required: ['documentId', 'expenseId'],
    },
  },

  // ========================
  // LIVESTOCK (hacienda)
  // ========================
  {
    name: 'add_livestock',
    description: 'Registrar ingreso/compra de hacienda (vacas, terneros, novillos, etc.) en un lote o corral de feedlot. Verbos: agregué, compré, metí, ingresé + N animales. Requiere lote o corral.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría del animal.' },
        count: { type: 'number', description: 'Cantidad de animales (entero > 0).' },
        breed: { type: 'string', description: 'Raza (Angus, Hereford, Brangus, etc.), si mencionado.' },
        avg_weight_kg: { type: 'number', description: 'Peso promedio en kg, si mencionado.' },
        unit_price_ars: { type: 'number', description: 'Precio unitario en pesos, si mencionado.' },
        unit_price_usd: { type: 'number', description: 'Precio unitario en dólares, si mencionado.' },
        reason: { type: 'string', description: 'Motivo/descripción breve (ej: "compra remate Liniers").' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Nombre del corral en el feedlot (alternativa a plot).' },
        event_date: DATE_PROP,
      },
      required: ['category', 'count'],
    },
  },
  {
    name: 'remove_livestock',
    description: 'Registrar egreso/venta de hacienda de un lote o corral. Verbos: vendí, saqué, faené + N animales. Requiere lote o corral.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría del animal.' },
        count: { type: 'number', description: 'Cantidad de animales.' },
        breed: { type: 'string', description: 'Raza, si mencionado.' },
        unit_price_ars: { type: 'number', description: 'Precio unitario en pesos, si mencionado.' },
        unit_price_usd: { type: 'number', description: 'Precio unitario en dólares, si mencionado.' },
        reason: { type: 'string', description: 'Motivo/descripción breve.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Nombre del corral en el feedlot (alternativa a plot).' },
        event_date: DATE_PROP,
      },
      required: ['category', 'count'],
    },
  },
  {
    name: 'transfer_livestock',
    description: 'Mover animales entre lotes, corrales, o lote↔corral. Verbos: mové, pasé, trasladé + N animales + de X a Y. Operación atómica. Origen y destino pueden ser plot o corral.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría del animal.' },
        count: { type: 'number', description: 'Cantidad a mover.' },
        breed: { type: 'string', description: 'Raza, si se quiere filtrar por raza.' },
        source_field: { type: 'string', description: 'Campo de origen, si mencionado.' },
        source_plot: { type: 'string', description: 'Lote de origen (si el origen es un lote).' },
        source_corral: { type: 'string', description: 'Corral de origen (si el origen es un corral de feedlot).' },
        dest_field: { type: 'string', description: 'Campo de destino, si mencionado.' },
        dest_plot: { type: 'string', description: 'Lote de destino (si el destino es un lote).' },
        dest_corral: { type: 'string', description: 'Corral de destino (si el destino es un corral de feedlot).' },
        dest_category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría destino (para recategorización en la misma ubicación).' },
        reason: { type: 'string', description: 'Motivo/descripción breve.' },
        event_date: DATE_PROP,
      },
      required: ['category', 'count'],
    },
  },
  {
    name: 'record_livestock_death',
    description: 'Registrar muerte/baja de animales en un lote o corral. Verbos: se murió, falleció, perdí, baja.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría del animal.' },
        count: { type: 'number', description: 'Cantidad muerta.' },
        breed: { type: 'string', description: 'Raza, si mencionado.' },
        reason: { type: 'string', description: 'Causa (enfermedad, accidente, etc.), si mencionado.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Nombre del corral en el feedlot (alternativa a plot).' },
        event_date: DATE_PROP,
      },
      required: ['category', 'count'],
    },
  },
  {
    name: 'record_livestock_birth',
    description: 'Registrar nacimiento/parición de terneros. SOLO usar con verbos explícitos de nacimiento: parió, nacieron, nació, parición, tuve crías. NUNCA usar para "hay N terneros" o "con N terneros" (eso es add_livestock).',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría del animal (normalmente ternero/ternera).' },
        count: { type: 'number', description: 'Cantidad nacida.' },
        breed: { type: 'string', description: 'Raza, si mencionado.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Nombre del corral en el feedlot (alternativa a plot).' },
        event_date: DATE_PROP,
      },
      required: ['category', 'count'],
    },
  },
  {
    name: 'adjust_livestock',
    description: 'Corregir/ajustar el conteo absoluto de animales en un lote o corral. Frases: "en lote X hay N vacas", "en corral 1 hay N novillos", "ajustá a N", "corregí, son N vacas", "el conteo real es N". DIFERENCIA con add_livestock: adjust ESTABLECE el total, add SUMA al existente.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría del animal.' },
        count: { type: 'number', description: 'Cantidad ABSOLUTA (total real, no diferencia).' },
        breed: { type: 'string', description: 'Raza, si mencionado.' },
        reason: { type: 'string', description: 'Motivo de la corrección.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Nombre del corral en el feedlot (alternativa a plot).' },
        event_date: DATE_PROP,
      },
      required: ['category', 'count'],
    },
  },
  {
    name: 'list_livestock',
    description: 'Listar inventario de hacienda con cantidad, raza y peso promedio por grupo. Incluye lotes y corrales de feedlot. Preguntas: cuántas vacas tengo, stock de hacienda, rodeo, cuánto pesan.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Filtrar por categoría, si mencionado.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Filtrar por corral del feedlot.' },
      },
    },
  },
  {
    name: 'livestock_history',
    description: 'Mostrar historial de movimientos de hacienda con fecha, cantidad, peso, precio y motivo. "historial vacas lote A1", "historial novillos corral 1", "movimientos novillos".',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'], description: 'Categoría del animal.' },
        breed: { type: 'string', description: 'Raza, si se quiere filtrar.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        corral: { type: 'string', description: 'Nombre del corral del feedlot (alternativa a plot).' },
      },
      required: ['category'],
    },
  },

  // ========================
  // FEEDLOT / CORRALS
  // ========================
  {
    name: 'create_feedlot',
    description: 'Crear un feedlot en un campo. Máximo 1 feedlot por campo. "crear feedlot en campo X", "nuevo feedlot".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del feedlot.' },
        field: FIELD_PROP,
        capacity: { type: 'number', description: 'Capacidad en cabezas, si mencionado.' },
      },
      required: ['name', 'field'],
    },
  },
  {
    name: 'list_feedlots',
    description: 'Listar feedlots del usuario. "mis feedlots", "feedlots".',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'delete_feedlot',
    description: 'Eliminar feedlot de un campo. "borrar feedlot del campo X".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
      },
      required: ['field'],
    },
  },
  {
    name: 'create_corral',
    description: 'Crear un corral dentro de un feedlot. "crear corral 1", "nuevo corral Norte en campo X".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del corral (ej: "1", "Norte", "Engorde A").' },
        field: FIELD_PROP,
        capacity: { type: 'number', description: 'Capacidad del corral, si mencionado.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_corrals',
    description: 'Listar corrales del feedlot. "corrales", "corrales del campo X".',
    input_schema: {
      type: 'object',
      properties: {
        field: FIELD_PROP,
      },
    },
  },
  {
    name: 'delete_corral',
    description: 'Eliminar un corral. "borrar corral 1".',
    input_schema: {
      type: 'object',
      properties: {
        corral: { type: 'string', description: 'Nombre del corral a eliminar.' },
        field: FIELD_PROP,
      },
      required: ['corral'],
    },
  },
  {
    name: 'rename_corral',
    description: 'Renombrar un corral. "renombrar corral 1 a Norte".',
    input_schema: {
      type: 'object',
      properties: {
        oldName: { type: 'string', description: 'Nombre actual del corral.' },
        newName: { type: 'string', description: 'Nuevo nombre del corral.' },
        field: FIELD_PROP,
      },
      required: ['oldName', 'newName'],
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
