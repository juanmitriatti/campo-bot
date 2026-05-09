import { pool } from "../config/db.js";

/**
 * Keys that must NEVER be exposed via the dashboard API.
 */
const SECRET_KEYS = new Set([
  'OPENAI_API_KEY',
  'WHISPER_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'VERIFY_TOKEN',
  'OPENWEATHER_API_KEY',
  'OPENAI_BASE_URL',
  'WHISPER_API_BASE_URL',
  'RESEND_API_KEY',
  'SENTRY_DSN',
  'SENTRY_DSN_FRONTEND',
]);

/**
 * Configurable settings with their defaults and types.
 * Only these keys can be set via the dashboard.
 */
// --- In-memory settings cache (5-min TTL) ---
const settingsCache = new Map(); // key → { value, expiresAt }
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;

const SETTING_DEFINITIONS = {
  // Audio
  MAX_AUDIO_DURATION_SECONDS: { default: '120', type: 'number', group: 'audio', label: 'Duración máxima de audio (seg)', description: 'Límite de duración para los audios de WhatsApp que el bot acepta transcribir. Audios más largos se rechazan.' },
  OPENAI_WHISPER_MODEL: { default: 'whisper-1', type: 'string', group: 'audio', label: 'Modelo Whisper', description: 'Modelo de OpenAI usado para la transcripción de voz a texto. "whisper-1" es el estándar.' },
  SPEECH_TIMEOUT_MS: { default: '30000', type: 'number', group: 'audio', label: 'Timeout transcripción (ms)', description: 'Tiempo máximo de espera para que la API de transcripción responda antes de cancelar.' },
  MAX_AUDIO_PER_HOUR: { default: '10', type: 'number', group: 'limits', label: 'Máx audios por hora por usuario', description: 'Rate limit de audios por usuario por hora. Previene abuso del servicio de transcripción.' },

  // AI — Legacy fallback (claude.js)
  CLAUDE_FALLBACK_MODEL: { default: 'claude-haiku-4-5-20251001', type: 'string', group: 'ai', label: 'Modelo Claude fallback legacy', description: 'Modelo usado por el parser de gastos/ingresos legacy (services/claude.js). Solo se usa si el pipeline AI-first falla.' },
  CLAUDE_FALLBACK_MAX_TOKENS: { default: '250', type: 'number', group: 'ai', label: 'Max tokens fallback legacy', description: 'Tokens máximos para la respuesta del parser legacy de gastos/ingresos.' },
  CLAUDE_FALLBACK_ENABLED: { default: 'true', type: 'boolean', group: 'ai', label: 'Claude fallback legacy habilitado', description: 'Habilita/deshabilita el parser legacy de gastos. Si está deshabilitado, solo funciona el pipeline AI-first.' },

  // AI Agent (tool_use pipeline — new)
  AGENT_ENABLED: { default: 'false', type: 'boolean', group: 'ai', label: 'AI Agent tool_use habilitado', description: 'Kill switch: true=usa tool_use (nuevo), false=usa JSON extraction (actual). Si true, AGENT_* settings aplican.' },
  AGENT_MODEL: { default: 'claude-haiku-4-5-20251001', type: 'string', group: 'ai', label: 'Modelo AI Agent', description: 'Modelo Claude para el agent tool_use.' },
  AGENT_MAX_TOKENS: { default: '400', type: 'number', group: 'ai', label: 'Max tokens AI Agent', description: 'Tokens máximos para respuesta del agent.' },
  AGENT_TIMEOUT_MS: { default: '8000', type: 'number', group: 'ai', label: 'Timeout AI Agent (ms)', description: 'Timeout del agent en ms.' },
  AGENT_TEMPERATURE: { default: '0', type: 'number', group: 'ai', label: 'Temperature AI Agent', description: 'Temperatura del agent (0=determinista, 1=creativo). Recomendado 0 para clasificación de intención.' },
  AGENT_CACHE_TTL: { default: 'short', type: 'string', group: 'ai', label: 'TTL del prompt cache AI Agent', description: 'Duración del cache de prompt (Anthropic). "short" = 5 minutos, write cost 125% (default, ideal para sesiones cortas). "long" = 1 hora, write cost 200% pero el cache dura 12x más (ideal si hay repeat traffic dentro de 1h). Valores aceptados: short | long.' },
  AGENT_FEW_SHOT_LIMIT: { default: '5', type: 'number', group: 'ai', label: 'Cantidad de few-shots por call', description: 'Cuántos ejemplos de entrenamiento inyectar en el prompt del agente. Más ejemplos = mejor cobertura pero más tokens. Rango útil: 3-15. Default 5. Cada ejemplo ~166 tokens. Subir a 10 suma ~$0.02/día con 100 calls; a 15 suma ~$0.04/día. La selección rota diaria (md5 determinístico) así Haiku ve distintos ejemplos día a día sin invalidar cache.' },
  AGENT_OUTPUT_VALIDATION_ENABLED: { default: 'false', type: 'boolean', group: 'ai', label: '[MASTER] Validación server-side del output del agente', description: 'KILL SWITCH MAESTRO de la capa de validación post-agente. Cuando true, habilita las reglas individuales (AGENT_VALIDATE_CROP, AGENT_VALIDATE_PLOT_FIELD) que descartan entidades que el agente puso pero que el usuario nunca nombró. Si está en false, ninguna validación corre por más que las reglas individuales estén true. Para apagar TODA la capa rápido sin redeploy, ponelo en false. Cambio toma efecto en ~5 min (cache de settings).' },
  AGENT_VALIDATE_CROP: { default: 'false', type: 'boolean', group: 'ai', label: 'Validar crop del agente contra texto del usuario', description: 'Cuando true (y master AGENT_OUTPUT_VALIDATION_ENABLED=true), descarta el param crop cuando el usuario no nombró ese cultivo en su mensaje (ni un sinónimo conocido como soybean→soja, choclo→maíz). El handler entonces pregunta el cultivo en vez de aceptar lo que el agente infirió desde active_crop o suposiciones. Cambio sin redeploy: efecto en ~5 min.' },
  AGENT_VALIDATE_PLOT_FIELD: { default: 'false', type: 'boolean', group: 'ai', label: 'Validar plot/field del agente contra texto del usuario', description: 'Cuando true (y master AGENT_OUTPUT_VALIDATION_ENABLED=true), descarta el param plot/field en tools de actividad cuando el usuario no nombró ese lote/campo y no usó un pronombre explícito ("ahí", "ese lote", "el mismo", "allá"). NO se aplica a tools de creación (add_field, add_plot, rename_*, delete_*) — ahí el nombre ES la entidad nueva. Cambio sin redeploy: efecto en ~5 min.' },
  AGENT_CORRECTION_PRE_CLASSIFIER_ENABLED: { default: 'false', type: 'boolean', group: 'ai', label: 'Pre-classifier de correcciones', description: 'Cuando true, detecta patrones de corrección como "no, era en lote X" / "perdón fue soja" / "me equivoqué, era en lote Y" ANTES de invocar al agente y rutea directo a edit_last_activity. Conservador: solo los patrones más explícitos disparan, así no compite con registros legítimos. Independiente del master AGENT_OUTPUT_VALIDATION_ENABLED. Cambio sin redeploy: efecto en ~5 min.' },
  AGENT_REDUCED_CONTEXT_PROMPT_ENABLED: { default: 'false', type: 'boolean', group: 'ai', label: 'Prefijo del agente sin contexto reciente', description: 'Cuando true, omite "último lote", "último campo" y "contextos recientes" del prefijo del mensaje al agente. Ese contexto tienta al modelo a auto-completar plot/field cuando el usuario no lo nombró. Los pronombres ("ahí", "ese lote") siguen funcionando porque __last__ se resuelve server-side desde conversation_state, independiente del prompt. La lista completa de campos/lotes se mantiene para que el agente reconozca nombres que el usuario sí mencione. Independiente del master AGENT_OUTPUT_VALIDATION_ENABLED. Cambio sin redeploy: efecto en ~5 min.' },

  // AI Intent Extraction (primary pipeline — fallback when AGENT_ENABLED=false)
  AI_INTENT_ENABLED: { default: 'true', type: 'boolean', group: 'ai', label: 'Pipeline IA JSON habilitado (kill switch)', description: 'Kill switch del pipeline JSON. Si se desactiva (y AGENT_ENABLED=false), TODOS los mensajes van al pipeline regex. Usar solo en emergencia.' },
  AI_INTENT_MODEL: { default: 'claude-haiku-4-5-20251001', type: 'string', group: 'ai', label: 'Modelo para extracción de intención', description: 'Modelo Claude usado para clasificar intención del mensaje del usuario (el motor principal del bot).' },
  AI_INTENT_MAX_TOKENS: { default: '300', type: 'number', group: 'ai', label: 'Max tokens extracción de intención', description: 'Tokens máximos para la respuesta JSON del clasificador de intención.' },
  AI_INTENT_TIMEOUT_MS: { default: '5000', type: 'number', group: 'ai', label: 'Timeout extracción de intención (ms)', description: 'Tiempo máximo de espera para la clasificación IA. Si expira, cae al pipeline regex.' },
  AI_INTENT_MIN_CONFIDENCE: { default: '0.70', type: 'number', group: 'ai', label: 'Confianza mínima para aceptar intención', description: 'Umbral de confianza IA. Por debajo de este valor, el resultado se descarta y se usa regex fallback.' },
  AI_INTENT_SYSTEM_PROMPT_PREFIX: { default: 'Asistente agrícola argentino.', type: 'string', group: 'ai', label: 'Prefijo system prompt IA', description: 'Primera línea del system prompt enviado al clasificador de intención. Permite ajustar el tono sin tocar código.' },
  CONVERSATION_HISTORY_MAX_CHARS: { default: '4000', type: 'number', group: 'ai', label: 'Máx caracteres historial conversación', description: 'Cantidad máxima de caracteres del historial de conversación enviados como contexto al clasificador IA. Más caracteres = más contexto pero más tokens consumidos (~4 chars = 1 token). 0 = sin historial.' },

  // Conversational fallback
  CONVERSATIONAL_FALLBACK_ENABLED: { default: 'true', type: 'boolean', group: 'ai', label: 'Fallback conversacional habilitado', description: 'Cuando el bot no entiende un mensaje (intent=unknown), genera una respuesta breve con IA. Si se desactiva, muestra texto de ayuda estático.' },
  CONVERSATIONAL_FALLBACK_MODEL: { default: 'claude-haiku-4-5-20251001', type: 'string', group: 'ai', label: 'Modelo fallback conversacional', description: 'Modelo Claude usado para respuestas conversacionales cuando no se detecta intención clara.' },
  CONVERSATIONAL_FALLBACK_MAX_TOKENS: { default: '500', type: 'number', group: 'ai', label: 'Max tokens fallback conversacional', description: 'Tokens máximos para respuestas conversacionales. Default 500 evita respuestas truncadas a mitad de palabra. Si el bot suele cortarse, subir a 800.' },
  CONVERSATIONAL_FALLBACK_TIMEOUT_MS: { default: '5000', type: 'number', group: 'ai', label: 'Timeout fallback conversacional (ms)', description: 'Tiempo máximo de espera para la respuesta conversacional.' },
  CONVERSATIONAL_FALLBACK_TEMPERATURE: { default: '0.3', type: 'number', group: 'ai', label: 'Temperature fallback conversacional', description: 'Creatividad de las respuestas conversacionales. 0.0=determinista, 1.0=creativo. Recomendado: 0.2-0.4.' },
  CONVERSATIONAL_FALLBACK_SYSTEM_PROMPT: { default: `Sos MIA, asistente de gestión agrícola por WhatsApp para productores argentinos. Respondé en español argentino (vos/tenés/podés), breve (máx 3-4 oraciones), tono amigable y práctico.

REGLAS:
- NUNCA enumeres capacidades en lista. Si el usuario pregunta qué podés hacer / cómo funcionás / para qué servís, decile en una oración que escriba *ayuda* para ver categorías con ejemplos.
- NUNCA digas que registraste, guardaste o anotaste algo. Vos NO podés guardar datos, solo orientar.
- NUNCA inventes datos del usuario (gastos, lluvias, hectáreas, rindes). No tenés acceso a su información.
- Si el usuario quiere registrar algo pero le falta info, decile que repita con más contexto. Ejemplo: "gasté 50000 en gasoil en lote norte".
- Para consultas agro generales (plagas, fenología, fertilización), respondé en 2-3 oraciones con conocimiento general.
- Si la consulta no es agrícola/rural, respondé amablemente que sos un asistente del campo y sugerí escribir *menú* o *ayuda*.
- Usá "lucas"=miles, "palos"=millones si el usuario los usa.`, type: 'string', group: 'ai', label: 'System prompt del fallback conversacional', description: 'Instrucciones que recibe el modelo para generar respuestas conversacionales. Define personalidad y límites del bot. NO incluir lista enumerada de capacidades — usar el comando "ayuda" para eso.' },

  // Rate limiting
  CONVERSATIONAL_FALLBACK_RATE_LIMIT_MAX: { default: '5', type: 'number', group: 'limits', label: 'Máx llamadas fallback por ventana', description: 'Cantidad máxima de respuestas conversacionales por usuario dentro de la ventana de tiempo.' },
  CONVERSATIONAL_FALLBACK_RATE_LIMIT_WINDOW_MS: { default: '600000', type: 'number', group: 'limits', label: 'Ventana rate limit fallback (ms)', description: 'Ventana de tiempo (10 min por defecto) para el rate limit del fallback conversacional.' },

  // Confidence thresholds
  CONFIDENCE_LOW_CONFIRM: { default: '0.70', type: 'number', group: 'ai', label: 'Confianza baja (forzar confirmación)', description: 'Si la confianza del resultado está por debajo de este valor, se pide confirmación al usuario antes de guardar.' },
  CONFIDENCE_UNKNOWN_FALLBACK: { default: '0.50', type: 'number', group: 'ai', label: 'Confianza para fallback conversacional', description: 'Si la confianza está por debajo de este valor, se activa el fallback conversacional en vez de ejecutar la acción.' },

  // Flow & conversation
  FLOW_TIMEOUT_MS: { default: '600000', type: 'number', group: 'bot', label: 'Timeout de flujo conversacional (ms)', description: 'Controla cuánto tiempo (en milisegundos) un flujo de registro (gasto, ingreso, actividad, lluvia, campo) permanece activo sin actividad del usuario. Pasado este tiempo el flujo se cierra automáticamente. Ejemplos: 300000 = 5 min, 600000 = 10 min (default), 900000 = 15 min. Este valor es leído desde esta tabla (system_settings); si no está definido acá cae a la variable de entorno FLOW_TIMEOUT_MS, y si tampoco existe usa el default del código (10 min). El valor se cachea 5 minutos en memoria y se refresca cada vez que arranca un flujo nuevo (startFlow), así que los cambios desde este panel se aplican en caliente sin reiniciar el bot.' },
  FLOW_MAX_STEP_FAILURES: { default: '3', type: 'number', group: 'bot', label: 'Máx fallos por paso antes de hint', description: 'Después de N respuestas inválidas en un paso del flujo, se muestra un hint para cancelar.' },
  FLOW_TIMEOUT_NOTIFICATION_ENABLED: { default: 'true', type: 'boolean', group: 'bot', label: 'Notificar al usuario cuando expira un flujo', description: 'Cuando un flujo expira por inactividad (ver FLOW_TIMEOUT_MS), envía un mensaje al usuario avisando que el formulario se cerró ("⏰ Cerré el gasto anterior por inactividad…"). Se dispara por dos caminos: (1) al recibir un mensaje nuevo del usuario después de la expiración, (2) de forma proactiva desde el scheduler (que corre cada minuto) para usuarios que ya no vuelven. Si está desactivado, el flujo se cierra silenciosamente. Cambios desde este panel se aplican en caliente (cache 5 min).' },
  FLOW_HALFLIFE_WARNING_ENABLED: { default: 'true', type: 'boolean', group: 'bot', label: 'Enviar recordatorio intermedio (¿seguís ahí?)', description: 'Si está activado, el bot envía un ping intermedio ("👋 ¿Seguís ahí? Tu gasto quedó a medias…") cuando el usuario lleva cierto tiempo sin responder dentro de un flujo. El tiempo de disparo lo controla FLOW_HALFLIFE_WARNING_MS. Corre desde el scheduler cada minuto y se marca en DB (flow_halflife_notified_at) para no duplicarse. Útil para re-enganchar al usuario antes de que el flujo expire por completo. Cambios desde este panel se aplican en caliente (cache 5 min).' },
  FLOW_HALFLIFE_WARNING_MS: { default: '300000', type: 'number', group: 'bot', label: 'Tiempo antes de enviar recordatorio (ms)', description: 'Milisegundos desde el inicio del flujo antes de enviar el recordatorio "¿seguís ahí?". Debe ser MENOR que FLOW_TIMEOUT_MS, de lo contrario el flujo expira antes de que el recordatorio se dispare. Ejemplo: con timeout 600000 ms (10 min), poner 300000 ms (5 min) envía el recordatorio a mitad de camino. Default: 300000 ms (5 min). Este valor también se lee vía el sistema de settings (DB → env → default) y se cachea 5 min, igual que FLOW_TIMEOUT_MS.' },
  MONTHLY_SUMMARY_HOUR: { default: '8', type: 'number', group: 'bot', label: 'Hora del resumen mensual (Argentina)', description: 'Hora (0-23) a la que se envía el resumen mensual el primer día de cada mes. Default: 8 AM.' },

  // Domain
  DEFAULT_RAIN_ALERT_MM: { default: '10', type: 'number', group: 'system', label: 'Umbral lluvia por defecto (mm)', description: 'Milímetros de lluvia a partir de los cuales se genera una alerta. Se usa como fallback cuando el usuario no configuró su propio umbral.' },
  REPORTS_STORAGE_PATH: { default: 'data/reports', type: 'string', group: 'agronomy', label: 'Ruta almacenamiento reportes', description: 'Directorio del servidor donde se guardan los reportes agronómicos PDF generados.' },

  // Cleanup
  CONVERSATION_LOG_TTL_DAYS: { default: '90', type: 'number', group: 'system', label: 'TTL de logs conversacionales (días)', description: 'Días que se conservan los registros de conversation_logs, conversation_events y conversation_errors. Pasado este tiempo se eliminan automáticamente a las 3 AM. Poner 0 para desactivar.' },
  MINI_MEMORY_EXPIRY_DAYS: { default: '7', type: 'number', group: 'system', label: 'Expiración de mini-memoria (días)', description: 'Días de inactividad tras los cuales se limpian los campos de contexto rápido (last_intent, last_plot_id, etc.) en conversation_state. Solo aplica a usuarios sin flujo activo. Poner 0 para desactivar.' },

  // Agro report customization (per-section toggles + branding)
  AGRO_REPORT_SHOW_HEADER_SUMMARY: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Encabezado enriquecido', description: 'Muestra en el header lluvia acumulada, superficie monitoreada y cultivos activos. Si está apagado, el encabezado es el básico (nombre del campo + período + fecha).' },
  AGRO_REPORT_SHOW_KPIS: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Tabla de KPIs', description: 'Bloque de métricas rápidas arriba del reporte: hectáreas trabajadas, kg cosechados, rinde promedio, lotes activos, actividades, gastos e ingresos estimados del período.' },
  AGRO_REPORT_SHOW_COMPARISON: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Comparativa con período anterior', description: 'Tabla comparativa de kg cosechados, rinde, hectáreas trabajadas, gastos e ingresos vs. el período equivalente previo, con variación %.' },
  AGRO_REPORT_SHOW_PER_PLOT: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Vista por lote', description: 'Organiza observaciones y actividades agrupadas por lote (con cultivo, estado, rinde y superficie). Si está apagado, se listan en bloque único.' },
  AGRO_REPORT_SHOW_TIMELINE: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Timeline de actividades', description: 'Formatea la actividad de la semana como timeline visual con bullets coloreados por tipo (cosecha, siembra, fumigación).' },
  AGRO_REPORT_SHOW_INSIGHTS: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Insights automáticos', description: 'Motor de reglas que detecta patrones en la semana (lote rindió por encima del promedio, concentración de cosecha, lotes sin actividad, etc.).' },
  AGRO_REPORT_SHOW_WEATHER_SECTION: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Sección climática', description: 'Bloque con lluvia acumulada del período + alerta si el pronóstico de los próximos días supera el umbral.' },
  AGRO_REPORT_SHOW_FINANCIAL_SUMMARY: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Resumen económico', description: 'Sección con gastos e ingresos por moneda (ARS + USD), resultado neto y detalle de rinde por lote dentro del período.' },
  AGRO_REPORT_SHOW_SCOUTING: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Sección de monitoreo', description: 'Sección "Monitoreo del cultivo": resumen del período (último estadio, plaga más severa, cobertura promedio de malezas, densidad, emergencia) + lista de scoutings registrados con sus métricas estructuradas.' },
  AGRO_REPORT_SHOW_CHARTS_YIELD: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Gráfico de rinde por lote', description: 'Gráfico de barras con el rinde en kg/ha de cada lote cosechado en el período.' },
  AGRO_REPORT_SHOW_CHARTS_CROPS: { default: 'true', type: 'boolean', group: 'agro_report', label: 'Gráfico de distribución de cultivos', description: 'Gráfico de torta con la distribución de superficie por cultivo activo en el período.' },
  AGRO_REPORT_SHOW_LOGO: { default: 'false', type: 'boolean', group: 'agro_report', label: 'Mostrar logo en el encabezado', description: 'Requiere haber subido un logo desde "Logo del reporte". Si está activado sin logo cargado, se ignora.' },
  AGRO_REPORT_LOGO_PATH: { default: '', type: 'string', group: 'agro_report', label: 'Logo del reporte (ruta)', description: 'Ruta al archivo de logo (PNG/JPG). Se completa automáticamente cuando subís un logo desde el botón. No editar a mano salvo que tengas un archivo servido por el contenedor.' },
  AGRO_REPORT_BRAND_NAME: { default: 'Agrobot', type: 'string', group: 'agro_report', label: 'Nombre de marca', description: 'Texto que aparece arriba del título cuando no hay logo cargado. Default "Agrobot".' },

  // Mensajes del bot (customizable)
  BOT_NAME: { default: 'MIA', type: 'string', group: 'mensajes', label: 'Nombre del bot', description: 'Nombre que usa el bot para presentarse. Aparece en saludos, ayuda y prompt del agente IA. Si cambiás esto, actualizá también el "System prompt del fallback conversacional" (sección IA) donde dice "Sos MIA".' },
  GREETING_NEW_USER_MESSAGE: { default: 'Hola{{nombre}} 👋 Soy *{{botName}}*, tu asistente de gestión agrícola.\n\nPara empezar, necesitás crear tu primer campo. Escribí algo como:\n📍 *agregar campo La Esperanza*', type: 'string', group: 'mensajes', label: 'Saludo: usuario sin campos', description: 'Mensaje cuando el usuario no tiene ningún campo creado. Variables: {{nombre}}, {{botName}}' },
  GREETING_NO_PLOTS_MESSAGE: { default: 'Hola{{nombre}} 👋 Ya tenés tu campo *{{fieldName}}*.\n\nAhora creá un lote para poder registrar gastos e ingresos. Escribí algo como:\n🌾 *agregar lote Lote 1 en {{fieldName}}*', type: 'string', group: 'mensajes', label: 'Saludo: usuario sin lotes', description: 'Mensaje cuando el usuario tiene campo pero no tiene lotes. Variables: {{nombre}}, {{botName}}, {{fieldName}}' },
  GREETING_NORMAL_MESSAGE: { default: 'Hola{{nombre}} 👋 Soy *{{botName}}*, tu asistente de gestión agrícola.', type: 'string', group: 'mensajes', label: 'Saludo: usuario normal', description: 'Mensaje de saludo para usuarios con campos y lotes. Variables: {{nombre}}, {{botName}}' },
  EXPENSE_CONFIRMATIONS_MESSAGE: { default: '✅ Listo, gasto registrado\n✅ Anotado\n✅ Gasto guardado\n✅ Registrado', type: 'string', group: 'mensajes', label: 'Pool confirmaciones de gasto', description: 'Mensajes de confirmación al registrar un gasto. Uno por línea, se elige uno al azar.' },
  INCOME_CONFIRMATIONS_MESSAGE: { default: '💰 Listo, ingreso registrado\n💰 Anotado\n💰 Ingreso guardado\n💰 Registrado', type: 'string', group: 'mensajes', label: 'Pool confirmaciones de ingreso', description: 'Mensajes de confirmación al registrar un ingreso. Uno por línea, se elige uno al azar.' },

  // Onboarding
  ONBOARDING_FIRST_PLOT_MESSAGE: { default: '🌾 *¡Tu campo está listo!* Ya tenés campo y lote configurados.\n\nAcá van ejemplos de lo que podés hacer:\n\n💰 *Gastos e Ingresos*\n"gasté 50000 en gasoil"\n"vendí 30 tn de soja a 300 usd"\n\n🌱 *Actividades*\n"fumigué lote norte con glifosato"\n"sembré soja en lote 1"\n\n🌧 *Lluvia y Clima*\n"llovieron 25mm"\n"clima"\n\n📊 *Reportes*\n"resumen del mes"\n"reporte agro"\n\nEscribí *menú* para ver todas las opciones.', type: 'string', group: 'onboarding', label: 'Mensaje de bienvenida tras primer lote', description: 'Mensaje que se envía una sola vez cuando el usuario crea su primer lote. Se muestra como guía de uso del bot.' },

  // Channel verification (WhatsApp OTP + Telegram deep-link)
  PUBLIC_URL: { default: 'https://campo-bot-production.up.railway.app', type: 'string', group: 'system', label: 'URL pública del frontend', description: 'URL base del frontend (ej: https://campo.bot). Se usa para construir links que el bot envía al usuario (registro, recuperación, etc.). Cambiá esto cuando muevas el dominio sin necesidad de redeploy.' },
  TELEGRAM_BOT_USERNAME: { default: '', type: 'string', group: 'system', label: 'Username del bot de Telegram', description: 'Username del bot SIN @ (ej: "CampoBot"). Necesario para generar deep-links de vinculación de cuenta (https://t.me/<usuario>?start=verify_<token>). Si está vacío, la vinculación de Telegram queda deshabilitada.' },
  OTP_TTL_MINUTES: { default: '10', type: 'number', group: 'system', label: 'Validez del código OTP (min)', description: 'Cuánto dura un código de verificación de WhatsApp (en minutos). Default 10. Subir a 15 si los usuarios reportan que el código vence antes de que lleguen a copiarlo.' },
  OTP_MAX_ATTEMPTS: { default: '5', type: 'number', group: 'system', label: 'Máximo intentos por código OTP', description: 'Cuántas veces el usuario puede equivocarse al ingresar el código antes de tener que pedir uno nuevo. Default 5.' },
  TELEGRAM_LINK_TTL_MINUTES: { default: '1440', type: 'number', group: 'system', label: 'Validez del link de Telegram (min)', description: 'Cuánto vive el deep-link de vinculación de Telegram (en minutos). Default 1440 (24h).' },
  REQUIRE_VERIFIED_CHANNEL: { default: 'false', type: 'boolean', group: 'system', label: 'Requerir verificación de canal', description: 'Si está activo, mensajes desde un WhatsApp/Telegram NO verificado son rechazados con un onboarding hint en lugar de auto-crear un usuario anónimo. Default false durante MVP/transición; activar antes del launch público para garantizar aislamiento multi-tenant.' },

  // Payments (MercadoPago)
  PAYMENTS_ENABLED: { default: 'false', type: 'boolean', group: 'payments', label: 'Pagos habilitados', description: 'Kill switch global de la integración de pagos. Si está apagado: no se ofrece checkout, no se crean trials automáticos, los webhooks se siguen aceptando para idempotencia pero no aplican cambios. Activar cuando MP_ACCESS_TOKEN esté configurado y probaste el flow en sandbox.' },
  MP_ACCESS_TOKEN: { default: '', type: 'string', group: 'payments', label: 'MercadoPago — Access Token', description: 'Access token de MercadoPago (formato APP_USR-XXXX-... o TEST-XXXX-...). Se usa para crear preapprovals y consultar estado. NUNCA commitearlo al repo. Generalo en https://www.mercadopago.com.ar/developers/panel/credentials.' },
  MP_WEBHOOK_SECRET: { default: '', type: 'string', group: 'payments', label: 'MercadoPago — Webhook Secret', description: 'Secret HMAC para verificar la firma de los webhooks (header x-signature). Configurarlo en MP > Notificaciones webhooks. Si lo dejás vacío, los webhooks se procesan sin verificar firma (solo apto para sandbox).' },
  TRIAL_DAYS: { default: '14', type: 'number', group: 'payments', label: 'Duración del trial (días)', description: 'Cuántos días de prueba gratis del plan pro recibe un usuario al registrarse. 0 = sin trial. Cambiarlo solo afecta a registros nuevos.' },
  TRIAL_PLAN_NAME: { default: 'pro_plus', type: 'string', group: 'payments', label: 'Plan del trial', description: 'Qué plan se otorga durante el trial. Default "pro_plus" para que el trial muestre todas las features (audio, agronomía, hacienda, stock). Si querés un trial más acotado cambialo a "pro". Tiene que ser un plan existente en la tabla plans.' },
  PAST_DUE_GRACE_DAYS: { default: '3', type: 'number', group: 'payments', label: 'Días de gracia tras pago fallido', description: 'Cuántos días pasados de un pago fallido (status past_due) antes de cancelar la suscripción y bajar al plan free. Default 3. El usuario sigue con acceso pleno durante la gracia.' },

  // Email (Resend)
  RESEND_API_KEY: { default: '', type: 'string', group: 'email', label: 'Resend — API key', description: 'API key de Resend (https://resend.com) para enviar emails transaccionales: recuperación de contraseña, verificación de email. Si está vacío, los emails se loguean a consola (modo dev). Generalo en https://resend.com/api-keys.' },
  MAIL_FROM_EMAIL: { default: 'noreply@campo-bot.com', type: 'string', group: 'email', label: 'Email remitente', description: 'Dirección "from" para todos los emails transaccionales. Tiene que ser un dominio verificado en Resend.' },
  MAIL_FROM_NAME: { default: 'Campo Bot', type: 'string', group: 'email', label: 'Nombre remitente', description: 'Nombre que aparece como remitente en los emails. Ej: "Campo Bot".' },
  PASSWORD_RESET_TTL_MINUTES: { default: '60', type: 'number', group: 'email', label: 'Validez del link de reset (min)', description: 'Cuánto vive el link para resetear contraseña. Default 60 minutos.' },
  EMAIL_VERIFY_TTL_HOURS: { default: '24', type: 'number', group: 'email', label: 'Validez del link de verificación (horas)', description: 'Cuánto vive el link de verificación de email post-registro. Default 24 horas.' },
  EMAIL_VERIFY_REQUIRED: { default: 'false', type: 'boolean', group: 'email', label: 'Requerir email verificado', description: 'Si está activo, el usuario no puede iniciar checkout de pago hasta verificar su email. Default false durante MVP; activar antes del launch público.' },

  // Sentry / observability
  SENTRY_DSN: { default: '', type: 'string', group: 'system', label: 'Sentry DSN (backend)', description: 'DSN de Sentry para alertas en tiempo real de errores en el servidor. Si está vacío, Sentry queda deshabilitado y los errores solo van a la tabla error_logs y a stdout. Crearlo en https://sentry.io/.' },
  SENTRY_DSN_FRONTEND: { default: '', type: 'string', group: 'system', label: 'Sentry DSN (frontend)', description: 'DSN de Sentry específico para el frontend (proyecto separado, recomendado). Se inyecta vía /api/auth/public-config y se inicializa en el cliente. Si está vacío, el frontend no reporta a Sentry.' },
  SENTRY_TRACES_SAMPLE_RATE: { default: '0.1', type: 'number', group: 'system', label: 'Sentry — sample rate de traces', description: 'Fracción de transacciones a samplear (0.0-1.0). Default 0.1 (10%) para no inflar costos. Subir a 1.0 solo en debug.' },
  SENTRY_ENVIRONMENT: { default: 'production', type: 'string', group: 'system', label: 'Sentry — environment tag', description: 'Tag de environment que se envía en cada evento (production, staging, dev). Permite filtrar en el dashboard de Sentry.' },
};

