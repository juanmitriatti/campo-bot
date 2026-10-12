/**
 * campaign-money.ts — qué plata pertenece a qué campaña. Fuente ÚNICA para el
 * chat (`campaign_stats`, ranking) y el dashboard (Resumen, margen por cultivo).
 *
 * Antes una campaña era "los gastos/ingresos del lote entre la siembra y el
 * cierre". Eso dejaba afuera (análisis de cosecha, 12 oct 2026):
 *   · el barbecho y los insumos comprados ANTES de sembrar → margen inflado;
 *   · el grano guardado y vendido DESPUÉS de cerrar → la soja del silobolsa
 *     aparecía "a pérdida";
 *   · todo lo cargado a nivel campo (arrendamiento, estructura).
 *
 * Reglas (convención agronómica: lo que se gasta en el lote después de que se
 * levantó un cultivo es del cultivo SIGUIENTE):
 *   1. Gasto en un lote → la campaña del lote cuya ventana lo contiene:
 *      desde el día siguiente al fin de cosecha de la campaña ANTERIOR (sin
 *      anterior: 180 días antes de sembrar) hasta su propio fin de cosecha
 *      (abierta si no cosechó). Lo gastado entre una cosecha y la siembra
 *      siguiente queda "para la próxima campaña" hasta que se siembre.
 *   2. Gastos de cosecha y comercialización (`POST_HARVEST_CATEGORIES`: flete,
 *      secada, comisión…) → la campaña sembrada más reciente del lote, aunque
 *      lleguen después de cosechar: son de ese grano, no del barbecho siguiente.
 *   3. Ingreso de grano (producto/categoría = un cultivo) en un lote → la
 *      campaña más reciente de ESE cultivo en el lote, sin límite de fecha: el
 *      grano guardado se vende cuando conviene. Otros ingresos del lote, por
 *      ventana como los gastos.
 *   4. Gasto o ingreso a nivel CAMPO → se reparte entre las campañas de ese
 *      campo cuya ventana lo contiene, por hectárea.
 *   5. Venta de grano sin lote → se reparte entre las campañas de ese cultivo
 *      de la última cosecha anterior a la venta (en su campo, o en todos si no
 *      tiene campo), por kilos cosechados (o hectáreas si no hay rinde).
 *   6. "Hacienda" nunca se reparte (tiene su propia economía); en un lote se
 *      atribuye y el consumidor la muestra aparte.
 * Lo que no cae en ninguna regla (plata sin ubicación que no es grano, gasto
 * después de cosechar sin campaña siguiente) queda SIN campaña — los reportes
 * por campaña no lo inventan.
 *
 * Una fila puede repartirse: cada (fila, campaña) lleva `share` (∑ = 1).
 */
import { accessibleFieldsSql } from '../shared/accessible-fields.js';

/**
 * Categorías de cosecha y comercialización: van con el grano que se cosechó,
 * no con el barbecho de la campaña siguiente. Comparación sin acentos.
 */
export const POST_HARVEST_CATEGORIES: readonly string[] = [
  'cosecha', 'flete', 'fletes', 'flete corto', 'flete largo',
  'comercializacion', 'gastos comerciales', 'comision', 'comisiones', 'corretaje',
  'secada', 'secado', 'zarandeo', 'paritaria', 'acondicionamiento',
  'almacenaje', 'silobolsa', 'silo bolsa', 'embolsado', 'extraccion',
];

/** Días antes de la siembra que se miran cuando la campaña no tiene anterior. */
export const FIRST_CAMPAIGN_LOOKBACK_DAYS = 180;

/** Texto sin acentos, minúsculas y sin espacios en los bordes (SQL). */
export function foldSql(expr: string): string {
  return `translate(lower(trim(COALESCE(${expr}, ''))), 'áéíóúüñ', 'aeiouun')`;
}

const postHarvestList = POST_HARVEST_CATEGORIES.map(c => `'${c}'`).join(', ');
const isPostHarvest = (cat: string) => `(${foldSql(cat)} IN (${postHarvestList}))`;
const isHacienda = (cat: string) => `(${foldSql(cat)} = 'hacienda')`;
/** Cultivo que nombra un ingreso: el producto si lo tiene, si no la categoría. */
const incomeCropKey = (t: string) => foldSql(`${t}.product`);

