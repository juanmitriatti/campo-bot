import { pool } from "../config/db.js";

// Deduplication: track recent errors to avoid flooding the DB
const recentErrors = new Map(); // key -> timestamp
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Patterns to sanitize from error messages and context
const SENSITIVE_PATTERNS = [
  // API keys and tokens
  { regex: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: 'Bearer [REDACTED]' },
  { regex: /(?:api[_-]?key|token|secret|password|authorization)[=:\s]["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, replacement: '[REDACTED_CREDENTIAL]' },
  { regex: /EAA[A-Za-z0-9]+/g, replacement: '[REDACTED_FB_TOKEN]' }, // Facebook/WhatsApp tokens
  { regex: /sk-[A-Za-z0-9-]{20,}/g, replacement: '[REDACTED_API_KEY]' }, // Anthropic/OpenAI keys
  // Phone numbers (Argentine format)
  { regex: /\b(549?\d{10,13})\b/g, replacement: '[PHONE]' },
  { regex: /\b(54\d{2,4}15\d{6,8})\b/g, replacement: '[PHONE]' },
];

/**
 * Sanitize a string by removing sensitive data.
 */
function sanitize(text) {
  if (!text) return text;
  let result = String(text);
  for (const { regex, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Generate a dedup key from service + error_type + message prefix.
 */
function dedupKey(service, errorType, message) {
  const prefix = (message || '').slice(0, 100);
  return `${service}:${errorType}:${prefix}`;
}

/**
 * Check if this error was recently logged (within DEDUP_WINDOW_MS).
 */
function isDuplicate(key) {
  const lastTime = recentErrors.get(key);
  if (!lastTime) return false;
  return (Date.now() - lastTime) < DEDUP_WINDOW_MS;
}

/**
 * Clean up old dedup entries (call periodically).
 */
function cleanupDedup() {
  const now = Date.now();
  for (const [key, timestamp] of recentErrors) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentErrors.delete(key);
    }
  }
}

// Periodic cleanup every 10 minutes
setInterval(cleanupDedup, 10 * 60 * 1000).unref();

/**
 * Log an error to the database. Non-blocking — never throws.
 *
 * @param {string} service - Service name (e.g., 'whatsapp', 'claude', 'webhook')
 * @param {string} errorType - Error classification (e.g., 'API_ERROR', 'PARSE_ERROR')
 * @param {string|Error} error - Error message or Error object
 * @param {object} [options] - Additional options
 * @param {number} [options.userId] - User ID if available
 * @param {string} [options.phone] - Phone number if available
 * @param {object|string} [options.context] - Request context
 * @param {string} [options.severity] - 'error' | 'warning' | 'info' (default: 'error')
 */
export async function logError(service, errorType, error, options = {}) {
  try {
    const message = sanitize(error instanceof Error ? error.message : String(error));
    const severity = options.severity || 'error';

    // Deduplication check
    const key = dedupKey(service, errorType, message);
    if (isDuplicate(key)) return;
    recentErrors.set(key, Date.now());

    // Sanitize context
    let contextStr = null;
    if (options.context) {
      const raw = typeof options.context === 'string'
        ? options.context
        : JSON.stringify(options.context, null, 2);
      contextStr = sanitize(raw);
      // Truncate long context
      if (contextStr.length > 2000) {
        contextStr = contextStr.slice(0, 2000) + '... [truncated]';
      }
    }

    // Sanitize phone
    const phone = options.phone ? sanitize(options.phone) : null;

    await pool.query(
      `INSERT INTO error_logs (service, error_type, message, user_id, phone, request_context, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [service, errorType, message, options.userId || null, phone, contextStr, severity]
    );
  } catch (dbErr) {
    // Last resort: log to console but never throw
    console.error('[error-logger] Failed to log error to DB:', dbErr.message);
  }
}

/**
 * Convenience: log a warning.
 */
export async function logWarning(service, errorType, message, options = {}) {
  return logError(service, errorType, message, { ...options, severity: 'warning' });
}

/**
 * Convenience: log an info-level event.
 */
export async function logInfo(service, errorType, message, options = {}) {
  return logError(service, errorType, message, { ...options, severity: 'info' });
}

/**
 * Query error logs with filters. Used by the dashboard API.
 */
export async function getErrorLogs({ service, severity, userId, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (service) {
    conditions.push(`service = $${paramIdx++}`);
    params.push(service);
  }
  if (severity) {
    conditions.push(`severity = $${paramIdx++}`);
    params.push(severity);
  }
  if (userId) {
    conditions.push(`user_id = $${paramIdx++}`);
    params.push(userId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM error_logs ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM error_logs ${where}`,
      params
    ),
  ]);

  return {
    errors: rows.rows,
    total: parseInt(countResult.rows[0].total),
  };
}

/**
 * Get a single error log by ID.
 */
export async function getErrorById(id) {
  const result = await pool.query(`SELECT * FROM error_logs WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

/**
 * Get error summary stats for dashboard.
 */
export async function getErrorStats() {
  const [totalR, todayR, byServiceR, bySeverityR] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM error_logs`),
    pool.query(`SELECT COUNT(*) AS total FROM error_logs WHERE created_at >= CURRENT_DATE`),
    pool.query(
      `SELECT service, COUNT(*) AS count FROM error_logs
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY service ORDER BY count DESC`
    ),
    pool.query(
      `SELECT severity, COUNT(*) AS count FROM error_logs
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY severity ORDER BY count DESC`
    ),
  ]);

  return {
    total: parseInt(totalR.rows[0].total),
    today: parseInt(todayR.rows[0].total),
    byService: byServiceR.rows,
    bySeverity: bySeverityR.rows,
  };
}
