import { pool } from "../config/db.js";
import { OBSERVATION_CATEGORY_KEYWORDS } from "../constants/agro-terms.js";
import { logWarning } from "../services/error-logger.js";

/**
 * Auto-detect observation category from text.
 * Returns one of: malezas, sanidad, nutricion, fenologia, clima, general
 */
export function detectObservationCategory(text) {
  const lower = text.toLowerCase();
  // Negation: "no hay malezas" is an ABSENCE — do not classify as positive presence
  if (/\bno\s+hay\b/.test(lower)) return 'general';
  for (const [category, keywords] of Object.entries(OBSERVATION_CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return category;
    }
  }
  return 'general';
}

// --- Financial content guard ---
// Detects financial patterns that should NEVER be stored as observations.
const FINANCIAL_VERBS = /(?:gast[eéo]|pagu[eé]|compr[eé]|cobr[eé]|vend[ií]|factur[eé]|ingres[eéo]|carg[ué]e?\s+(?:gasto|ingreso))/i;
const AMOUNT_PATTERN = /(?:\$\s*[\d.,]+|\d+\s*(?:mil|k|lucas|palos|pesos|dolares|usd)|\d{4,})/i;

function hasFinancialContent(text) {
  return FINANCIAL_VERBS.test(text) && AMOUNT_PATTERN.test(text);
}

/**
 * Normalize observation text for deduplication.
 * Strips accents, punctuation, trailing location fragments, and collapses whitespace.
 */
export function normalizeObservationText(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')          // remove accents
    .replace(/^(?:observacion|obs|nota)\s*[:\-\u2014]?\s*/i, '') // strip observation prefix (with or without colon)
    .replace(/[^\w\s]/g, '')                                    // remove punctuation
    .replace(/\s*(?:en\s+(?:el\s+)?)?(?:lote|campo)\s+\w+.*$/g, '') // remove "[en [el]] lote/campo X" and everything after
    .replace(/\s+(?:en\s+el|en|del?)\s*$/g, '')                 // remove trailing prepositions
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^hay\s+(?!no\b)/, '');                            // strip leading "hay " (but NOT "hay no..." → preserves "no hay")
}

// --- In-memory dedup cache ---
// Prevents duplicate inserts within the same process/session window.
// Key: "userId:plotId:normalizedText", Value: timestamp
const _recentInserts = new Map();
const MEMORY_DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

function _pruneMemoryCache() {
  const now = Date.now();
  for (const [key, ts] of _recentInserts) {
    if (now - ts > MEMORY_DEDUP_TTL_MS) _recentInserts.delete(key);
  }
}

// --- Save result types ---
// Typed return values so the handler can give appropriate feedback for each case.
export const SAVE_REJECTED_FINANCIAL = { _rejected: 'financial' };
export const SAVE_REJECTED_DUPLICATE = { _rejected: 'duplicate' };

/**
 * Save an agronomic observation.
 * Guards: rejects financial content, deduplicates via in-memory cache + DB check.
 * Returns: saved row on success, SAVE_REJECTED_FINANCIAL, or SAVE_REJECTED_DUPLICATE.
 */
export const SAVE_REJECTED_NO_PLOT = { _rejected: 'no_plot' };

/**
 * @param {number} userId
 * @param {{
 *   fieldId: number | null,
 *   plotId: number | null,
 *   text: string,
 *   category: string,
 *   source?: string,
 *   observationDate?: string | null,
 *   allowNoPlot?: boolean
 * }} params
 */