/**
 * Texto de las CTEs `campaigns` y `campaign_money`. `userParam` es el
 * placeholder ($n) del usuario: las campañas son las de sus campos
 * accesibles (dueño o miembro) y la plata sin ubicación, la suya.
 *
 * `campaigns`: id, plot_id, field_id, crop, crop_key, season_year,
 *   season_type, crop_order, start_date, harvest_end, end_date, ha, kg,
 *   cost_from, cost_to (NULL = abierta), next_start.
 * `campaign_money`: kind ('expense'|'income'), row_id, plot_crop_id, share,
 *   amount (ya multiplicado por share), currency, money_date, category,
 *   product, rule (qué regla lo atribuyó — para depurar).
 */
export function campaignMoneyCtes(userParam: string): string {
  const userIdx = Number(userParam.replace('$', ''));
  const accessible = accessibleFieldsSql(userIdx);
  // La plata de un campo accesible (de cualquier autor) o la propia sin ubicación.
  const moneyAccess = (t: string) => `(
       COALESCE(${t}.field_id, (SELECT field_id FROM plots WHERE id = ${t}.plot_id)) IN (${accessible})
       OR (${t}.user_id = ${userParam} AND ${t}.field_id IS NULL AND ${t}.plot_id IS NULL))`;

  // Ventana de costos de una campaña (reglas 1 y 2).
  const inCostWindow = (cat: string, date: string, c: string) => `(
       (${isPostHarvest(cat)} AND ${date} >= ${c}.start_date
          AND (${c}.next_start IS NULL OR ${date} < ${c}.next_start))
    OR (NOT ${isPostHarvest(cat)} AND ${date} >= ${c}.cost_from
          AND (${c}.cost_to IS NULL OR ${date} <= ${c}.cost_to)))`;

  return `campaigns_base AS (
    SELECT pc.id, pc.plot_id, pl.field_id, pc.crop, ${foldSql('pc.crop')} AS crop_key,
           pc.season_year, pc.season_type, pc.crop_order, pc.start_date,
           COALESCE(pc.harvest_ended_at::date, pc.harvested_at::date) AS harvest_end,
           pc.end_date,
           COALESCE(pc.sowed_hectares, pl.area_hectares, 0)::numeric AS ha,
           COALESCE(pc.yield_kg, 0)::numeric AS kg,
           LAG(COALESCE(pc.harvest_ended_at::date, pc.harvested_at::date, pc.end_date))
             OVER (PARTITION BY pc.plot_id ORDER BY pc.start_date, pc.id) AS prev_end,
           LEAD(pc.start_date) OVER (PARTITION BY pc.plot_id ORDER BY pc.start_date, pc.id) AS next_start
      FROM plot_crops pc
      JOIN plots pl ON pl.id = pc.plot_id AND pl.deleted_at IS NULL
     WHERE pl.field_id IN (${accessible})
  ),
  campaigns AS (
    SELECT b.*,
           LEAST(COALESCE(b.prev_end + 1, b.start_date - ${FIRST_CAMPAIGN_LOOKBACK_DAYS}), b.start_date) AS cost_from,
           COALESCE(b.harvest_end, b.end_date, b.next_start - 1) AS cost_to
      FROM campaigns_base b
  ),
  cm_exp_plot AS (
    SELECT DISTINCT ON (e.id) e.id AS row_id, c.id AS plot_crop_id, 1.0::numeric AS share,
           CASE WHEN ${isPostHarvest('e.category')} THEN 'post_harvest' ELSE 'window' END AS rule
      FROM expenses e
      JOIN campaigns c ON c.plot_id = e.plot_id
     WHERE e.deleted_at IS NULL AND e.plot_id IS NOT NULL
       AND ${inCostWindow('e.category', 'e.expense_date', 'c')}
     ORDER BY e.id, c.start_date DESC, c.id DESC
  ),
  cm_exp_field AS (
    SELECT x.row_id, x.plot_crop_id,
           CASE WHEN SUM(x.ha) OVER (PARTITION BY x.row_id) > 0
                THEN x.ha / SUM(x.ha) OVER (PARTITION BY x.row_id)
                ELSE 1.0 / COUNT(*) OVER (PARTITION BY x.row_id) END AS share,
           'field_prorate' AS rule
      FROM (
        SELECT DISTINCT ON (e.id, c.plot_id) e.id AS row_id, c.id AS plot_crop_id, c.ha
          FROM expenses e
          JOIN campaigns c ON c.field_id = e.field_id
         WHERE e.deleted_at IS NULL AND e.plot_id IS NULL AND e.field_id IS NOT NULL
           AND NOT ${isHacienda('e.category')}
           AND ${inCostWindow('e.category', 'e.expense_date', 'c')}
         ORDER BY e.id, c.plot_id, c.start_date DESC, c.id DESC
      ) x
  ),
  cm_inc_plot AS (
    SELECT DISTINCT ON (i.id) i.id AS row_id, c.id AS plot_crop_id, 1.0::numeric AS share,
           CASE WHEN c.crop_key = ${incomeCropKey('i')} OR c.crop_key = ${foldSql('i.category')}
                THEN 'crop_sale' ELSE 'window' END AS rule
      FROM incomes i
      JOIN campaigns c ON c.plot_id = i.plot_id
     WHERE i.deleted_at IS NULL AND i.plot_id IS NOT NULL
       AND (
         ((c.crop_key = ${incomeCropKey('i')} OR c.crop_key = ${foldSql('i.category')})
           AND i.income_date >= c.start_date)
         OR ${inCostWindow('i.category', 'i.income_date', 'c')}
       )
     ORDER BY i.id,
              (c.crop_key = ${incomeCropKey('i')} OR c.crop_key = ${foldSql('i.category')}) DESC,
              c.start_date DESC, c.id DESC
  ),
  -- Venta de grano sin lote: la última cosecha del cultivo anterior a la venta.
  cm_inc_grain_cands AS (
    SELECT i.id AS row_id, c.id AS plot_crop_id, c.kg, c.ha, c.season_year,
           MAX(c.season_year) OVER (PARTITION BY i.id) AS last_season
      FROM incomes i
      JOIN campaigns c
        ON (c.crop_key = ${incomeCropKey('i')} OR c.crop_key = ${foldSql('i.category')})
       AND c.start_date <= i.income_date
       AND (i.field_id IS NULL OR c.field_id = i.field_id)
     WHERE i.deleted_at IS NULL AND i.plot_id IS NULL
       AND ${moneyAccess('i')}
       AND NOT ${isHacienda('i.category')}
  ),
  cm_inc_grain AS (
    SELECT x.row_id, x.plot_crop_id,
           CASE WHEN SUM(x.kg) OVER (PARTITION BY x.row_id) > 0
                  THEN x.kg / SUM(x.kg) OVER (PARTITION BY x.row_id)
                WHEN SUM(x.ha) OVER (PARTITION BY x.row_id) > 0
                  THEN x.ha / SUM(x.ha) OVER (PARTITION BY x.row_id)
                ELSE 1.0 / COUNT(*) OVER (PARTITION BY x.row_id) END AS share,
           'grain_prorate' AS rule
      FROM cm_inc_grain_cands x
     WHERE x.season_year = x.last_season
  ),
  -- Ingreso de campo que NO es grano: por ventana y hectárea, como los gastos.
  cm_inc_field AS (
    SELECT x.row_id, x.plot_crop_id,
           CASE WHEN SUM(x.ha) OVER (PARTITION BY x.row_id) > 0
                THEN x.ha / SUM(x.ha) OVER (PARTITION BY x.row_id)
                ELSE 1.0 / COUNT(*) OVER (PARTITION BY x.row_id) END AS share,
           'field_prorate' AS rule
      FROM (
        SELECT DISTINCT ON (i.id, c.plot_id) i.id AS row_id, c.id AS plot_crop_id, c.ha
          FROM incomes i
          JOIN campaigns c ON c.field_id = i.field_id
         WHERE i.deleted_at IS NULL AND i.plot_id IS NULL AND i.field_id IS NOT NULL
           AND NOT ${isHacienda('i.category')}
           AND NOT EXISTS (SELECT 1 FROM cm_inc_grain_cands g WHERE g.row_id = i.id)
           AND ${inCostWindow('i.category', 'i.income_date', 'c')}
         ORDER BY i.id, c.plot_id, c.start_date DESC, c.id DESC
      ) x
  ),
  campaign_money AS (
    SELECT 'expense'::text AS kind, a.row_id, a.plot_crop_id, a.share,
           (e.amount * a.share)::numeric AS amount, COALESCE(e.currency, 'ARS') AS currency,
           e.expense_date AS money_date, e.category, e.product, a.rule
      FROM (SELECT * FROM cm_exp_plot UNION ALL SELECT * FROM cm_exp_field) a
      JOIN expenses e ON e.id = a.row_id
     WHERE ${moneyAccess('e')}
    UNION ALL
    SELECT 'income'::text, a.row_id, a.plot_crop_id, a.share,
           (i.amount * a.share)::numeric, COALESCE(i.currency, 'ARS'),
           i.income_date, i.category, i.product, a.rule
      FROM (SELECT * FROM cm_inc_plot UNION ALL SELECT * FROM cm_inc_grain UNION ALL SELECT * FROM cm_inc_field) a
      JOIN incomes i ON i.id = a.row_id
     WHERE ${moneyAccess('i')}
  )`;
}
