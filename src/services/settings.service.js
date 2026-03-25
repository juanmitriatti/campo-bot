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
  MAX_AUDIO_DURATION_SECONDS: { default: '120', type: 'number', group: 'audio', label: 'Duración máxima de audio (seg)' },
  OPENAI_WHISPER_MODEL: { default: 'whisper-1', type: 'string', group: 'audio', label: 'Modelo Whisper' },
  SPEECH_TIMEOUT_MS: { default: '30000', type: 'number', group: 'audio', label: 'Timeout transcripción (ms)' },

  // AI
  CLAUDE_FALLBACK_MODEL: { default: 'claude-haiku-4-5-20251001', type: 'string', group: 'ai', label: 'Modelo Claude fallback' },
  CLAUDE_FALLBACK_MAX_TOKENS: { default: '250', type: 'number', group: 'ai', label: 'Max tokens fallback' },
  CLAUDE_FALLBACK_ENABLED: { default: 'true', type: 'boolean', group: 'ai', label: 'Claude fallback habilitado' },

  // AI Intent Extraction
  AI_INTENT_ENABLED: { default: 'true', type: 'boolean', group: 'ai', label: 'Extracción de intención por IA habilitada' },
  AI_INTENT_MODEL: { default: 'claude-haiku-4-5-20251001', type: 'string', group: 'ai', label: 'Modelo para extracción de intención' },
  AI_INTENT_MAX_TOKENS: { default: '300', type: 'number', group: 'ai', label: 'Max tokens extracción de intención' },
  AI_INTENT_TIMEOUT_MS: { default: '5000', type: 'number', group: 'ai', label: 'Timeout extracción de intención (ms)' },
  AI_INTENT_MIN_CONFIDENCE: { default: '0.70', type: 'number', group: 'ai', label: 'Confianza mínima para aceptar intención IA' },
  CONVERSATIONAL_FALLBACK_ENABLED: { default: 'true', type: 'boolean', group: 'ai', label: 'Fallback conversacional habilitado' },
  CONVERSATIONAL_FALLBACK_MODEL: { default: 'claude-haiku-4-5-20251001', type: 'string', group: 'ai', label: 'Modelo fallback conversacional' },
  CONVERSATIONAL_FALLBACK_MAX_TOKENS: { default: '120', type: 'number', group: 'ai', label: 'Max tokens fallback conversacional' },
  CONVERSATIONAL_FALLBACK_TIMEOUT_MS: { default: '5000', type: 'number', group: 'ai', label: 'Timeout fallback conversacional (ms)' },
  CONVERSATIONAL_FALLBACK_TEMPERATURE: { default: '0.3', type: 'number', group: 'ai', label: 'Temperature fallback conversacional' },
  CONVERSATIONAL_FALLBACK_SYSTEM_PROMPT: { default: 'Sos un asistente agrícola en un bot de WhatsApp para productores argentinos. Respondé brevemente en español (máximo 2 oraciones). Si la pregunta es sobre agricultura, cultivos, lluvia o campo, dá una respuesta útil y corta. Si preguntan qué puede hacer el bot, explicá brevemente: registrar gastos, ingresos, lluvias, actividades agrícolas y pedir reportes. Nunca inventes datos del campo del usuario. Hablá en general.', type: 'string', group: 'ai', label: 'System prompt del fallback conversacional' },
  AI_INTENT_SYSTEM_PROMPT_PREFIX: { default: 'Asistente agrícola argentino.', type: 'string', group: 'ai', label: 'Prefijo system prompt extracción de intención' },
  CONVERSATIONAL_FALLBACK_RATE_LIMIT_MAX: { default: '5', type: 'number', group: 'limits', label: 'Máx llamadas fallback por ventana' },
  CONVERSATIONAL_FALLBACK_RATE_LIMIT_WINDOW_MS: { default: '600000', type: 'number', group: 'limits', label: 'Ventana rate limit fallback (ms)' },

  // Confidence thresholds
  CONFIDENCE_HIGH_SKIP_AI: { default: '0.75', type: 'number', group: 'ai', label: 'Confianza para omitir IA' },
  CONFIDENCE_LOW_CONFIRM: { default: '0.70', type: 'number', group: 'ai', label: 'Confianza baja (forzar confirmación)' },
  CONFIDENCE_UNKNOWN_FALLBACK: { default: '0.50', type: 'number', group: 'ai', label: 'Confianza para fallback conversacional' },

  // Flow & conversation
  FLOW_TIMEOUT_MS: { default: '600000', type: 'number', group: 'bot', label: 'Timeout de flujo conversacional (ms)' },
  FLOW_MAX_STEP_FAILURES: { default: '3', type: 'number', group: 'bot', label: 'Máx fallos por paso antes de hint' },
  PENDING_TRANSACTION_TIMEOUT_MS: { default: '300000', type: 'number', group: 'bot', label: 'Timeout transacción pendiente (ms)' },
  DEDUP_MAX_SIZE: { default: '1000', type: 'number', group: 'bot', label: 'Tamaño máximo caché deduplicación' },

  // Audio rate limiting
  MAX_AUDIO_PER_HOUR: { default: '10', type: 'number', group: 'limits', label: 'Máx audios por hora por usuario' },
  AUDIO_COST_PER_MINUTE_USD: { default: '0.006', type: 'number', group: 'audio', label: 'Costo audio por minuto (USD)' },

  // Cache TTLs
  USER_CONTEXT_CACHE_TTL_MS: { default: '60000', type: 'number', group: 'system', label: 'Cache contexto usuario (ms)' },
  FEATURE_GATE_CACHE_TTL_MS: { default: '300000', type: 'number', group: 'system', label: 'Cache feature gate (ms)' },

  // Scheduler & weather
  SCHEDULER_CRON_EXPRESSION: { default: '0 * * * *', type: 'string', group: 'system', label: 'Expresión cron del scheduler' },
  DEFAULT_RAIN_ALERT_MM: { default: '10', type: 'number', group: 'system', label: 'Umbral lluvia por defecto (mm)' },

  // Domain defaults
  DEFAULT_FIELD_NAME: { default: 'General', type: 'string', group: 'system', label: 'Nombre campo por defecto' },
  DEFAULT_USER_PLAN: { default: 'free', type: 'string', group: 'system', label: 'Plan por defecto nuevos usuarios' },

  // Agronomy
  MAX_OBSERVATIONS_PER_REPORT: { default: '200', type: 'number', group: 'agronomy', label: 'Máx observaciones por reporte' },
  REPORTS_STORAGE_PATH: { default: 'data/reports', type: 'string', group: 'agronomy', label: 'Ruta de almacenamiento de reportes' },

  // Limits
  MAX_AUDIO_PER_USER_DAY: { default: '50', type: 'number', group: 'limits', label: 'Máx audios por usuario/día' },
  MAX_REPORTS_PER_WEEK: { default: '10', type: 'number', group: 'limits', label: 'Máx reportes por semana' },
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
      default: def.default,
    };
  }

  return settings;
}

export function clearSettingsCache() {
  settingsCache.clear();
}

export { SETTING_DEFINITIONS, SECRET_KEYS };