export async function saveObservation(userId, { fieldId, plotId, text, category, source, observationDate, allowNoPlot }) {
  // Guard: observations normally MUST have a plot — never store with plot_id = NULL.
  // BulkMode (compound action) callers can pass allowNoPlot=true to save at
  // field-level intentionally; the post-compound bulk-plot handler can then
  // let the user assign a plot retroactively.
  if (!plotId && !allowNoPlot) {
    console.warn(`[obs-guard] Rejected observation without plot_id for user ${userId}`);
    logWarning('observations', 'REJECTED_NO_PLOT', `Observation without plot_id`, { userId });
    return SAVE_REJECTED_NO_PLOT;
  }

  // Guard: reject text with strong financial signals (verb + amount)
  // MUST run on original text — normalization strips $ and amounts
  if (hasFinancialContent(text)) {
    console.warn(`[obs-guard] Rejected financial content as observation for user ${userId}: "${text.slice(0, 80)}"`);
    logWarning('observations', 'REJECTED_FINANCIAL', `Financial content rejected as observation`, { userId });
    return SAVE_REJECTED_FINANCIAL;
  }

  // Single source of truth: normalizeObservationText for BOTH columns
  const normalizedText = normalizeObservationText(text);
  const dedupKey = `${userId}:${plotId || 0}:${normalizedText}`;

  // In-memory dedup (catches same-request / rapid-fire duplicates)
  _pruneMemoryCache();
  if (_recentInserts.has(dedupKey)) {
    console.warn(`[obs-guard] In-memory dedup for user ${userId}: "${normalizedText.slice(0, 80)}"`);
    logWarning('observations', 'DEDUP_MEMORY', `In-memory dedup hit`, { userId });
    return SAVE_REJECTED_DUPLICATE;
  }

  // DB dedup: same user + same normalized text + same plot within 5 minutes
  const dedupResult = await pool.query(
    `SELECT id FROM agro_observations
     WHERE user_id = $1 AND normalized_text = $2
       AND COALESCE(plot_id, 0) = COALESCE($3, 0)
       AND created_at > NOW() - INTERVAL '5 minutes'
     LIMIT 1`,
    [userId, normalizedText, plotId || null]
  );
  if (dedupResult.rows.length > 0) {
    _recentInserts.set(dedupKey, Date.now());
    console.warn(`[obs-guard] DB dedup for user ${userId}: "${normalizedText.slice(0, 80)}"`);
    logWarning('observations', 'DEDUP_DB', `DB dedup hit`, { userId });
    return SAVE_REJECTED_DUPLICATE;
  }

  const result = await pool.query(
    `INSERT INTO agro_observations (user_id, field_id, plot_id, observation_text, normalized_text, category, source, observation_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE)) RETURNING *`,
    [userId, fieldId || null, plotId || null, normalizedText, normalizedText, category || 'general', source || 'text', observationDate || null]
  );
  _recentInserts.set(dedupKey, Date.now());
  return result.rows[0];
}

/**
 * Deduplicate observation rows by normalized_text before rendering.
 * Keeps the first occurrence of each normalized text per plot.
 */
