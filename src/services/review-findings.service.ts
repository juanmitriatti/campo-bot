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
 */
const harvestBeforePlanting: Rule = async ({ userId, fieldIds, range }) => {
  const { rows } = await pool.query(
    `SELECT h.id, h.event_date::text AS harvest_date, h.crop,
            pl.id AS plot_id, pl.name AS plot_name, f.id AS field_id,
            s.event_date::text AS sow_date
       FROM domain_events h
       JOIN plots pl ON pl.id = h.plot_id
       JOIN fields f ON f.id = pl.field_id
       JOIN domain_events s
         ON s.plot_id = h.plot_id
        AND s.user_id = h.user_id
        AND s.event_type = 'planting'
        AND s.deleted_at IS NULL
        AND LOWER(COALESCE(s.crop, '')) = LOWER(COALESCE(h.crop, ''))
        AND s.event_date >= h.event_date
      WHERE h.user_id = $1 AND h.deleted_at IS NULL
        AND h.event_type = 'harvest'
        AND h.event_date BETWEEN $2::date AND $3::date
        AND pl.field_id = ANY($4::int[])`,
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
  const { rows } = await pool.query(
    `SELECT f.id, f.name,
            (SELECT COUNT(*) FROM plots p WHERE p.field_id = f.id AND p.deleted_at IS NULL)::int AS plots,
            (SELECT COUNT(*) FROM rainfall r WHERE r.field_id = f.id AND r.user_id = $1)::int AS rain,
            (SELECT COUNT(*) FROM expenses e WHERE e.field_id = f.id AND e.deleted_at IS NULL)::int AS expenses,
            (SELECT COUNT(*) FROM incomes i WHERE i.field_id = f.id AND i.deleted_at IS NULL)::int AS incomes,
            (SELECT COUNT(*) FROM domain_events d
               JOIN plots p2 ON p2.id = d.plot_id
              WHERE p2.field_id = f.id AND d.user_id = $1 AND d.deleted_at IS NULL)::int AS events
       FROM fields f
      WHERE f.id = ANY($2::int[]) AND f.deleted_at IS NULL AND f.user_id = $1`,
    [userId, fieldIds],
  );

  const noPlots: string[] = [];
  const noRecords: string[] = [];
  let refField: number | null = null;

  for (const r of rows) {
    const records = Number(r.rain) + Number(r.expenses) + Number(r.incomes) + Number(r.events);
    if (Number(r.plots) === 0 && records > 0) {
      noPlots.push(String(r.name));
      refField = refField ?? Number(r.id);
    } else if (Number(r.plots) > 0 && records === 0) {
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

const RULES: Rule[] = [
  productIsPlotName,
  overlappingPlantings,
  harvestBeforePlanting,
  outlierPlotArea,
  expensesWithoutPlot,
  hollowFields,
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
