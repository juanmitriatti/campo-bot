/**
 * "Para revisar" — things the bot probably got wrong.
 *
 * The point of this screen: everything in campo-bot is dictated to a chat and
 * parsed by an LLM, so the failure mode is not a missing record but a record
 * that looks fine and is wrong. These rules are deterministic reads over what
 * was saved; they never mutate anything and never guess an intent — each one
 * either fires on a checkable contradiction or stays quiet.
 *
 * Adding a rule: append to RULES. Every finding carries a `ref` so the UI can
 * point at the offending row, and a `severity` — `warn` for "this is almost
 * certainly wrong", `info` for "worth a look".
 */
import { pool } from '../config/db.js';
import { normalizeEntityName } from '../utils/entity-matcher.js';
import { isFieldLevelCategory } from '../utils/field-level-categories.js';
import { formatDayMonth } from './overview.service.js';
import type { CampaignRange } from '../utils/campaign-range.js';

export type Severity = 'warn' | 'info';

export interface Finding {
  /** Stable per-user key so the UI can remember dismissals. */
  key: string;
  rule: string;
  severity: Severity;
  title: string;
  body: string;
  action: string;
  /** What to open when the user acts on it. */
  ref: { type: 'activity' | 'expense' | 'plot' | 'field'; id: number } | null;
  fieldId: number | null;
}

interface Ctx {
  userId: number;
  fieldIds: number[];
  range: CampaignRange;
}

type Rule = (ctx: Ctx) => Promise<Finding[]>;

const fmtNum = (n: number) => new Intl.NumberFormat('es-AR').format(Math.round(n));

/**
 * 1. A plot name ended up in the `product` column.
 *
 * Real case: "fertilicé el lote norte con trigo" saved product = "lote norte".
 * Matching goes through entity-matcher so it agrees with how every other lookup
 * in the app normalizes names (invariante 3).
 */