export function deduplicateObservations(observations) {
  const seen = new Set();
  return observations.filter(obs => {
    const norm = normalizeObservationText(obs.observation_text);
    const key = `${obs.plot_id || 0}:${norm}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Get observations for a field with user and plot info.
 * Includes observations stored directly on the field OR on any plot belonging to the field.
 */
export async function getObservationsByField(fieldId, limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT o.*, u.name AS user_name, p.name AS plot_name
     FROM agro_observations o
     LEFT JOIN users u ON o.user_id = u.id
     LEFT JOIN plots p ON o.plot_id = p.id
     WHERE o.field_id = $1
        OR (o.plot_id IS NOT NULL AND p.field_id = $1)
     ORDER BY o.created_at DESC
     LIMIT $2 OFFSET $3`,
    [fieldId, limit, offset]
  );
  return result.rows;
}

/**
 * Get observations for a specific ISO week and year.
 * Includes observations stored directly on the field OR on any plot belonging to the field.
 */
export async function getWeekObservations(fieldId, weekNumber, year) {
  const result = await pool.query(
    `SELECT o.*, u.name AS user_name, p.name AS plot_name
     FROM agro_observations o
     LEFT JOIN users u ON o.user_id = u.id
     LEFT JOIN plots p ON o.plot_id = p.id
     WHERE (o.field_id = $1 OR (o.plot_id IS NOT NULL AND p.field_id = $1))
       AND EXTRACT(ISOYEAR FROM o.created_at) = $2
       AND EXTRACT(WEEK FROM o.created_at) = $3
     ORDER BY o.created_at ASC`,
    [fieldId, year, weekNumber]
  );
  return result.rows;
}

/**
 * Get observations from current ISO week.
 */
export async function getCurrentWeekObservations(fieldId) {
  const now = getNowArgentina();
  const { weekNumber, year } = getWeekNumber(now);
  return getWeekObservations(fieldId, weekNumber, year);
}

/**
 * Get observations for a specific plot in a given ISO week and year.
 * Strict plot_id filter — does NOT include field-level observations.
 */
export async function getWeekObservationsByPlot(plotId, weekNumber, year) {
  const result = await pool.query(
    `SELECT o.*, u.name AS user_name, p.name AS plot_name
     FROM agro_observations o
     LEFT JOIN users u ON o.user_id = u.id
     LEFT JOIN plots p ON o.plot_id = p.id
     WHERE o.plot_id = $1
       AND EXTRACT(ISOYEAR FROM o.created_at) = $2
       AND EXTRACT(WEEK FROM o.created_at) = $3
     ORDER BY o.created_at ASC`,
    [plotId, year, weekNumber]
  );
  return result.rows;
}

/**
 * Get observations from current ISO week for a specific plot.
 */
export async function getCurrentWeekObservationsByPlot(plotId) {
  const now = getNowArgentina();
  const { weekNumber, year } = getWeekNumber(now);
  return getWeekObservationsByPlot(plotId, weekNumber, year);
}

/**
 * Get observations for a field within a date range.
 * Uses observation_date (falls back to created_at via COALESCE).
 */
export async function getObservationsByDateRange(fieldId, desde, hasta) {
  const result = await pool.query(
    `SELECT o.*, u.name AS user_name, p.name AS plot_name
     FROM agro_observations o
     LEFT JOIN users u ON o.user_id = u.id
     LEFT JOIN plots p ON o.plot_id = p.id
     WHERE (o.field_id = $1 OR (o.plot_id IS NOT NULL AND p.field_id = $1))
       AND COALESCE(o.observation_date, o.created_at::date) >= $2::date
       AND COALESCE(o.observation_date, o.created_at::date) <= $3::date
     ORDER BY COALESCE(o.observation_date, o.created_at::date) ASC, o.created_at ASC`,
    [fieldId, desde, hasta]
  );
  return result.rows;
}

/**
 * Get observations for a specific plot within a date range.
 */
export async function getObservationsByDateRangeAndPlot(plotId, desde, hasta) {
  const result = await pool.query(
    `SELECT o.*, u.name AS user_name, p.name AS plot_name
     FROM agro_observations o
     LEFT JOIN users u ON o.user_id = u.id
     LEFT JOIN plots p ON o.plot_id = p.id
     WHERE o.plot_id = $1
       AND COALESCE(o.observation_date, o.created_at::date) >= $2::date
       AND COALESCE(o.observation_date, o.created_at::date) <= $3::date
     ORDER BY COALESCE(o.observation_date, o.created_at::date) ASC, o.created_at ASC`,
    [plotId, desde, hasta]
  );
  return result.rows;
}

/**
 * Get observation count for a field in the current week.
 * Includes observations on the field itself and on any plot belonging to the field.
 */
export async function getWeekObservationCount(fieldId) {
  const now = getNowArgentina();
  const { weekNumber, year } = getWeekNumber(now);
  const result = await pool.query(
    `SELECT COUNT(*) AS total FROM agro_observations o
     LEFT JOIN plots p ON o.plot_id = p.id
     WHERE (o.field_id = $1 OR (o.plot_id IS NOT NULL AND p.field_id = $1))
       AND EXTRACT(ISOYEAR FROM o.created_at) = $2
       AND EXTRACT(WEEK FROM o.created_at) = $3`,
    [fieldId, year, weekNumber]
  );
  return parseInt(result.rows[0].total);
}

/**
 * Get current date in Argentina timezone (UTC-3).
 * Avoids wrong-day issues when server runs in UTC.
 */
export function getNowArgentina() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })
  );
}

/**
 * Calculate ISO week number and year from a date.
 */
export function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { weekNumber, year: d.getUTCFullYear() };
}
