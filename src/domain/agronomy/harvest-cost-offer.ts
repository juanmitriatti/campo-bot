/**
 * Botones para cargar el costo de cosechar (contratista + flete) como gastos
 * del lote. Solo con producción registrada, fuera de bulkMode y con el setting
 * encendido. La respuesta al tap entra por el interactive router como
 * log_harvest_costs sin montos → pending machine-readable (invariante 5).
 *
 * Vive fuera del handler porque también lo necesita el pipeline: cuando la
 * cosecha trae cantidad, la confirmación ofrece PRIMERO cargar el grano al
 * stock (una sola botonera por respuesta) y el costo se ofrece recién después
 * del tap de stock. Antes se perdía en ese caso — el más común, "sacamos 130
 * tn" (P2-12, QA siembra/cosecha 9 sep 2026).
 */
import type { HandlerResponse, UserId } from '../../types/index.js';
import { logError } from '../../services/error-logger.js';

export async function buildHarvestCostOffer(
  userId: UserId,
  plotCropId: number | null | undefined,
  plotLabel: string,
  opts: { bulkMode?: boolean } = {},
): Promise<Pick<HandlerResponse, 'interactive'> | null> {
  if (!plotCropId || opts.bulkMode) return null;
  try {
    const { getSettingBool } = await import('../../services/settings.service.js');
    if ((await getSettingBool('HARVEST_COST_OFFER_ENABLED')) === false) return null;
    const { pool } = await import('../../config/db.js');
    const { rows } = await pool.query(
      `SELECT yield_kg,
              (SELECT COUNT(*) FROM expenses e WHERE e.plot_id = pc.plot_id AND e.deleted_at IS NULL
                  AND LOWER(e.category) IN ('cosecha', 'flete')
                  AND e.expense_date >= pc.start_date) AS cost_rows
         FROM plot_crops pc WHERE id = $1`,
      [plotCropId],
    );
    const pc = rows[0];
    if (!pc || !(Number(pc.yield_kg) > 0) || Number(pc.cost_rows) > 0) return null;
    const body = `💵 ¿Cargo el costo de cosechar *${plotLabel}*? Contratista (% del rinde o $/ha) y flete ($/tn) quedan como gastos de la campaña.`;
    return {
      interactive: {
        type: 'buttons',
        body,
        buttons: [
          { id: `harvest_cost_yes_${plotCropId}`, title: '💵 Cargar costo' },
          // cancel_action lo atiende el pipeline directamente (no pasa por el router)
          { id: 'cancel_action', title: 'Ahora no' },
        ],
      },
    };
  } catch (err) {
    logError('agronomy', 'HARVEST_COST_OFFER', err as Error, { userId, context: { plotCropId } });
    return null;
  }
}