const productIsPlotName: Rule = async ({ userId, fieldIds, range }) => {
  const { rows: plots } = await pool.query(
    `SELECT pl.id, pl.name FROM plots pl
       JOIN fields f ON f.id = pl.field_id
      WHERE f.id = ANY($1::int[]) AND pl.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [fieldIds],
  );
  if (!plots.length) return [];

  const byName = new Map<string, string>();
  for (const p of plots) {
    const n = normalizeEntityName(String(p.name));
    if (n) byName.set(n, String(p.name));
    // "lote norte" written out in full still points at plot "Norte".
    byName.set(normalizeEntityName('lote ' + String(p.name)), String(p.name));
  }

  const { rows } = await pool.query(
    `SELECT d.id, d.product, d.event_type, d.event_date::text AS event_date, d.crop
       FROM domain_events d
       LEFT JOIN plots pl ON pl.id = d.plot_id
      WHERE d.user_id = $1 AND d.deleted_at IS NULL
        AND d.product IS NOT NULL AND TRIM(d.product) <> ''
        AND d.event_date BETWEEN $2::date AND $3::date
        AND (d.plot_id IS NULL OR pl.field_id = ANY($4::int[]))`,
    [userId, range.from, range.to, fieldIds],
  );

  const out: Finding[] = [];
  for (const r of rows) {
    const hit = byName.get(normalizeEntityName(String(r.product)));
    if (!hit) continue;
    out.push({
      key: `product-plot-${r.id}`,
      rule: 'product_is_plot_name',
      severity: 'warn',
      title: 'Un nombre de lote quedó guardado como producto',
      body: `La ${labelFor(r.event_type)} del ${formatDayMonth(r.event_date)} tiene «${r.product}» en el campo producto, y «${hit}» es uno de tus lotes. Lo más probable es que el bot haya leído el lote como si fuera el insumo aplicado.`,
      action: 'Corregir el registro',
      ref: { type: 'activity', id: Number(r.id) },
      fieldId: null,
    });
  }
  return out;
};

/**
 * 2. Several different crops sown on the same plot within a few weeks.
 * A plot carries one crop at a time; two sowings close together mean one of
 * them landed on the wrong plot.
 */
const overlappingPlantings: Rule = async ({ userId, fieldIds, range }) => {
  const { rows } = await pool.query(
    `SELECT d.plot_id, pl.name AS plot_name, f.id AS field_id, f.name AS field_name,
            array_agg(DISTINCT LOWER(d.crop)) AS crops,
            MIN(d.event_date)::text AS first_date,
            MAX(d.event_date)::text AS last_date,
            COUNT(*)::int AS n
       FROM domain_events d
       JOIN plots pl ON pl.id = d.plot_id
       JOIN fields f ON f.id = pl.field_id
      WHERE d.user_id = $1 AND d.deleted_at IS NULL
        AND d.event_type = 'planting' AND d.crop IS NOT NULL
        AND d.event_date BETWEEN $2::date AND $3::date
        AND pl.field_id = ANY($4::int[])
      GROUP BY d.plot_id, pl.name, f.id, f.name
     HAVING COUNT(DISTINCT LOWER(d.crop)) > 1
        AND MAX(d.event_date) - MIN(d.event_date) <= 45`,
    [userId, range.from, range.to, fieldIds],
  );

  return rows.map((r: Record<string, unknown>) => {
    const crops = (r.crops as string[]).filter(Boolean);
    const span = daysBetween(String(r.first_date), String(r.last_date));
    return {
      key: `overlap-${r.plot_id}`,
      rule: 'overlapping_plantings',
      severity: 'warn' as Severity,
      title: `${crops.length} cultivos sembrados en el mismo lote en ${span} día${span === 1 ? '' : 's'}`,
      body: `«${r.plot_name}» figura sembrado con ${listEs(crops)} entre el ${formatDayMonth(String(r.first_date))} y el ${formatDayMonth(String(r.last_date))}. Un lote lleva un cultivo por vez, así que alguna de esas siembras probablemente iba a otro lote.`,
      action: `Revisar ${r.plot_name}`,
      ref: { type: 'plot' as const, id: Number(r.plot_id) },
      fieldId: Number(r.field_id),
    };
  });
};

/**
 * 3. A harvest dated on or before its own sowing, on the same plot and crop.
 *
 * "Its own sowing" is the nearest planting of that crop on that plot. The rule
 * fires only when NO planting of the crop precedes the harvest and one follows
 * it: that is the only shape that is actually impossible. The earlier version
 * matched ANY later planting, so soja harvested in April and soja re-sown in
 * November on the same lote — an ordinary rotation — was reported as an error.
 */
const harvestBeforePlanting: Rule = async ({ userId, fieldIds, range }) => {
  const { rows } = await pool.query(
    `SELECT h.id, h.event_date::text AS harvest_date, h.crop,
            pl.id AS plot_id, pl.name AS plot_name, f.id AS field_id,
            (SELECT MIN(s.event_date)::text FROM domain_events s
              WHERE s.plot_id = h.plot_id AND s.user_id = h.user_id
                AND s.event_type = 'planting' AND s.deleted_at IS NULL
                AND LOWER(COALESCE(s.crop, '')) = LOWER(COALESCE(h.crop, ''))
                AND s.event_date >= h.event_date) AS sow_date
       FROM domain_events h
       JOIN plots pl ON pl.id = h.plot_id
       JOIN fields f ON f.id = pl.field_id
      WHERE h.user_id = $1 AND h.deleted_at IS NULL
        AND h.event_type = 'harvest'
        AND h.event_date BETWEEN $2::date AND $3::date
        AND pl.field_id = ANY($4::int[])
        AND NOT EXISTS (
          SELECT 1 FROM domain_events b
           WHERE b.plot_id = h.plot_id AND b.user_id = h.user_id
             AND b.event_type = 'planting' AND b.deleted_at IS NULL
             AND LOWER(COALESCE(b.crop, '')) = LOWER(COALESCE(h.crop, ''))
             AND b.event_date < h.event_date
        )
        AND EXISTS (
          SELECT 1 FROM domain_events s
           WHERE s.plot_id = h.plot_id AND s.user_id = h.user_id
             AND s.event_type = 'planting' AND s.deleted_at IS NULL
             AND LOWER(COALESCE(s.crop, '')) = LOWER(COALESCE(h.crop, ''))
             AND s.event_date >= h.event_date
        )`,
    [userId, range.from, range.to, fieldIds],
  );

  return rows.map((r: Record<string, unknown>) => ({
    key: `harvest-before-${r.id}`,
    rule: 'harvest_before_planting',
    severity: 'warn' as Severity,
    title: 'Una cosecha quedó antes que su propia siembra',
    body: `En «${r.plot_name}» el ${r.crop ?? 'cultivo'} figura cosechado el ${formatDayMonth(String(r.harvest_date))} y sembrado el ${formatDayMonth(String(r.sow_date))}. Alguna de las dos fechas está mal, o son lotes distintos.`,
    action: 'Corregir la fecha',
    ref: { type: 'activity' as const, id: Number(r.id) },
    fieldId: Number(r.field_id),
  }));
};

/**
 * 4. A plot whose declared area dwarfs every other one.
 * Uses the median so a single outlier can't hide behind its own effect on a mean.
 */
const outlierPlotArea: Rule = async ({ fieldIds }) => {
  const { rows } = await pool.query(
    `SELECT pl.id, pl.name, pl.area_hectares::numeric AS ha, f.id AS field_id
       FROM plots pl
       JOIN fields f ON f.id = pl.field_id
      WHERE f.id = ANY($1::int[]) AND pl.deleted_at IS NULL AND f.deleted_at IS NULL
        AND pl.area_hectares IS NOT NULL AND pl.area_hectares > 0`,
    [fieldIds],
  );
  if (rows.length < 3) return [];

  const areas = rows.map((r: { ha: string }) => Number(r.ha)).sort((a: number, b: number) => a - b);
  const median = areas[Math.floor(areas.length / 2)];
  if (!median) return [];

  return rows
    .filter((r: { ha: string }) => Number(r.ha) >= median * 10)
    .map((r: Record<string, unknown>) => {
      const ha = Number(r.ha);
      const times = Math.round(ha / median);
      const others = areas.filter((a: number) => a < median * 10);
      const lo = others.length ? others[0] : median;
      const hi = others.length ? others[others.length - 1] : median;
      return {
        key: `area-outlier-${r.id}`,
        rule: 'outlier_plot_area',
        severity: 'info' as Severity,
        title: `«${r.name}» declara ${fmtNum(ha)} ha`,
        body: `Es ${fmtNum(times)} veces la mediana de tus otros lotes, que van de ${fmtNum(lo)} a ${fmtNum(hi)} ha. Mientras siga así, cualquier número por hectárea de este lote sale distorsionado.`,
        action: 'Editar superficie',
        ref: { type: 'plot' as const, id: Number(r.id) },
        fieldId: Number(r.field_id),
      };
    });
};

/**
 * 5. Expenses stuck at field level in a field that HAS plots.
 *
 * Deliberately excludes the corporate-overhead categories the expense handler
 * strips on purpose — flagging those would mean reporting our own rule as a bug.
 */
const expensesWithoutPlot: Rule = async ({ userId, fieldIds, range }) => {
  const { rows } = await pool.query(
    `SELECT e.id, e.amount::numeric AS amount, COALESCE(e.currency, 'ARS') AS currency,
            COALESCE(e.category, 'Sin categoría') AS category,
            e.expense_date::text AS expense_date,
            f.id AS field_id, f.name AS field_name,
            (SELECT COUNT(*) FROM plots p2 WHERE p2.field_id = f.id AND p2.deleted_at IS NULL)::int AS plot_count
       FROM expenses e
       JOIN fields f ON f.id = e.field_id
      WHERE e.user_id = $1 AND e.deleted_at IS NULL
        AND e.plot_id IS NULL
        AND e.expense_date BETWEEN $2::date AND $3::date
        AND f.id = ANY($4::int[])
      ORDER BY e.amount DESC`,
    [userId, range.from, range.to, fieldIds],
  );

  const candidates = rows.filter(
    (r: Record<string, unknown>) => Number(r.plot_count) >= 2 && !isFieldLevelCategory(String(r.category)),
  );
  if (!candidates.length) return [];

  const total = candidates.reduce((s: number, r: Record<string, unknown>) => s + Number(r.amount), 0);
  const first = candidates[0];
  const money = (n: number, cur: string) =>
    (cur === 'USD' ? 'USD ' : '$') + fmtNum(n);

  if (candidates.length === 1) {
    return [{
      key: `no-plot-${first.id}`,
      rule: 'expense_without_plot',
      severity: 'info',
      title: `Un gasto de ${money(Number(first.amount), String(first.currency))} quedó sin lote`,
      body: `${first.category}, cargado a nivel campo en «${first.field_name}» el ${formatDayMonth(String(first.expense_date))}. Queda afuera del gasto por lote, así que ese lote va a parecer más barato de lo que fue.`,
      action: 'Asignar lote',
      ref: { type: 'expense', id: Number(first.id) },
      fieldId: Number(first.field_id),
    }];
  }

  return [{
    key: 'no-plot-many',
    rule: 'expense_without_plot',
    severity: 'info',
    title: `${candidates.length} gastos quedaron sin lote`,
    body: `Suman ${money(total, String(first.currency))} a nivel campo, en categorías que sí van a un lote. El mayor es ${first.category} del ${formatDayMonth(String(first.expense_date))} en «${first.field_name}».`,
    action: 'Asignar lotes',
    ref: { type: 'expense', id: Number(first.id) },
    fieldId: Number(first.field_id),
  }];
};

/**
 * 6. Fields that carry records but have no plots, and fields with plots but no
 * records at all — the two shapes of "esto quedó a medio cargar".
 */
const hollowFields: Rule = async ({ userId, fieldIds, range }) => {
  // "Has records" is all-time (a field with old data and no lotes is still
  // half-loaded); "no activity" is campaign-scoped, which is what the message
  // says — the all-time count let a field idle for two campaigns stay quiet.
  const { rows } = await pool.query(
    `SELECT f.id, f.name,
            (SELECT COUNT(*) FROM plots p WHERE p.field_id = f.id AND p.deleted_at IS NULL)::int AS plots,
            (SELECT COUNT(*) FROM rainfall r WHERE r.field_id = f.id AND r.user_id = $1)::int AS rain,
            (SELECT COUNT(*) FROM expenses e WHERE e.field_id = f.id AND e.deleted_at IS NULL)::int AS expenses,
            (SELECT COUNT(*) FROM incomes i WHERE i.field_id = f.id AND i.deleted_at IS NULL)::int AS incomes,
            (SELECT COUNT(*) FROM domain_events d
               JOIN plots p2 ON p2.id = d.plot_id
              WHERE p2.field_id = f.id AND d.user_id = $1 AND d.deleted_at IS NULL)::int AS events,
            (
              (SELECT COUNT(*) FROM rainfall r WHERE r.field_id = f.id AND r.user_id = $1
                 AND r.rainfall_date BETWEEN $3::date AND $4::date)
            + (SELECT COUNT(*) FROM expenses e
                 LEFT JOIN plots ep ON ep.id = e.plot_id
                WHERE COALESCE(e.field_id, ep.field_id) = f.id AND e.deleted_at IS NULL
                  AND e.expense_date BETWEEN $3::date AND $4::date)
            + (SELECT COUNT(*) FROM incomes i
                 LEFT JOIN plots ip ON ip.id = i.plot_id
                WHERE COALESCE(i.field_id, ip.field_id) = f.id AND i.deleted_at IS NULL
                  AND i.income_date BETWEEN $3::date AND $4::date)
            + (SELECT COUNT(*) FROM domain_events d
                 JOIN plots p2 ON p2.id = d.plot_id
                WHERE p2.field_id = f.id AND d.user_id = $1 AND d.deleted_at IS NULL
                  AND d.event_date BETWEEN $3::date AND $4::date)
            )::int AS campaign_records
       FROM fields f
      WHERE f.id = ANY($2::int[]) AND f.deleted_at IS NULL AND f.user_id = $1`,
    [userId, fieldIds, range.from, range.to],
  );

  const noPlots: string[] = [];
  const noRecords: string[] = [];
  let refField: number | null = null;

  for (const r of rows) {
    const records = Number(r.rain) + Number(r.expenses) + Number(r.incomes) + Number(r.events);
    if (Number(r.plots) === 0 && records > 0) {
      noPlots.push(String(r.name));
      refField = refField ?? Number(r.id);
    } else if (Number(r.plots) > 0 && Number(r.campaign_records) === 0) {
      noRecords.push(String(r.name));
      refField = refField ?? Number(r.id);
    }
  }
  if (!noPlots.length && !noRecords.length) return [];

  const parts: string[] = [];
  if (noPlots.length) {
    parts.push(`${listEs(noPlots.map(quote))} ${noPlots.length === 1 ? 'tiene' : 'tienen'} movimientos cargados pero ningún lote, así que nada de eso entra en el detalle por lote.`);
  }
  if (noRecords.length) {
    parts.push(`${listEs(noRecords.map(quote))} ${noRecords.length === 1 ? 'tiene' : 'tienen'} lotes y ni un registro en la campaña ${range.label}.`);
  }

  return [{
    key: 'hollow-fields',
    rule: 'hollow_fields',
    severity: 'info',
    title: noPlots.length && noRecords.length
      ? 'Campos a medio cargar'
      : (noPlots.length ? 'Campos sin lotes' : 'Campos sin actividad'),
    body: parts.join(' '),
    action: 'Ver campos',
    ref: refField ? { type: 'field', id: refField } : null,
    fieldId: null,
  }];
};

/**
 * 7. A group declares fewer head than the individual animals attached to it.
 *
 * The hybrid model deliberately allows PARTIAL individualization — a group of
 * 100 with 60 identified animals is normal and must stay quiet. Only the excess
 * is checkable nonsense: you cannot have 103 animals inside a group that says
 * it holds 100.
 */
const livestockGroupVsIndividuals: Rule = async ({ userId, fieldIds }) => {
  const { rows } = await pool.query(
    `SELECT lg.id::text AS group_id, lg.count::int AS declared,
            COUNT(a.id)::int AS individual, lg.category::text AS category,
            f.id AS field_id, f.name AS field_name,
            p.name AS plot_name, c.name AS corral_name
       FROM livestock_groups lg
       JOIN fields f ON f.id = lg.field_id
       LEFT JOIN plots   p ON p.id = lg.plot_id
       LEFT JOIN corrals c ON c.id = lg.corral_id
       LEFT JOIN animals a
              ON a.group_id = lg.id AND a.deleted_at IS NULL AND a.status = 'activo'
      WHERE lg.user_id = $1 AND f.id = ANY($2::int[])
        AND lg.deleted_at IS NULL AND f.deleted_at IS NULL
      GROUP BY lg.id, lg.count, lg.category, f.id, f.name, p.name, c.name
     HAVING COUNT(a.id) > lg.count`,
    [userId, fieldIds],
  );

  return rows.map((r: Record<string, unknown>) => {
    const loc = r.plot_name ? `lote ${r.plot_name}` : r.corral_name ? `corral ${r.corral_name}` : String(r.field_name);
    return {
      key: `livestock-group-excess-${r.group_id}`,
      rule: 'livestock_group_vs_individuals',
      severity: 'warn' as Severity,
      title: `El grupo de ${r.category} en ${loc} no cierra`,
      body: `Declara ${fmtNum(Number(r.declared))} animales, pero tiene ${fmtNum(Number(r.individual))} identificados individualmente. O falta ajustar la cantidad del grupo, o hay caravanas cargadas de más.`,
      action: 'Ver hacienda',
      ref: { type: 'field' as const, id: Number(r.field_id) },
      fieldId: Number(r.field_id),
    };
  });
};

/**
 * 8. A corral holding more head than its configured capacity.
 *
 * `capacity` is advisory by design (the handler warns and lets the operation
 * through), so this is where a corral that stayed over capacity surfaces later.
 * A corral with no capacity set is never reported: NULL means "not configured",
 * not zero.
 */
const corralOvercapacity: Rule = async ({ userId, fieldIds }) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name AS corral_name, c.capacity::int AS capacity,
            fl.name AS feedlot_name, f.id AS field_id,
            occ.current
       FROM corrals c
       JOIN feedlots fl ON fl.id = c.feedlot_id
       JOIN fields   f  ON f.id  = fl.field_id
       JOIN LATERAL (
         SELECT COALESCE(SUM(lg.count), 0)::int AS current
           FROM livestock_groups lg
          WHERE lg.corral_id = c.id AND lg.deleted_at IS NULL
       ) occ ON TRUE
      WHERE fl.user_id = $1 AND f.id = ANY($2::int[])
        AND c.deleted_at IS NULL AND f.deleted_at IS NULL
        AND c.capacity IS NOT NULL AND c.capacity > 0
        AND occ.current > c.capacity`,
    [userId, fieldIds],
  );

  return rows.map((r: Record<string, unknown>) => ({
    key: `corral-over-${r.id}`,
    rule: 'corral_overcapacity',
    severity: 'info' as Severity,
    title: `El corral ${r.corral_name} está por encima de su capacidad`,
    body: `Tiene ${fmtNum(Number(r.current))} animales y está configurado para ${fmtNum(Number(r.capacity))} (${r.feedlot_name}). Si la capacidad quedó vieja, actualizala; si no, conviene repartir la hacienda.`,
    action: 'Ver feedlot',
    ref: { type: 'field' as const, id: Number(r.field_id) },
    fieldId: Number(r.field_id),
  }));
};