/**
 * Get a single setting. Checks DB first, falls back to process.env, then to default.
 */
export async function getSetting(key) {
  // Check cache first
  const cached = settingsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let resolved = null;

  try {
    const result = await pool.query(
      `SELECT value FROM system_settings WHERE key = $1`,
      [key]
    );
    if (result.rows.length > 0) {
      resolved = result.rows[0].value;
    }
  } catch (err) {
    // Table may not exist yet during migrations — fall through
  }

  // Fallback to env
  if (resolved === null && process.env[key] !== undefined) {
    resolved = process.env[key];
  }

  // Fallback to default
  if (resolved === null) {
    const def = SETTING_DEFINITIONS[key];
    if (def) resolved = def.default;
  }

  // Cache the resolved value (even null, to avoid repeated DB misses)
  settingsCache.set(key, { value: resolved, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });

  return resolved;
}

/**
 * Get a setting as a number.
 */
export async function getSettingNumber(key) {
  const val = await getSetting(key);
  return val !== null ? Number(val) : null;
}

/**
 * Get a setting as a boolean.
 */
export async function getSettingBool(key) {
  const val = await getSetting(key);
  if (val === null) return null;
  return val === 'true' || val === '1';
}

/**
 * Set a setting in the database.
 */
export async function setSetting(key, value) {
  if (SECRET_KEYS.has(key)) {
    throw new Error(`Cannot set secret key "${key}" via settings API`);
  }
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, String(value)]
  );
  // Invalidate cache for this key
  settingsCache.delete(key);
}

/**
 * Get all configurable settings (for dashboard display).
 * Merges DB values with defaults. Never includes secrets.
 */
export async function getAllSettings() {
  // Get all DB overrides
  let dbSettings = {};
  try {
    const result = await pool.query(`SELECT key, value, updated_at FROM system_settings`);
    for (const row of result.rows) {
      dbSettings[row.key] = { value: row.value, updatedAt: row.updated_at };
    }
  } catch (err) {
    // Table may not exist yet
  }

  // Build response from definitions
  const settings = {};
  for (const [key, def] of Object.entries(SETTING_DEFINITIONS)) {
    const dbEntry = dbSettings[key];
    const envValue = process.env[key];
    settings[key] = {
      value: dbEntry?.value ?? envValue ?? def.default,
      source: dbEntry ? 'database' : (envValue !== undefined ? 'env' : 'default'),
      updatedAt: dbEntry?.updatedAt || null,
      type: def.type,
      group: def.group,
      label: def.label,
      description: def.description || null,
      default: def.default,
    };
  }

  return settings;
}

export function clearSettingsCache() {
  settingsCache.clear();
}

export { SETTING_DEFINITIONS, SECRET_KEYS };
