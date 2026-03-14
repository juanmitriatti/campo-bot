import { pool } from "../config/db.js";

// --- Category detection keywords ---
const CATEGORY_KEYWORDS = {
  malezas: [
    'maleza', 'rama negra', 'yuyo', 'sorgo de alepo', 'cardo', 'gramon',
    'enredadera', 'gramilla', 'cerraja', 'nabón', 'nabon', 'ortiga',
  ],
  sanidad: [
    'oruga', 'plaga', 'chinche', 'isoca', 'trips', 'arañuela', 'aranuela',
    'mosca', 'pulgon', 'pulgón', 'bolillera', 'cogollero', 'bicho',
    'enfermedad', 'hongo', 'roya', 'mancha', 'podredumbre',
  ],
  nutricion: [
    'nutricion', 'nutrición', 'deficiencia', 'clorosis', 'amarillamiento',
    'carencia', 'amarillo', 'necros',
  ],
  fenologia: [
    'estado', 'fenolog', 'floración', 'floracion', 'llenado', 'emergencia',
    'macollaje', 'espigazón', 'espigazon', 'panojamiento',
    'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v12',
    'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8',
  ],
  clima: [
    'helada', 'granizo', 'sequia', 'sequía', 'encharcamiento', 'stress',
    'estrés', 'estres', 'viento', 'inundación', 'inundacion',
  ],
};

/**
 * Auto-detect observation category from text.
 * Returns one of: malezas, sanidad, nutricion, fenologia, clima, general
 */
export function detectObservationCategory(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return category;
    }
  }
  return 'general';
}

/**
 * Save an agronomic observation.
 */
export async function saveObservation(userId, { fieldId, plotId, text, category, source }) {
  const result = await pool.query(
    `INSERT INTO agro_observations (user_id, field_id, plot_id, observation_text, category, source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, fieldId || null, plotId || null, text, category || 'general', source || 'text']
  );
  return result.rows[0];
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
  const now = new Date();
  const { weekNumber, year } = getWeekNumber(now);
  return getWeekObservations(fieldId, weekNumber, year);
}

/**
 * Get observation count for a field in the current week.
 * Includes observations on the field itself and on any plot belonging to the field.
 */
export async function getWeekObservationCount(fieldId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS total FROM agro_observations o
     LEFT JOIN plots p ON o.plot_id = p.id
     WHERE (o.field_id = $1 OR (o.plot_id IS NOT NULL AND p.field_id = $1))
       AND EXTRACT(ISOYEAR FROM o.created_at) = EXTRACT(ISOYEAR FROM NOW())
       AND EXTRACT(WEEK FROM o.created_at) = EXTRACT(WEEK FROM NOW())`,
    [fieldId]
  );
  return parseInt(result.rows[0].total);
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
