/**
 * corral-capacity.service.ts — advertencia de sobrecapacidad de corrales.
 *
 * `feedlots.capacity` y `corrals.capacity` existen desde la migración 055 y se
 * muestran al usuario, pero NUNCA se validaron contra la ocupación real: un
 * corral de 500 se podía llenar con 900 animales sin que el sistema dijera nada.
 *
 * REGLA DE PRODUCTO: se advierte, NO se bloquea. El productor sabe cosas que el
 * sistema no (encierre temporal, corral que se amplió, animales que salen
 * mañana). Bloquear una operación real porque un número de configuración quedó
 * viejo es peor que no advertir nada — el usuario aprende a pelearse con la
 * herramienta.
 *
 * Un corral SIN capacidad configurada nunca advierte: `NULL` significa "no me
 * dijiste", no "cero".
 */

import { pool } from '../../config/db.js';

export interface CapacityCheck {
  corralId: number;
  corralName: string;
  /** null = sin capacidad configurada → nunca se advierte. */
  capacity: number | null;
  /** Cabezas actualmente en el corral (suma de los grupos vivos). */
  current: number;
  /** Cabezas que agrega esta operación. */
  delta: number;
  /** current + delta. */
  projected: number;
  /** true solo si hay capacidad configurada Y la proyección la supera. */
  exceeds: boolean;
  /** Cuántas cabezas por encima queda. 0 si no excede. */
  overBy: number;
}

export class CorralCapacityService {
  /**
   * Proyecta la ocupación de un corral tras sumarle `delta` cabezas.
   *
   * Devuelve `null` cuando el corral no existe o no es accesible: el llamador
   * está en medio de una operación que ya validó la ubicación, y un chequeo de
   * capacidad jamás debe ser el que la haga fallar.
   */
  async check(userId: number, corralId: number, delta: number): Promise<CapacityCheck | null> {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.capacity,
              COALESCE((
                SELECT SUM(lg.count) FROM livestock_groups lg
                 WHERE lg.corral_id = c.id AND lg.deleted_at IS NULL
              ), 0)::int AS current
         FROM corrals c
         JOIN feedlots f ON c.feedlot_id = f.id
        WHERE c.id = $1 AND c.deleted_at IS NULL AND f.user_id = $2`,
      [corralId, userId],
    );
    if (rows.length === 0) return null;

    const row = rows[0] as { id: number; name: string; capacity: number | null; current: number };
    const capacity = row.capacity == null ? null : Number(row.capacity);
    const current = Number(row.current);
    const projected = current + delta;
    const exceeds = capacity != null && capacity > 0 && projected > capacity;

    return {
      corralId: row.id,
      corralName: row.name,
      capacity,
      current,
      delta,
      projected,
      exceeds,
      overBy: exceeds ? projected - capacity! : 0,
    };
  }

  /**
   * Mensaje de advertencia listo para anexar a la respuesta del handler, o
   * `null` si no hay nada que advertir. El llamador lo agrega DESPUÉS de
   * confirmar la operación — primero se registra lo que pidió el usuario, y
   * recién después se le comenta el problema.
   */
  async warningFor(userId: number, corralId: number, delta: number): Promise<string | null> {
    const check = await this.check(userId, corralId, delta);
    if (!check || !check.exceeds) return null;

    return `⚠️ El corral ${check.corralName} queda con ${check.projected} animales ` +
           `y tiene capacidad configurada para ${check.capacity} (${check.overBy} de más).`;
  }

  /** Corrales del usuario que HOY están por encima de su capacidad. Para "Para revisar" y alertas. */
  async findOvercapacity(userId: number): Promise<Array<{
    corralId: number; corralName: string; feedlotName: string; capacity: number; current: number; overBy: number;
  }>> {
    const { rows } = await pool.query(
      `SELECT c.id AS "corralId", c.name AS "corralName", f.name AS "feedlotName",
              c.capacity, occ.current, (occ.current - c.capacity) AS "overBy"
         FROM corrals c
         JOIN feedlots f ON c.feedlot_id = f.id
         JOIN LATERAL (
           SELECT COALESCE(SUM(lg.count), 0)::int AS current
             FROM livestock_groups lg
            WHERE lg.corral_id = c.id AND lg.deleted_at IS NULL
         ) occ ON TRUE
        WHERE f.user_id = $1
          AND c.deleted_at IS NULL
          AND c.capacity IS NOT NULL
          AND c.capacity > 0
          AND occ.current > c.capacity
        ORDER BY (occ.current - c.capacity) DESC`,
      [userId],
    );
    return rows;
  }
}
