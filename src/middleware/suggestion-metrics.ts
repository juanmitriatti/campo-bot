// Métricas de las sugerencias post-acción ("¿Y ahora?"). Fire-and-forget:
// nunca bloquean ni rompen una respuesta. Sin esto la funcionalidad era
// invisible (0 filas en 3 meses de logs de prod) y cualquier rediseño era
// opinión contra opinión.
import { pool } from '../config/db.js';

export type SuggestionEvent = 'shown' | 'tap';

export function recordSuggestionEvent(input: {
  userId: number | string;
  channel?: string | null;
  event: SuggestionEvent;
  suggestionKey?: string | null;
  buttonId?: string | null;
}): void {
  pool.query(
    `INSERT INTO suggestion_events (user_id, channel, event, suggestion_key, button_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [Number(input.userId), input.channel ?? null, input.event, input.suggestionKey ?? null, input.buttonId ?? null],
  ).catch(err => {
    console.warn('[SUGGEST] no pude registrar el evento (sigo igual):', (err as Error).message);
  });
}

/** Sugerencias mostradas hoy (AR) a un usuario — para el tope diario. */
export async function countShownToday(userId: number | string): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM suggestion_events
        WHERE user_id = $1 AND event = 'shown'
          AND created_at >= (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`,
      [Number(userId)],
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0; // fail-open: sin métrica no se castiga al usuario
  }
}
