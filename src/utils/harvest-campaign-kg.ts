/**
 * Kilos cosechados POR CAMPAÑA — fuente ÚNICA para el dashboard (Resumen y
 * analytics agronómico).
 *
 * Antes cada pantalla sumaba por EVENTO de cosecha: `quantity` del evento, o
 * la suma de sus camiones, o el rinde de la campaña. Una cosecha de dos días
 * ("rindió 42 qq/ha" el día 1 + tres camiones el día 2) daba dos filas para el
 * mismo lote y el Resumen mostraba rinde declarado + cargas SUMADOS (500 tn
 * cuando el bot había confirmado 420; QA siembra/cosecha 9 sep 2026, P0-2).
 *
 * La unidad correcta es la campaña (`plot_crops`): su `yield_kg` ya es el
 * GREATEST(declarado, Σ cargas netas) que mantiene el handler. Acá se toma el
 * máximo entre eso, las cargas netas y la suma de `quantity` de sus eventos
 * (campañas viejas con evento pero sin `yield_kg`). Los eventos de cosecha SIN
 * campaña (legacy, `plot_crop_id` NULL) entran uno por uno con su `quantity`.
 *
 * Devuelve el texto de una CTE `harvest_campaigns` con columnas:
 *   plot_id, plot_crop_id (NULL en legacy), crop, event_date (primer día de
 *   cosecha en la ventana), kg, ha (sembradas o del lote).
 * Los placeholders se pasan por nombre porque cada query ordena sus params
 * distinto.
 */
export function harvestCampaignsCte(p: { user: string; from: string; to: string; fieldIds: string }): string {
  const kgFactor = (unitExpr: string) => `CASE LOWER(COALESCE(${unitExpr}, 'kg'))
      WHEN 'tn' THEN 1000 WHEN 'tonelada' THEN 1000 WHEN 'toneladas' THEN 1000 WHEN 't' THEN 1000
      WHEN 'qq' THEN 100 WHEN 'quintal' THEN 100 WHEN 'quintales' THEN 100
      ELSE 1 END`;
  return `harvest_campaigns AS (
    SELECT x.plot_id, x.plot_crop_id, x.crop, x.event_date, x.kg, x.ha
      FROM (
        SELECT pc.plot_id,
               pc.id AS plot_crop_id,
               COALESCE(pc.crop, MIN(d.crop)) AS crop,
               MIN(d.event_date) AS event_date,
               GREATEST(
                 COALESCE(pc.yield_kg, 0),
                 COALESCE((SELECT SUM(COALESCE(hl.net_weight_kg, hl.weight_kg))
                             FROM harvest_loads hl
                             JOIN domain_events de ON de.id = hl.domain_event_id AND de.deleted_at IS NULL
                            WHERE hl.plot_crop_id = pc.id), 0),
                 COALESCE(SUM(d.quantity * ${kgFactor('d.unit')}), 0)
               )::numeric AS kg,
               COALESCE(pc.sowed_hectares, pl.area_hectares) AS ha
          FROM plot_crops pc
          JOIN plots pl ON pl.id = pc.plot_id AND pl.deleted_at IS NULL
          JOIN domain_events d ON d.plot_crop_id = pc.id
                              AND d.event_type = 'harvest'
                              AND d.deleted_at IS NULL
         WHERE d.user_id = ${p.user}
           AND d.event_date BETWEEN ${p.from}::date AND ${p.to}::date
           AND pl.field_id = ANY(${p.fieldIds}::int[])
         GROUP BY pc.id, pc.plot_id, pc.crop, pc.yield_kg, pc.sowed_hectares, pl.area_hectares
        UNION ALL
        SELECT d.plot_id,
               NULL::int AS plot_crop_id,
               d.crop,
               d.event_date,
               (d.quantity * ${kgFactor('d.unit')})::numeric AS kg,
               pl.area_hectares AS ha
          FROM domain_events d
          JOIN plots pl ON pl.id = d.plot_id AND pl.deleted_at IS NULL
         WHERE d.user_id = ${p.user}
           AND d.plot_crop_id IS NULL
           AND d.event_type = 'harvest'
           AND d.deleted_at IS NULL
           AND d.quantity IS NOT NULL
           AND d.event_date BETWEEN ${p.from}::date AND ${p.to}::date
           AND pl.field_id = ANY(${p.fieldIds}::int[])
      ) x
     WHERE x.kg > 0
  )`;
}
