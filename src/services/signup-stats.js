import { pool } from "../config/db.js";

// Semana de lunes a domingo en hora argentina.
const WEEK_START = `date_trunc('week', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'`;

/**
 * Altas de esta semana y de la anterior, para el panel de admin. No cuenta
 * administradores, cuentas dadas de baja ni las del test-bot.
 */
export async function getWeeklySignups() {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= ${WEEK_START})::int AS this_week,
       COUNT(*) FILTER (WHERE created_at >= ${WEEK_START} - INTERVAL '7 days'
                          AND created_at < ${WEEK_START})::int AS last_week
       FROM users
      WHERE deleted_at IS NULL
        AND role IS DISTINCT FROM 'admin'
        AND COALESCE(phone_number, '') NOT LIKE 'testbot\_%'`,
  );
  return { thisWeek: rows[0].this_week, lastWeek: rows[0].last_week };
}