/**
 * 9. An animal that left the herd and then registered an event.
 *
 * A sold or dead animal that keeps getting weighed or moved is an impossible
 * fact — either the exit was recorded on the wrong caravana, or the later event
 * was.
 *
 * Only events that mean the animal was actually WORKED ON count. The animal's
 * own bookkeeping (identificación, ingreso, nacimiento) and the exit events
 * themselves are excluded on purpose: registering an animal today and
 * back-dating its sale to May is legitimate catch-up data entry, and flagging
 * that would fire on ordinary use.
 */
const animalEventAfterExit: Rule = async ({ userId, fieldIds }) => {
  const { rows } = await pool.query(
    `SELECT a.id::text AS animal_id, a.status::text AS status,
            a.exit_date::text AS exit_date, a.field_id,
            COUNT(ae.id)::int AS n,
            MAX(ae.event_date)::text AS last_event,
            (SELECT ai.value FROM animal_identifications ai
              WHERE ai.animal_id = a.id AND ai.is_current
              ORDER BY ai.assigned_date DESC LIMIT 1) AS tag
       FROM animals a
       JOIN animal_events ae ON ae.animal_id = a.id AND ae.deleted_at IS NULL
      WHERE a.user_id = $1
        AND (a.field_id IS NULL OR a.field_id = ANY($2::int[]))
        AND a.deleted_at IS NULL
        AND a.status IN ('vendido','muerto','transferido')
        AND a.exit_date IS NOT NULL
        AND ae.event_date > a.exit_date
        AND ae.event_type IN (
          'movimiento','cambio_grupo','cambio_categoria','cambio_establecimiento',
          'vacunacion','desparasitacion','tratamiento','revision_sanitaria',
          'pesaje','condicion_corporal',
          'servicio','inseminacion','diagnostico_prenez','parto','destete'
        )
      GROUP BY a.id, a.status, a.exit_date, a.field_id`,
    [userId, fieldIds],
  );

  return rows.map((r: Record<string, unknown>) => ({
    key: `animal-after-exit-${r.animal_id}`,
    rule: 'animal_event_after_exit',
    severity: 'warn' as Severity,
    title: `Un animal ${r.status} sigue registrando movimientos`,
    body: `La caravana ${r.tag ?? 'sin identificar'} figura como ${r.status} el ${formatDayMonth(String(r.exit_date))}, pero tiene ${fmtNum(Number(r.n))} evento(s) posteriores (el último el ${formatDayMonth(String(r.last_event))}). O la baja se cargó en el animal equivocado, o el evento.`,
    action: 'Ver animal',
    ref: r.field_id ? { type: 'field' as const, id: Number(r.field_id) } : null,
    fieldId: r.field_id ? Number(r.field_id) : null,
  }));
};

