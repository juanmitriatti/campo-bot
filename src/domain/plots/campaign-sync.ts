/**
 * Fechas de una campaña (plot_crops) a partir de sus eventos — fuente ÚNICA
 * para después de editar una siembra o una cosecha, desde el chat o el dashboard.
 *
 * Antes corregir la fecha de una siembra ("la siembra fue el 25/09") o de una
 * cosecha cambiaba el domain_event y dejaba la campaña con la fecha vieja: el
 * start_date, la campaña (año/tipo) y harvested_at seguían diciendo otra cosa
 * (AGR-15 / DSH-6, auditoría oct 2026).
 *
 *   start_date               = el primer día de siembra; la campaña sale de ahí.
 *   harvested_at / _ended_at = primer y último día de cosecha (si está cosechada).
 */
import { pool } from '../../config/db.js';
import { getSeasonTypeForCrop, getSeasonYear } from './crop.service.js';

export async function syncCampaignDatesFromEvents(plotCropId: number | null | undefined): Promise<void> {
  if (!plotCropId) return;
  const { rows } = await pool.query(
    `SELECT pc.crop,
            (SELECT MIN(event_date)::text FROM domain_events
              WHERE plot_crop_id = pc.id AND event_type = 'planting' AND deleted_at IS NULL) AS first_sow,
            (SELECT MIN(event_date)::text FROM domain_events
              WHERE plot_crop_id = pc.id AND event_type = 'harvest' AND deleted_at IS NULL) AS first_harvest,
            (SELECT MAX(event_date)::text FROM domain_events
              WHERE plot_crop_id = pc.id AND event_type = 'harvest' AND deleted_at IS NULL) AS last_harvest
       FROM plot_crops pc WHERE pc.id = $1`,
    [plotCropId],
  );
  const r = rows[0] as { crop: string; first_sow: string | null; first_harvest: string | null; last_harvest: string | null } | undefined;
  if (!r) return;

  if (r.first_sow) {
    const [y, m, d] = r.first_sow.split('-').map(Number);
    const seasonType = getSeasonTypeForCrop(r.crop);
    const seasonYear = getSeasonYear(new Date(y, m - 1, d, 12), seasonType);
    await pool.query(
      `UPDATE plot_crops SET start_date = $2, season_year = $3, season_type = $4 WHERE id = $1`,
      [plotCropId, r.first_sow, seasonYear, seasonType],
    );
  }
  if (r.first_harvest) {
    await pool.query(
      `UPDATE plot_crops SET harvested_at = $2, harvest_ended_at = $3
        WHERE id = $1 AND harvested_at IS NOT NULL`,
      [plotCropId, r.first_harvest, r.last_harvest],
    );
  }
}