const RULES: Rule[] = [
  productIsPlotName,
  overlappingPlantings,
  harvestBeforePlanting,
  outlierPlotArea,
  expensesWithoutPlot,
  hollowFields,
  livestockGroupVsIndividuals,
  corralOvercapacity,
  animalEventAfterExit,
];

export async function getReviewFindings(ctx: Ctx): Promise<Finding[]> {
  const results = await Promise.all(
    RULES.map(async (rule) => {
      try {
        return await rule(ctx);
      } catch (err) {
        // One broken rule must never take the whole Resumen down — the card is
        // advisory. Log it and carry on (invariante 1: nothing dropped silently).
        console.error('[REVIEW] regla falló:', (err as Error)?.message);
        return [];
      }
    }),
  );
  const flat = results.flat();
  // warn first, then info; stable within each group.
  return flat.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
}

// ── helpers ──────────────────────────────────────────────────────────────
function labelFor(eventType: string): string {
  const map: Record<string, string> = {
    fertilization: 'fertilización', spraying: 'pulverización', planting: 'siembra',
    harvest: 'cosecha', tillage: 'labor', irrigation: 'riego',
  };
  return map[eventType] ?? 'actividad';
}

function quote(s: string): string {
  return `«${s}»`;
}

function listEs(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' y ' + items[items.length - 1];
}

function daysBetween(a: string, b: string): number {
  const d = (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;
  return Math.max(0, Math.round(d));
}
